// The Zulip NotifierAdapter. This is the factory the registry wires up; it composes
// the store (adapter-owned zulip_* tables via env.DB), deliver (form-urlencoded REST
// send), and render (the only vendor-string site) into the app-facing contract.
//
// Boundary note: this module imports only env, contract, and its own siblings —
// never dao/registry/routes/cron (the eslint wall). All persistence goes through
// store.ts; the app never learns a zulip_user_id.

import type { SetupInstructions, LinkStatus, NotifierDescriptor } from '@shared/notifications';
import type { Env } from '../../../env';
import type {
  DeliverRequest,
  DeliverResult,
  InboundContext,
  NotifierAdapter,
} from '../../contract';
import { sendZulipDM } from './deliver';
import { renderZulip } from './render';
import { getLink, mintCode, deleteLink } from './store';
import { handleZulipInbound } from './webhook';

/** Link-code TTL: ~15 min, matching the settings-panel copy in the design doc. */
const CODE_TTL_MS = 15 * 60 * 1000;

export function makeZulipAdapter(env: Env): NotifierAdapter {
  return {
    async describe(): Promise<NotifierDescriptor> {
      return { channel: 'zulip', displayName: 'Zulip' };
    },

    // Ready only when the channel is fully usable end-to-end: the three send secrets
    // (site, bot email, api key) AND the webhook token the inbound `/link` flow
    // verifies — without any of them linking or delivery can't work, so the app
    // hides Zulip.
    isConfigured(): boolean {
      return Boolean(
        env.ZULIP_SITE && env.ZULIP_BOT_EMAIL && env.ZULIP_API_KEY && env.ZULIP_WEBHOOK_TOKEN,
      );
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
      try {
        const r = await sendZulipDM(env, link.zulipUserId, renderZulip(req.payload));
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
