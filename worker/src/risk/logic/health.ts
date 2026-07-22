// The HEALTH registry's semantics, server-side. Ports the blob's HEALTH entries +
// metricValue + cardTier + tierCounts into one pass that produces the `metrics`,
// `fieldMetrics`, `composite` and `tier` fields of a RiskTicket.
//
// Rules preserved verbatim from the userscript (arch §10):
//   - A DONE-COLUMN ticket registers band 'none' / score null on every metric and
//     has a null composite and null tier — its raw values still display
//     ("keep showing, stop flagging"). It is excluded from the tier counts.
//   - A NOT-STARTED ticket has band 'none' / score null on idle, in-column and
//     cycle (those clocks haven't begun); blocked and the field metrics still apply.
//   - A count field reads 0 when its key is present but the issue carries no value,
//     and bands 'ok' at 0; a flag field is binary (score 1/0, band risk/ok). A key
//     ABSENT from `fieldValues` (old snapshot / field added since the refresh) is
//     the graceful-degrade case: value null, band 'none', score null.
//   - A ticket's tier is the worst non-'none' band across the core metrics, the
//     field metrics AND the composite.

import type {
  RiskBand,
  RiskCompositeConfig,
  RiskCutoffs,
  RiskFieldConfigEntry,
  RiskMetricId,
  RiskMetricState,
  RiskTierCounts,
} from '@shared/risk';
import { COMP, band, compositeScore, resolveCutoff, type CompositeTerm } from './scoring';

/** The raw per-ticket values the metrics are computed from. */
export interface HealthInput {
  column: string;
  points: number | null;
  blocked: boolean;
  started: boolean;
  idleHours: number | null;
  timeInColumnHours: number | null;
  cycleHours: number | null;
  /** Raw value per configured field id. Test `id in fieldValues`, not truthiness:
   *  a missing KEY degrades to 'none', a present null counts as 0 / false. */
  fieldValues: Record<string, number | boolean | null>;
}

export interface HealthResult {
  metrics: Record<RiskMetricId, RiskMetricState>;
  fieldMetrics: Record<string, RiskMetricState>;
  composite: { score: number | null; band: RiskBand };
  tier: RiskBand | null;
}

const RANK: Record<Exclude<RiskBand, 'none'>, number> = { ok: 1, warn: 2, risk: 3 };

/** The board treats its LAST column as done — by position, not by Jira's category. */
export function isDoneColumn(column: string, columns: string[]): boolean {
  return columns.length > 0 && column === columns[columns.length - 1];
}

/** One admin-mapped field's metric state. Kind semantics mirror the two built-ins
 *  they generalize: count = the old rejections banding, flag = the old
 *  flagged-half of blocked. */
export function evaluateFieldMetric(
  entry: RiskFieldConfigEntry,
  fieldValues: Record<string, number | boolean | null>,
  done: boolean,
): RiskMetricState {
  if (!(entry.fieldId in fieldValues)) {
    // Old snapshot, or a field added since it was written: no data, no flagging.
    return { value: null, band: 'none', score: null };
  }
  const raw = fieldValues[entry.fieldId];
  if (entry.kind === 'count') {
    const warn = entry.warn ?? 0;
    const risk = entry.risk ?? 0;
    const v = typeof raw === 'number' ? raw : 0; // absent on the issue reads 0
    return {
      value: v,
      band: done ? 'none' : v > 0 && risk > 0 ? band(v, { warn, risk }) : 'ok',
      score: done || risk <= 0 ? null : v / risk,
      warn,
      risk,
    };
  }
  const on = !!raw;
  return {
    value: on,
    band: done ? 'none' : on ? 'risk' : 'ok',
    score: done ? null : on ? 1 : 0,
  };
}

export function evaluateTicket(
  raw: HealthInput,
  cutoffs: RiskCutoffs | null,
  composite: RiskCompositeConfig,
  columns: string[],
  fields: readonly RiskFieldConfigEntry[] = [],
): HealthResult {
  const done = isDoneColumn(raw.column, columns);

  const blocked: RiskMetricState = {
    value: raw.blocked,
    band: done ? 'none' : raw.blocked ? 'risk' : 'ok',
    score: done ? null : raw.blocked ? 1 : 0,
  };

  // The three clock metrics: pending (band 'none', score null) while the ticket is
  // done, not started, or has no value; otherwise scored against its OWN resolved
  // thresholds, which ride along for the detail view.
  const clock = (
    metric: 'idle' | 'timeInColumn' | 'cycle',
    value: number | null,
  ): RiskMetricState => {
    const c = resolveCutoff(cutoffs, metric, raw.column, raw.points);
    const pending = done || !raw.started || value == null;
    return {
      value,
      band: pending ? 'none' : band(value as number, c),
      score: pending ? null : (value as number) / c.risk,
      warn: c.warn,
      risk: c.risk,
    };
  };

  const metrics: Record<RiskMetricId, RiskMetricState> = {
    blocked,
    idle: clock('idle', raw.idleHours),
    timeInColumn: clock('timeInColumn', raw.timeInColumnHours),
    cycle: clock('cycle', raw.cycleHours),
  };

  const fieldMetrics: Record<string, RiskMetricState> = {};
  for (const entry of fields) {
    fieldMetrics[entry.fieldId] = evaluateFieldMetric(entry, raw.fieldValues, done);
  }

  // Done work is never scored — it would drown the in-flight tickets it's meant
  // to rank against.
  const score = done
    ? null
    : compositeScore(
        [
          ...(['blocked', 'idle', 'timeInColumn', 'cycle'] as const).map(
            (id): CompositeTerm => ({
              score: metrics[id].score,
              weight: composite.weights[id] ?? 1,
            }),
          ),
          ...fields.map(
            (entry): CompositeTerm => ({
              score: fieldMetrics[entry.fieldId]?.score ?? null,
              weight: entry.weight ?? 1,
            }),
          ),
        ],
        composite.p,
      );
  const compositeBand: RiskBand = score == null ? 'none' : band(score, COMP);

  return {
    metrics,
    fieldMetrics,
    composite: { score, band: compositeBand },
    tier: cardTier(metrics, fieldMetrics, compositeBand),
  };
}

/** Worst non-'none' band across the core metrics, the field metrics and the
 *  composite; null = nothing fired. */
export function cardTier(
  metrics: Record<RiskMetricId, RiskMetricState>,
  fieldMetrics: Record<string, RiskMetricState>,
  compositeBand: RiskBand,
): RiskBand | null {
  let worst: Exclude<RiskBand, 'none'> | null = null;
  const consider = (b: RiskBand): void => {
    if (b === 'none') return;
    if (worst === null || RANK[b] > RANK[worst]) worst = b;
  };
  for (const m of Object.values(metrics)) consider(m.band);
  for (const m of Object.values(fieldMetrics)) consider(m.band);
  consider(compositeBand);
  return worst;
}

/** Tickets per tier. Tier-less tickets (done column / all pending) aren't counted. */
export function tierCounts(tiers: (RiskBand | null)[]): RiskTierCounts {
  const c: RiskTierCounts = { risk: 0, warn: 0, ok: 0 };
  for (const t of tiers) {
    if (t === 'risk' || t === 'warn' || t === 'ok') c[t]++;
  }
  return c;
}
