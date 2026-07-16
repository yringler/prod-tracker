// The Zulip NotifierAdapter. This is the factory the registry wires up; it composes
// the store (adapter-owned zulip_* tables via env.DB), deliver (form-urlencoded REST
// send), and render (the only vendor-string site) into the app-facing contract.
//
// Boundary note: this module imports only env, contract, and its own siblings —
// never dao/registry/routes/cron (the eslint wall). All persistence goes through
// store.ts; the app never learns a zulip_user_id.

import type { SetupInstructions, LinkStatus, NotifierDescriptor } from '@shared/notifications';
import type { Env } from '../../../env';
import { log } from '../../../log';
import type {
  ConfigureOrgResult,
  DeliverRequest,
  DeliverResult,
  InboundContext,
  NotifierAdapter,
} from '../../contract';
import { sendZulipDM } from './deliver';
import { configureZulipOrg, loadOrgSecrets, ZULIP_REQUESTED_FIELDS } from './org-config';
import { renderZulip } from './render';
import { getLink, hasOrgConfig, mintCode, deleteLink } from './store';
import { handleZulipInbound } from './webhook';

/** Link-code TTL: ~15 min, matching the settings-panel copy in the design doc. */
const CODE_TTL_MS = 15 * 60 * 1000;

export function makeZulipAdapter(env: Env): NotifierAdapter {
  return {
    async describe(): Promise<NotifierDescriptor> {
      return { channel: 'zulip', displayName: 'Zulip', requestedFields: ZULIP_REQUESTED_FIELDS };
    },

    // Ready only when THIS org has admin-entered config (site/botEmail/apiKey +
    // webhook token, stored encrypted in zulip_org_config) — configureZulipOrg
    // requires all four, so a row existing means the channel is usable end-to-end.
    isConfigured(orgId: string): Promise<boolean> {
      return hasOrgConfig(env, orgId);
    },

    // Admin-entered org config: validate + live-verify + encrypt + persist.
    configureOrg(
      orgId: string,
      fields: Record<string, string>,
      configuredBy: string,
    ): Promise<ConfigureOrgResult> {
      return configureZulipOrg(env, orgId, fields, configuredBy);
    },

    async beginSetup(userId: string): Promise<SetupInstructions> {
      const code = await mintCode(env, userId, CODE_TTL_MS);
      // Compute the same TTL the store persisted so the UI can show an expiry hint.
      const expiresAt = Date.now() + CODE_TTL_MS;
      return {
        steps: [
          {
            kind: 'text',
            body: 'Send a direct message to the notify bot on Zulip with this command:',
          },
          { kind: 'copyable', label: 'Command', value: `/link ${code}`, expiresAt },
        ],
        completion: 'poll',
      };
    },

    async getStatus(userId: string): Promise<LinkStatus> {
      const link = await getLink(env, userId);
      if (!link) return { linked: false };
      return { linked: true, label: link.fullName ?? 'Zulip' };
    },

    async deliver(req: DeliverRequest): Promise<DeliverResult> {
      const link = await getLink(env, req.userId);
      if (!link) return { status: 'not_linked' };
      const creds = await loadOrgSecrets(env, link.cloudId);
      if (!creds) {
        // No config for the link's org (or a NULL-org link with 0/2+ configs): a
        // real misconfiguration, not "user unlinked" — log it and fail
        // non-retryably so escalation falls through to the next channel.
        log.warn('zulip: no org config for link', { hasCloudId: link.cloudId != null });
        return { status: 'failed', retryable: false };
      }
      try {
        const r = await sendZulipDM(creds, link.zulipUserId, renderZulip(req.payload));
        if (r.ok) return { status: 'delivered' };
        return { status: 'failed', retryable: r.retryable };
      } catch {
        // Network/transport throw — treat as transient so escalation can retry later.
        return { status: 'failed', retryable: true };
      }
    },

    async unlink(userId: string): Promise<void> {
      await deleteLink(env, userId);
    },

    handleInbound(req: Request, ctx: InboundContext): Promise<Response> {
      return handleZulipInbound(env, req, ctx);
    },
  };
}
