// The server-only "one JIRA = one rateable unit" policy, tested pure (no I/O).
// Covers the read transform (groupPendingByIssue) and the push-dedup decision
// (selectPushTransition) — the subtle new code that had no unit test pre-refactor.
import { describe, expect, it } from 'vitest';
import type { StatusTransition } from '@shared/domain';
import type { PendingRow } from '../src/db/dao';
import { groupPendingByIssue, selectPushTransition } from '../src/pending';

// A fixed clock so staleness is deterministic (the function takes `now`), rather
// than anchoring to the real clock as the DB-backed ratings test must.
const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const before = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

const row = (
  pendingId: string,
  issueKey: string,
  toStatus: string,
  transitionedAt: string,
): PendingRow => ({
  pendingId,
  cloudId: 'c1',
  accountId: 'u1',
  issueKey,
  title: `${issueKey} title`,
  url: `https://example.atlassian.net/browse/${issueKey}`,
  storyPoints: 5,
  toStatus,
  changelogId: pendingId,
  transitionedAt,
});

describe('groupPendingByIssue', () => {
  it('bundles an issue oldest-first with the latest as representative, across issues', () => {
    // Newest-first, as getPendingForOwner returns (ORDER BY transitioned_at DESC).
    const rows = [
      row('p3', 'X-1', 'Done', before(10)),
      row('p2', 'X-1', 'In Review', before(20)),
      row('p1', 'X-1', 'In Progress', before(30)),
      row('p4', 'X-2', 'In Progress', before(15)),
    ];

    const items = groupPendingByIssue(rows, NOW);

    expect(items).toHaveLength(2);
    const x1 = items.find((i) => i.issueKey === 'X-1')!;
    // Oldest-first inside the bundle.
    expect(x1.transitions.map((t) => t.toStatus)).toEqual(['In Progress', 'In Review', 'Done']);
    // Representative = latest transition (id/points/time all come from it).
    expect(x1.pendingId).toBe('p3');
    expect(x1.storyPoints).toBe(5);
    expect(x1.transitionedAt).toBe(x1.transitions.at(-1)!.transitionedAt);
    // The other issue is its own single-transition item.
    expect(items.find((i) => i.issueKey === 'X-2')!.transitions).toHaveLength(1);
  });

  it('drops stale transitions before grouping', () => {
    const rows = [
      row('new', 'X-1', 'Done', before(5)),
      row('old', 'X-1', 'In Progress', before(60 * 48)), // 2 days old
    ];

    const items = groupPendingByIssue(rows, NOW);

    expect(items).toHaveLength(1);
    expect(items[0]!.transitions.map((t) => t.toStatus)).toEqual(['Done']);
  });

  it('omits an issue entirely when every transition is stale', () => {
    const rows = [
      row('s1', 'X-9', 'Done', before(60 * 30)),
      row('s2', 'X-9', 'In Progress', before(60 * 40)),
    ];
    expect(groupPendingByIssue(rows, NOW)).toEqual([]);
  });
});

describe('selectPushTransition', () => {
  const tr = (changelogId: string, toStatus: string): StatusTransition => ({
    changelogId,
    issueKey: 'X-1',
    fromStatus: null,
    toStatus,
    at: before(10),
  });

  it('stays silent when the issue already had a live pending', () => {
    const fresh = [tr('1001', 'In Progress'), tr('1002', 'Done')];
    expect(selectPushTransition(fresh, true)).toBeNull();
  });

  it('picks the first (oldest) fresh-owned transition when none was live', () => {
    const fresh = [tr('1001', 'In Progress'), tr('1002', 'Done')];
    expect(selectPushTransition(fresh, false)?.changelogId).toBe('1001');
  });

  it('returns null when the fresh-owned set is empty', () => {
    expect(selectPushTransition([], false)).toBeNull();
  });
});
