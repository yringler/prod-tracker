import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { RiskConfigIssue, RiskWorkSchedule } from '@shared/risk';
import type { Cutoff, CutoffRowGroup, EditorRow, SizeBucketKey } from '@shared/risk-cutoffs';
import { CutoffRowComponent } from './cutoff-row.component';
import { fmtWorkHM } from './format';
import type { SelectOption } from './option-select.component';

export interface GroupScopeChange {
  row: EditorRow;
  column: string | null;
  size: SizeBucketKey | null;
}
export interface GroupThresholdChange {
  row: EditorRow;
  field: 'warn' | 'risk';
  hours: number;
}

/**
 * One column's rules, as a collapsible disclosure group.
 *
 * **The selector is an attribute selector on a `<tbody>`** — a table may contain
 * several `<tbody>` elements, which is exactly the "one group = several `<tr>`s"
 * shape needed here. (An element selector inside a table breaks the layout; see
 * `cutoff-row.component.ts`.)
 *
 * The nesting is the point: a size row inside a column group beats that group's
 * header row, which beats the "Any column" group, which beats the pinned fallback.
 * The old flat list asserted that precedence typographically; here it is
 * structural.
 */
@Component({
  selector: 'tbody[sp-cutoff-group]',
  standalone: true,
  imports: [CutoffRowComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (group().headerRow; as header) {
      <tr
        sp-cutoff-row
        [row]="header"
        [columnOptions]="columnOptions()"
        [sizeOptions]="sizeOptions()"
        [unit]="unit()"
        [schedule]="schedule()"
        [readonly]="readonly()"
        [sizeDisabled]="sizeDisabled()"
        [isNew]="newRowKey() === header.key"
        [issues]="issuesFor(header)"
        [expandable]="group().sizeRows.length > 0"
        [expanded]="expanded()"
        [sizeRuleCount]="group().sizeRows.length"
        [sizeRuleRange]="rangeLabel()"
        (scopeChange)="scopeChange.emit({ row: header, ...$event })"
        (thresholdChange)="thresholdChange.emit({ row: header, ...$event })"
        (remove)="remove.emit(header)"
        (toggle)="toggle.emit()"
      ></tr>
    } @else {
      <!-- No column-only rule. Do NOT render an empty input pair here: a blank row
           the admin can type into would imply a stored rule that does not exist —
           the same "the row contradicts its own caption" defect this repair is
           about. State the fall-through instead, and offer to create the rule. -->
      <tr class="grp-empty">
        <td>
          @if (group().sizeRows.length) {
            <wa-button
              size="small"
              appearance="plain"
              [attr.title]="expanded() ? 'Hide the size rules' : 'Show the size rules'"
              (click)="toggle.emit()"
            >
              <wa-icon [attr.name]="expanded() ? 'chevron-down' : 'chevron-right'"></wa-icon>
            </wa-button>
          }
          <strong>{{ columnLabel() }}</strong>
          @if (!group().known) {
            <wa-badge variant="warning">not on any configured board</wa-badge>
          }
        </td>
        <td class="cap">{{ group().sizeRows.length }} size rule(s)</td>
        <td class="cap" colspan="2">
          no rule for the column itself — falls through to
          <strong>{{ fallthroughLabel() }}</strong>
        </td>
        <td>
          @if (!readonly()) {
            <wa-button size="small" appearance="plain" title="Add a rule for this column" (click)="addRule.emit()">
              <wa-icon name="plus"></wa-icon>
            </wa-button>
          }
        </td>
      </tr>
    }

    @if (expanded()) {
      @for (r of group().sizeRows; track r.key) {
        <tr
          sp-cutoff-row
          class="size-row"
          [row]="r"
          [columnOptions]="columnOptions()"
          [sizeOptions]="sizeOptions()"
          [unit]="unit()"
          [schedule]="schedule()"
          [readonly]="readonly()"
          [sizeDisabled]="sizeDisabled()"
          [isNew]="newRowKey() === r.key"
          [issues]="issuesFor(r)"
          (scopeChange)="scopeChange.emit({ row: r, ...$event })"
          (thresholdChange)="thresholdChange.emit({ row: r, ...$event })"
          (remove)="remove.emit(r)"
        ></tr>
      }
      @if (!readonly()) {
        <tr class="grp-add">
          <td colspan="5">
            <wa-button size="small" appearance="plain" (click)="addRule.emit()">
              <wa-icon slot="start" name="plus"></wa-icon>Add a rule for {{ columnLabel() }}
            </wa-button>
          </td>
        </tr>
      }
    }
  `,
  styles: [
    `
      .size-row td:first-child {
        padding-left: 22px;
      }
      .cap {
        font-size: 11px;
        color: var(--muted);
      }
      .grp-empty td,
      .grp-add td {
        padding: 4px 6px;
        border-bottom: 1px solid var(--line);
      }
    `,
  ],
})
export class CutoffGroupComponent {
  readonly group = input.required<CutoffRowGroup>();
  readonly resolvedFallthrough = input.required<Cutoff>();
  readonly expanded = input(false);
  readonly columnOptions = input.required<readonly SelectOption[]>();
  readonly sizeOptions = input.required<readonly SelectOption[]>();
  readonly unit = input<'hours' | 'days'>('hours');
  readonly schedule = input.required<RiskWorkSchedule>();
  readonly readonly = input(false);
  readonly sizeDisabled = input(false);
  readonly newRowKey = input<string | null>(null);
  readonly issuesByKey = input<Record<string, RiskConfigIssue[]>>({});

  readonly toggle = output<void>();
  readonly addRule = output<void>();
  readonly scopeChange = output<GroupScopeChange>();
  readonly thresholdChange = output<GroupThresholdChange>();
  readonly remove = output<EditorRow>();

  readonly columnLabel = computed(() => this.group().column ?? 'Any column');

  /** "1h → 48h" — advertises that the collapsed group is a real size ladder rather
   *  than a repeat of the header. */
  readonly rangeLabel = computed<string | null>(() => {
    const rows = this.group().sizeRows;
    if (rows.length < 2) return null;
    const warns = rows.map((r) => r.warn);
    const lo = fmtWorkHM(Math.min(...warns));
    const hi = fmtWorkHM(Math.max(...warns));
    return lo && hi && lo !== hi ? `${lo} → ${hi}` : null;
  });

  readonly fallthroughLabel = computed(() => {
    const c = this.resolvedFallthrough();
    return `warn ≥ ${fmtWorkHM(c.warn) ?? '—'} · risk ≥ ${fmtWorkHM(c.risk) ?? '—'}`;
  });

  issuesFor(row: EditorRow): RiskConfigIssue[] {
    return this.issuesByKey()[row.key] ?? [];
  }
}
