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
  SetupSubmission,
} from '@shared/notifications';
import { type AuthedCtx, error, json, readJson } from '../http';
import { availableChannels, resolve } from '../notifications/registry';

/** GET /api/notifications/channels — descriptor + link status for each channel,
 *  for the authed account only. */
export async function listChannels(ctx: AuthedCtx): Promise<Response> {
  const channels: ChannelListItem[] = [];
  for (const channel of availableChannels()) {
    const adapter = resolve(ctx.env, channel);
    if (!adapter) continue; // config drift: a registered key that failed the guard
    const descriptor = await adapter.describe();
    const status = await adapter.getStatus(ctx.accountId);
    channels.push({ descriptor, status });
  }
  const body: ChannelListResponse = { channels };
  return json(body);
}

/** POST /api/notifications/:channel/setup — mint live setup instructions. */
export async function beginChannelSetup(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter) return error(404, 'unknown channel');
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
  if (!adapter || !adapter.submitSetup) return error(404, 'unknown channel');
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

/** GET /api/notifications/:channel/status — poll target for the setup UI. */
export async function channelStatus(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter) return error(404, 'unknown channel');
  const status: LinkStatus = await adapter.getStatus(ctx.accountId);
  return json(status);
}

/** DELETE /api/notifications/:channel — unlink. The route orchestrates BOTH halves:
 *  the adapter clears its own vendor-address row, and the app clears user_channels
 *  (the adapter can't touch app-owned tables). */
export async function unlinkChannel(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter) return error(404, 'unknown channel');
  await adapter.unlink(ctx.accountId);
  await ctx.dao.unregisterChannel(ctx.accountId, channel);
  return json({ ok: true });
}
