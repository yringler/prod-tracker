// Timer reduction: a ticket's changelog -> idle / in-column / cycle work-hours.
// Ports rbReduceTimers (0_userscript.js L458-505) and rbRecentUpdaters (L371-378),
// with the work clock injected instead of the module-global rbWorkMs.
//
// The domain rules encoded here are load-bearing (arch §10) — read them before
// changing anything:
//   - "Done" is the board's LAST column BY POSITION, not Jira's status category.
//   - Time inside Done never counts, but Done is a PAUSE, not a stop: a ticket
//     pulled back out resumes its clocks (only the Done interval is excluded).
//     A ticket currently in Done is frozen at the moment it last entered Done.
//   - Idle resets on a status change OR an assignee change (whichever is later).
//   - Clocks start at the first entry into the configured In Progress status.
//     Before that, timeInColumn and cycle are NULL, not zero. Idle is the one
//     exception: rbReduceTimers (the ground truth) always computes it — from the
//     ticket's creation when nothing has moved — so it is carried raw here too.
//     Nothing bands it before start: health.clock() forces band 'none' / score null
//     for a not-started ticket, so the raw number is display-only until then.

import { MS_PER_HOUR } from './workhours';

export interface StatusChange {
  at: string;
  fromId: string;
  fromName: string | null;
  toId: string;
  toName: string | null;
}

export interface AssigneeChange {
  at: string;
  from: string | null;
  to: string | null;
}

/** One changelog entry: who edited the issue, and when (any field). */
export interface ChangelogEvent {
  at: string;
  author: string;
}

/** A contiguous stretch of time the issue spent in one status. */
export interface StatusSeg {
  id: string;
  name: string;
  start: number;
  end: number;
}

/** The board/status maps every timer computation is relative to. */
export interface BoardMaps {
  /** status id -> board column name. */
  statusToColumn: Record<string, string>;
  /** Jira statusCategory === 'done' status ids (excluded from the cycle clock). */
  doneStatusIds: ReadonlySet<string>;
  /** Status ids sitting in the board's LAST column (the board's own "Done"). */
  doneColumnStatusIds: ReadonlySet<string>;
}

export interface TimerInput extends BoardMaps {
  created: string;
  statusChanges: StatusChange[];
  /** Timestamps of assignee changes (idle anchors). */
  assigneeChangeAts: string[];
  currentStatusId: string;
  currentStatusName: string;
  inProgressStatus: string;
  nowMs: number;
}

export interface TimerResult {
  idleHours: number;
  timeInColumnHours: number | null;
  cycleHours: number | null;
  started: boolean;
}

export type WorkMs = (start: number, end: number) => number;

/**
 * Status history -> one segment per status visit, ending at `nowMs`. Shared with
 * the segment builder, which needs the same walk before it diverges (it keeps
 * Done visits as stubs; the timers drop them).
 */
export function buildStatusSegs(
  created: string,
  statusChanges: StatusChange[],
  currentStatusId: string,
  currentStatusName: string,
  nowMs: number,
): StatusSeg[] {
  const t0 = Date.parse(created);
  const changes = statusChanges.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = changes[0];
  const segs: StatusSeg[] = [];
  let prevT = t0;
  let prevId = first ? first.fromId : currentStatusId;
  let prevName = (first ? first.fromName : currentStatusName) ?? '';
  for (const c of changes) {
    const ct = Date.parse(c.at);
    segs.push({ id: prevId, name: prevName, start: prevT, end: ct });
    prevT = ct;
    prevId = c.toId;
    prevName = c.toName ?? '';
  }
  segs.push({ id: prevId, name: prevName, start: prevT, end: nowMs });
  return segs;
}

export function reduceTimers(input: TimerInput, workMs: WorkMs): TimerResult {
  const {
    created,
    statusChanges,
    assigneeChangeAts,
    currentStatusId,
    currentStatusName,
    statusToColumn,
    doneStatusIds,
    doneColumnStatusIds,
    inProgressStatus,
    nowMs,
  } = input;

  const t0 = Date.parse(created);
  const raw = buildStatusSegs(created, statusChanges, currentStatusId, currentStatusName, nowMs);

  const inBoardDone = (s: StatusSeg): boolean => doneColumnStatusIds.has(String(s.id));
  const lastSeg = raw[raw.length - 1];
  const sittingInDone = !!lastSeg && inBoardDone(lastSeg);
  const clockEnd = sittingInDone && lastSeg ? lastSeg.start : nowMs;
  const segs = raw
    .map((s) => ({ ...s, end: Math.min(s.end, clockEnd) }))
    .filter((s) => s.end > s.start && !inBoardDone(s));

  // Idle anchor = the later of "entered the current status" and "assignee last
  // changed" — movement of either kind resets the clock. Assignee changes after
  // clockEnd (i.e. while parked in Done) are ignored.
  const last = segs[segs.length - 1];
  let anchor = last ? last.start : t0;
  for (const a of assigneeChangeAts) {
    const t = Date.parse(a);
    if (t > anchor && t <= clockEnd) anchor = t;
  }
  const idleHours = workMs(anchor, clockEnd) / MS_PER_HOUR;

  let firstIP: number | null = null;
  for (const s of segs) {
    if (s.name === inProgressStatus) {
      firstIP = s.start;
      break;
    }
  }
  const started = firstIP != null;
  if (firstIP == null) return { idleHours, timeInColumnHours: null, cycleHours: null, started };

  // In-column: while sitting in Done, measure the LAST NON-DONE column; else live.
  let curCol = statusToColumn[String(currentStatusId)] ?? currentStatusName;
  if (sittingInDone && last) curCol = statusToColumn[String(last.id)] ?? last.name;

  let tic = 0;
  let cyc = 0;
  for (const s of segs) {
    const from = Math.max(s.start, firstIP);
    if (s.end <= from) continue;
    const w = workMs(from, s.end);
    if ((statusToColumn[String(s.id)] ?? s.name) === curCol) tic += w;
    if (!doneStatusIds.has(String(s.id))) cyc += w;
  }
  return {
    idleHours,
    timeInColumnHours: tic / MS_PER_HOUR,
    cycleHours: cyc / MS_PER_HOUR,
    started,
  };
}

/** Display names of everyone who changed the issue within `windowMs` before `nowMs`. */
export function recentUpdaters(
  events: ChangelogEvent[],
  nowMs: number,
  windowMs = 24 * MS_PER_HOUR,
): string[] {
  const cutoff = nowMs - windowMs;
  const seen = new Set<string>();
  for (const e of events) {
    const t = Date.parse(e.at);
    if (t >= cutoff && e.author) seen.add(e.author);
  }
  return [...seen];
}
