import { describe, expect, it } from 'vitest';
import {
  diffNewTransitions,
  extractStatusTransitions,
  transitionOwnership,
  type JiraIssue,
} from '../src/jira/changelog';

// A realistic-ish search-with-changelog issue. One history changes assignee +
// status together (we must pick the status item); another changes only status.
const issue: JiraIssue = {
  key: 'ABC-1',
  fields: { summary: 'Build the thing', status: { name: 'Done', statusCategory: { key: 'done' } } },
  changelog: {
    histories: [
      {
        id: '1001',
        created: '2026-06-01T10:00:00.000Z',
        items: [
          { field: 'assignee', from: null, fromString: null, to: 'u1', toString: 'Alice' },
          { field: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' },
        ],
      },
      {
        id: '1002',
        created: '2026-06-02T10:00:00.000Z',
        items: [{ field: 'description', from: null, fromString: null, to: null, toString: 'x' }],
      },
      {
        id: '1003',
        created: '2026-06-03T10:00:00.000Z',
        items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '4', toString: 'Done' }],
      },
    ],
  },
};

describe('extractStatusTransitions', () => {
  it('returns one transition per status-bearing history, ignoring non-status', () => {
    const ts = extractStatusTransitions(issue);
    expect(ts.map((t) => t.changelogId)).toEqual(['1001', '1003']);
    expect(ts[0]).toMatchObject({ fromStatus: 'To Do', toStatus: 'In Progress', issueKey: 'ABC-1' });
    expect(ts[1]).toMatchObject({ fromStatus: 'In Progress', toStatus: 'Done' });
  });

  it('handles an issue with no changelog', () => {
    expect(extractStatusTransitions({ key: 'X-1', fields: {} })).toEqual([]);
  });
});

describe('transitionOwnership — whose transition is it', () => {
  const ME = 'me-acct';
  const REVIEWER = 'rev-acct';

  it('owns a hand-off that reassigns the ticket away (the missed case)', () => {
    // In Progress(me) → Pending Review, same history reassigns me → reviewer;
    // current assignee is now the reviewer.
    const issue: JiraIssue = {
      key: 'ABC-2',
      fields: { status: { name: 'Pending Review' }, assignee: { accountId: REVIEWER } },
      changelog: {
        histories: [
          {
            id: '2001',
            created: '2026-06-01T10:00:00.000Z',
            items: [
              { field: 'assignee', from: ME, fromString: 'Me', to: REVIEWER, toString: 'Rev' },
              { field: 'status', from: '3', fromString: 'In Progress', to: '5', toString: 'Pending Review' },
            ],
          },
        ],
      },
    };
    expect(transitionOwnership(issue, ME).get('2001')).toBe(true);
  });

  it("does not own a reviewer's later move after the hand-off", () => {
    // 2001: me → reviewer hand-off (owned). 2002: reviewer moves it further while
    // it is theirs (not owned). Current assignee = reviewer.
    const issue: JiraIssue = {
      key: 'ABC-3',
      fields: { status: { name: 'In Review' }, assignee: { accountId: REVIEWER } },
      changelog: {
        histories: [
          {
            id: '2001',
            created: '2026-06-01T10:00:00.000Z',
            items: [
              { field: 'assignee', from: ME, fromString: 'Me', to: REVIEWER, toString: 'Rev' },
              { field: 'status', from: '3', fromString: 'In Progress', to: '5', toString: 'Pending Review' },
            ],
          },
          {
            id: '2002',
            created: '2026-06-01T11:00:00.000Z',
            items: [{ field: 'status', from: '5', fromString: 'Pending Review', to: '6', toString: 'In Review' }],
          },
        ],
      },
    };
    const owned = transitionOwnership(issue, ME);
    expect(owned.get('2001')).toBe(true);
    expect(owned.get('2002')).toBe(false);
  });

  it('owns a transition while the ticket stays mine throughout', () => {
    const issue: JiraIssue = {
      key: 'ABC-4',
      fields: { status: { name: 'In Progress' }, assignee: { accountId: ME } },
      changelog: {
        histories: [
          {
            id: '3001',
            created: '2026-06-01T10:00:00.000Z',
            items: [{ field: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }],
          },
        ],
      },
    };
    expect(transitionOwnership(issue, ME).get('3001')).toBe(true);
  });

  it('owns a transition that reassigns the ticket to me', () => {
    // X(reviewer) → Y, reassigned reviewer → me; current assignee = me.
    const issue: JiraIssue = {
      key: 'ABC-5',
      fields: { status: { name: 'In Progress' }, assignee: { accountId: ME } },
      changelog: {
        histories: [
          {
            id: '4001',
            created: '2026-06-01T10:00:00.000Z',
            items: [
              { field: 'assignee', from: REVIEWER, fromString: 'Rev', to: ME, toString: 'Me' },
              { field: 'status', from: '5', fromString: 'Pending Review', to: '3', toString: 'In Progress' },
            ],
          },
        ],
      },
    };
    expect(transitionOwnership(issue, ME).get('4001')).toBe(true);
  });

  it('fails open (owned) when the current assignee is unknown', () => {
    const issue: JiraIssue = {
      key: 'ABC-6',
      fields: { status: { name: 'In Progress' } },
      changelog: {
        histories: [
          {
            id: '5001',
            created: '2026-06-01T10:00:00.000Z',
            items: [{ field: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }],
          },
        ],
      },
    };
    expect(transitionOwnership(issue, ME).get('5001')).toBe(true);
  });
});

describe('diffNewTransitions — idempotency by changelog id', () => {
  it('emits everything when no cursor stored, advancing to the max id', () => {
    const ts = extractStatusTransitions(issue);
    const r = diffNewTransitions(ts, null);
    expect(r.toEmit.map((t) => t.changelogId)).toEqual(['1001', '1003']);
    expect(r.newLastSeen).toBe('1003');
  });

  it('emits nothing on a fully-overlapping re-poll (exactly-once)', () => {
    const ts = extractStatusTransitions(issue);
    const r = diffNewTransitions(ts, '1003');
    expect(r.toEmit).toEqual([]);
    expect(r.newLastSeen).toBe('1003'); // cursor never moves backwards
  });

  it('emits only the unseen tail when window overlaps a prior tick', () => {
    const ts = extractStatusTransitions(issue);
    const r = diffNewTransitions(ts, '1001');
    expect(r.toEmit.map((t) => t.changelogId)).toEqual(['1003']);
    expect(r.newLastSeen).toBe('1003');
  });

  it('emits oldest-first regardless of input order', () => {
    const ts = [...extractStatusTransitions(issue)].reverse();
    const r = diffNewTransitions(ts, null);
    expect(r.toEmit.map((t) => t.changelogId)).toEqual(['1001', '1003']);
  });

  it('compares ids numerically (BigInt-safe past 2^53)', () => {
    // 9007199254740993 != 9007199254740992 only under BigInt comparison.
    const big = [
      { changelogId: '9007199254740993', issueKey: 'X-1', fromStatus: null, toStatus: 'Done', at: 'z' },
    ];
    const r = diffNewTransitions(big, '9007199254740992');
    expect(r.toEmit).toHaveLength(1);
    expect(r.newLastSeen).toBe('9007199254740993');
  });
});
