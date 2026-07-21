// Cutoff resolution + scoring. Ported from the userscript's board blob
// (sizeBucket / HARD_FALLBACK / resolveCutoff / tband / REJ / COMP /
// compositeScore), which sits around the SCRUM_ENGINE markers in RB_BOARD_HTML.
//
// One deliberate change: compositeScore no longer consults the viewer's
// metric-enable/order toggles (`state.on` / `state.order`). The server always
// scores all five metrics in a fixed order, so every viewer sees the same number
// and the snapshot can carry it.

import type { RiskBand, RiskCompositeConfig, RiskMetricId } from '@shared/risk';
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

/** The five metrics, in the order the server evaluates them. */
export const METRIC_ORDER: readonly RiskMetricId[] = [
  'rejections',
  'blocked',
  'idle',
  'timeInColumn',
  'cycle',
];

/** Fixed thresholds for the two metrics with no config table. */
export const REJ: Cutoff = { warn: 2, risk: 4 }; // code-review rejections (count)
export const COMP: Cutoff = { warn: 0.7, risk: 1.0 }; // composite: 1.0 = "at the risk line"

/** The blob's `tband`: at-or-past risk → 'risk', at-or-past warn → 'warn', else 'ok'. */
export function band(v: number, t: Cutoff): Exclude<RiskBand, 'none'> {
  return v >= t.risk ? 'risk' : v >= t.warn ? 'warn' : 'ok';
}

/**
 * Weighted power mean of the per-metric scores: `(Σ w·max(0,s)^p / Σw)^(1/p)`.
 * Each score is value/risk (1.0 = at the risk line), so size/column sensitivity
 * is already baked in. Null scores (no data) are excluded; a metric weighted <= 0
 * is excluded too. Null when nothing contributed.
 */
export function compositeScore(
  scores: Partial<Record<RiskMetricId, number | null>>,
  cfg: RiskCompositeConfig,
): number | null {
  const p = cfg.p > 0 ? cfg.p : 1;
  let wsum = 0;
  let acc = 0;
  let any = false;
  for (const id of METRIC_ORDER) {
    const s = scores[id];
    if (s == null) continue;
    const w = cfg.weights[id] ?? 1;
    if (w <= 0) continue;
    any = true;
    wsum += w;
    acc += w * Math.pow(Math.max(0, s), p);
  }
  if (!any || wsum === 0) return null;
  return Math.pow(acc / wsum, 1 / p);
}
