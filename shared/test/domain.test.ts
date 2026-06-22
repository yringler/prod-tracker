import { describe, expect, it } from 'vitest';
import {
  changelogIdGreater,
  computeRatio,
  isDoneTransition,
  isRatingFraction,
  sprintForTimestamp,
} from '@shared/domain';

describe('isRatingFraction', () => {
  it('accepts only 0, .25, .5, 1', () => {
    expect([0, 0.25, 0.5, 1].every(isRatingFraction)).toBe(true);
    expect(isRatingFraction(0.75)).toBe(false);
    expect(isRatingFraction('1')).toBe(false);
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

describe('computeRatio', () => {
  it('is null when done is 0 (avoid divide-by-zero)', () => {
    expect(computeRatio(5, 0)).toBeNull();
    expect(computeRatio(9, 5)).toBeCloseTo(1.8);
  });
});
