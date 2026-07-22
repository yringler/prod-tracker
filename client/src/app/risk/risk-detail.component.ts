import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { RiskFieldConfigEntry, RiskTicket } from '@shared/risk';
import {
  METRIC_LABELS,
  METRIC_PRIORITY,
  bandVariant,
  fieldThresholdLabel,
  fieldValueLabel,
  fmtWorkHM,
  metricValueLabel,
  thresholdLabel,
} from './format';

interface MetricRow {
  /** A core metric id, or a mapped field's fieldId. */
  id: string;
  label: string;
  value: string;
  band: string;
  thresholds: string | null;
}

// The detail view: the full metric rundown with each ticket's OWN resolved
// warn/risk thresholds, where its time went per column, and linked PRs when the
// org's dev-status probe succeeded. Everything is read straight off the snapshot —
// no client-side scoring (see the plan's read/write split).
//
// The flow-timeline SVG is deliberately not ported yet; the flow data already
// ships in the snapshot, so it's a pure client addition later.
@Component({
  selector: 'sp-risk-detail',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <wa-dialog
      [attr.label]="ticket()?.key ?? ''"
      [open]="ticket() !== null"
      (wa-after-hide)="closed.emit()"
    >
      @if (ticket(); as t) {
        <div>
          <div class="row" style="gap:8px; align-items:baseline">
            <strong>{{ t.summary }}</strong>
          </div>
          <div class="row" style="gap:6px; margin-top:6px; flex-wrap:wrap">
            <wa-tag size="small" appearance="outlined">{{ t.status }} · {{ t.column }}</wa-tag>
            <wa-tag size="small" appearance="outlined">{{ t.type }}</wa-tag>
            @if (t.points !== null) {
              <wa-tag size="small" appearance="outlined">{{ t.points }} pts</wa-tag>
            }
            <wa-tag size="small" appearance="outlined">{{ t.assignee ?? 'Unassigned' }}</wa-tag>
            @if (t.parentKey) {
              <wa-tag size="small" appearance="outlined">parent {{ t.parentKey }}</wa-tag>
            }
          </div>

          <wa-divider></wa-divider>

          <h4 style="margin:0 0 6px">Health</h4>
          <table style="width:100%">
            <tbody>
              @for (m of metrics(); track m.id) {
                <tr>
                  <td style="width:130px">{{ m.label }}</td>
                  <td><wa-tag size="small" [attr.variant]="m.band">{{ m.value }}</wa-tag></td>
                  <td class="muted" style="font-size:12px">{{ m.thresholds }}</td>
                </tr>
              }
              <tr>
                <td>Score</td>
                <td>
                  <wa-tag size="small" [attr.variant]="variant(t.composite.band)">
                    {{ compositeLabel() }}
                  </wa-tag>
                </td>
                <td class="muted" style="font-size:12px">100 = at the risk line</td>
              </tr>
            </tbody>
          </table>

          @if (t.blockedByOpen.length) {
            <p class="muted" style="font-size:12px">Blocked by {{ t.blockedByOpen.join(', ') }}</p>
          }

          @if (t.columnTotals.length) {
            <wa-divider></wa-divider>
            <h4 style="margin:0 0 6px">Where the time went</h4>
            @for (c of t.columnTotals; track c.column) {
              <div style="margin-bottom:6px">
                <div class="row" style="justify-content:space-between; font-size:12px">
                  <span>
                    {{ c.column }}
                    @if (c.visits > 1) {
                      <span class="muted">· {{ c.visits }} visits</span>
                    }
                  </span>
                  <span class="muted">{{ hm(c.hours) }}</span>
                </div>
                <div class="bar">
                  <div
                    class="fill"
                    [style.width.%]="widthPct(c.hours)"
                    [style.background]="barColor(c.column)"
                  ></div>
                </div>
              </div>
            }
            <p class="muted" style="font-size:12px">
              Cycle total {{ hm(t.flow.totalHours) }} of work time (time in Done never counts).
            </p>
          }

          @if (t.prs?.length) {
            <wa-divider></wa-divider>
            <h4 style="margin:0 0 6px">Pull requests</h4>
            @for (pr of t.prs ?? []; track pr.id) {
              <div class="row" style="gap:8px; font-size:13px">
                <wa-tag size="small" appearance="outlined">{{ pr.state }}</wa-tag>
                <a [href]="pr.url" target="_blank" rel="noopener">{{ pr.title || pr.id }}</a>
                <span class="muted">{{ pr.approvals }}/{{ pr.reviewers }} approved</span>
              </div>
            }
          }

          @if (t.recentUpdaters.length) {
            <p class="muted" style="font-size:12px; margin-top:10px">
              Touched in the last 24h by {{ t.recentUpdaters.join(', ') }}.
            </p>
          }
        </div>
      }
      <wa-button slot="footer" appearance="outlined" (click)="closed.emit()">Close</wa-button>
    </wa-dialog>
  `,
  styles: [
    `
      .bar {
        height: 6px;
        border-radius: 3px;
        background: var(--line);
        overflow: hidden;
      }
      .fill {
        height: 100%;
        background: var(--accent);
      }
      td {
        padding: 2px 6px 2px 0;
      }
    `,
  ],
})
export class RiskDetailComponent {
  /** null closes the dialog — the parent owns the selection signal. */
  ticket = input<RiskTicket | null>(null);
  /** The snapshot's field entries — labels for the ticket's fieldMetrics rows.
   *  `[]` on a pre-fields snapshot, whose tickets carry no fieldMetrics either. */
  fields = input<readonly RiskFieldConfigEntry[]>([]);
  closed = output<void>();

  metrics = computed<MetricRow[]>(() => {
    const t = this.ticket();
    if (!t) return [];
    const core: MetricRow[] = METRIC_PRIORITY.map((id) => ({
      id,
      label: METRIC_LABELS[id],
      value: metricValueLabel(id, t),
      band: bandVariant(t.metrics[id].band),
      thresholds: thresholdLabel(id, t),
    }));
    // Field rows render only when the snapshot actually measured them — a legacy
    // snapshot has no fieldMetrics, and showing '—' rows would imply it did.
    const field: MetricRow[] = this.fields()
      .filter((e) => t.fieldMetrics?.[e.fieldId])
      .map((e) => ({
        id: e.fieldId,
        label: e.label,
        value: fieldValueLabel(e, t),
        band: bandVariant(t.fieldMetrics[e.fieldId]!.band),
        thresholds: fieldThresholdLabel(e, t),
      }));
    return [...core, ...field];
  });

  compositeLabel = computed(() => {
    const s = this.ticket()?.composite.score;
    return s == null ? '—' : String(Math.round(s * 100));
  });

  private maxColumnHours = computed(() =>
    Math.max(1, ...(this.ticket()?.columnTotals ?? []).map((c) => c.hours)),
  );

  hm(hours: number | null): string {
    return fmtWorkHM(hours) ?? '—';
  }
  widthPct(hours: number): number {
    return Math.round((hours / this.maxColumnHours()) * 100);
  }

  /** The ticket's CURRENT column is banded by its time-in-column metric (straight
   *  off the snapshot — no client-side cutoff math); columns it has already left
   *  stay neutral, since no band was computed for them. */
  barColor(column: string): string {
    const t = this.ticket();
    if (!t || column !== t.column) return 'var(--accent)';
    const band = t.metrics.timeInColumn.band;
    return band === 'risk' ? 'var(--risk)' : band === 'warn' ? 'var(--warn)' : 'var(--accent)';
  }
  variant(band: string): string {
    return bandVariant(band as 'ok' | 'warn' | 'risk' | 'none');
  }
}
