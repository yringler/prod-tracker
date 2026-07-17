import { describe, expect, it } from 'vitest';
import {
  ESCALATION_DELAY_MS,
  FALLBACK_CLAIM_CEILING,
  PENDING_MAX_AGE_MS,
  REMINDER_COOLDOWN_MS,
  changelogIdGreater,
  claimCeiling,
  computeRatio,
  escalationWindow,
  isDoneTransition,
  isStaleTransition,
  isTrackerToday,
  mayRemind,
  sprintForTimestamp,
  trackerDayKey,
  weekStartOf,
  workdayPace,
} from '@shared/domain';

describe('weekStartOf', () => {
  it('anchors every day of a week to that week’s Monday (UTC)', () => {
    // 2026-06-01 is a Monday; the whole week maps to it.
    expect(weekStartOf('2026-06-01T10:00:00.000Z')).toBe('2026-06-01'); // Mon
    expect(weekStartOf('2026-06-03T23:59:59.000Z')).toBe('2026-06-01'); // Wed
    expect(weekStartOf('2026-06-07T12:00:00.000Z')).toBe('2026-06-01'); // Sun
    expect(weekStartOf('2026-06-08T00:00:00.000Z')).toBe('2026-06-08'); // next Mon
  });

  it('accepts a bare YYYY-MM-DD day key', () => {
    expect(weekStartOf('2026-06-04')).toBe('2026-06-01');
  });

  it('crosses the year boundary correctly', () => {
    // 2027-01-01 is a Friday → its week’s Monday is 2026-12-28.
    expect(weekStartOf('2027-01-01T00:00:00.000Z')).toBe('2026-12-28');
  });
});

describe('escalationWindow', () => {
  it('has a 10-minute escalation delay', () => {
    expect(ESCALATION_DELAY_MS).toBe(600000);
  });

  it('brackets created_at values: due = now−10m, notBefore = now−24h', () => {
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const { dueBeforeIso, notBeforeIso } = escalationWindow(now);
    expect(dueBeforeIso).toBe('2026-06-15T11:50:00.000Z'); // now − 10m
    expect(notBeforeIso).toBe('2026-06-14T12:00:00.000Z'); // now − 24h
    expect(Date.parse(dueBeforeIso)).toBe(now - ESCALATION_DELAY_MS);
    expect(Date.parse(notBeforeIso)).toBe(now - PENDING_MAX_AGE_MS);
    // A ripe row sits inside [notBefore, dueBefore).
    expect(Date.parse(notBeforeIso)).toBeLessThan(Date.parse(dueBeforeIso));
  });
});

describe('mayRemind', () => {
  const t0 = Date.parse('2026-06-15T12:00:00.000Z');

  it('always reminds when there is no prior reminder', () => {
    expect(mayRemind('900', null, t0)).toBe(true);
  });

  it('suppresses a real transition still within the cooldown', () => {
    const last = { changelogId: '900', atIso: new Date(t0).toISOString() };
    // Greater id (transitioned) but only 5 min later — cooldown not passed.
    expect(mayRemind('901', last, t0 + 5 * 60 * 1000)).toBe(false);
  });

  it('suppresses a same/lower id even after the cooldown', () => {
    const last = { changelogId: '900', atIso: new Date(t0).toISOString() };
    const later = t0 + REMINDER_COOLDOWN_MS + 60_000;
    expect(mayRemind('900', last, later)).toBe(false); // same id
    expect(mayRemind('899', last, later)).toBe(false); // lower id
  });

  it('reminds when both transitioned and cooldown passed', () => {
    const last = { changelogId: '900', atIso: new Date(t0).toISOString() };
    expect(mayRemind('901', last, t0 + REMINDER_COOLDOWN_MS + 60_000)).toBe(true);
  });

  it('treats the exact cooldown boundary as passed (>=)', () => {
    const last = { changelogId: '900', atIso: new Date(t0).toISOString() };
    expect(mayRemind('901', last, t0 + REMINDER_COOLDOWN_MS)).toBe(true);
  });
});

