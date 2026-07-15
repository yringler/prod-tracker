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
}

/** Link state for a user+channel; `label` is an opaque display string. */
export type LinkStatus =
  | { linked: false }
  | { linked: true; label: string };

// ---- Wire shapes (client <-> worker /api/notifications/*) ----

export interface ChannelListItem {
  descriptor: NotifierDescriptor;
  status: LinkStatus;
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
