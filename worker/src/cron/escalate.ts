// Escalation cron. A pending_ratings row that survives past ESCALATION_DELAY_MS
// means the user never acted on the push, so we re-deliver the SAME prompt through
// their other linked channels. The app composes only a channel-neutral
// NotificationPayload and reaches channels ONLY via the registry seam — it never
// touches an adapter directly and never builds a vendor-shaped string.

import { escalationWindow, mayRemind } from '@shared/domain';
import { UTCDate } from '@date-fns/utc';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import type { NotificationPayload } from '../notifications/contract';
import { resolve } from '../notifications/registry';
import { selectEscalations } from '../pending';
import { log as rootLog, errFields, type Logger } from '../log';

export async function escalate(
  env: Env,
  dao: Dao,
  log: Logger = rootLog,
  nowMs: number = Date.now(),
): Promise<void> {
  const { dueBeforeIso, notBeforeIso } = escalationWindow(nowMs);
  const due = await dao.pendingDueForEscalation(dueBeforeIso, notBeforeIso);
  if (due.length === 0) return;

  const toDeliver = selectEscalations(due);
  const atIso = new UTCDate(nowMs).toISOString();
  for (const p of toDeliver) {
    // Reminder dedup + serialization: skip if not eligible (no new transition or
    // still in cooldown), then claim-before-send so one concurrent tick wins.
    const last = await dao.getLastReminder(p.cloudId, p.accountId, p.issueKey);
    if (!mayRemind(p.changelogId, last, nowMs)) continue;
    // Read channels BEFORE claiming: if this read throws, no claim row is written,
    // so markEscalated is skipped (below) and the pending re-selects next tick with
    // mayRemind true (last===null) → a clean retry instead of a permanent silent
    // no-op. The claim must stay immediately before the deliver loop as the
    // serialization point, so it goes after this read.
    const channels = await dao.getUserChannels(p.accountId);
    const won = await dao.claimReminder(
      p.cloudId,
      p.accountId,
      p.issueKey,
      p.changelogId,
      last?.atIso ?? null,
      atIso,
    );
    if (!won) continue;
    // Channel-neutral payload — deepLink is just a URL back into our own app.
    const payload: NotificationPayload = {
      title: 'A ticket is waiting for your effort rating',
      body: `${p.issueKey} — ${p.title}`,
      deepLink: `${env.APP_ORIGIN}/tracker?pending=${encodeURIComponent(p.pendingId)}`,
      urgency: 'normal',
    };
    for (const { channel } of channels) {
      const adapter = resolve(env, channel);
      if (!adapter) {
        log.warn('escalate: unknown channel (config drift)', { channel });
        continue;
      }
      try {
        const r = await adapter.deliver({
          userId: p.accountId,
          payload,
          // Dedup now lives in the caller CAS (claimReminder); this key is only a
          // best-effort adapter-side hint. For a collapsed flurry it is the earliest
          // sibling's pendingId, while the reminder itself is keyed on the max
          // changelog id.
          idempotencyKey: p.pendingId,
        });
        if (r.status === 'delivered') break; // stop at the first success
        if (r.status === 'not_linked') continue; // fall through to the next channel
        log.warn('escalate: delivery failed', { channel, retryable: r.retryable });
      } catch (e) {
        log.warn('escalate: adapter threw', { channel, ...errFields(e) });
      }
    }
  }

  // Mark the FULL due set (the collapsed siblings too), regardless of outcome: the
  // escalation window is time-bound, so a user with no channels (or a transient
  // failure) isn't retried forever, and un-delivered siblings don't re-escalate.
  //
  // Window-closer semantics: a transition arriving DURING the cooldown is
  // escalated_at-closed the same tick (it's in the due set) and will only trigger a
  // further reminder if a strictly-newer transition arrives AFTER the cooldown. This
  // is deliberate — one issue-level nudge per cooldown window, anti-spam — not a
  // delayed re-send of the suppressed transition. See DEFERRED.md (flagged for human
  // confirmation against the literal transitioned-AND-10min rule).
  await dao.markEscalated(due.map((p) => p.pendingId), atIso);
  log.info('escalate: done', { due: due.length, delivered: toDeliver.length });
}
