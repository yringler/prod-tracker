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
  workHoursPerDay,
  type Cutoff,
  type CutoffRowGroup,
  type EditorRow,
  type SizeBucketKey,
} from '@shared/risk-cutoffs';
import { CutoffRowComponent } from './cutoff-row.component';
import { fmtThreshold } from './format';
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
 * One column's rules, as a stack of summary lines.
 *
 * **The selector is an ELEMENT selector.** It was `tbody[sp-cutoff-group]` while the
 * editor was a 5-column table; the table is gone (a rule is now a sentence that
 * expands into a vertical form — see `cutoff-row.component.ts`), so the host is a
 * plain block inside a `<div>`, which is both valid and simpler.
 *
 * The nesting is the point: a size rule inside a column group beats that group's
 * column-only rule, which beats the "Any column" group, which beats the pinned
 * fallback. The old flat list asserted that precedence typographically; here it is
 * structural.
 */
@Component({
  selector: 'sp-cutoff-group',
  standalone: true,
  imports: [CutoffRowComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (group().headerRow; as header) {
      <sp-cutoff-row
        [row]="header"
        [columnOptions]="columnOptions()"
        [sizeOptions]="sizeOptions()"
        [unit]="unit()"
        [schedule]="schedule()"
        [readonly]="readonly()"
        [sizeDisabled]="sizeDisabled()"
        [isNew]="newRowKey() === header.key"
        [issues]="issuesFor(header)"
        [unknownColumn]="unknownColumn()"
        [expandable]="group().sizeRows.length > 0"
        [expanded]="expanded()"
        [sizeRuleCount]="group().sizeRows.length"
        [sizeRuleRange]="rangeLabel()"
        (scopeChange)="scopeChange.emit({ row: header, ...$event })"
        (thresholdChange)="thresholdChange.emit({ row: header, ...$event })"
        (remove)="remove.emit(header)"
        (toggle)="toggle.emit()"
      ></sp-cutoff-row>
    } @else {
      <!-- No column-only rule. Do NOT render an empty pair of inputs here: a blank
           form the admin can type into would imply a stored rule that does not
           exist. State the fall-through instead, and offer to create the rule. -->
      <div class="empty">
        <span class="sentence">
          <strong>{{ columnLabel() }}</strong> — no rule for the column itself; falls
          through to {{ fallthroughLabel() }}
        </span>
        @if (unknownColumn()) {
          <wa-badge appearance="outlined" variant="warning">not on any configured board</wa-badge>
        }
        @if (group().sizeRows.length) {
          <wa-button
            size="small"
            appearance="plain"
            [attr.title]="expanded() ? 'Hide the size rules' : 'Show the size rules'"
            (click)="toggle.emit()"
          >
            {{ sizeRuleLabel() }}
            <wa-icon slot="end" [attr.name]="expanded() ? 'chevron-down' : 'chevron-right'"></wa-icon>
          </wa-button>
        }
        @if (!readonly()) {
          <wa-button size="small" appearance="plain" title="Add a rule for this column" (click)="addRule.emit()">
            <wa-icon name="plus"></wa-icon>
          </wa-button>
        }
      </div>
    }

    @if (expanded()) {
      <div class="ladder">
        @for (r of group().sizeRows; track r.key) {
          <sp-cutoff-row
            [row]="r"
            [sizeOnly]="true"
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
          ></sp-cutoff-row>
        }
        @if (!readonly()) {
          <div class="add">
            <wa-button size="small" appearance="plain" (click)="addRule.emit()">
              <wa-icon slot="start" name="plus"></wa-icon>Add a rule for {{ columnLabel() }}
            </wa-button>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .empty {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        padding: 6px 2px;
        font-size: 13px;
        border-bottom: 1px solid var(--line);
      }
      .empty .sentence {
        flex: 1 1 auto;
        color: var(--muted);
      }
      .empty strong {
        color: var(--ink);
      }
      .ladder {
        padding-left: 22px;
      }
      .add {
        padding: 2px 0;
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
  /** Whether we hold any board columns at all. With none, `group().known` is false
   *  for EVERY column — which says nothing about the columns and everything about
   *  our own ignorance, so the badge must not be drawn. */
  readonly columnsKnown = input(false);

  readonly toggle = output<void>();
  readonly addRule = output<void>();
  readonly scopeChange = output<GroupScopeChange>();
  readonly thresholdChange = output<GroupThresholdChange>();
  readonly remove = output<EditorRow>();

  readonly columnLabel = computed(() => this.group().column ?? 'Any column');

  /** Only a claim we can actually support: we have board data AND this column is
   *  not in it. */
  readonly unknownColumn = computed(() => this.columnsKnown() && !this.group().known);

  /** "warn 1h 00m → 4d 4h 00m" — advertises that the collapsed ladder is a real
   *  progression rather than a repeat of the column rule. Follows the units toggle. */
  readonly rangeLabel = computed<string | null>(() => {
    const rows = this.group().sizeRows;
    if (rows.length < 2) return null;
    const warns = rows.map((r) => r.warn);
    const lo = this.t(Math.min(...warns));
    const hi = this.t(Math.max(...warns));
    return lo !== hi ? `warn ${lo} → ${hi}` : null;
  });

  sizeRuleLabel(): string {
    const n = this.group().sizeRows.length;
    const range = this.rangeLabel();
    return `${n} size rule${n === 1 ? '' : 's'}${range ? ` · ${range}` : ''}`;
  }

  readonly fallthroughLabel = computed(() => {
    const c = this.resolvedFallthrough();
    return `warn after ${this.t(c.warn)}, risk after ${this.t(c.risk)}`;
  });

  issuesFor(row: EditorRow): RiskConfigIssue[] {
    return this.issuesByKey()[row.key] ?? [];
  }

  private t(hours: number): string {
    return fmtThreshold(hours, this.unit(), workHoursPerDay(this.schedule()));
  }
}
