import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { RiskConfigIssue, RiskWorkSchedule } from '@shared/risk';
import {
  parseSizeValue,
  sizeBucketLabel,
  workHoursPerDay,
  type EditorRow,
  type SizeBucketKey,
} from '@shared/risk-cutoffs';
import { targetValue } from './dom-events';
import { fmtThreshold, fmtWorkHM } from './format';
import { OptionSelectComponent, type SelectOption } from './option-select.component';

/**
 * One cutoff rule, as a **summary line that expands into a vertical form**.
 *
 * COLLAPSED it is a sentence — "In Progress · points 4–5 — warn after 5h 00m, risk
 * after 9h 00m" — so a metric's whole table reads as a short list of statements you
 * can scan. EXPANDED it is one field per ROW (scope, size, warn, risk, remove),
 * which is what let the old 5-column table go: two number inputs do not need half a
 * viewport, and the horizontal form was unreadable below ~1100px.
 *
 * **The selector is an ELEMENT selector**, which it could not be while this was a
 * `<tr>` inside a `<tbody>` (browsers hoist an unknown element out of a table). The
 * host is a plain block; the container is a `<div>`, so this is valid markup.
 *
 * The disclosure is hand-rolled rather than a `<wa-details>` on purpose: a flagged
 * rule must be **force-open and stay open** (a callout may never point at a rule the
 * admin cannot see), and `wa-details` owns its own `open` state and animates it, so
 * re-asserting `open` from a `wa-hide` handler fights the component. `open()` here
 * is `forcedOpen() || userOpen()`, which cannot be closed away.
 */
