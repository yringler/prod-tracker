// Per-column totals + the flow timeline for the detail view. Ports
// rbBuildSegments (0_userscript.js L516-588) with the work clock injected.
//
// A Done visit is a PAUSE that renders as a stub (zero cycle height): Done
// segments are KEPT here (unlike in reduceTimers, which drops them), so both
// "sitting in Done" and "pulled back out of Done" render correctly. Time inside
// Done still never counts toward the cycle clock.

import type { RiskAssigneeSeg, RiskColumnSeg, RiskFlow } from '@shared/risk';
import type { WorkInterval } from './workhours';
import { MS_PER_HOUR } from './workhours';
import { buildStatusSegs, type AssigneeChange, type BoardMaps, type StatusChange, type StatusSeg, type WorkMs } from './timers';

export interface SegmentInput extends BoardMaps {
  created: string;
  statusChanges: StatusChange[];
  assigneeChanges: AssigneeChange[];
  currentStatusId: string;
  currentStatusName: string;
  currentAssignee: string | null;
  inProgressStatus: string;
  nowMs: number;
}

export interface SegmentResult {
  columnTotals: { column: string; hours: number; visits: number }[];
  flow: RiskFlow;
}

export type WorkMsWithin = (from: number, to: number, intervals: WorkInterval[]) => number;

export function buildSegments(
  input: SegmentInput,
  workMs: WorkMs,
  workMsWithin: WorkMsWithin,
): SegmentResult {
  const {
    created,
    statusChanges,
    assigneeChanges,
    currentStatusId,
    currentStatusName,
    currentAssignee,
    statusToColumn,
    doneStatusIds,
    doneColumnStatusIds,
    inProgressStatus,
    nowMs,
  } = input;

  const t0 = Date.parse(created);
  const segs = buildStatusSegs(
    created,
    statusChanges,
    currentStatusId,
    currentStatusName,
    nowMs,
  ).filter((s) => s.end > s.start);

  const isDoneSeg = (s: StatusSeg): boolean =>
    doneStatusIds.has(String(s.id)) || doneColumnStatusIds.has(String(s.id));

  let firstIP: number | null = null;
  for (const s of segs) {
    if (s.name === inProgressStatus) {
      firstIP = s.start;
      break;
    }
  }
  if (firstIP == null) {
    // Never started: nothing to lay out on the timeline.
    return {
      columnTotals: [],
      flow: { createdAt: created, startedAt: null, columnSegs: [], assigneeSegs: [], totalHours: 0 },
    };
  }

  // The intervals the cycle clock is actually running (post-start, non-Done).
  const cycleIntervals: WorkInterval[] = [];
  for (const s of segs) {
    if (isDoneSeg(s)) continue;
    const from = Math.max(s.start, firstIP);
    if (s.end > from) cycleIntervals.push({ start: from, end: s.end });
  }

  const colOf = (s: StatusSeg): string => statusToColumn[String(s.id)] ?? s.name;
  const columnSegs: RiskColumnSeg[] = [];
  for (const s of segs) {
    const from = Math.max(s.start, firstIP);
    if (s.end <= from) continue;
    const col = colOf(s);
    const dc = isDoneSeg(s);
    const last = columnSegs[columnSegs.length - 1];
    // Adjacent visits to the same column (a status move within one column) merge.
    if (last && last.column === col && last.doneCat === dc) {
      last.toMs = s.end;
      last.status = s.name;
    } else {
      columnSegs.push({ column: col, status: s.name, fromMs: from, toMs: s.end, doneCat: dc, hours: 0 });
    }
  }

  const totals: Record<string, number> = {};
  const visits: Record<string, number> = {};
  const order: string[] = [];
  for (const cs of columnSegs) {
    cs.hours = workMsWithin(cs.fromMs, cs.toMs, cycleIntervals) / MS_PER_HOUR;
    if (!(cs.column in totals)) {
      totals[cs.column] = 0;
      visits[cs.column] = 0;
      order.push(cs.column);
    }
    totals[cs.column] = (totals[cs.column] ?? 0) + workMs(cs.fromMs, cs.toMs) / MS_PER_HOUR;
    visits[cs.column] = (visits[cs.column] ?? 0) + 1;
  }
  const columnTotals = order.map((c) => ({
    column: c,
    hours: totals[c] ?? 0,
    visits: visits[c] ?? 0,
  }));

  const ach = assigneeChanges.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const rawA: { assignee: string | null; start: number; end: number }[] = [];
  let aPrevT = t0;
  let aPrev = ach.length ? (ach[0]?.from ?? null) : currentAssignee;
  for (const c of ach) {
    const ct = Date.parse(c.at);
    rawA.push({ assignee: aPrev, start: aPrevT, end: ct });
    aPrevT = ct;
    aPrev = c.to;
  }
  rawA.push({ assignee: aPrev, start: aPrevT, end: nowMs });

  // Assignee segments are clipped at first-In-Progress, same as the column ones.
  const assigneeSegs: RiskAssigneeSeg[] = [];
  for (const s of rawA) {
    const from = Math.max(s.start, firstIP);
    if (s.end <= from) continue;
    const last = assigneeSegs[assigneeSegs.length - 1];
    if (last && last.assignee === s.assignee) last.toMs = s.end;
    else assigneeSegs.push({ assignee: s.assignee, fromMs: from, toMs: s.end, hours: 0 });
  }
  for (const s of assigneeSegs) {
    s.hours = workMsWithin(s.fromMs, s.toMs, cycleIntervals) / MS_PER_HOUR;
  }

  return {
    columnTotals,
    flow: {
      createdAt: created,
      startedAt: new Date(firstIP).toISOString(),
      columnSegs,
      assigneeSegs,
      totalHours: workMsWithin(firstIP, nowMs, cycleIntervals) / MS_PER_HOUR,
    },
  };
}
