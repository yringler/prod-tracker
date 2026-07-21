// Presentation helpers for the risk board. Pure, no Angular — the board and the
// detail modal share them. No scoring or banding happens here: the snapshot ships
// every value, band and threshold already computed (see worker/src/risk/logic).

import type { RiskBand, RiskMetricId, RiskTicket } from '@shared/risk';
import { WORK_HOURS_PER_DAY } from '@shared/risk-cutoffs';

/** A "day" here is one 8-hour WORK day, matching the work-hours-only clock the
 *  metrics are measured in. Ported from the userscript's fmtWorkHM; the constant
 *  now lives in @shared/risk-cutoffs so the admin editor's unit toggle and this
 *  formatter can't disagree about what "1d" means. */
export const HOURS_PER_WORKDAY = WORK_HOURS_PER_DAY;

export function fmtWorkHM(hours: number | null | undefined): string | null {
  if (hours == null) return null;
  const minsPerDay = HOURS_PER_WORKDAY * 60;
  let mins = Math.round(hours * 60);
  const d = Math.floor(mins / minsPerDay);
  mins -= d * minsPerDay;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/**
 * A stored threshold (always WORK HOURS) as the cutoffs editor's units toggle is
 * currently showing it. In `hours` mode this is plain `fmtWorkHM`, the same string
 * the caption under every number input shows; in `days` mode it is the fractional
 * work-day value the input itself holds, so the collapsed rule summaries can never
 * disagree with the control they expand into.
 */
export function fmtThreshold(
  hours: number,
  unit: 'hours' | 'days',
  hoursPerDay: number,
): string {
  if (unit === 'days') return `${Math.round((hours / hoursPerDay) * 100) / 100}d`;
  return fmtWorkHM(hours) ?? '—';
}

export const METRIC_LABELS: Record<RiskMetricId, string> = {
  blocked: 'Blocked',
  idle: 'Last movement',
  timeInColumn: 'In column',
  cycle: 'Cycle',
  rejections: 'Rejections',
};

/** Actionability order (arch §11): which firing metric to read first. */
export const METRIC_PRIORITY: RiskMetricId[] = [
  'blocked',
  'idle',
  'timeInColumn',
  'cycle',
  'rejections',
];

export interface MetricPill {
  id: RiskMetricId;
  label: string;
  text: string;
  band: RiskBand;
}

/** The short pill text for one metric — the "why is this flagged" phrase. */
export function metricText(id: RiskMetricId, t: RiskTicket): string {
  switch (id) {
    case 'blocked':
      return t.blockedByOpen.length ? `blocked · ${t.blockedByOpen.join(', ')}` : 'blocked';
    case 'idle':
      return `idle ${fmtWorkHM(t.idleHours) ?? '—'}`;
    case 'timeInColumn':
      return `in ${t.column} ${fmtWorkHM(t.timeInColumnHours) ?? '—'}`;
    case 'cycle':
      return `cycle ${fmtWorkHM(t.cycleHours) ?? '—'}`;
    case 'rejections': {
      const n = typeof t.metrics.rejections.value === 'number' ? t.metrics.rejections.value : 0;
      return `${n} rejection${n === 1 ? '' : 's'}`;
    }
  }
}

/** Only the metrics currently firing (warn/risk), worst-actionable first. A healthy
 *  row shows none — the list's length is the signal. */
export function firingMetrics(t: RiskTicket): MetricPill[] {
  return METRIC_PRIORITY.filter((id) => {
    const b = t.metrics[id].band;
    return b === 'warn' || b === 'risk';
  }).map((id) => ({
    id,
    label: METRIC_LABELS[id],
    text: metricText(id, t),
    band: t.metrics[id].band,
  }));
}

/** Web Awesome variant for a band (used on wa-tag pills). */
export function bandVariant(band: RiskBand | null): 'danger' | 'warning' | 'neutral' {
  return band === 'risk' ? 'danger' : band === 'warn' ? 'warning' : 'neutral';
}

/** "just now" / "7m ago" / "3h ago" / "2d ago" for the snapshot's computedAt. */
export function sinceLabel(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Threshold caption for the detail view, straight from the ticket's own resolved
 *  cutoffs — never recomputed client-side. */
export function thresholdLabel(id: RiskMetricId, t: RiskTicket): string | null {
  const m = t.metrics[id];
  if (m.warn == null || m.risk == null) return null;
  if (id === 'rejections') return `warn ≥ ${m.warn} · risk ≥ ${m.risk}`;
  return `warn ≥ ${fmtWorkHM(m.warn)} · risk ≥ ${fmtWorkHM(m.risk)}`;
}

/** Raw display value for the detail view's metric rundown. */
export function metricValueLabel(id: RiskMetricId, t: RiskTicket): string {
  const m = t.metrics[id];
  if (id === 'blocked') return m.value ? 'Yes' : 'No';
  if (id === 'rejections') return String(m.value ?? 0);
  if (!t.started) return 'not started';
  return fmtWorkHM(typeof m.value === 'number' ? m.value : null) ?? '—';
}
