// The email transport send. Modelled on a Resend/MailChannels-style JSON HTTP API.
// Workers give us `fetch` natively; zero dependencies. This module never composes
// the message — render.ts does — and it reads NO env: the credentials arrive as an
// argument (per-org, admin-provisioned), exactly like zulip/deliver.ts.

import { log } from '../../../log';
import type { EmailOrgSecrets } from './org-config';

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean };

/** POST an email via the transport, using the org's decrypted credentials.
 *  5xx/429 → retryable; 4xx → not. Network throws propagate to the adapter, which
 *  treats them as retryable. */
export async function sendEmail(
  creds: EmailOrgSecrets,
  to: string,
  subject: string,
  text: string,
): Promise<SendResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: creds.fromAddress, to, subject, text }),
  });

  if (res.ok) return { ok: true };
  const retryable = res.status >= 500 || res.status === 429;
  // Surface WHY, as zulip/deliver.ts does: the transport returns a JSON error body
  // naming the cause (an unverified From: domain, a revoked key, a malformed
  // address). It echoes no secret, so log it truncated — without this the caller
  // only sees a bare retryable flag and can't tell a bad key from a bad request.
  let errBody = '';
  try {
    errBody = (await res.text()).slice(0, 500);
  } catch {
    // body is best-effort; a failed read must not mask the send failure
  }
  // Redact addresses before logging: the transport's 4xx bodies echo the request,
  // including `to`. The status/reason is what we need; the recipient is not, and
  // Workers Logs are persisted. Non-anchored twin of org-config's EMAIL_RE (which
  // is ^…$ and cannot be used for substring replacement).
  const safeBody = errBody.replace(/[^\s"'<>@]+@[^\s"'<>@]+\.[^\s"'<>,@]+/g, '[address]');
  log.warn('email: send rejected', { status: res.status, retryable, body: safeBody });
  return { ok: false, retryable };
}
