// Pure changelog parsing + idempotency. No I/O — unit-tested with fixtures
// (worker/test/changelog.test.ts). This is the load-bearing "count each
// transition exactly once" logic, so it lives apart from the network code.

import type { StatusTransition } from '@shared/domain';
import { changelogIdGreater } from '@shared/domain';

// --- Minimal shapes of the Jira search-with-changelog payload ----------------

export interface JiraChangelogItem {
  field: string;
  fieldId?: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface JiraChangelogHistory {
  id: string; // changelog ENTRY id — our idempotency key
  created: string; // ISO
  items: JiraChangelogItem[];
}

export interface JiraIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    /** Current assignee. `accountId` anchors the assignee reconstruction below. */
    assignee?: { accountId?: string } | null;
  };
  changelog?: { histories?: JiraChangelogHistory[] };
}

/**
 * Flatten an issue's changelog into status transitions. One transition per
 * changelog history that contains a `field === "status"` item. (A single
 * history can change several fields; we only care about the status item.)
 */
export function extractStatusTransitions(issue: JiraIssue): StatusTransition[] {
  const histories = issue.changelog?.histories ?? [];
  const out: StatusTransition[] = [];
  for (const h of histories) {
    const statusItem = h.items.find((it) => it.field === 'status');
    if (!statusItem || statusItem.toString === null) continue;
    out.push({
      changelogId: h.id,
      issueKey: issue.key,
      fromStatus: statusItem.fromString,
      toStatus: statusItem.toString,
      at: h.created,
    });
  }
  return out;
}

/**
 * Decide, per status transition, whether it "belongs to" a given user — i.e. the
 * user was the assignee immediately BEFORE or immediately AFTER the transition.
 * Returns a map keyed by changelog id; a status-bearing history with `false`
 * means a transition the user neither performed nor received (e.g. a reviewer
 * moving the ticket along after it was handed off).
 *
 * The poll's JQL is broadened to also surface tickets recently assigned to the
 * user (`assignee WAS currentUser()`), which can drag in such reviewer-owned
 * transitions; this gate filters them back out so we only notify on / attribute
 * transitions that are actually the user's.
 *
 * Assignee state is reconstructed by anchoring on the issue's CURRENT assignee
 * (`fields.assignee.accountId`) and walking the changelog newest→oldest,
 * reversing each `assignee` item (`item.from` is the prior accountId). Anchoring
 * on a known-current value keeps this correct even if Jira truncated the
 * changelog to recent entries.
 *
 * Fail open: if the current assignee is unknown, every transition is reported as
 * owned — better to over-notify than silently drop (mirrors isStaleTransition).
 */
export function transitionOwnership(
  issue: JiraIssue,
  userAccountId: string,
): Map<string, boolean> {
  const owned = new Map<string, boolean>();
  const histories = [...(issue.changelog?.histories ?? [])].sort((a, b) =>
    changelogIdGreater(a.id, b.id) ? -1 : 1,
  );

  const currentAssignee = issue.fields.assignee?.accountId;
  if (currentAssignee === undefined) {
    // Indeterminate anchor — fail open: treat all transitions as the user's.
    for (const h of histories) {
      if (h.items.some((it) => it.field === 'status')) owned.set(h.id, true);
    }
    return owned;
  }

  // `after` = assignee state immediately after the history currently in hand.
  let after: string | null = currentAssignee;
  for (const h of histories) {
    const assigneeItem = h.items.find((it) => it.field === 'assignee');
    const before: string | null = assigneeItem ? assigneeItem.from : after;
    if (h.items.some((it) => it.field === 'status')) {
      owned.set(h.id, after === userAccountId || before === userAccountId);
    }
    after = before; // step further back: this history's "before" is the next one's "after"
  }
  return owned;
}

export interface DiffResult {
  /** Transitions strictly newer than lastSeenChangelogId, oldest-first. */
  toEmit: StatusTransition[];
  /**
   * The changelog id to persist as the new cursor: the max id seen in this
   * batch, or the existing cursor if the batch was empty / all old. Never moves
   * backwards.
   */
  newLastSeen: string | null;
}

/**
 * Idempotency by changelog id, NOT by time window. Given all transitions for an
 * issue (from a possibly-overlapping query window) and the stored cursor, return
 * only the unseen ones and the advanced cursor.
 */
export function diffNewTransitions(
  transitions: readonly StatusTransition[],
  lastSeenChangelogId: string | null,
): DiffResult {
  let newLastSeen = lastSeenChangelogId;
  const fresh: StatusTransition[] = [];
  for (const t of transitions) {
    if (changelogIdGreater(t.changelogId, lastSeenChangelogId)) fresh.push(t);
    // Advance cursor past the highest id we've *observed*, even ones we already
    // emitted in a prior tick, so overlapping windows can't re-emit them.
    if (changelogIdGreater(t.changelogId, newLastSeen)) newLastSeen = t.changelogId;
  }
  fresh.sort((a, b) => (changelogIdGreater(a.changelogId, b.changelogId) ? 1 : -1));
  return { toEmit: fresh, newLastSeen };
}
