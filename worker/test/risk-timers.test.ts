// reduceTimers: the Done-is-a-pause rule, the not-started nulls, and the idle
// anchor (status OR assignee movement). Runs on a 24/7 clock so work-hours equal
// wall-clock hours and the timer logic is what's under test (the clock itself has
// its own golden tests in risk-workhours.test.ts).
import { describe, expect, it } from 'vitest';
import type { RiskWorkSchedule } from '@shared/risk';
import { makeWorkClock } from '../src/risk/logic/workhours';
import { recentUpdaters, reduceTimers, type StatusChange, type TimerInput } from '../src/risk/logic/timers';

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
const { workMs } = makeWorkClock(ALWAYS_OPEN);

/** Hours after Mon 2026-03-02T00:00Z, as an ISO string. */
const BASE = Date.parse('2026-03-02T00:00:00Z');
const at = (h: number): string => new Date(BASE + h * 3.6e6).toISOString();
const ms = (h: number): number => BASE + h * 3.6e6;

// A tiny board: To Do (1) -> In Progress (2) -> Code Review (3) -> Done (9).
const MAPS = {
  statusToColumn: { '1': 'To Do', '2': 'In Progress', '3': 'Code Review', '9': 'Done' },
  doneStatusIds: new Set(['9']),
  doneColumnStatusIds: new Set(['9']),
};

function input(over: Partial<TimerInput>): TimerInput {
  return {
    ...MAPS,
    created: at(0),
    statusChanges: [],
    assigneeChangeAts: [],
    currentStatusId: '1',
    currentStatusName: 'To Do',
    inProgressStatus: 'In Progress',
    nowMs: ms(100),
    ...over,
  };
}

const move = (h: number, from: [string, string], to: [string, string]): StatusChange => ({
  at: at(h),
  fromId: from[0],
  fromName: from[1],
  toId: to[0],
  toName: to[1],
});

const TODO: [string, string] = ['1', 'To Do'];
const IP: [string, string] = ['2', 'In Progress'];
const CR: [string, string] = ['3', 'Code Review'];
const DONE: [string, string] = ['9', 'Done'];

describe('reduceTimers', () => {
  it('reports nulls (not zeros) for a ticket that never started', () => {
    const t = reduceTimers(input({}), workMs);
    expect(t.started).toBe(false);
    expect(t.timeInColumnHours).toBeNull();
    expect(t.cycleHours).toBeNull();
    expect(t.idleHours).toBe(100); // idle still runs, anchored at creation
  });

  it('clocks a ticket sitting in In Progress', () => {
    const t = reduceTimers(
      input({
        statusChanges: [move(10, TODO, IP)],
        currentStatusId: '2',
        currentStatusName: 'In Progress',
      }),
      workMs,
    );
    expect(t.started).toBe(true);
    expect(t.idleHours).toBe(90);
    expect(t.timeInColumnHours).toBe(90);
    expect(t.cycleHours).toBe(90);
  });

  it('treats Done as a pause: a pulled-back ticket resumes, the Done interval is excluded', () => {
    const t = reduceTimers(
      input({
        statusChanges: [move(10, TODO, IP), move(30, IP, DONE), move(70, DONE, IP)],
        currentStatusId: '2',
        currentStatusName: 'In Progress',
      }),
      workMs,
    );
    // In Progress 10->30 and 70->100; the 40h parked in Done never counts.
    expect(t.cycleHours).toBe(50);
    expect(t.timeInColumnHours).toBe(50);
    expect(t.idleHours).toBe(30); // anchored at the move back out of Done
  });

  it('freezes a ticket currently in Done at the moment it entered, on its last non-Done column', () => {
    const t = reduceTimers(
      input({
        statusChanges: [move(10, TODO, IP), move(30, IP, CR), move(50, CR, DONE)],
        currentStatusId: '9',
        currentStatusName: 'Done',
      }),
      workMs,
    );
    // clockEnd = 50 (entry into Done), so nothing accrues while it sits there.
    expect(t.idleHours).toBe(20); // Code Review entered at 30, frozen at 50
    expect(t.timeInColumnHours).toBe(20); // Code Review, the last NON-Done column
    expect(t.cycleHours).toBe(40); // 10 -> 50
  });

  it('resets idle on an assignee change as well as a status change', () => {
    const base = input({
      statusChanges: [move(10, TODO, IP)],
      currentStatusId: '2',
      currentStatusName: 'In Progress',
    });
    expect(reduceTimers(base, workMs).idleHours).toBe(90);
    // A handoff at h=60 is more recent than the status move at h=10.
    expect(reduceTimers({ ...base, assigneeChangeAts: [at(60)] }, workMs).idleHours).toBe(40);
    // An older handoff doesn't move the anchor backwards.
    expect(reduceTimers({ ...base, assigneeChangeAts: [at(5)] }, workMs).idleHours).toBe(90);
  });

  it('ignores an assignee change after clockEnd (i.e. while parked in Done)', () => {
    const t = reduceTimers(
      input({
        statusChanges: [move(10, TODO, IP), move(50, IP, DONE)],
        currentStatusId: '9',
        currentStatusName: 'Done',
        assigneeChangeAts: [at(80)],
      }),
      workMs,
    );
    expect(t.idleHours).toBe(40); // 10 -> 50, not 80 -> 50 and not 50 -> 100
  });
});

describe('recentUpdaters', () => {
  it('de-duplicates authors inside the window and drops older ones', () => {
    const events = [
      { at: at(10), author: 'Old Olga' },
      { at: at(90), author: 'Recent Rina' },
      { at: at(95), author: 'Recent Rina' },
    ];
    expect(recentUpdaters(events, ms(100))).toEqual(['Recent Rina']);
    expect(recentUpdaters(events, ms(100), 200 * 3.6e6).sort()).toEqual(['Old Olga', 'Recent Rina']);
  });
});
