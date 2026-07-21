import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import type { RiskCompositeConfig, RiskMetricId, RiskWorkSchedule } from '@shared/risk';
import { scheduleDaysSummary, workHoursPerDay, workHoursPerWeek } from '@shared/risk-cutoffs';
import { METRIC_LABELS } from './format';

/** The order the server evaluates in (worker/src/risk/logic/scoring.ts METRIC_ORDER). */
const METRIC_IDS: RiskMetricId[] = ['rejections', 'blocked', 'idle', 'timeInColumn', 'cycle'];

/**
 * The composite half of the risk config: how the five per-metric scores collapse
 * into the one number the board ranks by.
 *
 * Two footguns get first-class UI here:
 * - **`p` is not a number anyone can reason about.** It's the exponent of a power
 *   mean, so it's rendered as a labeled slider between "weighted average" and
 *   "worst metric dominates" rather than as a bare field.
 * - **weight 0 is not the same as blank.** `compositeScore` drops a metric weighted
 *   ≤ 0 entirely, while an ABSENT weight defaults to 1. A 0 therefore renders as an
 *   explicit "Excluded" state, not as "a very small weight".
 */
@Component({
  selector: 'sp-risk-composite',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
      <h3>Composite score</h3>

      <div class="row" style="align-items:center; gap:8px">
        <wa-switch [checked]="!custom()" (change)="onFollowDefaults($event)">
          Use the built-in defaults
        </wa-switch>
      </div>
      @if (custom()) {
        <wa-callout variant="warning" style="margin-top:8px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          You own these weights now — future tuning of the shipped defaults won't
          reach this site.
        </wa-callout>
      } @else {
        <p class="muted" style="font-size:12px">
          Following the shipped defaults (p = {{ value().p }}, every metric weighted
          equally). Turn the switch off to tune them.
        </p>
      }

      <wa-slider
        label="How harshly one bad metric counts"
        min="1"
        max="4"
        step="0.5"
        with-markers
        with-tooltip
        [attr.disabled]="!custom() ? '' : null"
        [attr.value]="value().p"
        (change)="setP($event)"
      >
        <span slot="reference">weighted average</span>
        <span slot="reference">worst metric dominates</span>
      </wa-slider>
      <p class="muted" style="font-size:12px">{{ pCaption() }}</p>

      <table class="w">
        <thead>
          <tr><th>Metric</th><th>Weight</th><th></th></tr>
        </thead>
        <tbody>
          @for (m of metricIds; track m) {
            <tr>
              <td>{{ label(m) }}</td>
              <td>
                <wa-number-input
                  size="small"
                  min="0"
                  step="0.5"
                  [attr.disabled]="!custom() ? '' : null"
                  [value]="String(weight(m))"
                  (change)="setWeight(m, $event)"
                ></wa-number-input>
              </td>
              <td>
                @if (weight(m) <= 0) {
                  <wa-badge variant="neutral">Excluded — not scored at all</wa-badge>
                } @else {
                  <span class="muted" style="font-size:12px">{{ share(m) }}% of the mean</span>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
      <p class="muted" style="font-size:12px">
        A weight of <strong>0</strong> removes the metric from the score entirely —
        which is different from leaving it out of the config, where it defaults to 1.
        Excluded metrics still show on the board; they just stop ranking it.
      </p>
      @if (allExcluded()) {
        <wa-callout variant="danger" style="margin-top:8px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          Every metric is excluded, so no ticket can get a composite score and the
          board would rank by nothing.
        </wa-callout>
      }

      <p class="muted" style="font-size:12px; margin-top:12px">
        <strong>Clock:</strong> {{ clockCaption() }}
      </p>
    </div>
  `,
  styles: [
    `
      table.w {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
        font-size: 13px;
      }
      table.w th {
        text-align: left;
        font-size: 12px;
        color: var(--muted);
        padding: 4px 6px;
        border-bottom: 1px solid var(--line);
      }
      table.w td {
        padding: 4px 6px;
        border-bottom: 1px solid var(--line);
        vertical-align: middle;
      }
    `,
  ],
})
export class RiskCompositeEditorComponent {
  readonly composite = input<RiskCompositeConfig | null>(null);
  readonly defaults = input.required<RiskCompositeConfig>();
  /** The effective work schedule — only to caption what the hours elsewhere mean. */
  readonly schedule = input.required<RiskWorkSchedule>();

  /** null = inherit (stored NULL). */
  readonly compositeChange = output<RiskCompositeConfig | null>();

  readonly metricIds = METRIC_IDS;

  custom = signal(false);
  model = signal<RiskCompositeConfig>({ p: 2, weights: {} });

  constructor() {
    effect(() => {
      const stored = this.composite();
      this.custom.set(stored !== null);
      this.model.set(normalize(stored ?? this.defaults()));
    });
  }

  readonly value = computed(() => this.model());

  readonly allExcluded = computed(() => METRIC_IDS.every((m) => this.weight(m) <= 0));

  readonly pCaption = computed(() => {
    const p = this.model().p;
    if (p <= 1) return 'p = 1: a plain weighted average — five middling metrics rank like one bad one.';
    if (p >= 3.5) return `p = ${p}: the single worst metric almost entirely decides the score.`;
    return `p = ${p}: a bad metric is pulled toward the top of the score rather than averaged away.`;
  });

  readonly clockCaption = computed(() => {
    const s = this.schedule();
    return (
      `every duration on this page is measured on a ${round(workHoursPerWeek(s))} work-hour week ` +
      `(${scheduleDaysSummary(s)}, ${s.timeZone}) ≈ ${round(workHoursPerDay(s))}h per working day.`
    );
  });

  label(id: RiskMetricId): string {
    return METRIC_LABELS[id];
  }

  /** An ABSENT weight means 1 (compositeScore's `?? 1`), so show that, not 0. */
  weight(id: RiskMetricId): number {
    return this.model().weights[id] ?? 1;
  }

  share(id: RiskMetricId): number {
    const total = METRIC_IDS.reduce((sum, m) => sum + Math.max(0, this.weight(m)), 0);
    return total > 0 ? Math.round((this.weight(id) / total) * 100) : 0;
  }

  setP(e: Event): void {
    const p = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(p) || p <= 0) return;
    this.patch((c) => ({ ...c, p }));
  }

  setWeight(id: RiskMetricId, e: Event): void {
    const w = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(w) || w < 0) return;
    this.patch((c) => ({ ...c, weights: { ...c.weights, [id]: w } }));
  }

  onFollowDefaults(e: Event): void {
    const followDefaults = (e.target as HTMLInputElement).checked;
    this.custom.set(!followDefaults);
    this.model.set(normalize(this.defaults()));
    this.emit();
  }

  private patch(fn: (c: RiskCompositeConfig) => RiskCompositeConfig): void {
    if (!this.custom()) return;
    this.model.update(fn);
    this.emit();
  }

  private emit(): void {
    this.compositeChange.emit(this.custom() ? this.model() : null);
  }
}

/** Write every metric's weight out explicitly. Storing the implicit `?? 1` makes
 *  the difference between "absent (=1)" and "0 (excluded)" visible in the JSON the
 *  admin saves, which is the whole point of the Excluded badge. */
function normalize(c: RiskCompositeConfig): RiskCompositeConfig {
  const weights: Partial<Record<RiskMetricId, number>> = {};
  for (const m of METRIC_IDS) weights[m] = c.weights?.[m] ?? 1;
  return { p: Number.isFinite(c.p) && c.p > 0 ? c.p : 1, weights };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
