// The "one JIRA = one rateable unit" policy, extracted pure so it can be
// fixture-tested (worker/test/pending.test.ts) — the same reason changelog.ts
// lives apart from the network code. The rule is server-only (poller writes,
// getPending reads, submitRating clears — all in the worker; the client only
// renders pre-grouped data), so it lives in the worker, not shared. This module
// owns the two pure halves of the rule: the read transform and the push-dedup
// decision. Freshness lives here too, once (the read path's single owner).

import type { PendingRating } from '@shared/contracts';
import type { StatusTransition } from '@shared/domain';
import { changelogIdGreater, isStaleTransition } from '@shared/domain';
import type { EscalationCandidate, PendingRow } from './db/dao';

/**
 * Group an owner's pending rows into one rateable item per issue — a flurry of
 * moves is rated once, not once per move. Stale transitions are dropped first
 * (freshness lives here, once). Rows arrive newest-first (getPendingForOwner
 * ORDER BY transitioned_at DESC), so the first row seen per issue is the latest —
 * the representative for id/points/title/url and the time the eventual claim
 * buckets on. Each issue's transitions are listed oldest-first.
 */
export function groupPendingByIssue(rows: PendingRow[], now: number = Date.now()): PendingRating[] {
  const byIssue = new Map<string, PendingRating>();
  for (const p of rows) {
    if (isStaleTransition(p.transitionedAt, now)) continue;
    const existing = byIssue.get(p.issueKey);
    if (existing) {
      existing.transitions.unshift({ toStatus: p.toStatus, transitionedAt: p.transitionedAt });
    } else {
      byIssue.set(p.issueKey, {
        pendingId: p.pendingId,
        issueKey: p.issueKey,
        title: p.title,
        url: p.url,
        storyPoints: p.storyPoints,
        transitions: [{ toStatus: p.toStatus, transitionedAt: p.transitionedAt }],
        transitionedAt: p.transitionedAt,
      });
    }
  }
  return [...byIssue.values()];
}

/**
 * Pick the single transition to push for, or `null` for silence — one push per
 * issue per flurry. Silent if the issue already had a live pending before this
 * poll (`hadLivePendingBefore`); else the first (oldest) fresh-owned transition;
 * else `null` when that set is empty. `freshOwned` is the poller's already-owned,
 * already-fresh set, ascending by changelog id, so its first element is oldest.
 */
export function selectPushTransition(
  freshOwned: StatusTransition[],
  hadLivePendingBefore: boolean,
): StatusTransition | null {
  if (hadLivePendingBefore) return null;
  return freshOwned[0] ?? null;
}

/**
 * Collapse ripe escalation rows to one per (cloud, account, issue) — a flurry
 * escalates once, not once per move (the escalate-path twin of groupPendingByIssue).
 * Rows arrive oldest-first (pendingDueForEscalation ORDER BY created_at), so the
 * first seen per key is the earliest and stays the representative for the deep
 * link — but the representative carries the MAX changelog id across the collapsed
 * group, so the reminder-dedup (mayRemind) keys on the newest transition of the
 * flurry, not the oldest. Callers must still markEscalated the FULL input set (the
 * collapsed siblings), or the un-delivered rows re-escalate next tick.
 */
export function selectEscalations(due: EscalationCandidate[]): EscalationCandidate[] {
  const byKey = new Map<string, EscalationCandidate>();
  for (const p of due) {
    const key = `${p.cloudId} ${p.accountId} ${p.issueKey}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...p });
    } else if (changelogIdGreater(p.changelogId, existing.changelogId)) {
      existing.changelogId = p.changelogId;
    }
  }
  return [...byKey.values()];
}
