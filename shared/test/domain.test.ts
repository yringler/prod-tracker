import { describe, expect, it } from 'vitest';
import {
  PENDING_MAX_AGE_MS,
  changelogIdGreater,
  computeRatio,
  isDoneTransition,
  isStaleTransition,
  sprintForTimestamp,
  weekStartOf,
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
