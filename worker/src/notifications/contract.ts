// Worker-internal notification contract. These types describe DELIVERY and the
// adapter interface — they are server-only and are deliberately NOT in shared/
// (that would needlessly widen the isomorphic surface).
//
// INVARIANT: the app worker never composes a vendor-shaped string. It hands the
// adapter a channel-neutral NotificationPayload; the adapter (and only the
// adapter) renders vendor content. `describe()` and `beginSetup()` stay split:
// describe() is static/cacheable, beginSetup() mints live time-boxed state.

import type {
  LinkStatus,
  NotifierDescriptor,
  SetupInstructions,
  SetupSubmission,
} from '@shared/notifications';

export interface NotificationPayload {
  title: string;
  body: string;
  deepLink: string;
  urgency: 'normal' | 'high';
  // channel-neutral. NO vendor markdown, NO vendor formatting.
}

export interface DeliverRequest {
  userId: string;
  /** Which org's PROVISIONING to deliver under. Every call site already knows it
   *  (the cron has p.cloudId, the routes ctx.cloudId, risk cfg.cloudId), so the
   *  adapter is handed the org instead of reverse-engineering it from a link row
   *  or from env. Adapters may still fall back to a link's own org. */
  orgId: string;
  payload: NotificationPayload;
  idempotencyKey: string;
}

export type DeliverResult =
  | { status: 'delivered' }
  | { status: 'not_linked' } // fall through to the next channel
  | { status: 'failed'; retryable: boolean };

/** Outcome of persisting admin-entered org config. `error` is a human-readable
 *  message the admin UI shows verbatim (vendor rejection, missing field, …). */
export type ConfigureOrgResult = { ok: true } | { ok: false; error: string };

/** Neutral callback the app hands an adapter's inbound handler so a successful link
 *  registers the channel app-side. The adapter passes its OWN channel name and an
 *  opaque label; it never imports dao/registry (the eslint wall) and never learns
 *  the app's storage shape. */
export interface InboundContext {
  registerChannel(userId: string, channel: string, label: string): Promise<void>;
}

export interface NotifierAdapter {
  describe(): Promise<NotifierDescriptor>;
  /** Optional: whether this channel can deliver FOR THIS ORG. Env-based adapters
   *  (email) may ignore `orgId` and answer synchronously; DB-config adapters
   *  (zulip) look up the org's row and return a Promise. Absent → treated as
   *  always-configured (back-compat). The app skips channels that report false,
   *  so a channel that cannot deliver is never advertised. */
  isConfigured?(orgId: string): boolean | Promise<boolean>;
  /** Optional: validate + persist admin-entered per-org config (the values named
   *  by the descriptor's `requestedFields`). The adapter live-verifies against its
   *  vendor before storing and returns a human-readable error on failure. Secrets
   *  are write-only: nothing stored here ever flows back to a client. */
  configureOrg?(
    orgId: string,
    fields: Record<string, string>,
    configuredBy: string,
  ): Promise<ConfigureOrgResult>;
  /** Optional: remove this org's provisioning (the admin turning the channel off
   *  site-wide). Adapters that take no per-org config omit it. */
  unconfigureOrg?(orgId: string): Promise<void>;
  /** Optional: NON-SECRET metadata about this org's stored config, for the admin
   *  list. `summary` is an explicit allow-list the adapter declares — a secret must
   *  never be put in it. Null when the org has no config. */
  orgConfigSummary?(orgId: string): Promise<{
    configuredAt: string;
    configuredBy: string | null;
    summary: Record<string, string>;
  } | null>;
  beginSetup(userId: string): Promise<SetupInstructions>;
  getStatus(userId: string): Promise<LinkStatus>;
  deliver(req: DeliverRequest): Promise<DeliverResult>;
  unlink(userId: string): Promise<void>;
  /** Optional: complete a setup whose flow gathers input in-app (an `input` step)
   *  rather than out-of-band (a webhook). The generic /complete route forwards the
   *  submitted fields; the adapter validates + persists and returns the new status.
   *  Adapters whose linking is fully out-of-band (Zulip's webhook) omit this. */
  submitSetup?(userId: string, submission: SetupSubmission): Promise<LinkStatus>;
  /** Optional: handle a public inbound webhook (e.g. a Zulip outgoing-webhook). The
   *  app resolves the adapter by channel and calls this ABOVE the auth gate; the
   *  adapter verifies its own shared secret and returns the Response. */
  handleInbound?(req: Request, ctx: InboundContext): Promise<Response>;
}
