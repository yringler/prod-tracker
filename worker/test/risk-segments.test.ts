// buildSegments: per-column totals (adjacent-merge + visit counts), Done visits
// kept as stubs, assignee segments clipped at first-In-Progress, and the cycle
// total. 24/7 clock so hours read as wall-clock hours.
import { describe, expect, it } from 'vitest';
import type { RiskWorkSchedule } from '@shared/risk';
import { makeWorkClock } from '../src/risk/logic/workhours';
import { buildSegments, type SegmentInput } from '../src/risk/logic/segments';
import type { StatusChange } from '../src/risk/logic/timers';

const ALWAYS_OPEN: RiskWorkSchedule = {
  timeZone: 'UTC',
  days: {
    Mon: [0, 24],
    Tue: [0, 24],
    Wed: [0, 24],
    Thu: [0, 24],
    Fri: [0, 24],
    Sat: [0, 24],
    Sun: [0, 24],
  },
};
const { workMs, workMsWithin } = makeWorkClock(ALWAYS_OPEN);

const BASE = Date.parse('2026-03-02T00:00:00Z');
const at = (h: number): string => new Date(BASE + h * 3.6e6).toISOString();
const ms = (h: number): number => BASE + h * 3.6e6;

// Two statuses ('2', '21') share the In Progress column — the merge case.
const MAPS = {
  statusToColumn: {
    '1': 'To Do',
    '2': 'In Progress',
    '21': 'In Progress',
    '3': 'Code Review',
    '9': 'Done',
  },
  doneStatusIds: new Set(['9']),
  doneColumnStatusIds: new Set(['9']),
};

const move = (h: number, from: [string, string], to: [string, string]): StatusChange => ({
  at: at(h),
  fromId: from[0],
  fromName: from[1],
  toId: to[0],
  toName: to[1],
});
const TODO: [string, string] = ['1', 'To Do'];
const IP: [string, string] = ['2', 'In Progress'];
const IP2: [string, string] = ['21', 'In Dev Review'];
const CR: [string, string] = ['3', 'Code Review'];
const DONE: [string, string] = ['9', 'Done'];

function input(over: Partial<SegmentInput> = {}): SegmentInput {
  return {
    ...MAPS,
    created: at(0),
    statusChanges: [
      move(10, TODO, IP),
      move(30, IP, IP2),
      move(40, IP2, CR),
      move(60, CR, IP),
      move(80, IP, DONE),
    ],
    assigneeChanges: [{ at: at(20), from: 'Ann', to: 'Bob' }],
    currentStatusId: '9',
    currentStatusName: 'Done',
    currentAssignee: 'Bob',
    inProgressStatus: 'In Progress',
    nowMs: ms(100),
    ...over,
  };
}

describe('buildSegments', () => {
  it('merges adjacent same-column visits and counts revisits', () => {
    const { columnTotals } = buildSegments(input(), workMs, workMsWithin);
    expect(columnTotals).toEqual([
      // 10->40 (two statuses, one column) plus 60->80 = 50h over 2 visits.
      { column: 'In Progress', hours: 50, visits: 2 },
      { column: 'Code Review', hours: 20, visits: 1 },
      { column: 'Done', hours: 20, visits: 1 },
    ]);
  });

  it('keeps the Done visit as a zero-cycle stub', () => {
    const { flow } = buildSegments(input(), workMs, workMsWithin);
    expect(flow.columnSegs.map((s) => [s.column, s.doneCat, s.hours])).toEqual([
      ['In Progress', false, 30],
      ['Code Review', false, 20],
      ['In Progress', false, 20],
      ['Done', true, 0], // kept, but contributes nothing to the cycle clock
    ]);
    expect(flow.startedAt).toBe(at(10));
    expect(flow.totalHours).toBe(70); // 10 -> 100 minus the 20h in Done
  });

  it('clips assignee segments at first-In-Progress', () => {
    const { flow } = buildSegments(input(), workMs, workMsWithin);
    expect(flow.assigneeSegs).toEqual([
      { assignee: 'Ann', fromMs: ms(10), toMs: ms(20), hours: 10 }, // not from creation
      { assignee: 'Bob', fromMs: ms(20), toMs: ms(100), hours: 60 }, // Done excluded
    ]);
  });

  it('returns an empty timeline for a ticket that never started', () => {
    const { columnTotals, flow } = buildSegments(
      input({ statusChanges: [], currentStatusId: '1', currentStatusName: 'To Do' }),
      workMs,
      workMsWithin,
    );
    expect(columnTotals).toEqual([]);
    expect(flow).toEqual({
      createdAt: at(0),
      startedAt: null,
      columnSegs: [],
      assigneeSegs: [],
      totalHours: 0,
    });
  });
});
