// The impact preview's arithmetic: re-score a STORED snapshot's tickets under a
// candidate config and diff the tiers. Pure — no DB, no Jira, no fetch.
//
// The whole point of this file is that it does NOT reimplement scoring. It calls
// `evaluateTicket` and `tierCounts`, the exact functions the cron write path uses,
// over the raw inputs the snapshot already carries (`RiskTicket` is a superset of
// `HealthInput`). If the scorer changes, the preview changes with it; it cannot
// drift into telling an admin something the next refresh won't do.
//
// WHAT IT CANNOT SHOW: `idleHours` / `timeInColumnHours` / `cycleHours` were
// measured on the work clock of the snapshot's OWN schedule. A candidate schedule
// change moves those numbers, and only a real refresh can recompute them — so we
// report `scheduleStale` and the UI says so in words, rather than pretending.

import type {
  RiskBand,
  RiskBoardSnapshot,
  RiskCompositeConfig,
  RiskCutoffs,
  RiskFieldConfigEntry,
  RiskPreviewMover,
  RiskTierCounts,
  RiskTicket,
  RiskWorkSchedule,
} from '@shared/risk';
import { evaluateTicket, tierCounts } from './health';

/** Per-board cap on the sample list. Small on purpose: it is an illustration, not
 *  a report — and `sampleTruncated` says so whenever it bites. */
export const PREVIEW_SAMPLE_LIMIT = 6;

export interface PreviewCandidate {
  cutoffs: RiskCutoffs;
  composite: RiskCompositeConfig;
  schedule: RiskWorkSchedule;
  fields: RiskFieldConfigEntry[];
}

export interface PreviewDiff {
  before: RiskTierCounts;
  after: RiskTierCounts;
  movedToRisk: number;
  movedToOk: number;
  moved: number;
  sampleMovers: RiskPreviewMover[];
  sampleTruncated: boolean;
  scheduleStale: boolean;
}

const RANK: Record<RiskBand, number> = { none: 0, ok: 1, warn: 2, risk: 3 };

function rank(t: RiskBand | null): number {
  return t === null ? 0 : RANK[t];
}

/**
 * Diff one board. `before` is recomputed from the tickets' STORED tiers rather
 * than read off `snapshot.tierCounts`, so both halves of the comparison come out
 * of one function and a stale/hand-edited stored count can never skew the delta.
 */
export function previewSnapshot(
  snapshot: RiskBoardSnapshot,
  candidate: PreviewCandidate,
  limit: number = PREVIEW_SAMPLE_LIMIT,
): PreviewDiff {
  const tickets: RiskTicket[] = Array.isArray(snapshot.tickets) ? snapshot.tickets : [];
  const columns = Array.isArray(snapshot.columns) ? snapshot.columns : [];

  const afterTiers: (RiskBand | null)[] = [];
  const movers: { mover: RiskPreviewMover; severity: number }[] = [];
  let movedToRisk = 0;
  let movedToOk = 0;

  for (const t of tickets) {
    // `blocked` is the STORED verdict: a legacy snapshot's blocked still includes
    // the old flag-OR (one refresh stale, self-healing). A field with no key in
    // `fieldValues` (legacy snapshot / field added since) bands 'none' and
    // contributes nothing — that IS the graceful-degrade path.
    const { tier } = evaluateTicket(
      {
        column: t.column,
        points: t.points,
        blocked: t.blocked,
        started: t.started,
        idleHours: t.idleHours,
        timeInColumnHours: t.timeInColumnHours,
        cycleHours: t.cycleHours,
        fieldValues: t.fieldValues ?? {},
      },
      candidate.cutoffs,
      candidate.composite,
      columns,
      candidate.fields,
    );
    afterTiers.push(tier);
    if (tier === t.tier) continue;
    if (tier === 'risk') movedToRisk++;
    if (tier === 'ok') movedToOk++;
    movers.push({
      mover: { key: t.key, summary: t.summary, from: t.tier, to: tier },
      // Worst move first: a ticket climbing ok -> risk is the one an admin must
      // see; a ticket falling risk -> ok is the reassuring tail.
      severity: rank(tier) - rank(t.tier),
    });
  }

  movers.sort((a, b) => b.severity - a.severity || a.mover.key.localeCompare(b.mover.key));
  const sampleMovers = movers.slice(0, Math.max(0, limit)).map((m) => m.mover);

  return {
    before: tierCounts(tickets.map((t) => t.tier)),
    after: tierCounts(afterTiers),
    movedToRisk,
    movedToOk,
    moved: movers.length,
    sampleMovers,
    sampleTruncated: movers.length > sampleMovers.length,
    scheduleStale: !sameSchedule(snapshot.schedule, candidate.schedule),
  };
}

/** Structural compare of the two work schedules. A difference means every stored
 *  clock value was measured on a different clock than the candidate one. */
export function sameSchedule(
  a: RiskWorkSchedule | null | undefined,
  b: RiskWorkSchedule | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.timeZone !== b.timeZone) return false;
  const days = new Set([...Object.keys(a.days ?? {}), ...Object.keys(b.days ?? {})]);
  for (const d of days) {
    const x = a.days?.[d as keyof RiskWorkSchedule['days']] ?? null;
    const y = b.days?.[d as keyof RiskWorkSchedule['days']] ?? null;
    if (x === null || y === null) {
      if (x !== y) return false;
      continue;
    }
    if (x[0] !== y[0] || x[1] !== y[1]) return false;
  }
  return true;
}

export function addCounts(a: RiskTierCounts, b: RiskTierCounts): RiskTierCounts {
  return { risk: a.risk + b.risk, warn: a.warn + b.warn, ok: a.ok + b.ok };
}
