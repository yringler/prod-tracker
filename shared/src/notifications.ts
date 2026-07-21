// Isomorphic, UI-facing notification contract types. Imported by BOTH the worker
// (adapter/dispatch code) and the Angular client (settings UI), so this file must
// stay pure/framework-free like the rest of shared/ (eslint-enforced).
//
// INVARIANT: this vocabulary is generic; it mentions NO vendor. There is
// deliberately NO `{ kind: 'html' }` step (it would hand an adapter an XSS vector
// into our DOM). Adapters whose flow doesn't fit use `embed`.
//
// Feature agent (feature-plan §1) fills in behavior/handlers around these; the
// SHAPES below are the contract and are intentionally complete so both later
// phases compile against a stable seam.

/** A channel is a runtime string; the enum lives in the DB, not the type system. */
export type Channel = string;

/** The generic setup-step vocabulary the client renders with an exhaustive switch. */
export type SetupStep =
  | { kind: 'text'; body: string }
  | { kind: 'copyable'; label: string; value: string; expiresAt?: number }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'input'; label: string; name: string; inputType: 'tel' | 'email' | 'text' }
  | { kind: 'embed'; src: string; height: number };

/** How the UI learns the link succeeded. */
export interface SetupInstructions {
  steps: SetupStep[];
  completion: 'poll' | 'push';
}

/** Static, cacheable channel identity (no user context). */
export interface NotifierDescriptor {
  channel: string; // e.g. "zulip"
  displayName: string; // e.g. "Zulip"
  iconUrl?: string; // exactOptionalPropertyTypes: omit the key, never set undefined
  /** Org-level config field names an admin supplies (write-only; stored values are
   *  never echoed back to any client). The admin UI renders one plain text input
   *  per name — no client-side validation, no vendor knowledge. Absent → the
   *  channel has no per-org config. */
  requestedFields?: string[];
  /** Beyond the on/off toggle, does this channel need ONE thing from the user (an
   *  address, a handle) before it can deliver? Drives the settings UI's choice
   *  between a plain switch and switch-plus-setup. Provisioning is the admin's;
   *  this is identity only. */
  requiresUserIdentity?: boolean;
  /** Short, human, vendor-neutral name for that one thing ("an email address",
   *  "your Zulip account") so the CLIENT stays free of vendor knowledge. */
  identityPrompt?: string;
}

/** Link state for a user+channel; `label` is an opaque display string. */
export type LinkStatus =
  | { linked: false }
  | { linked: true; label: string };

// ---- Wire shapes (client <-> worker /api/notifications/*) ----

export interface ChannelListItem {
  descriptor: NotifierDescriptor;
  /** Whether the user has an IDENTITY on this channel (an address/handle). */
  status: LinkStatus;
  /** Whether the user has OPTED IN. Orthogonal to `status`: you can be off while
   *  still linked (muted, address remembered) or on while not yet linked (the
   *  settings UI then opens the identity prompt). */
  enabled: boolean;
}
export interface ChannelListResponse {
  channels: ChannelListItem[];
}
export type BeginSetupResponse = SetupInstructions;

/** Values collected from an in-app setup flow's `input` steps, keyed by step `name`.
 *  Posted back to the generic /complete route for adapters that gather input in-app
 *  (e.g. email) rather than out-of-band (e.g. Zulip's webhook). */
export interface SetupSubmission {
  fields: Record<string, string>;
}

/** PUT /api/notifications/:channel/enabled — the per-user opt-in toggle. */
export interface SetChannelEnabledRequest {
  enabled: boolean;
}
/** The reply carries the identity status too, so one round-trip tells the client
 *  whether turning the channel ON still needs an identity prompt. */
export interface SetChannelEnabledResponse {
  enabled: boolean;
  status: LinkStatus;
}

// ---- Wire shapes (client <-> worker /api/admin/notifications/*) ----

/** One channel's per-org config surface, for the admin UI. `configured` is for the
 *  ADMIN'S org only; stored secret values are write-only and never returned. */
export interface AdminChannelConfigItem {
  descriptor: NotifierDescriptor;
  configured: boolean;
  /** ISO UTC of the last successful configure (audit echo). */
  configuredAt?: string;
  /** Admin account id that configured it (audit echo). */
  configuredBy?: string;
  /** Non-secret echo of the stored config, e.g. `{ site: 'https://org.zulipchat.com' }`
   *  or `{ fromAddress: 'notify@org.com' }`. OPT-IN PER ADAPTER: an adapter must
   *  explicitly declare a value public to put it here. The write-only invariant is
   *  unchanged for everything else — secrets never appear in this map. */
  summary?: Record<string, string>;
}
export interface AdminChannelConfigResponse {
  channels: AdminChannelConfigItem[];
}
/** Admin-entered values keyed by the descriptor's `requestedFields` names. */
export interface ConfigureChannelRequest {
  fields: Record<string, string>;
}