describe('trackerDayKey / isTrackerToday', () => {
  // Wall-clock local by design — build local Dates so the assertions hold in any
  // runtime timezone. Tue 2026-06-02; the day boundary is 3AM local.
  it('folds pre-3AM work into the previous day', () => {
    expect(trackerDayKey(new Date(2026, 5, 2, 2, 0))).toBe('2026-06-01'); // 2:00 → Mon
    expect(trackerDayKey(new Date(2026, 5, 2, 2, 59))).toBe('2026-06-01'); // 2:59 → Mon
  });

  it('starts the new day at exactly 3AM', () => {
    expect(trackerDayKey(new Date(2026, 5, 2, 3, 0))).toBe('2026-06-02'); // 3:00 → Tue
  });

  it('leaves daytime work on its own calendar day', () => {
    expect(trackerDayKey(new Date(2026, 5, 2, 13, 30))).toBe('2026-06-02');
    expect(trackerDayKey(new Date(2026, 5, 2, 23, 59))).toBe('2026-06-02');
  });

  it('isTrackerToday straddles the 3AM boundary against now', () => {
    const now = new Date(2026, 5, 2, 10, 0); // Tue 10:00
    expect(isTrackerToday(new Date(2026, 5, 2, 2, 0), now)).toBe(false); // 2AM Tue → Mon
    expect(isTrackerToday(new Date(2026, 5, 2, 3, 0), now)).toBe(true); // 3AM Tue → Tue
    // 1AM Wed folds back to Tue, so it still counts as "today" at Tue 10:00.
    expect(isTrackerToday(new Date(2026, 5, 3, 1, 0), now)).toBe(true);
    expect(isTrackerToday(new Date(2026, 5, 3, 3, 0), now)).toBe(false); // 3AM Wed → Wed
  });
});

describe('changelogIdGreater', () => {
  it('treats null cursor as "everything is newer"', () => {
    expect(changelogIdGreater('1', null)).toBe(true);
  });
  it('compares numerically beyond 2^53', () => {
    expect(changelogIdGreater('9007199254740993', '9007199254740992')).toBe(true);
    expect(changelogIdGreater('9007199254740992', '9007199254740993')).toBe(false);
  });
});

describe('isDoneTransition', () => {
  it('uses the admin name set when present (case-insensitive)', () => {
    expect(isDoneTransition('Shipped', ['shipped'], 'indeterminate')).toBe(true);
    expect(isDoneTransition('Done', ['shipped'], 'done')).toBe(false);
  });
  it('falls back to status category when the name set is empty', () => {
    expect(isDoneTransition('Done', [], 'done')).toBe(true);
    expect(isDoneTransition('In Progress', [], 'indeterminate')).toBe(false);
  });
});

describe('sprintForTimestamp', () => {
  const sprints = [
    { sprintId: 1, startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-15T00:00:00Z' },
    { sprintId: 2, startAt: '2026-05-15T00:00:01Z', endAt: '2026-05-29T00:00:00Z' },
  ];
  it('buckets by the timestamp, not current sprint', () => {
    expect(sprintForTimestamp('2026-05-10T00:00:00Z', sprints)).toBe(1);
    expect(sprintForTimestamp('2026-05-20T00:00:00Z', sprints)).toBe(2);
    expect(sprintForTimestamp('2026-06-01T00:00:00Z', sprints)).toBeNull();
  });
});

describe('isStaleTransition', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');
  it('is false just under the max age, true just over', () => {
    const justUnder = new Date(now - PENDING_MAX_AGE_MS + 60_000).toISOString();
    const justOver = new Date(now - PENDING_MAX_AGE_MS - 60_000).toISOString();
    expect(isStaleTransition(justUnder, now)).toBe(false);
    expect(isStaleTransition(justOver, now)).toBe(true);
  });
  it('parses Jira-style numeric tz offsets', () => {
    expect(isStaleTransition('2026-06-22T11:00:00.000+0000', now)).toBe(false);
    expect(isStaleTransition('2026-06-20T11:00:00.000+0000', now)).toBe(true);
  });
  it('fails open on an unparseable timestamp', () => {
    expect(isStaleTransition('not-a-date', now)).toBe(false);
  });
});

