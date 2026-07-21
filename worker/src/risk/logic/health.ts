// The HEALTH registry's semantics, server-side. Ports the blob's HEALTH entries +
// metricValue + cardTier + tierCounts into one pass that produces the `metrics`,
// `composite` and `tier` fields of a RiskTicket.
//
// Rules preserved verbatim from the userscript (arch §10):
//   - A DONE-COLUMN ticket registers band 'none' / score null on every metric and
//     has a null composite and null tier — its raw values still display
//     ("keep showing, stop flagging"). It is excluded from the tier counts.
//   - A NOT-STARTED ticket has band 'none' / score null on idle, in-column and
//     cycle (those clocks haven't begun); rejections and blocked still apply.
//   - `rejections` reads 0 when absent and bands 'ok' at 0; `blocked` is binary
//     (score 1/0, band risk/ok).
//   - A ticket's tier is the worst non-'none' band across the metrics AND the
//     composite (the composite is one of the enabled metrics upstream).

import type {
  RiskBand,
  RiskCompositeConfig,
  RiskCutoffs,
  RiskMetricId,
  RiskMetricState,
  RiskTierCounts,
} from '@shared/risk';
import { COMP, REJ, band, compositeScore, resolveCutoff } from './scoring';

/** The raw per-ticket values the metrics are computed from. */
export interface HealthInput {
  column: string;
  points: number | null;
  rejections: number | null;
  blocked: boolean;
  started: boolean;
  idleHours: number | null;
  timeInColumnHours: number | null;
  cycleHours: number | null;
}

export interface HealthResult {
  metrics: Record<RiskMetricId, RiskMetricState>;
  composite: { score: number | null; band: RiskBand };
  tier: RiskBand | null;
}

const RANK: Record<Exclude<RiskBand, 'none'>, number> = { ok: 1, warn: 2, risk: 3 };

/** The board treats its LAST column as done — by position, not by Jira's category. */
export function isDoneColumn(column: string, columns: string[]): boolean {
  return columns.length > 0 && column === columns[columns.length - 1];
}

export function evaluateTicket(
  raw: HealthInput,
  cutoffs: RiskCutoffs | null,
  composite: RiskCompositeConfig,
  columns: string[],
): HealthResult {
  const done = isDoneColumn(raw.column, columns);

  const rejections = raw.rejections ?? 0;
  const rej: RiskMetricState = {
    value: rejections,
    band: done ? 'none' : rejections > 0 ? band(rejections, REJ) : 'ok',
    score: done ? null : rejections / REJ.risk,
    warn: REJ.warn,
    risk: REJ.risk,
  };

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
    rejections: rej,
    blocked,
    idle: clock('idle', raw.idleHours),
    timeInColumn: clock('timeInColumn', raw.timeInColumnHours),
    cycle: clock('cycle', raw.cycleHours),
  };

  // Done work is never scored — it would drown the in-flight tickets it's meant
  // to rank against.
  const score = done
    ? null
    : compositeScore(
        {
          rejections: metrics.rejections.score,
          blocked: metrics.blocked.score,
          idle: metrics.idle.score,
          timeInColumn: metrics.timeInColumn.score,
          cycle: metrics.cycle.score,
        },
        composite,
      );
  const compositeBand: RiskBand = score == null ? 'none' : band(score, COMP);

  return {
    metrics,
    composite: { score, band: compositeBand },
    tier: cardTier(metrics, compositeBand),
  };
}

/** Worst non-'none' band across the metrics and the composite; null = nothing fired. */
export function cardTier(
  metrics: Record<RiskMetricId, RiskMetricState>,
  compositeBand: RiskBand,
): RiskBand | null {
  let worst: Exclude<RiskBand, 'none'> | null = null;
  const consider = (b: RiskBand): void => {
    if (b === 'none') return;
    if (worst === null || RANK[b] > RANK[worst]) worst = b;
  };
  for (const m of Object.values(metrics)) consider(m.band);
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
