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
import type { RiskConfigIssue, RiskFieldConfigEntry, RiskFieldMeta } from '@shared/risk';
import { validateFieldEntries } from '@shared/risk-fields';
import { targetChecked, targetValue } from './dom-events';
import { FieldPickerComponent } from './field-picker.component';

/** One row of the editor. Thresholds/weight are kept as TEXT while editing — a
 *  half-typed number must not snap to 0 — and parsed on emit; the shared
 *  validator then flags whatever doesn't parse. */
interface FieldRow {
  label: string;
  fieldId: string;
  kind: 'count' | 'flag';
  warnText: string;
  riskText: string;
  weightText: string;
}

/** Thresholds a fresh count entry starts at — the old hardcoded rejections pair,
 *  as a seed the admin is expected to edit. */
const SEED_WARN = 2;
const SEED_RISK = 4;

/**
 * `<sp-risk-fields>` — the generic field-mapping list that replaced the four
 * fixed slots. Each row maps one Jira field, under an admin-given label, into
 * its own composite-score metric: `count` fields (Jira schema.type `number`)
 * band against per-row warn/risk; everything else is an on/off flag.
 *
 * Kind is copied from the picked `RiskFieldMeta.kind` AT SELECTION TIME and
 * stored on the entry, so scoring stays stable even if discovery later changes.
 *
 * Same controlled-on-load / uncontrolled-after-mount contract as the cutoffs
 * editor: the parent binds its SERVER entries (written on load and successful
 * save only), never the draft it gets back from `(entriesChange)` — one signal
 * for both would feed every keystroke back into the input effect and clobber
 * the edit.
 */
