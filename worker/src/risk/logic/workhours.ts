// The work-hours clock every risk metric is measured in. Ported from the
// userscript's rbNyParts / rbOffsetMs / rbNyWallToUtc / RB_WORK / rbWorkMs
// (0_userscript.js L304-332) and rbWorkMsWithin (L507-514), generalized from the
// hardcoded America/New_York Mon-Thu 9-18 / Fri 9-13 schedule to a config-driven
// one. The board UI carried a second copy of the same algorithm (flowWorkMs);
// this module is the single implementation.
//
// DOCUMENTED EXCEPTION to the repo's `UTCDate` convention: these metrics are
// wall-clock-by-definition ("was the office open?"), so the math runs in the
// schedule's timezone via Intl.DateTimeFormat — the same class of exception as
// `workdayPace`/`trackerDayKey` in shared/src/domain.ts. Intl behaves identically
// in workerd, Node and the browser, and needs no dependency.

import type { RiskWeekday, RiskWorkSchedule } from '@shared/risk';

/** Wall-clock parts of an instant, in the clock's timezone. */
interface Parts {
  wd: string;
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export interface WorkInterval {
  start: number;
  end: number;
}

export interface WorkClock {
  /** Work-milliseconds between two instants (epoch ms). 0 for empty/inverted spans. */
  workMs(start: number, end: number): number;
  /** Work-ms of [from,to] restricted to `intervals` (used for cycle-clipped totals). */
  workMsWithin(from: number, to: number, intervals: WorkInterval[]): number;
}

/** Guard against a pathological span walking forever; 800 days, as upstream. */
const MAX_DAYS = 800;

export function makeWorkClock(schedule: RiskWorkSchedule): WorkClock {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  function parts(ms: number): Parts {
    const o: Record<string, string> = {};
    for (const p of dtf.formatToParts(ms)) o[p.type] = p.value;
    let h = Number(o['hour']);
    if (h === 24) h = 0; // some ICU builds render midnight as 24 under h23
    return {
      wd: o['weekday'] ?? '',
      y: Number(o['year']),
      mo: Number(o['month']),
      d: Number(o['day']),
      h,
      mi: Number(o['minute']),
      s: Number(o['second']),
    };
  }

  /** Offset (ms) to add to a UTC-shaped wall time to get the real instant. */
  function offsetMs(ms: number): number {
    const p = parts(ms);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
  }

  /** Local wall time -> epoch ms. One correction pass, as upstream: enough for
   *  the 9am/6pm boundaries this is ever asked about (DST shifts happen at 2am). */
  function wallToUtc(y: number, mo: number, d: number, hh: number, mm: number): number {
    const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
    return guess - offsetMs(guess);
  }

  function dayWindow(wd: string): [number, number] | null {
    return schedule.days[wd as RiskWeekday] ?? null;
  }

  function workMs(start: number, end: number): number {
    if (!(end > start)) return 0;
    let total = 0;
    const sp = parts(start);
    // Walk local midnights. +12h picks the day we're standing on and +26h the
    // next one, both safely clear of any DST shift.
    let cursor = wallToUtc(sp.y, sp.mo, sp.d, 0, 0);
    for (let i = 0; i < MAX_DAYS && cursor < end; i++) {
      const cp = parts(cursor + 12 * 3600000);
      const w = dayWindow(cp.wd);
      if (w) {
        const openU = wallToUtc(cp.y, cp.mo, cp.d, w[0], 0);
        const closeU = wallToUtc(cp.y, cp.mo, cp.d, w[1], 0);
        const lo = Math.max(start, openU);
        const hi = Math.min(end, closeU);
        if (hi > lo) total += hi - lo;
      }
      const np = parts(cursor + 26 * 3600000);
      cursor = wallToUtc(np.y, np.mo, np.d, 0, 0);
    }
    return total;
  }

  function workMsWithin(from: number, to: number, intervals: WorkInterval[]): number {
    let t = 0;
    for (const iv of intervals) {
      const lo = Math.max(from, iv.start);
      const hi = Math.min(to, iv.end);
      if (hi > lo) t += workMs(lo, hi);
    }
    return t;
  }

  return { workMs, workMsWithin };
}

/** Every metric is reported in work-hours. */
export const MS_PER_HOUR = 3.6e6;
