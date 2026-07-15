// The Zulip REST send. Zulip's message API is form-urlencoded (NOT JSON — a common
// trip-up) with HTTP Basic auth (bot email : api key). Workers give us `fetch` and
// `btoa` natively, so this needs zero dependencies. This module never composes the
// message content — it receives an already-rendered string from render.ts.

import type { Env } from '../../../env';
import { log } from '../../../log';

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean };

/** POST a direct message to `recipient` (a numeric Zulip user id, as a string).
 *  Maps transport failures to a retryable flag: 5xx/429 are transient (retryable),
 *  4xx are caller/config errors (not retryable). Network throws propagate to the
 *  adapter, which treats them as retryable. */
export async function sendZulipDM(
  env: Env,
  recipient: string,
  content: string,
): Promise<SendResult> {
  const body = new URLSearchParams({
    // `private` is the backward-compatible message type: modern Zulip keeps it as an
    // alias for `direct`, while older self-hosted servers (like the one this deploys
    // against — the inbound webhook already tolerates the legacy `private_message`
    // trigger for the same reason) only accept `private` and reject `direct` with a 400.
    type: 'private',
    to: JSON.stringify([recipient]), // JSON-encoded array, inside the form encoding
    content,
  });

  const res = await fetch(`${env.ZULIP_SITE}/api/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.ZULIP_BOT_EMAIL}:${env.ZULIP_API_KEY}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (res.ok) return { ok: true };
  const retryable = res.status >= 500 || res.status === 429;
  // Surface WHY: Zulip returns a JSON error body ({ result, msg, code }) that names the
  // cause — "Invalid API key" (bad bot creds → 401), "Invalid message type" (→ 400),
  // etc. It echoes no secret, so log it truncated. Without this the caller only sees a
  // bare retryable flag and can't tell a bad key from a bad request. Cap head sampling
  // notwithstanding, one line here makes the failure diagnosable from `wrangler tail`.
  let errBody = '';
  try {
    errBody = (await res.text()).slice(0, 500);
  } catch {
    // body is best-effort; a failed read must not mask the send failure
  }
  log.warn('zulip: send rejected', { status: res.status, retryable, body: errBody });
  return { ok: false, retryable };
}
