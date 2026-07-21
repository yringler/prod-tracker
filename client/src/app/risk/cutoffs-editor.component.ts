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
import type { RiskColumnsResponse, RiskConfigIssue, RiskCutoffs, RiskWorkSchedule } from '@shared/risk';
import {
  CUTOFF_METRICS,
  HARD_FALLBACK,
  SIZE_BUCKET_KEYS,
  type Cutoff,
  type CutoffMetricId,
  type EditorMetricModel,
  type EditorRow,
  type SizeBucketKey,
  collapseCutoffs,
  fromEditorModel,
  resolveCutoff,
  scheduleDaysSummary,
  sizeBucketLabel,
  sortRowsForDisplay,
  toEditorModel,
  validateCutoffs,
  workHoursPerDay,
  workHoursPerWeek,
} from '@shared/risk-cutoffs';
import { fmtWorkHM } from './format';

type Unit = 'hours' | 'days';

/**
 * The Risk-cutoffs editor: a projection over the stored `RiskCutoffs` shape, which
 * is unchanged (the scoring path never sees this file). Every design choice here
 * maps to a specific footgun in the raw-JSON editor it replaces:
 *
 * - **Units.** Numbers are WORK hours, and the caption says so using the org's
 *   effective schedule (`workHoursPerWeek`), so changing the schedule visibly
 *   changes what "24 hours" means. The hours/days toggle stores hours either way.
 * - **Size buckets.** The Size picker shows the point RANGES each bucket captures
 *   ("4–5", "14–20 (and 21+)"), so nobody types `4` meaning "4 points".
 * - **Specificity, not order.** Rows are sorted most-specific-first and there are
 *   no drag handles — the absence IS the lesson. The one real order dependency
 *   (a column-only rule tying with a size-only rule) is surfaced as a warning.
 * - **Blank vs. pasted copy.** A switch makes "follow the shipped defaults"
 *   (stored NULL) a labeled choice rather than an emergent property of an empty
 *   textarea, and says out loud what taking ownership costs.
 *
 * The resolution preview runs the SERVER'S `resolveCutoff` (from
 * `@shared/risk-cutoffs`), so it cannot drift. No ticket data is scored here.
 */