@Component({
  selector: 'sp-cutoff-row',
  standalone: true,
  imports: [OptionSelectComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rule" [class.open]="open()" [class.flagged]="issues().length > 0">
      <div class="head">
        <button
          type="button"
          class="disclose"
          [attr.aria-expanded]="open()"
          [attr.title]="forcedOpen() ? 'This rule needs attention, so it stays open' : null"
          (click)="toggleOpen()"
        >
          <wa-icon [attr.name]="open() ? 'chevron-down' : 'chevron-right'"></wa-icon>
          <span class="sentence">{{ summary() }}</span>
        </button>

        @if (unknownColumn()) {
          <wa-badge appearance="outlined" variant="warning">not on any configured board</wa-badge>
        }
        @if (doneIssue(); as issue) {
          <wa-badge appearance="outlined" variant="neutral">{{ issue }}</wa-badge>
        }
        @if (isNew()) {
          <wa-badge appearance="outlined" variant="brand">new</wa-badge>
        }

        @if (expandable() && sizeRuleCount() > 0) {
          <!-- The LADDER toggle, distinct from this rule's own disclosure: it opens
               the size rules nested under this column, which is the specificity
               order the resolver applies. -->
          <wa-button
            class="ladder"
            size="small"
            appearance="plain"
            [attr.title]="expanded() ? 'Hide the size rules' : 'Show the size rules'"
            (click)="toggle.emit()"
          >
            {{ sizeRuleLabel() }}
            <wa-icon slot="end" [attr.name]="expanded() ? 'chevron-down' : 'chevron-right'"></wa-icon>
          </wa-button>
        }
      </div>

      @if (open()) {
        <div class="fields">
          <div class="frow">
            <span class="lbl">Scope (column)</span>
            <span class="ctl">
              <sp-option-select
                [value]="row().column ?? ''"
                [options]="columnOptions()"
                [disabled]="readonly()"
                ariaLabel="Scope (column)"
                (valueChange)="onColumn($event)"
              ></sp-option-select>
            </span>
          </div>

          <div class="frow">
            <span class="lbl">Size</span>
            <span class="ctl">
              <sp-option-select
                [value]="sizeValue()"
                [options]="sizeOptions()"
                [disabled]="readonly() || sizeDisabled()"
                ariaLabel="Size"
                (valueChange)="onSize($event)"
              ></sp-option-select>
            </span>
          </div>

          <div class="frow">
            <span class="lbl">
              Warn ≥ <wa-badge appearance="outlined" variant="warning">badge only</wa-badge>
            </span>
            <span class="ctl">
              <wa-number-input
                size="small"
                min="0"
                [attr.step]="step()"
                [attr.autofocus]="isNew() ? '' : null"
                [attr.disabled]="readonly() ? '' : null"
                [value]="disp(row().warn)"
                (change)="onThreshold('warn', $event)"
              ></wa-number-input>
              <span class="cap">{{ hm(row().warn) }}</span>
            </span>
          </div>

          <div class="frow">
            <span class="lbl">
              Risk ≥ <wa-badge appearance="outlined" variant="danger">drives the score</wa-badge>
            </span>
            <span class="ctl">
              <wa-number-input
                size="small"
                min="0"
                [attr.step]="step()"
                [attr.disabled]="readonly() ? '' : null"
                [value]="disp(row().risk)"
                (change)="onThreshold('risk', $event)"
              ></wa-number-input>
              <span class="cap">{{ hm(row().risk) }}</span>
            </span>
          </div>

          @for (i of issues(); track $index) {
            <div class="frow">
              <span class="lbl"></span>
              <span class="ctl issue">{{ i.message }}</span>
            </div>
          }

          @if (!readonly()) {
            <div class="frow">
              <span class="lbl"></span>
              <span class="ctl">
                <wa-button size="small" appearance="outlined" variant="danger" (click)="remove.emit()">
                  <wa-icon slot="start" name="xmark"></wa-icon>Remove this rule
                </wa-button>
              </span>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .rule {
        border-bottom: 1px solid var(--line);
        padding: 2px 0;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .disclose {
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        background: none;
        border: 0;
        padding: 4px 2px;
        text-align: left;
        font: inherit;
        font-size: 13px;
        color: inherit;
        cursor: pointer;
      }
      .disclose:hover .sentence {
        text-decoration: underline;
      }
      .rule.flagged .sentence {
        font-weight: 600;
      }
      .fields {
        padding: 4px 0 8px 22px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .frow {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .lbl {
        flex: 0 0 auto;
        width: 190px;
        font-size: 12px;
        color: var(--muted);
      }
      .ctl {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .cap {
        font-size: 11px;
        color: var(--muted);
      }
      .issue {
        font-size: 12px;
        color: var(--muted);
      }
    `,
  ],
})
export class CutoffRowComponent {
  readonly row = input.required<EditorRow>();
  readonly columnOptions = input.required<readonly SelectOption[]>();
  readonly sizeOptions = input.required<readonly SelectOption[]>();
  readonly unit = input<'hours' | 'days'>('hours');
  readonly schedule = input.required<RiskWorkSchedule>();
  readonly readonly = input(false);
  readonly sizeDisabled = input(false);
  readonly isNew = input(false);
  readonly issues = input<readonly RiskConfigIssue[]>([]);
  /** True only when we HOLD board columns and this rule's column isn't among them —
   *  never when the column list is simply unknown. */
  readonly unknownColumn = input(false);
  /** Set on a group's column-only rule: renders the LADDER toggle with its
   *  "8 size rules · warn 1h 00m → 4d 4h 00m" summary. */
  readonly expandable = input(false);
  readonly expanded = input(false);
  readonly sizeRuleCount = input(0);
  readonly sizeRuleRange = input<string | null>(null);
  /** Inside a column group the column is the group's own heading, so a size rule's
   *  sentence names only its size. */
  readonly sizeOnly = input(false);

  readonly scopeChange = output<{ column: string | null; size: SizeBucketKey | null }>();
  readonly thresholdChange = output<{ field: 'warn' | 'risk'; hours: number }>();
  readonly remove = output<void>();
  readonly toggle = output<void>();

  /** The admin's own open/closed state for this rule's form. */
  private readonly userOpen = signal(false);

  /** A rule carrying an error/warning, and a rule that was just added, are open and
   *  CANNOT be closed — the callout stack and the "Add rule" button would otherwise
   *  point at something invisible. */
  readonly forcedOpen = computed(() => this.issues().length > 0 || this.isNew());
  readonly open = computed(() => this.forcedOpen() || this.userOpen());

  toggleOpen(): void {
    this.userOpen.update((v) => !v);
  }

  sizeRuleLabel(): string {
    const n = this.sizeRuleCount();
    const range = this.sizeRuleRange();
    return `${n} size rule${n === 1 ? '' : 's'}${range ? ` · ${range}` : ''}`;
  }

  /** The collapsed line. Plain language, and it follows the units toggle — the
   *  summary and the control it expands into must never disagree. */
  readonly summary = computed(
    () =>
      `${this.scopeText()} — warn after ${this.t(this.row().warn)}, risk after ${this.t(this.row().risk)}`,
  );

  readonly scopeText = computed(() => {
    const r = this.row();
    const size = r.size === null ? null : sizePhrase(r.size);
    if (this.sizeOnly()) return size ?? 'Any size';
    const column = r.column ?? 'Any column';
    return size ? `${column} · ${size}` : column;
  });

  readonly sizeValue = computed(() => {
    const size = this.row().size;
    return size === null ? '' : String(size);
  });

  readonly doneIssue = computed(
    () => this.issues().find((i) => i.code === 'DONE_COLUMN_RULE')?.message ?? null,
  );

  step(): string {
    return this.unit() === 'days' ? '0.25' : '1';
  }

  /** Values are ALWAYS stored in hours; the toggle only changes what's shown. */
  disp(hours: number): string {
    if (this.unit() === 'hours') return String(hours);
    return String(Math.round((hours / workHoursPerDay(this.schedule())) * 100) / 100);
  }

  hm(hours: number): string {
    return fmtWorkHM(hours) ?? '—';
  }

  private t(hours: number): string {
    return fmtThreshold(hours, this.unit(), workHoursPerDay(this.schedule()));
  }

  onColumn(raw: string): void {
    this.scopeChange.emit({ column: raw === '' ? null : raw, size: this.row().size });
  }

  onSize(raw: string): void {
    const size = parseSizeValue(raw);
    // REJECT, don't coerce: `undefined` means "not a bucket". Writing it would
    // produce a value the validator later 400s on (the old `Number(null) === 0`).
    if (size === undefined) return;
    this.scopeChange.emit({ column: this.row().column, size });
  }

  onThreshold(field: 'warn' | 'risk', e: Event): void {
    const shown = Number(targetValue(e));
    if (!Number.isFinite(shown)) return;
    const hours =
      this.unit() === 'hours' ? shown : shown * workHoursPerDay(this.schedule());
    this.thresholdChange.emit({ field, hours });
  }
}

/** "Unpointed" / "points 4–5" — the bucket as the point RANGE it captures, phrased
 *  so no label needs a plural ("1 points", "14–20 (and 21+) points"). */
function sizePhrase(size: SizeBucketKey): string {
  return size === 'none' ? 'Unpointed' : `points ${sizeBucketLabel(size)}`;
}
