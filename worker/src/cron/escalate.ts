// Escalation cron. A pending_ratings row that survives past ESCALATION_DELAY_MS
// means the user never acted on the push, so we re-deliver the SAME prompt through
// their other linked channels. The app composes only a channel-neutral
// NotificationPayload and reaches channels ONLY via the registry seam — it never
// touches an adapter directly and never builds a vendor-shaped string.

import { escalationWindow } from '@shared/domain';
import { UTCDate } from '@date-fns/utc';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import type { NotificationPayload } from '../notifications/contract';
import { resolve } from '../notifications/registry';
import { log as rootLog, errFields, type Logger } from '../log';

export async function escalate(env: Env, dao: Dao, log: Logger = rootLog): Promise<void> {
  const nowMs = Date.now();
  const { dueBeforeIso, notBeforeIso } = escalationWindow(nowMs);
  const due = await dao.pendingDueForEscalation(dueBeforeIso, notBeforeIso);
  if (due.length === 0) return;

  const escalated: string[] = [];
  for (const p of due) {
    const channels = await dao.getUserChannels(p.accountId);
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
          idempotencyKey: p.pendingId,
        });
        if (r.status === 'delivered') break; // stop at the first success
        if (r.status === 'not_linked') continue; // fall through to the next channel
        log.warn('escalate: delivery failed', { channel, retryable: r.retryable });
      } catch (e) {
        log.warn('escalate: adapter threw', { channel, ...errFields(e) });
      }
    }
    // Mark once regardless of outcome: the escalation window is time-bound, so a
    // user with no channels (or a transient failure) isn't retried forever.
    escalated.push(p.pendingId);
  }

  await dao.markEscalated(escalated, new UTCDate(nowMs).toISOString());
  log.info('escalate: done', { due: due.length, marked: escalated.length });
}