describe('computeRatio', () => {
  it('is null when done is 0 (avoid divide-by-zero)', () => {
    expect(computeRatio(5, 0)).toBeNull();
    expect(computeRatio(9, 5)).toBeCloseTo(1.8);
  });
});

describe('workdayPace', () => {
  // Wall-clock local dates on purpose — the workday is the user's local 9–6,
  // so these tests are timezone-independent by construction.
  const at = (h: number, m = 0) => new Date(2026, 5, 22, h, m);
  const goal = 16; // quarter targets: 4 / 8 / 12 / 16

  it('starts the day pointed at the first quarter target', () => {
    const p = workdayPace(goal, 0, at(9, 30));
    expect(p).toMatchObject({ state: 'onTrack', quarter: 1, targetPoints: 4, pointsRemaining: 4 });
    expect(p.deadline).toEqual(at(11, 15));
  });

  it('treats pre-workday time like the start of the day', () => {
    const p = workdayPace(goal, 0, at(7));
    expect(p.state).toBe('onTrack');
    expect(p.deadline).toEqual(at(11, 15));
  });

  it('advances to the next quarter as soon as the current target is met', () => {
    const p = workdayPace(goal, 5, at(10));
    expect(p).toMatchObject({ state: 'ahead', quarter: 2, targetPoints: 8, pointsRemaining: 3 });
    expect(p.deadline).toEqual(at(13, 30));
  });

  it('is on track when past a deadline whose target was met', () => {
    // 12:00 is in Q2; 5 ≥ the Q1 target of 4, chasing 8 by 13:30.
    expect(workdayPace(goal, 5, at(12))).toMatchObject({ state: 'onTrack', quarter: 2, targetPoints: 8 });
  });

  it('flags behind and points at the current quarter deadline as catch-up', () => {
    // 14:00 is in Q3 and the Q2 target (8) was missed → catch up to 12 by 15:45.
    const p = workdayPace(goal, 5, at(14));
    expect(p).toMatchObject({ state: 'behind', quarter: 3, targetPoints: 12, pointsRemaining: 7 });
    expect(p.deadline).toEqual(at(15, 45));
  });

  it('is done at (or past) the goal regardless of time', () => {
    expect(workdayPace(goal, 16, at(10))).toMatchObject({ state: 'done', pointsRemaining: 0 });
    expect(workdayPace(goal, 20, at(19))).toMatchObject({ state: 'done', dayOver: true });
  });

  it('stays behind on quarter 4 once the workday is over', () => {
    const p = workdayPace(goal, 10, at(18, 30));
    expect(p).toMatchObject({ state: 'behind', quarter: 4, targetPoints: 16, dayOver: true });
    expect(p.deadline).toEqual(at(18));
  });

  it('handles goals that do not divide by 4', () => {
    expect(workdayPace(10, 0, at(9)).targetPoints).toBe(2.5);
  });
});

describe('claimCeiling', () => {
  it('is twice the story points for a normal estimate', () => {
    expect(claimCeiling(5)).toBe(10);
    expect(claimCeiling(1)).toBe(2);
  });
  it('falls back to a flat ceiling for missing or sub-1 estimates', () => {
    expect(claimCeiling(null)).toBe(FALLBACK_CLAIM_CEILING);
    expect(claimCeiling(0)).toBe(FALLBACK_CLAIM_CEILING);
    expect(claimCeiling(0.5)).toBe(FALLBACK_CLAIM_CEILING);
  });
});
