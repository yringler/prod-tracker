// The app<->adapter indirection. App dispatch code depends ONLY on this module,
// never on a concrete adapter, so later extraction to a separate Worker (or
// adding Slack/email) is a one-file change here.
//
// This is a STUB: the registry is empty until the feature agent (feature-plan §3)
// registers concrete adapters, e.g. REGISTRY.zulip = (env) => makeZulipAdapter(env).
// Kept minimal + type-clean so `npm run typecheck` passes now.

import type { Env } from '../env';
import type { NotifierAdapter } from './contract';

/**
 * Structural guard: a stale `channel` row (e.g. an adapter that was removed)
 * degrades to a logged skip rather than a `TypeError`. Config-drift signal.
 */
export function isNotifier(x: unknown): x is NotifierAdapter {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { deliver?: unknown }).deliver === 'function'
  );
}

/**
 * Per-channel adapter factories. Built lazily from `env` so secrets never live at
 * module scope. Empty in this scaffold; the feature agent adds entries.
 */
const REGISTRY: Record<string, (env: Env) => NotifierAdapter> = {};

export function resolve(env: Env, channel: string): NotifierAdapter | null {
  const make = REGISTRY[channel];
  if (!make) return null;
  const adapter = make(env);
  return isNotifier(adapter) ? adapter : null;
}

export function availableChannels(): string[] {
  return Object.keys(REGISTRY);
}
