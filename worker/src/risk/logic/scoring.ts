// Cutoff resolution + scoring. Ported from the userscript's board blob
// (sizeBucket / HARD_FALLBACK / resolveCutoff / tband / REJ / COMP /
// compositeScore), which sits around the SCRUM_ENGINE markers in RB_BOARD_HTML.
//
// One deliberate change: compositeScore no longer consults the viewer's
// metric-enable/order toggles (`state.on` / `state.order`). The server always
// scores all five metrics in a fixed order, so every viewer sees the same number
// and the snapshot can carry it.

import type { RiskBand, RiskCompositeConfig, RiskCutoffs, RiskMetricId } from '@shared/risk';

/** Story-point buckets the cutoff tables are keyed by. */
export const FIB_BUCKETS = [1, 2, 3, 5, 8, 13, 20] as const;

/** Metrics whose thresholds are column/size-sensitive (the configurable tables). */
export type CutoffMetricId = 'idle' | 'cycle' | 'timeInColumn';

export interface Cutoff {
  warn: number;
  risk: number;
}

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

/** Absolute code-level floor. Guarantees a real {warn,risk} even if config is
 *  missing, malformed, or every matching rule still has null values. */
export const HARD_FALLBACK: Record<CutoffMetricId, Cutoff> = {
  idle: { warn: 24, risk: 72 },
  cycle: { warn: 160, risk: 240 },
  timeInColumn: { warn: 24, risk: 56 },
};

export function sizeBucket(points: number | null): number | 'none' {
  if (points == null) return 'none';
  for (const b of FIB_BUCKETS) if (points <= b) return b;
  return FIB_BUCKETS[FIB_BUCKETS.length - 1] as number; // overflow: clamp to the top bucket
}

/**
 * The {warn, risk} thresholds this ticket resolves to for `metric`.
 * Most specific matching rule first (column+size beats column-only beats
 * size-only beats neither), INDEPENDENT of how rules are ordered in config; a
 * rule only counts if it actually carries real warn+risk numbers. Then the
 * `default` rule, then the hard fallback.
 */
export function resolveCutoff(
  cutoffs: RiskCutoffs | null,
  metric: CutoffMetricId,
  column: string,
  points: number | null,
): Cutoff {
  const rules = cutoffs?.[metric] ?? [];
  const bucket = sizeBucket(points);
  const specificity = (r: { column?: string; size?: number | 'none' }): number =>
    (r.column !== undefined ? 1 : 0) + (r.size !== undefined ? 1 : 0);
  const candidates = rules
    .filter(
      (r) =>
        !r.default &&
        (r.column === undefined || r.column === column) &&
        (r.size === undefined || r.size === bucket),
    )
    .sort((a, b) => specificity(b) - specificity(a));
  for (const r of candidates) {
    if (r.warn != null && r.risk != null) return { warn: r.warn, risk: r.risk };
  }
  const def = rules.find((r) => r.default);
  if (def && def.warn != null && def.risk != null) return { warn: def.warn, risk: def.risk };
  return HARD_FALLBACK[metric];
}

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
