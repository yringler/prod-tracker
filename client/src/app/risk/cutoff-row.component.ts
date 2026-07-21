import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { RiskConfigIssue, RiskWorkSchedule } from '@shared/risk';
import {
  parseSizeValue,
  workHoursPerDay,
  type EditorRow,
  type SizeBucketKey,
} from '@shared/risk-cutoffs';
import { targetValue } from './dom-events';
import { fmtWorkHM } from './format';
import { OptionSelectComponent, type SelectOption } from './option-select.component';

/**
 * One editable cutoff rule.
 *
 * **The selector is an ATTRIBUTE selector on purpose.** `tr[sp-cutoff-row]` makes
 * the host element the `<tr>` itself. An element selector (`<sp-cutoff-row>`)
 * inside a `<tbody>` is not valid table content: the layout collapses and browsers
 * hoist the unknown element out of the table entirely. Do not "simplify" this.
 */
@Component({
  selector: 'tr[sp-cutoff-row]',
  standalone: true,
  imports: [OptionSelectComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <td>
      @if (expandable()) {
        <!-- The disclosure lives ON the column-only rule's row, so the nesting
             literally reads "size refines column" — which IS the specificity order
             the resolver applies. -->
        <wa-button
          size="small"
          appearance="plain"
          [attr.title]="expanded() ? 'Hide the size rules' : 'Show the size rules'"
          (click)="toggle.emit()"
        >
          <wa-icon [attr.name]="expanded() ? 'chevron-down' : 'chevron-right'"></wa-icon>
        </wa-button>
        @if (sizeRuleCount() > 0) {
          <wa-badge appearance="outlined" variant="neutral">{{ sizeRuleLabel() }}</wa-badge>
        }
      }
      <sp-option-select
        [value]="row().column ?? ''"
        [options]="columnOptions()"
        [disabled]="readonly()"
        ariaLabel="Scope (column)"
        (valueChange)="onColumn($event)"
      ></sp-option-select>
      @if (doneIssue(); as issue) {
        <!-- Inline, not only in the bottom callout stack: that stack is index-
             addressed and, once the table is grouped, sits far from the rule it
             describes. -->
        <div class="cap"><wa-badge variant="neutral">{{ issue }}</wa-badge></div>
      }
    </td>
    <td>
      <sp-option-select
        [value]="sizeValue()"
        [options]="sizeOptions()"
        [disabled]="readonly() || sizeDisabled()"
        ariaLabel="Size"
        (valueChange)="onSize($event)"
      ></sp-option-select>
    </td>
    <td>
      <wa-number-input
        size="small"
        min="0"
        [attr.step]="step()"
        [attr.autofocus]="isNew() ? '' : null"
        [attr.disabled]="readonly() ? '' : null"
        [value]="disp(row().warn)"
        (change)="onThreshold('warn', $event)"
      ></wa-number-input>
      <div class="cap">{{ hm(row().warn) }}</div>
    </td>
    <td>
      <wa-number-input
        size="small"
        min="0"
        [attr.step]="step()"
        [attr.disabled]="readonly() ? '' : null"
        [value]="disp(row().risk)"
        (change)="onThreshold('risk', $event)"
      ></wa-number-input>
      <div class="cap">{{ hm(row().risk) }}</div>
    </td>
    <td>
      @if (!readonly()) {
        <wa-button size="small" appearance="plain" title="Remove this rule" (click)="remove.emit()">
          <wa-icon name="xmark"></wa-icon>
        </wa-button>
      }
    </td>
  `,
  styles: [
    `
      .cap {
        font-size: 11px;
        color: var(--muted);
        padding-top: 2px;
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
  /** Set on a group's column-only row: renders the disclosure chevron + the
   *  "N size rules — 1h → 48h" badge that advertises the ladder while collapsed. */
  readonly expandable = input(false);
  readonly expanded = input(false);
  readonly sizeRuleCount = input(0);
  readonly sizeRuleRange = input<string | null>(null);

  readonly scopeChange = output<{ column: string | null; size: SizeBucketKey | null }>();
  readonly thresholdChange = output<{ field: 'warn' | 'risk'; hours: number }>();
  readonly remove = output<void>();
  readonly toggle = output<void>();

  sizeRuleLabel(): string {
    const n = this.sizeRuleCount();
    const range = this.sizeRuleRange();
    return `${n} size rule${n === 1 ? '' : 's'}${range ? ` · ${range}` : ''}`;
  }

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
