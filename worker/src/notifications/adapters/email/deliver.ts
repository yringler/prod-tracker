// The email transport send. Modelled on a Resend/MailChannels-style JSON HTTP API
// behind EMAIL_API_KEY. Workers give us `fetch` natively; zero dependencies. This
// module never composes the message — render.ts does.

import type { Env } from '../../../env';

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean };

/** POST an email via the transport. 5xx/429 → retryable; 4xx → not. Network throws
 *  propagate to the adapter, which treats them as retryable. */
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<SendResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });

  if (res.ok) return { ok: true };
  const retryable = res.status >= 500 || res.status === 429;
  return { ok: false, retryable };
}
