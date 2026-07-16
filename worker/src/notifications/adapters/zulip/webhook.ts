// The Zulip inbound webhook — inbound-only, purely for LINKING. Zulip fires an
// outgoing-webhook POST when the bot is DM'd or @-mentioned; the user sends
// `/link CODE` and we bind their Atlassian account to their Zulip sender_id.
//
// Security posture (see notifaction-adapters.md §7):
//  - verify the webhook token against the per-org config (token-is-capability;
//    stored only as a sha256 hash — the hash lookup both authenticates AND
//    resolves which org the /link belongs to),
//  - GUARD on a DIRECT message so a `/link` posted in a public stream (a mention)
//    can never redeem a code,
//  - per-sender_id failed-attempt rate limit so codes can't be brute-forced,
//  - codes are bound-at-generation, single-use, TTL'd (enforced in store.ts).
//
// Every decision point logs (structured, no secrets) so `wrangler tail` shows
// exactly where an attempted link stops. This module never imports dao/registry:
// it reaches the app only through the neutral InboundContext.registerChannel
// callback that index.ts injects.

import type { Env } from '../../../env';
import { errFields, log as rootLog } from '../../../log';
import type { InboundContext } from '../../contract';
import { sha256Hex } from '../../secretbox';
import {
  findOrgByTokenHash,
  recentFailedAttempts,
  recordFailedAttempt,
  redeemCode,
  saveLink,
} from './store';

/** Failed `/link` attempts allowed per sender within the window before we refuse. */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_FAILED = 5;

// Zulip renamed "private message" → "direct message"; self-hosted servers on older
// versions still send `trigger: "private_message"` for a DM to the bot. Accept both
// — both are DMs, so the security intent (never process a public-channel `/link`) is
// preserved: we still reject "mention" and any stream message.
const DM_TRIGGERS = new Set(['direct_message', 'private_message']);

const INSTRUCTIONS =
  'To connect notifications, generate a code in the app settings and send it here as ' +
  '`/link YOURCODE`.';

/** The subset of the Zulip outgoing-webhook payload we consume. */
interface ZulipWebhookBody {
  token?: unknown;
  trigger?: unknown;
  message?: {
    sender_id?: unknown;
    sender_full_name?: unknown;
    content?: unknown;
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A Zulip reply: returning `{ content }` makes the bot post it; `{}` is silence. */
function reply(content: string): Response {
  return json({ content });
}

export async function handleZulipInbound(
  env: Env,
  req: Request,
  ctx: InboundContext,
): Promise<Response> {
  const log = rootLog.child({ webhook: 'zulip' });

  let body: ZulipWebhookBody;
  try {
    body = (await req.json()) as ZulipWebhookBody;
  } catch (e) {
    log.warn('zulip webhook: unparseable JSON body', errFields(e));
    return json({}, 400);
  }

  // Token-is-capability: reject anything not carrying a configured org's secret.
  // Zulip's outgoing-webhook `token` is a per-bot value DISTINCT from the bot's API
  // key (find it via the Bots page → "Download config of all active outgoing
  // webhooks", the `token=` line). It's stored only as a sha256 hash; a hash hit
  // both authenticates the request AND resolves which org this /link belongs to —
  // the bot that received the DM defines the org, not the linker's session. We log
  // only non-sensitive shape — never the token itself.
  if (typeof body.token !== 'string' || body.token.length === 0) {
    log.warn('zulip webhook: token missing', { hasToken: typeof body.token === 'string' });
    return json({}, 401);
  }
  const cloudId = await findOrgByTokenHash(env, await sha256Hex(body.token));
  if (!cloudId) {
    log.warn('zulip webhook: token matched no org config', { hasToken: true });
    return json({}, 401);
  }

  // GUARD: only direct messages may redeem. A `/link CODE` posted as a public
  // @-mention would otherwise leak the code to the channel and let anyone replay it.
  if (typeof body.trigger !== 'string' || !DM_TRIGGERS.has(body.trigger)) {
    log.info('zulip webhook: ignoring non-DM trigger', { trigger: body.trigger ?? null });
    return json({});
  }

  const msg = body.message ?? {};
  const senderId = msg.sender_id;
  if (typeof senderId !== 'number' && typeof senderId !== 'string') {
    log.warn('zulip webhook: DM without a usable sender_id');
    return json({});
  }
  const sender = String(senderId);
  const fullName = typeof msg.sender_full_name === 'string' ? msg.sender_full_name : null;
  const content = typeof msg.content === 'string' ? msg.content : '';

  const m = content.trim().match(/^\/link\s+([A-Za-z0-9]+)$/i);
  if (!m) {
    // Unknown content → instructions, the only affordance the user gets.
    log.info('zulip webhook: DM did not match /link CODE', { sender });
    return reply(INSTRUCTIONS);
  }

  // Per-sender failed-attempt rate limit, so a code can't be brute-forced into
  // someone else's account.
  const sinceIso = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const failed = await recentFailedAttempts(env, sender, sinceIso);
  if (failed >= RATE_MAX_FAILED) {
    log.warn('zulip webhook: sender rate-limited', { sender, failed });
    return reply('Too many attempts. Please wait a few minutes and try again.');
  }

  const code = m[1]!.toUpperCase();
  const redeemed = await redeemCode(env, code);
  if (!redeemed) {
    await recordFailedAttempt(env, sender);
    log.warn('zulip webhook: code invalid, expired, or already used', { sender });
    return reply('That code is invalid or has expired. Generate a fresh one in app settings.');
  }

  await saveLink(env, redeemed.accountId, sender, fullName, cloudId);
  await ctx.registerChannel(redeemed.accountId, 'zulip', fullName ?? 'Zulip');
  log.info('zulip webhook: account linked', { sender, account: redeemed.accountId, cloudId });
  return reply('Connected ✓ You will now get effort-rating reminders here.');
}