@Component({
  selector: 'sp-risk-cutoffs',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
      <h3>Thresholds</h3>

      <div class="row" style="align-items:center; gap:8px">
        <wa-switch
          [checked]="!custom()"
          (change)="onFollowDefaults($event)"
        >Use the built-in defaults</wa-switch>
      </div>

      @if (!custom()) {
        <p class="muted" style="font-size:12px">
          You're following the shipped defaults; they'll keep improving under you.
          The tables below are read-only until you turn the switch off.
        </p>
      } @else {
        <wa-callout variant="warning" style="margin-top:8px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          You own these thresholds now. Future improvements to the shipped defaults
          will no longer reach this site.
        </wa-callout>
      }

      @if (repairs().length) {
        <wa-callout variant="warning" style="margin-top:8px">
          <wa-icon slot="icon" name="wrench"></wa-icon>
          <strong>We repaired {{ repairs().length }} rule(s) while loading.</strong>
          Nothing is saved until you press Save.
          <ul style="margin:4px 0 0 16px; padding:0">
            @for (r of repairs(); track $index) {
              <li>{{ r.metric }}: {{ r.message }}</li>
            }
          </ul>
        </wa-callout>
      }
      @if (simplified() > 0) {
        <wa-callout variant="neutral" style="margin-top:8px">
          <wa-icon slot="icon" name="broom"></wa-icon>
          Simplified {{ simplified() }} redundant row(s) — the thresholds every
          column and size resolves to are unchanged.
        </wa-callout>
      }
      @if (pointsMissing()) {
        <wa-callout variant="warning" style="margin-top:8px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          No Story Points field is resolved for this site, so every ticket counts as
          <em>Unpointed</em> — size rules will never fire. Pick one in
          <strong>Fields</strong> on this page (or in site admin) first.
        </wa-callout>
      }

      <wa-tab-group [attr.active]="metric()" (wa-tab-show)="onTab($event)">
        @for (m of metrics; track m.id) {
          <wa-tab [attr.panel]="m.id">{{ m.label }}</wa-tab>
        }
        @for (m of metrics; track m.id) {
          <wa-tab-panel [attr.name]="m.id">
            <p class="muted" style="font-size:12px; margin-top:0">{{ m.help }}</p>
          </wa-tab-panel>
        }
      </wa-tab-group>

      <p class="muted units">{{ unitsCaption() }}</p>

      <div class="row" style="align-items:center; gap:8px">
        <wa-radio-group
          orientation="horizontal"
          size="small"
          [attr.value]="unit()"
          (change)="onUnit($event)"
        >
          <wa-radio value="hours">work hours</wa-radio>
          <wa-radio value="days">work days</wa-radio>
        </wa-radio-group>
      </div>

      <table class="cut">
        <thead>
          <tr>
            <th>Scope (column)</th>
            <th>Size</th>
            <th id="th-warn-{{ metric() }}">Warn ≥ <wa-badge appearance="outlined" variant="warning">badge only</wa-badge></th>
            <th id="th-risk-{{ metric() }}">Risk ≥ <wa-badge appearance="outlined" variant="danger">drives the score</wa-badge></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.key) {
            <tr>
              <td>
                <wa-select
                  size="small"
                  [attr.disabled]="!custom() ? '' : null"
                  [value]="row.column ?? ''"
                  (change)="setScope(row, 'column', $event)"
                >
                  <wa-option value="">Any column</wa-option>
                  @for (b of columnGroups(); track b.name) {
                    <wa-divider></wa-divider>
                    <small>{{ b.name }}</small>
                    @for (c of b.columns; track c.name) {
                      <wa-option [value]="c.name" [attr.disabled]="c.done && !showDone() ? '' : null">
                        {{ c.name }}{{ c.done ? ' — Done, never scored' : '' }}
                      </wa-option>
                    }
                  }
                </wa-select>
              </td>
              <td>
                <wa-select
                  size="small"
                  [attr.disabled]="!custom() || pointsMissing() ? '' : null"
                  [value]="row.size === null ? '' : String(row.size)"
                  (change)="setScope(row, 'size', $event)"
                >
                  <wa-option value="">Any size</wa-option>
                  @for (s of sizes; track s) {
                    <wa-option [value]="String(s)">{{ label(s) }}</wa-option>
                  }
                </wa-select>
              </td>
              <td>
                <wa-number-input
                  size="small"
                  min="0"
                  [attr.step]="step()"
                  [attr.disabled]="!custom() ? '' : null"
                  [value]="disp(row.warn)"
                  (change)="setThreshold(row, 'warn', $event)"
                ></wa-number-input>
                <div class="cap">{{ hm(row.warn) }}</div>
              </td>
              <td>
                <wa-number-input
                  size="small"
                  min="0"
                  [attr.step]="step()"
                  [attr.disabled]="!custom() ? '' : null"
                  [value]="disp(row.risk)"
                  (change)="setThreshold(row, 'risk', $event)"
                ></wa-number-input>
                <div class="cap">{{ hm(row.risk) }}</div>
              </td>
              <td>
                @if (custom()) {
                  <wa-button
                    size="small"
                    appearance="plain"
                    title="Remove this rule"
                    (click)="removeRow(row)"
                  ><wa-icon name="xmark"></wa-icon></wa-button>
                }
              </td>
            </tr>
          }
          <tr class="fallback">
            <td>Everything else</td>
            <td>—</td>
            <td>
              <wa-number-input
                size="small"
                min="0"
                [attr.step]="step()"
                [attr.disabled]="!custom() ? '' : null"
                [value]="disp(fallback().warn)"
                (change)="setFallback('warn', $event)"
              ></wa-number-input>
              <div class="cap">{{ hm(fallback().warn) }}</div>
            </td>
            <td>
              <wa-number-input
                size="small"
                min="0"
                [attr.step]="step()"
                [attr.disabled]="!custom() ? '' : null"
                [value]="disp(fallback().risk)"
                (change)="setFallback('risk', $event)"
              ></wa-number-input>
              <div class="cap">{{ hm(fallback().risk) }}</div>
            </td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <wa-tooltip [attr.for]="'th-risk-' + metric()">
        A ticket's score is value ÷ risk, so lowering this raises the composite for
        every matching ticket and can flip the board. "Warn" only paints a badge.
      </wa-tooltip>
      @if (!hasFallback()) {
        <p class="muted" style="font-size:12px">
          This table has no catch-all rule, so anything it doesn't match falls to the
          built-in floor shown above. Editing that row creates the catch-all.
        </p>
      }

      <div class="row" style="gap:8px; margin-top:8px; align-items:center">
        @if (custom()) {
          <wa-button size="small" appearance="outlined" (click)="addRow()">
            <wa-icon slot="start" name="plus"></wa-icon>Add rule
          </wa-button>
        }
        <label class="muted" style="font-size:12px; display:flex; gap:4px; align-items:center">
          <wa-checkbox size="small" [attr.checked]="showDone() ? '' : null" (change)="showDone.set(checked($event))"></wa-checkbox>
          show Done columns
        </label>
      </div>

      @for (w of warnings(); track $index) {
        <wa-callout variant="warning" style="margin-top:8px">
          <wa-icon slot="icon" name="circle-info"></wa-icon>{{ w.message }}
        </wa-callout>
      }
      @for (e of errors(); track $index) {
        <wa-callout variant="danger" style="margin-top:8px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>{{ e.message }}
        </wa-callout>
      }

      <wa-details summary="Test a ticket">
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
          <wa-select size="small" [value]="testColumn()" (change)="testColumn.set(value($event))">
            @for (b of columnGroups(); track b.name) {
              <wa-divider></wa-divider>
              <small>{{ b.name }}</small>
              @for (c of b.columns; track c.name) {
                <wa-option [value]="c.name">{{ c.name }}</wa-option>
              }
            }
            <wa-option value="Some other column">Some other column</wa-option>
          </wa-select>
          <wa-select size="small" [value]="testSize()" (change)="testSize.set(value($event))">
            <wa-option value="none">Unpointed</wa-option>
            @for (s of sizes; track s) {
              @if (s !== 'none') {
                <wa-option [value]="String(s)">{{ label(s) }}</wa-option>
              }
            }
          </wa-select>
          <span>→ <strong>{{ testResult() }}</strong></span>
        </div>
        <p class="muted" style="font-size:12px">
          Computed with the same function the server scores with, on the table above.
        </p>
      </wa-details>

      <wa-details summary="Advanced: edit as JSON">
        <div class="row" style="gap:8px; align-items:center">
          <span class="muted" style="font-size:12px">Current tables (read-only):</span>
          <wa-copy-button [attr.value]="json()"></wa-copy-button>
          <wa-button size="small" appearance="outlined" (click)="importOpen.set(true)">
            Import JSON…
          </wa-button>
        </div>
        <pre class="ref">{{ json() }}</pre>
      </wa-details>
    </div>

    <wa-dialog
      label="Import cutoffs JSON"
      [open]="importOpen()"
      (wa-after-hide)="importOpen.set(false)"
    >
      <wa-textarea
        rows="10"
        placeholder="paste a RiskCutoffs object"
        [value]="importText()"
        (input)="importText.set(value($event))"
      ></wa-textarea>
      @for (i of importIssues(); track $index) {
        <wa-callout [attr.variant]="importOk() ? 'warning' : 'danger'" style="margin-top:8px">
          {{ i.metric ?? '' }} {{ i.message }}
        </wa-callout>
      }
      <wa-button slot="footer" appearance="plain" (click)="importOpen.set(false)">Cancel</wa-button>
      <wa-button slot="footer" variant="brand" (click)="doImport()">Load into the table</wa-button>
    </wa-dialog>

    <wa-dialog
      label="Follow the shipped defaults again?"
      [open]="confirmDefaults()"
      (wa-after-hide)="confirmDefaults.set(false)"
    >
      Discard your customizations and go back to the shipped defaults? Your current
      tables are not saved anywhere else.
      <wa-button slot="footer" appearance="plain" (click)="cancelFollowDefaults()">Keep editing</wa-button>
      <wa-button slot="footer" variant="danger" (click)="applyFollowDefaults()">Discard &amp; follow defaults</wa-button>
    </wa-dialog>
  `,
  styles: [
    `
      table.cut {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
        font-size: 13px;
      }
      table.cut th {
        text-align: left;
        font-weight: 600;
        font-size: 12px;
        color: var(--muted);
        padding: 4px 6px;
        border-bottom: 1px solid var(--line);
      }
      table.cut td {
        padding: 4px 6px;
        vertical-align: top;
        border-bottom: 1px solid var(--line);
      }
      tr.fallback td {
        font-style: italic;
        background: var(--panel);
      }
      .cap {
        font-size: 11px;
        color: var(--muted);
        padding-top: 2px;
      }
      .units {
        font-size: 12px;
        margin-bottom: 4px;
      }
      .ref {
        max-height: 200px;
        overflow: auto;
        font-size: 11px;
        color: var(--muted);
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 6px;
        margin: 6px 0 0;
      }
    `,
  ],
})
export class RiskCutoffsEditorComponent {
  /** The org's stored override; null = following the shipped defaults. */
  readonly cutoffs = input<RiskCutoffs | null>(null);
  readonly defaults = input.required<RiskCutoffs>();
  /** The EFFECTIVE schedule (the org's, or the shipped one) — the units caption is
   *  written from this, not from a hardcoded sentence. */
  readonly schedule = input.required<RiskWorkSchedule>();
  readonly scheduleIsCustom = input(false);
  readonly columns = input<RiskColumnsResponse | null>(null);

  /** null = inherit (stored NULL). Emitted on every edit; the parent saves it. */
  readonly cutoffsChange = output<RiskCutoffs | null>();

  readonly metrics = CUTOFF_METRICS;
  readonly sizes = SIZE_BUCKET_KEYS;

  custom = signal(false);
  metric = signal<CutoffMetricId>('idle');
  unit = signal<Unit>('hours');
  showDone = signal(false);
  model = signal<EditorMetricModel[]>([]);
  repairs = signal<RiskConfigIssue[]>([]);
  simplified = signal(0);
  testColumn = signal('In Progress');
  testSize = signal('none');
  importOpen = signal(false);
  importText = signal('');
  importIssues = signal<RiskConfigIssue[]>([]);
  importOk = signal(false);
  confirmDefaults = signal(false);

  constructor() {
    // Inputs arrive asynchronously (two HTTP calls), so load reactively rather
    // than in ngOnInit.
    effect(() => {
      const stored = this.cutoffs();
      const defaults = this.defaults();
      this.load(stored ?? defaults, stored !== null);
    });
  }

  /** On load we collapse first: `DEFAULT_CUTOFFS.idle` is 64 rules that resolve
   *  identically to 7 (proven exhaustively in worker/test/risk-cutoff-editor.test.ts),
   *  and a 64-row table is unreadable. Never auto-saved — only written if the admin
   *  presses Save. */
  private load(source: RiskCutoffs, custom: boolean): void {
    const collapsed = collapseCutoffs(source);
    const before = count(source);
    const model = toEditorModel(collapsed);
    this.custom.set(custom);
    this.model.set(model);
    this.repairs.set(model.flatMap((m) => m.unrepresentable));
    this.simplified.set(Math.max(0, before - count(collapsed)));
  }

  // --- Derived views ----------------------------------------------------------

  readonly current = computed<RiskCutoffs>(() => fromEditorModel(this.model()));

  readonly active = computed<EditorMetricModel | null>(
    () => this.model().find((m) => m.metric === this.metric()) ?? null,
  );

  readonly rows = computed<EditorRow[]>(() => sortRowsForDisplay(this.active()?.rows ?? []));

  readonly hasFallback = computed(() => this.active()?.fallback != null);

  readonly fallback = computed<Cutoff>(
    () => this.active()?.fallback ?? HARD_FALLBACK[this.metric()],
  );

  readonly pointsMissing = computed(() => this.columns()?.pointsFieldConfigured === false);

  readonly columnGroups = computed(() =>
    (this.columns()?.boards ?? []).map((b) => ({
      name: b.name,
      columns: b.columns.map((c) => ({ name: c, done: c === b.doneColumn })),
    })),
  );

  private readonly ctx = computed(() => ({
    boards: (this.columns()?.boards ?? []).map((b) => ({
      name: b.name,
      columns: b.columns,
      doneColumn: b.doneColumn,
    })),
    ...(this.columns() ? { pointsFieldConfigured: this.columns()!.pointsFieldConfigured } : {}),
  }));

  private readonly validation = computed(() => validateCutoffs(this.current(), this.ctx()));

  readonly warnings = computed(() =>
    this.validation().warnings.filter((w) => w.metric === this.metric()),
  );
  readonly errors = computed(() =>
    this.validation().errors.filter((e) => e.metric === this.metric()),
  );

  readonly json = computed(() => JSON.stringify(this.current(), null, 2));

  /** The units caption, derived from the org's EFFECTIVE schedule — so changing the
   *  schedule visibly changes what "24 hours" means. */
  readonly unitsCaption = computed(() => {
    const s = this.schedule();
    const week = workHoursPerWeek(s);
    const day = workHoursPerDay(s);
    const which = this.scheduleIsCustom() ? 'your week' : 'the built-in schedule';
    return (
      `Hours are WORK hours: ${which} is ${round(week)}h (${scheduleDaysSummary(s)}, ${s.timeZone})` +
      ` ≈ ${round(day)}h per working day. 24h = ${round(24 / day)} working days.`
    );
  });

  readonly testResult = computed(() => {
    const size = this.testSize();
    const points = size === 'none' ? null : Number(size);
    const c = resolveCutoff(this.current(), this.metric(), this.testColumn(), points);
    return `warn ≥ ${fmtWorkHM(c.warn)} · risk ≥ ${fmtWorkHM(c.risk)}`;
  });

  // --- Display helpers --------------------------------------------------------

  label(size: SizeBucketKey): string {
    return sizeBucketLabel(size);
  }
  hm(hours: number): string {
    return fmtWorkHM(hours) ?? '—';
  }
  step(): string {
    return this.unit() === 'days' ? '0.25' : '1';
  }
  /** Values are ALWAYS stored in hours; the toggle only changes what's shown. */
  disp(hours: number): string {
    if (this.unit() === 'hours') return String(hours);
    return String(Math.round((hours / workHoursPerDay(this.schedule())) * 100) / 100);
  }
  private toHours(shown: number): number {
    return this.unit() === 'hours' ? shown : shown * workHoursPerDay(this.schedule());
  }
  value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
  checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  // --- Edits ------------------------------------------------------------------

  onTab(e: Event): void {
    const name = (e as CustomEvent<{ name: string }>).detail?.name;
    if (name) this.metric.set(name as CutoffMetricId);
  }
  onUnit(e: Event): void {
    this.unit.set(this.value(e) === 'days' ? 'days' : 'hours');
  }

  onFollowDefaults(e: Event): void {
    const followDefaults = this.checked(e);
    if (followDefaults) {
      // Losing customizations is destructive — confirm, and put the switch back if
      // they change their mind.
      this.confirmDefaults.set(true);
      return;
    }
    // Taking ownership copies the defaults in; nothing is lost, so no confirm.
    this.load(this.defaults(), true);
    this.emit();
  }
  cancelFollowDefaults(): void {
    this.confirmDefaults.set(false);
    // Re-assert the model so the switch re-renders in its true (off) position.
    this.model.update((m) => [...m]);
  }
  applyFollowDefaults(): void {
    this.confirmDefaults.set(false);
    this.load(this.defaults(), false);
    this.emit();
  }

  addRow(): void {
    const metric = this.metric();
    const base = this.fallback();
    this.patch(metric, (m) => {
      // A fresh row must not collide with an existing scope (which would be a
      // DUPLICATE_SCOPE error), so pick the first free (column, size) slot.
      const taken = new Set(m.rows.map((r) => r.key));
      const cols: (string | null)[] = [null, ...(this.columns()?.boards ?? []).flatMap((b) => b.columns)];
      for (const column of cols) {
        for (const size of [null, ...SIZE_BUCKET_KEYS] as (SizeBucketKey | null)[]) {
          const key = `${metric}:${column ?? '*'}:${size ?? '*'}`;
          if (taken.has(key)) continue;
          return { ...m, rows: [...m.rows, { key, column, size, warn: base.warn, risk: base.risk }] };
        }
      }
      return m;
    });
  }

  removeRow(row: EditorRow): void {
    this.patch(this.metric(), (m) => ({ ...m, rows: m.rows.filter((r) => r.key !== row.key) }));
  }

  setScope(row: EditorRow, field: 'column' | 'size', e: Event): void {
    const raw = this.value(e);
    const metric = this.metric();
    const column = field === 'column' ? (raw || null) : row.column;
    const size: SizeBucketKey | null =
      field === 'size' ? (raw === '' ? null : raw === 'none' ? 'none' : Number(raw)) : row.size;
    const key = `${metric}:${column ?? '*'}:${size ?? '*'}`;
    this.patch(metric, (m) =>
      // Rows are keyed by scope, so a move onto an occupied scope is refused rather
      // than silently producing a duplicate the server would reject.
      m.rows.some((r) => r.key === key && r.key !== row.key)
        ? m
        : { ...m, rows: m.rows.map((r) => (r.key === row.key ? { ...r, key, column, size } : r)) },
    );
  }

  setThreshold(row: EditorRow, field: 'warn' | 'risk', e: Event): void {
    const v = Number(this.value(e));
    if (!Number.isFinite(v)) return;
    const hours = this.toHours(v);
    this.patch(this.metric(), (m) => ({
      ...m,
      rows: m.rows.map((r) => (r.key === row.key ? { ...r, [field]: hours } : r)),
    }));
  }

  setFallback(field: 'warn' | 'risk', e: Event): void {
    const v = Number(this.value(e));
    if (!Number.isFinite(v)) return;
    const hours = this.toHours(v);
    const base = this.fallback();
    this.patch(this.metric(), (m) => ({ ...m, fallback: { ...base, [field]: hours } }));
  }

  private patch(metric: CutoffMetricId, fn: (m: EditorMetricModel) => EditorMetricModel): void {
    if (!this.custom()) return; // read-only while following the defaults
    this.model.update((all) => all.map((m) => (m.metric === metric ? fn(m) : m)));
    this.emit();
  }

  private emit(): void {
    this.cutoffsChange.emit(this.custom() ? this.current() : null);
  }

  // --- JSON import ------------------------------------------------------------

  doImport(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.importText());
    } catch {
      this.importOk.set(false);
      this.importIssues.set([{ code: 'BAD_JSON', message: 'That is not valid JSON.' }]);
      return;
    }
    const { errors, warnings } = validateCutoffs(parsed, this.ctx());
    if (errors.length) {
      // Refuse, and say exactly which rules — the editor is the source of truth
      // once loaded, so a half-imported table would be worse than none.
      this.importOk.set(false);
      this.importIssues.set(errors);
      return;
    }
    this.importOk.set(true);
    this.importIssues.set(warnings);
    this.load(parsed as RiskCutoffs, true);
    this.emit();
    this.importOpen.set(false);
  }
}

function count(c: RiskCutoffs): number {
  return c.idle.length + c.cycle.length + c.timeInColumn.length;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
