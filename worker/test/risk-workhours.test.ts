// The risk board's work-hours clock: golden spans, weekends, the Friday early
// close, both DST transitions (the clock must follow the wall clock, not UTC),
// degenerate ranges, and a non-NY schedule (it's config-driven, not hardcoded).
import { describe, expect, it } from 'vitest';
import { makeWorkClock, MS_PER_HOUR } from '../src/risk/logic/workhours';
import { DEFAULT_SCHEDULE } from '../src/risk/logic/defaults';
import type { RiskWorkSchedule } from '@shared/risk';

const ny = makeWorkClock(DEFAULT_SCHEDULE);
const hours = (start: string, end: string): number =>
  ny.workMs(Date.parse(start), Date.parse(end)) / MS_PER_HOUR;

describe('work clock (America/New_York, Mon-Thu 9-18, Fri 9-13)', () => {
  it('counts a span inside one workday', () => {
    // Wed 2026-03-04, 10:00 -> 12:00 EST (UTC-5).
    expect(hours('2026-03-04T15:00:00Z', '2026-03-04T17:00:00Z')).toBe(2);
  });

  it('clips to the working window and skips the weekend', () => {
    // Fri 12:00 EST -> Mon 10:00 EST: 1h of Friday (13:00 close) + 1h of Monday.
    expect(hours('2026-03-06T17:00:00Z', '2026-03-09T14:00:00Z')).toBe(2);
  });

  it('closes Friday at 13:00', () => {
    // Fri 12:00 -> 18:00 local: only the hour before the early close counts.
    expect(hours('2026-03-06T17:00:00Z', '2026-03-06T23:00:00Z')).toBe(1);
  });

  it('follows the wall clock across spring-forward (2026-03-08)', () => {
    // Fri 09:00 EST (UTC-5) -> Mon 18:00 EDT (UTC-4): Friday 4h + Monday 9h.
    // A naive UTC clock would be an hour out on the Monday.
    expect(hours('2026-03-06T14:00:00Z', '2026-03-09T22:00:00Z')).toBe(13);
  });

  it('follows the wall clock across fall-back (2026-11-01)', () => {
    // Fri 09:00 EDT (UTC-4) -> Mon 18:00 EST (UTC-5): Friday 4h + Monday 9h.
    expect(hours('2026-10-30T13:00:00Z', '2026-11-02T23:00:00Z')).toBe(13);
  });

  it('returns 0 for empty and inverted ranges', () => {
    expect(hours('2026-03-04T15:00:00Z', '2026-03-04T15:00:00Z')).toBe(0);
    expect(hours('2026-03-04T17:00:00Z', '2026-03-04T15:00:00Z')).toBe(0);
  });

  it('counts only the intervals given to workMsWithin', () => {
    const from = Date.parse('2026-03-04T14:00:00Z'); // Wed 09:00
    const to = Date.parse('2026-03-04T23:00:00Z'); // Wed 18:00 (a full 9h day)
    expect(ny.workMs(from, to) / MS_PER_HOUR).toBe(9);
    const intervals = [
      { start: Date.parse('2026-03-04T15:00:00Z'), end: Date.parse('2026-03-04T17:00:00Z') },
    ];
    expect(ny.workMsWithin(from, to, intervals) / MS_PER_HOUR).toBe(2);
  });

  it('is config-driven, not New-York-shaped', () => {
    // Israeli week: Sun-Thu 09:00-17:00, Jerusalem time.
    const israel: RiskWorkSchedule = {
      timeZone: 'Asia/Jerusalem',
      days: {
        Sun: [9, 17],
        Mon: [9, 17],
        Tue: [9, 17],
        Wed: [9, 17],
        Thu: [9, 17],
        Fri: null,
        Sat: null,
      },
    };
    const clock = makeWorkClock(israel);
    // Thu 2026-03-05 09:00 IST -> Sun 2026-03-08 17:00 IST: Thursday 8h + Sunday 8h
    // (Friday and Saturday are the weekend here, Sunday is a workday).
    const span =
      clock.workMs(Date.parse('2026-03-05T07:00:00Z'), Date.parse('2026-03-08T15:00:00Z')) /
      MS_PER_HOUR;
    expect(span).toBe(16);
    // The NY clock disagrees on the same span — proving the schedule drives it.
    expect(ny.workMs(Date.parse('2026-03-05T07:00:00Z'), Date.parse('2026-03-08T15:00:00Z'))).not.toBe(
      span * MS_PER_HOUR,
    );
  });
});
