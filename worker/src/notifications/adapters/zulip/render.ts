// The ONE sanctioned place a Zulip-shaped string is composed. The rest of the
// worker (dao, cron/escalate, routes, index) only ever produces the channel-neutral
// NotificationPayload; this module turns that into vendor content. Keeping every
// vendor string behind this single function is what makes "the app composes no
// vendor string" checkable.

import type { NotificationPayload } from '../../contract';

/** Compose the Zulip DM body from a channel-neutral payload. Plain text plus the
 *  deep link — no vendor markdown tricks, so the mapping stays trivially auditable. */
export function renderZulip(payload: NotificationPayload): string {
  return `**${payload.title}**\n\n${payload.body}\n\n${payload.deepLink}`;
}
