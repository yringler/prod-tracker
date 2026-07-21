// The Email NotifierAdapter — the second implementation, proving the abstraction:
// its `deliver` path is identical in shape to Zulip's (identify → render → send →
// report), while its SETUP differs (an in-app `input` step + submitSetup, no inbound
// webhook). That difference is the point — delivery is uniform, setup is not — and it
// needed NO new SetupStep kind and NO change to escalation.
//
// Provisioning is ADMIN-owned per org (email_org_config, added 0013), like Zulip's:
// the user supplies only an address, never a credential. The legacy
// EMAIL_API_KEY/EMAIL_FROM env config survives as a fallback inside
// loadEmailSecrets so existing deployments keep delivering.
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
import { log } from '../../../log';
import type { ConfigureOrgResult, DeliverRequest, DeliverResult, NotifierAdapter } from '../../contract';
import { sendEmail } from './deliver';
import {
  configureEmailOrg,
  EMAIL_RE,
  EMAIL_REQUESTED_FIELDS,
  emailOrgSummary,
  loadEmailSecrets,
} from './org-config';
import { renderEmail } from './render';
import { deleteEmail, deleteEmailOrgConfig, getEmail, saveEmail } from './store';

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
      return {
        channel: 'email',
        displayName: 'Email',
        requestedFields: EMAIL_REQUESTED_FIELDS,
        // The one thing we need from the user is where to send it.
        requiresUserIdentity: true,
        identityPrompt: 'an email address',
      };
    },

    // Ready when THIS org can actually send: an admin-provisioned row (api key +
    // From: address), or the legacy env pair as a fallback. Absent both → the app
    // hides Email.
    async isConfigured(orgId: string): Promise<boolean> {
      return (await loadEmailSecrets(env, orgId)) !== null;
    },

    // Admin-entered org config: validate + live-verify + encrypt + persist.
    configureOrg(
      orgId: string,
      fields: Record<string, string>,
      configuredBy: string,
    ): Promise<ConfigureOrgResult> {
      return configureEmailOrg(env, orgId, fields, configuredBy);
    },

    // Turn the channel off site-wide. Per-user addresses survive; delivery then
    // falls back to the legacy env pair if one is still set, else fails.
    unconfigureOrg(orgId: string): Promise<void> {
      return deleteEmailOrgConfig(env, orgId);
    },

    orgConfigSummary(orgId: string) {
      return emailOrgSummary(env, orgId);
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
      const creds = await loadEmailSecrets(env, req.orgId);
      if (!creds) {
        // No transport config for this org: a real misconfiguration, not "user
        // unlinked" — log it and fail non-retryably so escalation falls through to
        // the next channel (mirrors zulip/adapter.ts).
        log.warn('email: no transport config for org', { orgId: req.orgId });
        return { status: 'failed', retryable: false };
      }
      const { subject, text } = renderEmail(req.payload);
      try {
        const r = await sendEmail(creds, email, subject, text);
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
