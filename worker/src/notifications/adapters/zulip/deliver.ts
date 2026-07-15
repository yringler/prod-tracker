// The Zulip REST send. Zulip's message API is form-urlencoded (NOT JSON — a common
// trip-up) with HTTP Basic auth (bot email : api key). Workers give us `fetch` and
// `btoa` natively, so this needs zero dependencies. This module never composes the
// message content — it receives an already-rendered string from render.ts.

import type { Env } from '../../../env';

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
    type: 'direct',
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
  return { ok: false, retryable };
}
