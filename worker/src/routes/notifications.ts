// App-side, authenticated notification-channel routes. Everything here is
// hard-scoped to ctx.accountId (the caller's own channels). Channels are reached
// ONLY through the registry seam (never a deep adapter import — eslint-enforced),
// so this layer stays vendor-agnostic: it forwards the adapter's self-describing
// setup vocabulary and never composes a vendor string.

import type {
  BeginSetupResponse,
  ChannelListItem,
  ChannelListResponse,
  LinkStatus,
  SetChannelEnabledRequest,
  SetChannelEnabledResponse,
  SetupSubmission,
} from '@shared/notifications';
import { type AuthedCtx, error, json, readJson } from '../http';
import { errFields, log } from '../log';
import type { NotificationPayload, NotifierAdapter } from '../notifications/contract';
import { availableChannels, resolve } from '../notifications/registry';

/** An adapter is available unless it explicitly reports it can't deliver for this
 *  org (env-based adapters ignore the orgId). Undefined `isConfigured` (adapters
 *  that don't gate) → treated as configured. */
async function configured(
  adapter: NotifierAdapter,
  channel: string,
  orgId: string,
): Promise<boolean> {
  try {
    return (await adapter.isConfigured?.(orgId)) !== false;
  } catch (e) {
    // A DB-backed isConfigured (e.g. an unmigrated zulip_org_config table) must
    // degrade to "unavailable" rather than throw: the channel list skips it and the
    // setup routes 404 it — the same graceful path as a genuinely unconfigured org,
    // instead of a bare 500.
    log.warn('configured: isConfigured threw, treating channel as unavailable', {
      channel,
      ...errFields(e),
    });
    return false;
  }
}

/** GET /api/notifications/channels — descriptor + link status + opt-in for each
 *  channel the ORG has provisioned, for the authed account only. `status` (do I
 *  have an identity here?) and `enabled` (do I want it?) are orthogonal. */
export async function listChannels(ctx: AuthedCtx): Promise<Response> {
  const channels: ChannelListItem[] = [];
  // One self-scoped read for the whole list; a channel with no row has never been
  // opted into, so it defaults to off. Wrapped for the same reason as the
  // per-adapter try below: an unmigrated `enabled` column must degrade to "nothing
  // opted in", not 500 the settings panel.
  let prefs = new Map<string, boolean>();
  try {
    prefs = new Map(
      (await ctx.dao.listChannelPrefs(ctx.accountId)).map((p) => [p.channel, p.enabled]),
    );
  } catch (e) {
    log.warn('listChannels: channel prefs unavailable, defaulting to off', errFields(e));
  }
  for (const channel of availableChannels()) {
    const adapter = resolve(ctx.env, channel);
    if (!adapter) continue; // config drift: a registered key that failed the guard
    try {
      // Inside the try: a DB-backed isConfigured (e.g. an unmigrated table) must
      // degrade to a skip, not blank the list.
      if (!(await configured(adapter, channel, ctx.cloudId))) continue; // can't deliver for this org → don't advertise
      const descriptor = await adapter.describe();
      const status = await adapter.getStatus(ctx.accountId);
      channels.push({ descriptor, status, enabled: prefs.get(channel) ?? false });
    } catch (e) {
      // One misconfigured adapter (e.g. an unmigrated table so getStatus throws)
      // must NOT blank the whole list — skip it and log so it's visible in
      // `wrangler tail`. The healthy channels still render.
      log.warn('listChannels: adapter unavailable, skipping', { channel, ...errFields(e) });
    }
  }
  const body: ChannelListResponse = { channels };
  return json(body);
}

/** POST /api/notifications/:channel/setup — mint live setup instructions. */
export async function beginChannelSetup(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter || !(await configured(adapter, channel, ctx.cloudId))) return error(404, 'unknown channel');
  const instructions: BeginSetupResponse = await adapter.beginSetup(ctx.accountId);
  return json(instructions);
}

/** POST /api/notifications/:channel/complete — finish an in-app setup (an `input`
 *  flow, e.g. email). The route forwards the submitted fields to the adapter's
 *  submitSetup, then — if the link succeeded — registers the app-owned channel with
 *  the adapter's opaque label (the adapter can't touch user_channels). */