@Component({
  selector: 'sp-risk-fields',
  standalone: true,
  imports: [FieldPickerComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (row of rows(); track $index; let i = $index) {
      <div class="entry">
        <div class="grid">
          <wa-input
            size="small"
            placeholder="label, e.g. Rejections"
            aria-label="metric label"
            [value]="row.label"
            (input)="patch(i, { label: inputValue($event) })"
          ></wa-input>
          <sp-field-picker
            [fields]="fields()"
            [value]="row.fieldId"
            ariaLabel="Jira field"
            (valueChange)="pickField(i, $event)"
          ></sp-field-picker>
          <div class="col">
            @if (row.fieldId) {
              <wa-badge [attr.variant]="row.kind === 'count' ? 'brand' : 'neutral'">
                {{ row.kind === 'count' ? 'counts toward score' : 'on/off flag' }}
              </wa-badge>
            }
            @if (row.kind === 'count') {
              <label class="mini">warn at
                <wa-number-input
                  size="small"
                  min="0"
                  without-steppers
                  aria-label="warn threshold"
                  [value]="row.warnText"
                  (input)="patch(i, { warnText: inputValue($event) })"
                ></wa-number-input>
              </label>
              <label class="mini">risk at
                <wa-number-input
                  size="small"
                  min="0"
                  without-steppers
                  aria-label="risk threshold"
                  [value]="row.riskText"
                  (input)="patch(i, { riskText: inputValue($event) })"
                ></wa-number-input>
              </label>
              <label class="mini">weight
                <wa-number-input
                  size="small"
                  min="0"
                  step="0.5"
                  without-steppers
                  aria-label="composite weight"
                  [value]="row.weightText"
                  (input)="patch(i, { weightText: inputValue($event) })"
                ></wa-number-input>
              </label>
            } @else {
              <label class="mini">include in score
                <wa-switch
                  size="small"
                  aria-label="include this flag in the composite score"
                  [checked]="flagIncluded(row)"
                  (change)="patch(i, { weightText: toggled($event) ? '1' : '0' })"
                ></wa-switch>
              </label>
            }
          </div>
          <wa-button
            size="small"
            appearance="plain"
            variant="danger"
            aria-label="remove this field"
            (click)="remove(i)"
          >
            <wa-icon name="trash"></wa-icon>
          </wa-button>
        </div>
        @for (issue of issuesFor(i); track issue.message) {
          <p class="err">{{ issue.message }}</p>
        }
      </div>
    } @empty {
      <p class="muted" style="font-size:12px">
        No fields mapped. The four built-in metrics still score; add a field to
        turn a Jira signal (a rejection counter, a flag, a label) into its own
        metric under your label.
      </p>
    }
    @for (issue of listIssues(); track issue.message) {
      <p class="err">{{ issue.message }}</p>
    }
    <wa-button size="small" appearance="outlined" (click)="add()">+ Add field</wa-button>
  `,
  styles: [
    `
      .entry {
        border-top: 1px solid var(--line);
        padding: 8px 0;
      }
      .grid {
        display: grid;
        grid-template-columns: 180px minmax(200px, 1fr) auto auto;
        gap: 8px;
        align-items: start;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: flex-start;
      }
      .mini {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      /* \`wa-number-input\` spends ~58px on chrome before a digit renders (host/base
         inline padding + the input's own 14+14px), and each stepper button costs
         another 34px. At the original 90px WITH steppers the input was squeezed to
         exactly its own padding — a 0px content box, \`overflow: clip\`, every value
         invisible. Keep \`without-steppers\` on these, and keep width - 58 >= ~40px. */
      .mini wa-number-input {
        width: 110px;
      }
      .err {
        color: var(--risk);
        font-size: 12px;
        margin: 4px 0 0;
      }
    `,
  ],
})
export class RiskFieldsEditorComponent {
  /** The SERVER's entries — the parent must never feed the draft back in here. */
  readonly entries = input.required<readonly RiskFieldConfigEntry[]>();
  /** All of the site's Jira fields, for the picker + kind resolution. */
  readonly fields = input.required<readonly RiskFieldMeta[]>();

  readonly entriesChange = output<RiskFieldConfigEntry[]>();

  rows = signal<FieldRow[]>([]);

  constructor() {
    effect(() => {
      this.rows.set(this.entries().map(toRow));
    });
  }

  /** The shared validator over the CURRENT draft — the same function the server
   *  runs on PUT, so an error shown here is exactly an error that would 400. */
  private readonly validation = computed(() => validateFieldEntries(this.draftEntries()));

  readonly draftEntries = computed<RiskFieldConfigEntry[]>(() => this.rows().map(toEntry));

  issuesFor(index: number): RiskConfigIssue[] {
    return this.validation().errors.filter((i) => i.index === index);
  }
  /** Issues not anchored to a row (e.g. the entry cap). */
  listIssues = computed<RiskConfigIssue[]>(() =>
    this.validation().errors.filter((i) => i.index === undefined),
  );

  inputValue(e: Event): string {
    return targetValue(e);
  }

  toggled(e: Event): boolean {
    return targetChecked(e);
  }

  /** Flag inclusion: blank weight defaults to 1 (matches toEntry), else weight > 0. */
  flagIncluded(row: FieldRow): boolean {
    const t = row.weightText.trim();
    if (t === '') return true;
    const n = Number(t);
    return Number.isFinite(n) ? n > 0 : true;
  }

  add(): void {
    this.rows.update((rows) => [
      ...rows,
      { label: '', fieldId: '', kind: 'flag', warnText: '', riskText: '', weightText: '1' },
    ]);
    this.emit();
  }

  remove(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
    this.emit();
  }

  patch(index: number, change: Partial<FieldRow>): void {
    this.rows.update((rows) => rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
    this.emit();
  }

  /** Kind is resolved from the picked field's schema-derived kind RIGHT HERE and
   *  travels on the entry; count rows get the seed thresholds if blank. */
  pickField(index: number, fieldId: string): void {
    const meta = this.fields().find((f) => f.id === fieldId);
    this.rows.update((rows) =>
      rows.map((r, i) => {
        if (i !== index) return r;
        const kind = meta?.kind ?? r.kind;
        return {
          ...r,
          fieldId,
          kind,
          label: r.label || (meta?.name ?? ''),
          warnText: kind === 'count' ? r.warnText || String(SEED_WARN) : '',
          riskText: kind === 'count' ? r.riskText || String(SEED_RISK) : '',
        };
      }),
    );
    this.emit();
  }

  private emit(): void {
    this.entriesChange.emit(this.draftEntries());
  }
}

function toRow(e: RiskFieldConfigEntry): FieldRow {
  return {
    label: e.label,
    fieldId: e.fieldId,
    kind: e.kind,
    warnText: e.warn !== undefined ? String(e.warn) : '',
    riskText: e.risk !== undefined ? String(e.risk) : '',
    weightText: e.weight !== undefined ? String(e.weight) : '1',
  };
}

/** Text → entry. Non-numbers are OMITTED (not coerced to 0) so the shared
 *  validator can name the actual problem. Weight 1 is written explicitly — same
 *  "make the default visible" choice as the composite editor's normalize(). */
function toEntry(r: FieldRow): RiskFieldConfigEntry {
  const num = (t: string): number | undefined => {
    const trimmed = t.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  };
  const warn = num(r.warnText);
  const risk = num(r.riskText);
  const weight = num(r.weightText) ?? 1;
  return {
    label: r.label.trim(),
    fieldId: r.fieldId,
    kind: r.kind,
    ...(r.kind === 'count' && warn !== undefined ? { warn } : {}),
    ...(r.kind === 'count' && risk !== undefined ? { risk } : {}),
    weight,
  };
}
