// Cutoff resolution + scoring. Ported from the userscript's board blob
// (sizeBucket / HARD_FALLBACK / resolveCutoff / tband / REJ / COMP /
// compositeScore), which sits around the SCRUM_ENGINE markers in RB_BOARD_HTML.
//
// One deliberate change: compositeScore no longer consults the viewer's
// metric-enable/order toggles (`state.on` / `state.order`). The server always
// scores every metric in a fixed order, so every viewer sees the same number
// and the snapshot can carry it.

import type { RiskBand, RiskMetricId } from '@shared/risk';
import type { Cutoff } from '@shared/risk-cutoffs';

// Cutoff RESOLUTION moved to @shared/risk-cutoffs so the admin editor's "which rule
// wins" preview runs the server's own function and cannot drift. Re-exported here
// so every existing worker import (and worker/test/risk-scoring.test.ts) is
// unchanged — this file is still the one place the scoring path imports from.
export {
  FIB_BUCKETS,
  HARD_FALLBACK,
  resolveCutoff,
  sizeBucket,
  type Cutoff,
  type CutoffMetricId,
} from '@shared/risk-cutoffs';

/** The four built-in metrics, in the order the server evaluates them.
 *  Admin-mapped field metrics score after these, in config order. */
export const METRIC_ORDER: readonly RiskMetricId[] = [
  'blocked',
  'idle',
  'timeInColumn',
  'cycle',
];

/** Fixed thresholds for the composite: 1.0 = "at the risk line". */
export const COMP: Cutoff = { warn: 0.7, risk: 1.0 };

/** The blob's `tband`: at-or-past risk → 'risk', at-or-past warn → 'warn', else 'ok'. */
export function band(v: number, t: Cutoff): Exclude<RiskBand, 'none'> {
  return v >= t.risk ? 'risk' : v >= t.warn ? 'warn' : 'ok';
}

/** One contribution to the composite: a metric's score and its configured weight.
 *  Callers pass core metrics with `cfg.weights[id] ?? 1` and field metrics with
 *  `entry.weight ?? 1`. */
export interface CompositeTerm {
  score: number | null;
  weight: number;
}

/**
 * Weighted power mean of the per-metric scores: `(Σ w·max(0,s)^p / Σw)^(1/p)`.
 * Each score is value/risk (1.0 = at the risk line), so size/column sensitivity
 * is already baked in. Null scores (no data) are excluded; a term weighted <= 0
 * is excluded too. Null when nothing contributed.
 */
export function compositeScore(terms: readonly CompositeTerm[], p: number): number | null {
  const exp = p > 0 ? p : 1;
  let wsum = 0;
  let acc = 0;
  let any = false;
  for (const t of terms) {
    if (t.score == null || t.weight <= 0) continue;
    any = true;
    wsum += t.weight;
    acc += t.weight * Math.pow(Math.max(0, t.score), exp);
  }
  if (!any || wsum === 0) return null;
  return Math.pow(acc / wsum, 1 / exp);
}