export async function completeChannelSetup(
  req: Request,
  ctx: AuthedCtx,
  channel: string,
): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter || !adapter.submitSetup || !(await configured(adapter, channel, ctx.cloudId)))
    return error(404, 'unknown channel');
  const body = await readJson<SetupSubmission>(req);
  const fields = body && typeof body.fields === 'object' && body.fields ? body.fields : {};
  const status = await adapter.submitSetup(ctx.accountId, { fields });
  if (status.linked) {
    await ctx.dao.registerChannel(ctx.accountId, channel, status.label);
  } else {
    // Setup rejected the input — make sure no stale app-owned row lingers.
    await ctx.dao.unregisterChannel(ctx.accountId, channel);
  }
  return json(status);
}

/** PUT /api/notifications/:channel/enabled — the per-user opt-in toggle. This is
 *  the whole user-side surface now: provisioning belongs to the admin, so a user
 *  only chooses WHETHER to be reminded here, never HOW to send. Gated on the org
 *  having provisioned the channel (you can't opt into a channel your site doesn't
 *  have). The reply carries the identity status so the client learns in ONE
 *  round-trip whether turning it on still needs an address/handle. */
export async function setChannelEnabled(
  req: Request,
  ctx: AuthedCtx,
  channel: string,
): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter || !(await configured(adapter, channel, ctx.cloudId)))
    return error(404, 'unknown channel');
  const body = await readJson<SetChannelEnabledRequest>(req);
  if (typeof body?.enabled !== 'boolean') return error(400, 'enabled (boolean) required');
  await ctx.dao.setChannelEnabled(ctx.accountId, channel, body.enabled);
  const res: SetChannelEnabledResponse = {
    enabled: body.enabled,
    status: await adapter.getStatus(ctx.accountId),
  };
  return json(res);
}

/** GET /api/notifications/:channel/status — poll target for the setup UI. */
export async function channelStatus(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter) return error(404, 'unknown channel');
  const status: LinkStatus = await adapter.getStatus(ctx.accountId);
  return json(status);
}

/** POST /api/notifications/test — deliver a synthetic reminder to the caller's OWN
 *  linked channels right now, bypassing the escalation window. This is the only way to
 *  verify the outbound send path end-to-end: linking ("Connected ✓") is just the
 *  webhook's echoed reply and never exercises the bot credentials, so a bot api key
 *  that fails sends can still pass linking, then fail every real reminder. Hard-scoped to
 *  ctx.accountId (you can only DM yourself), so it's safe in prod. Reaches channels via
 *  the registry seam only — no adapter import (eslint wall). Returns a per-channel result
 *  so the exact outcome (delivered / not_linked / failed / unknown) is visible in the
 *  HTTP response; deliver.ts additionally logs the vendor status/body on a failure. */
export async function sendTestNotification(ctx: AuthedCtx): Promise<Response> {
  const payload: NotificationPayload = {
    title: 'Test notification from storypoint-tracker',
    body: 'If you can read this, your notification channel is delivering correctly.',
    deepLink: `${ctx.env.APP_ORIGIN}/tracker`,
    urgency: 'normal',
  };
  const channels = await ctx.dao.getUserChannels(ctx.accountId);
  const results: { channel: string; status: string; retryable?: boolean }[] = [];
  for (const { channel } of channels) {
    const adapter = resolve(ctx.env, channel);
    if (!adapter) {
      results.push({ channel, status: 'unknown_channel' });
      continue;
    }
    try {
      const r = await adapter.deliver({
        userId: ctx.accountId,
        orgId: ctx.cloudId,
        payload,
        idempotencyKey: `test:${ctx.accountId}:${Date.now()}`,
      });
      results.push(
        r.status === 'failed'
          ? { channel, status: r.status, retryable: r.retryable }
          : { channel, status: r.status },
      );
    } catch (e) {
      log.warn('sendTestNotification: adapter threw', { channel, ...errFields(e) });
      results.push({ channel, status: 'threw' });
    }
  }
  return json({ ok: true, channels: results });
}

/** DELETE /api/notifications/:channel — FORGET MY IDENTITY (not "mute": that's the
 *  /enabled toggle). The route orchestrates BOTH halves: the adapter clears its own
 *  vendor-address row, and the app clears user_channels (the adapter can't touch
 *  app-owned tables) — which drops the `enabled` flag with it, so a later re-link
 *  starts from the column default. */
export async function unlinkChannel(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter) return error(404, 'unknown channel');
  await adapter.unlink(ctx.accountId);
  await ctx.dao.unregisterChannel(ctx.accountId, channel);
  return json({ ok: true });
}
