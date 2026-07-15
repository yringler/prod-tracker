// The Zulip inbound webhook — inbound-only, purely for LINKING. Zulip fires an
// outgoing-webhook POST when the bot is DM'd or @-mentioned; the user sends
// `/link CODE` and we bind their Atlassian account to their Zulip sender_id.
//
// Security posture (see notifaction-adapters.md §7):
//  - verify the shared ZULIP_WEBHOOK_TOKEN (token-is-capability),
//  - GUARD trigger === 'direct_message' so a `/link` posted in a public stream
//    (a mention) can never redeem a code,
//  - per-sender_id failed-attempt rate limit so codes can't be brute-forced,
//  - codes are bound-at-generation, single-use, TTL'd (enforced in store.ts).
//
// This module never imports dao/registry: it reaches the app only through the
// neutral InboundContext.registerChannel callback that index.ts injects.

import type { Env } from '../../../env';
import type { InboundContext } from '../../contract';
import { recentFailedAttempts, recordFailedAttempt, redeemCode, saveLink } from './store';

/** Failed `/link` attempts allowed per sender within the window before we refuse. */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_FAILED = 5;

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
  let body: ZulipWebhookBody;
  try {
    body = (await req.json()) as ZulipWebhookBody;
  } catch {
    return json({}, 400);
  }

  // Token-is-capability: reject anything not carrying our shared secret.
  if (typeof body.token !== 'string' || body.token !== env.ZULIP_WEBHOOK_TOKEN) {
    return json({}, 401);
  }

  // GUARD: only direct messages may redeem. A `/link CODE` posted as a public
  // @-mention would otherwise leak the code to the channel and let anyone replay it.
  if (body.trigger !== 'direct_message') {
    return json({});
  }

  const msg = body.message ?? {};
  const senderId = msg.sender_id;
  if (typeof senderId !== 'number' && typeof senderId !== 'string') {
    return json({});
  }
  const sender = String(senderId);
  const fullName = typeof msg.sender_full_name === 'string' ? msg.sender_full_name : null;
  const content = typeof msg.content === 'string' ? msg.content : '';

  const m = content.trim().match(/^\/link\s+([A-Za-z0-9]+)$/i);
  if (!m) {
    // Unknown content → instructions, the only affordance the user gets.
    return reply(INSTRUCTIONS);
  }

  // Per-sender failed-attempt rate limit, so a code can't be brute-forced into
  // someone else's account.
  const sinceIso = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const failed = await recentFailedAttempts(env, sender, sinceIso);
  if (failed >= RATE_MAX_FAILED) {
    return reply('Too many attempts. Please wait a few minutes and try again.');
  }

  const code = m[1]!.toUpperCase();
  const redeemed = await redeemCode(env, code);
  if (!redeemed) {
    await recordFailedAttempt(env, sender);
    return reply('That code is invalid or has expired. Generate a fresh one in app settings.');
  }

  await saveLink(env, redeemed.accountId, sender, fullName);
  await ctx.registerChannel(redeemed.accountId, 'zulip', fullName ?? 'Zulip');
  return reply('Connected ✓ You will now get effort-rating reminders here.');
}
