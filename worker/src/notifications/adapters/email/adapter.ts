// The Email NotifierAdapter — the second implementation, proving the abstraction:
// its `deliver` path is identical in shape to Zulip's (identify → render → send →
// report), while its SETUP differs (an in-app `input` step + submitSetup, no inbound
// webhook). That difference is the point — delivery is uniform, setup is not — and it
// needed NO new SetupStep kind and NO change to escalation.
//
// Boundary: imports only env, contract, and its own siblings — never
// dao/registry/routes/cron. Persistence goes through store.ts; the app never learns
// the address (only a masked label, via the route's registerChannel).

import type {
  LinkStatus,
  NotifierDescriptor,
  SetupInstructions,
  SetupSubmission,
} from '@shared/notifications';
import type { Env } from '../../../env';
import type { DeliverRequest, DeliverResult, NotifierAdapter } from '../../contract';
import { sendEmail } from './deliver';
import { renderEmail } from './render';
import { deleteEmail, getEmail, saveEmail } from './store';

// Deliberately loose: we only reject the obviously-not-an-address, since the real
// verification is deliverability (a production build would confirm via a sent code).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mask an address for the opaque display label: "yehuda@x.com" -> "y****@x.com". */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return 'Email';
  const local = email.slice(0, at);
  const head = local[0] ?? '';
  return `${head}****${email.slice(at)}`;
}

export function makeEmailAdapter(env: Env): NotifierAdapter {
  return {
    async describe(): Promise<NotifierDescriptor> {
      return { channel: 'email', displayName: 'Email' };
    },

    async beginSetup(): Promise<SetupInstructions> {
      return {
        steps: [
          { kind: 'text', body: 'Enter the email address where you want reminders:' },
          { kind: 'input', label: 'Email address', name: 'email', inputType: 'email' },
        ],
        completion: 'poll',
      };
    },

    async submitSetup(userId: string, submission: SetupSubmission): Promise<LinkStatus> {
      const email = (submission.fields['email'] ?? '').trim();
      if (!EMAIL_RE.test(email)) return { linked: false };
      await saveEmail(env, userId, email);
      return { linked: true, label: maskEmail(email) };
    },

    async getStatus(userId: string): Promise<LinkStatus> {
      const email = await getEmail(env, userId);
      if (!email) return { linked: false };
      return { linked: true, label: maskEmail(email) };
    },

    async deliver(req: DeliverRequest): Promise<DeliverResult> {
      const email = await getEmail(env, req.userId);
      if (!email) return { status: 'not_linked' };
      const { subject, text } = renderEmail(req.payload);
      try {
        const r = await sendEmail(env, email, subject, text);
        if (r.ok) return { status: 'delivered' };
        return { status: 'failed', retryable: r.retryable };
      } catch {
        return { status: 'failed', retryable: true };
      }
    },

    async unlink(userId: string): Promise<void> {
      await deleteEmail(env, userId);
    },
  };
}
