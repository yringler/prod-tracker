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
  CUTOFF_METRIC_IDS,
  HARD_FALLBACK,
  NO_SUCH_COLUMN,
  SIZE_BUCKET_KEYS,
  type Cutoff,
  type CutoffMetricId,
  type CutoffRowGroup,
  type EditorMetricModel,
  type EditorRow,
  type SizeBucketKey,
  applyScopeChange,
  collapseCutoffs,
  editorRowKey,
  editorRowsInDisplayOrder,
  fromEditorModel,
  groupRowsByColumn,
  resolveCutoff,
  scheduleDaysSummary,
  seedRowFor,
  sizeBucketLabel,
  sortRowsForDisplay,
  toEditorModel,
  validateCutoffs,
  workHoursPerDay,
  workHoursPerWeek,
} from '@shared/risk-cutoffs';
import {
  CutoffGroupComponent,
  type GroupScopeChange,
  type GroupThresholdChange,
} from './cutoff-group.component';
import { targetChecked, targetValue } from './dom-events';
import { fmtWorkHM } from './format';
import { OptionSelectComponent, type SelectOption } from './option-select.component';
import { columnOptions, hasDoneColumnRule, sizeOptions } from './select-options';

type Unit = 'hours' | 'days';

/** Below this many rows a metric's table is small enough to open fully expanded,
 *  so `idle`/`cycle` look exactly as they did before grouping landed. */
const EXPAND_ALL_BELOW = 10;

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
 * - **Specificity, not order.** Rules are grouped BY COLUMN and serialized in
 *   display order, so the nesting is the precedence and what you see is the
 *   tie-break order. There are no drag handles — the absence IS the lesson.
 * - **Blank vs. pasted copy.** A switch makes "follow the shipped defaults"
 *   (stored NULL) a labeled choice rather than an emergent property of an empty
 *   textarea, and says out loud what taking ownership costs.
 *
 * OWNERSHIP: this file owns the MODEL (`model`/`custom`/`load`/`patch`/`emit`), the
 * tabs, the units caption, the fallback row, the callout stack, "Test a ticket" and
 * the JSON dialogs. One rule is `tr[sp-cutoff-row]`; one column group is
 * `tbody[sp-cutoff-group]`; every `<wa-select>` goes through `<sp-option-select>`.
 * State is threaded one way through inputs — deliberately no shared service or
 * store, which would add a file and obscure ownership against the slice's
 * "must be easy to delete" contract.
 *
 * The resolution preview runs the SERVER'S `resolveCutoff` (from
 * `@shared/risk-cutoffs`), so it cannot drift. No ticket data is scored here.
 */
@Component({
  selector: 'sp-risk-cutoffs',
  standalone: true,
  imports: [CutoffGroupComponent, OptionSelectComponent],
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
      @if (simplifiedCaption(); as caption) {
        <wa-callout variant="neutral" style="margin-top:8px">
          <wa-icon slot="icon" name="broom"></wa-icon>
          {{ caption }}
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
      @if (columnsError(); as err) {
        <wa-callout variant="danger" style="margin-top:8px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          Could not load this site's board columns, so the Scope picker has no
          suggestions and the Story-Points check below is inconclusive: {{ err }}
        </wa-callout>
      }
      @if (columnsProbeError(); as err) {
        <wa-callout variant="warning" style="margin-top:8px">
          <wa-icon slot="icon" name="circle-info"></wa-icon>
          One board's columns could not be read from Jira, so its columns are missing
          from the Scope picker: {{ err }}
        </wa-callout>
      }
      @for (b of boardsAwaitingSave(); track b) {
        <wa-callout variant="neutral" style="margin-top:8px">
          <wa-icon slot="icon" name="circle-info"></wa-icon>
          Save to load columns for <strong>{{ b }}</strong> — the column list is read
          from the boards that are already saved.
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
        @for (g of groups(); track groupKey(g)) {
          <tbody
            sp-cutoff-group
            [group]="g"
            [resolvedFallthrough]="fallthroughFor(g)"
            [expanded]="isExpanded(g)"
            [columnOptions]="columnOptionsFor(g.column)"
            [sizeOptions]="sizeOptionList"
            [unit]="unit()"
            [schedule]="schedule()"
            [readonly]="!custom()"
            [sizeDisabled]="pointsMissing()"
            [newRowKey]="newRowKey()"
            [issuesByKey]="issuesByKey()"
            (toggle)="toggleGroup(g)"
            (addRule)="addRow(g.column)"
            (scopeChange)="onScopeChange($event)"
            (thresholdChange)="onThresholdChange($event)"
            (remove)="removeRow($event)"
          ></tbody>
        }
        <tbody>
          <tr class="fallback">
            <td>
              Everything else
              @if (hasFallback()) {
                <wa-badge appearance="outlined" variant="neutral">Yours</wa-badge>
              } @else {
                <wa-badge appearance="outlined" variant="warning">Built-in floor</wa-badge>
              }
            </td>
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
          @if (!hasFallback()) {
            <!-- The explanation belongs ON the row, not in a detached paragraph 40px
                 below it that contradicts it. -->
            <tr class="fallback">
              <td colspan="5" class="cap">
                No catch-all rule is stored, so unmatched tickets use the built-in
                floor. Type a number here to make it yours.
              </td>
            </tr>
          }
        </tbody>
      </table>
      <wa-tooltip [attr.for]="'th-risk-' + metric()">
        A ticket's score is value ÷ risk, so lowering this raises the composite for
        every matching ticket and can flip the board. "Warn" only paints a badge.
      </wa-tooltip>

      <div class="row" style="gap:8px; margin-top:8px; align-items:center">
        @if (custom()) {
          <wa-button size="small" appearance="outlined" (click)="addRow(null)">
            <wa-icon slot="start" name="plus"></wa-icon>Add rule
          </wa-button>
        }
        <label class="muted" style="font-size:12px; display:flex; gap:4px; align-items:center">
          <wa-checkbox size="small" [attr.checked]="showDone() ? '' : null" (change)="onShowDone($event)"></wa-checkbox>
          offer Done columns as choices
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
          <sp-option-select
            [value]="testColumn()"
            [options]="testColumnOptions()"
            ariaLabel="Test column"
            (valueChange)="testColumn.set($event)"
          ></sp-option-select>
          <sp-option-select
            [value]="testSize()"
            [options]="testSizeOptions"
            ariaLabel="Test size"
            (valueChange)="testSize.set($event)"
          ></sp-option-select>
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
  /** The org's stored override; null = following the shipped defaults.
   *
   *  The PARENT must bind its `serverCutoffs` signal here, NOT the draft it
   *  receives from `cutoffsChange` — otherwise this input's effect re-runs `load()`
   *  on our own emit and clobbers the edit mid-keystroke. See risk-admin. */
  readonly cutoffs = input<RiskCutoffs | null>(null);
  readonly defaults = input.required<RiskCutoffs>();
  /** The EFFECTIVE schedule (the org's, or the shipped one) — the units caption is
   *  written from this, not from a hardcoded sentence. */
  readonly schedule = input.required<RiskWorkSchedule>();
  readonly scheduleIsCustom = input(false);
  readonly columns = input<RiskColumnsResponse | null>(null);
  /** Set when `GET /api/admin/risk/columns` FAILED. Without this a failure is
   *  indistinguishable from "this site has no columns", which also silently makes
   *  `pointsMissing()` false. */
  readonly columnsError = input<string | null>(null);
  /** Boards ticked in the picker but not yet saved — their columns cannot appear
   *  until the save, because the endpoint iterates the SAVED board list. */
  readonly boardsAwaitingSave = input<readonly string[]>([]);

  /** null = inherit (stored NULL). Emitted on every edit; the parent saves it. */
  readonly cutoffsChange = output<RiskCutoffs | null>();

  readonly metrics = CUTOFF_METRICS;
  readonly sizeOptionList: readonly SelectOption[] = sizeOptions();
  readonly testSizeOptions: readonly SelectOption[] = [
    { value: 'none', label: 'Unpointed' },
    ...SIZE_BUCKET_KEYS.filter((s) => s !== 'none').map((s) => ({
      value: String(s),
      label: sizeBucketLabel(s),
    })),
  ];

  custom = signal(false);
  metric = signal<CutoffMetricId>('idle');
  unit = signal<Unit>('hours');
  showDone = signal(false);
  model = signal<EditorMetricModel[]>([]);
  repairs = signal<RiskConfigIssue[]>([]);
  simplifiedByMetric = signal<Record<CutoffMetricId, { before: number; after: number }>>(
    emptySimplified(),
  );
  testColumn = signal('In Progress');
  testSize = signal('none');
  importOpen = signal(false);
  importText = signal('');
  importIssues = signal<RiskConfigIssue[]>([]);
  importOk = signal(false);
  confirmDefaults = signal(false);
  /** The row "Add rule" just created — marked so the button has visible feedback
   *  even when the seeded numbers match what was already resolving there. */
  newRowKey = signal<string | null>(null);
  /** Per-group manual expand/collapse, keyed `metric:column`. Absent = the default
   *  rule below decides. Cleared on every load. */
  private manualExpanded = signal<Record<string, boolean>>({});

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
   *  presses Save.
   *
   *  ASSERTION: **collapse runs on LOAD, never on EDIT.** Reachable from exactly
   *  three places — the input effect (a real reload; the parent's `serverCutoffs`
   *  split is what guarantees our own emit can't come back here), the
   *  follow-defaults transitions, and `doImport`. Running it on a model containing
   *  a just-added row WILL DELETE THAT ROW, because a freshly seeded rule is
   *  redundant by construction (`seedRowFor` seeds it to what its scope already
   *  resolves to). `repairs()`/`simplifiedByMetric()` are therefore load-time facts
   *  and stop re-announcing per keystroke, and the O(n²)-to-a-fixpoint equivalence
   *  probe stops running on every keystroke. */
  private load(source: RiskCutoffs, custom: boolean): void {
    const collapsed = collapseCutoffs(source);
    const model = toEditorModel(collapsed);
    this.custom.set(custom);
    this.model.set(model);
    this.repairs.set(model.flatMap((m) => m.unrepresentable));
    const simplified = emptySimplified();
    for (const metric of CUTOFF_METRIC_IDS) {
      simplified[metric] = { before: source[metric].length, after: collapsed[metric].length };
    }
    this.simplifiedByMetric.set(simplified);
    this.manualExpanded.set({});
    this.newRowKey.set(null);
    // A table that plainly contains a Done-column rule must not sit next to a
    // toggle that reads "off" — that is the same self-contradiction as an
    // "Everything else" row whose caption denies it exists.
    this.showDone.set(
      model.some((m) => hasDoneColumnRule(m.rows, this.boards())),
    );
  }

  // --- Derived views ----------------------------------------------------------

  /** Serialized in DISPLAY order, deliberately: for a column-only/size-only tie the
   *  resolver's winner is decided by array position, so this makes what you see the
   *  tie-break order. See `editorRowsInDisplayOrder`. */
  readonly current = computed<RiskCutoffs>(() =>
    fromEditorModel(editorRowsInDisplayOrder(this.model())),
  );

  readonly active = computed<EditorMetricModel | null>(
    () => this.model().find((m) => m.metric === this.metric()) ?? null,
  );

  /** Display order — and, since `current()` serializes in this order, also the
   *  order the stored array will hold, so a `RiskConfigIssue.index` addresses
   *  `rows()[index]`. */
  readonly rows = computed<EditorRow[]>(() => sortRowsForDisplay(this.active()?.rows ?? []));

  readonly hasFallback = computed(() => this.active()?.fallback != null);

  readonly fallback = computed<Cutoff>(
    () => this.active()?.fallback ?? HARD_FALLBACK[this.metric()],
  );

  readonly pointsMissing = computed(() => this.columns()?.pointsFieldConfigured === false);

  readonly columnsProbeError = computed(() => this.columns()?.probeError ?? null);

  private readonly boards = computed(() =>
    (this.columns()?.boards ?? []).map((b) => ({
      name: b.name,
      columns: b.columns,
      doneColumn: b.doneColumn,
    })),
  );

  /** Board column order — the order the groups render in. */
  private readonly columnOrder = computed(() => {
    const seen: string[] = [];
    for (const b of this.boards()) for (const c of b.columns) if (!seen.includes(c)) seen.push(c);
    return seen;
  });

  readonly groups = computed<CutoffRowGroup[]>(() =>
    groupRowsByColumn(this.rows(), this.columnOrder()),
  );

  private readonly ctx = computed(() => ({
    boards: this.boards(),
    ...(this.columns() ? { pointsFieldConfigured: this.columns()!.pointsFieldConfigured } : {}),
  }));

  private readonly validation = computed(() => validateCutoffs(this.current(), this.ctx()));

  /** Issues addressed to a specific rule, keyed by the row they belong to — so a
   *  group holding one can be force-expanded and the row can badge it inline. */
  readonly issuesByKey = computed<Record<string, RiskConfigIssue[]>>(() => {
    const rows = this.rows();
    const out: Record<string, RiskConfigIssue[]> = {};
    const v = this.validation();
    for (const issue of [...v.errors, ...v.warnings]) {
      if (issue.metric !== this.metric() || issue.index === undefined) continue;
      const row = rows[issue.index];
      if (!row) continue;
      (out[row.key] ??= []).push(issue);
    }
    return out;
  });

  /** NO_DEFAULT is deliberately dropped from the rendered stack for the ACTIVE
   *  metric: the "Everything else" row now states the same fact inline, next to the
   *  numbers it is about. A named filter here, NOT a weakening of `validateCutoffs`
   *  — the worker runs that same validator and must keep emitting the warning. */
  readonly warnings = computed(() =>
    this.validation().warnings.filter(
      (w) => w.metric === this.metric() && w.code !== 'NO_DEFAULT',
    ),
  );
  readonly errors = computed(() =>
    this.validation().errors.filter((e) => e.metric === this.metric()),
  );

  readonly json = computed(() => JSON.stringify(this.current(), null, 2));

  /** The active metric's own before/after — the old caption counted across all
   *  THREE metrics (137 → 47) while reading as if it described the visible table. */
  readonly simplifiedCaption = computed<string | null>(() => {
    const mine = this.simplifiedByMetric()[this.metric()];
    const others = CUTOFF_METRIC_IDS.filter(
      (m) => m !== this.metric() && this.simplifiedByMetric()[m].before > this.simplifiedByMetric()[m].after,
    ).length;
    const tail = others === 1 ? ' One other table was simplified too.' : others > 1 ? ` ${others} other tables were simplified too.` : '';
    if (mine.before <= mine.after) return others ? tail.trim() : null;
    if (!this.custom()) {
      // Display-only: while the switch is on nothing here can ever be saved.
      return `The shipped defaults are shown simplified (${mine.before} rules → ${mine.after}); the stored defaults are unchanged.${tail}`;
    }
    return (
      `Simplified this table from ${mine.before} rules to ${mine.after} — every column and size still` +
      ` resolves to the same thresholds. Nothing is saved until you press Save.${tail}`
    );
  });

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

  readonly testColumnOptions = computed<SelectOption[]>(() => [
    ...columnOptions(this.boards(), { value: this.testColumn(), showDone: true }).filter(
      (o) => o.value !== '',
    ),
    { value: 'Some other column', label: 'Some other column' },
  ]);

  readonly testResult = computed(() => {
    const size = this.testSize();
    const points = size === 'none' ? null : Number(size);
    const c = resolveCutoff(this.current(), this.metric(), this.testColumn(), points);
    return `warn ≥ ${fmtWorkHM(c.warn)} · risk ≥ ${fmtWorkHM(c.risk)}`;
  });

  // --- Grouping / disclosure --------------------------------------------------

  groupKey(g: CutoffRowGroup): string {
    return `${this.metric()}:${g.column ?? '*'}`;
  }

  /** A group's own column-only fall-through: what a ticket in this column resolves
   *  to when the group has no rule of its own. */
  fallthroughFor(g: CutoffRowGroup): Cutoff {
    return resolveCutoff(this.current(), this.metric(), g.column ?? NO_SUCH_COLUMN, null);
  }

  columnOptionsFor(current: string | null): SelectOption[] {
    return columnOptions(this.boards(), { value: current ?? '', showDone: this.showDone() });
  }

  /**
   * Default expansion: open when the group is a one-liner, or when the whole
   * metric is small — so `idle`/`cycle` render exactly as they did before grouping
   * and there is no new interaction to learn on the two tables that were fine.
   * `timeInColumn` (33 rows) opens as 7 collapsed column groups.
   *
   * FORCE-EXPAND any group holding a flagged rule: a callout pointing at a rule the
   * admin cannot see is a message with no referent.
   */
  isExpanded(g: CutoffRowGroup): boolean {
    const manual = this.manualExpanded()[this.groupKey(g)];
    if (manual !== undefined) return manual;
    if (this.hasIssue(g)) return true;
    return g.sizeRows.length <= 1 || this.rows().length < EXPAND_ALL_BELOW;
  }

  private hasIssue(g: CutoffRowGroup): boolean {
    const issues = this.issuesByKey();
    const keys = [...(g.headerRow ? [g.headerRow.key] : []), ...g.sizeRows.map((r) => r.key)];
    return keys.some((k) => (issues[k]?.length ?? 0) > 0);
  }

  toggleGroup(g: CutoffRowGroup): void {
    const key = this.groupKey(g);
    const next = !this.isExpanded(g);
    this.manualExpanded.update((m) => ({ ...m, [key]: next }));
  }

  // --- Display helpers --------------------------------------------------------

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
    return targetValue(e);
  }

  // --- Edits ------------------------------------------------------------------

  onTab(e: Event): void {
    const name = (e as CustomEvent<{ name: string }>).detail?.name;
    if (name) this.metric.set(name as CutoffMetricId);
  }
  onUnit(e: Event): void {
    this.unit.set(targetValue(e) === 'days' ? 'days' : 'hours');
  }
  onShowDone(e: Event): void {
    this.showDone.set(targetChecked(e));
  }

  onFollowDefaults(e: Event): void {
    const followDefaults = targetChecked(e);
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

  /**
   * Add a rule, optionally pre-scoped to a column (a group's "Add a rule" passes
   * its own column; the global button passes null and lands in "Any column").
   *
   * Two things used to be wrong here and both are fixed:
   * 1. The row was collapsed away again immediately, because `emit()` fed the
   *    parent, which fed `[cutoffs]` back in, which re-ran `load()` → collapse.
   *    Fixed STRUCTURALLY by the parent's serverCutoffs/cutoffs split; collapse is
   *    now load-only. The new row IS redundant in the collapse sense — that is
   *    correct and intended (see 2), so do NOT re-add collapse-on-emit.
   * 2. It seeded from `fallback()`, which is provably wrong whenever a column rule
   *    already covers the scope: the rule then changes every matching ticket's
   *    thresholds the instant it appears. `seedRowFor` seeds from what the new
   *    row's OWN scope resolves to today, so **adding a rule changes no resolution
   *    until you type in it.**
   */
  addRow(column: string | null = null): void {
    const metric = this.metric();
    const current = this.current();
    this.patch(metric, (m) => {
      const taken = new Set(m.rows.map((r) => r.key));
      // Within a column, prefer a free SIZE bucket — that refinement is what the
      // group is for — and fall back to the column-only slot.
      const cols: (string | null)[] =
        column === null ? [null, ...this.columnOrder()] : [column];
      const sizes: (SizeBucketKey | null)[] =
        column === null ? [null, ...SIZE_BUCKET_KEYS] : [...SIZE_BUCKET_KEYS, null];
      for (const col of cols) {
        for (const size of sizes) {
          const key = editorRowKey(metric, col, size);
          if (taken.has(key)) continue;
          const seed = seedRowFor(current, metric, col, size);
          this.newRowKey.set(key);
          // Make sure the admin can actually SEE the row that just appeared.
          if (col !== null) {
            this.manualExpanded.update((x) => ({ ...x, [`${metric}:${col}`]: true }));
          }
          return { ...m, rows: [...m.rows, { key, column: col, size, ...seed }] };
        }
      }
      return m;
    });
  }

  removeRow(row: EditorRow): void {
    this.patch(this.metric(), (m) => ({ ...m, rows: m.rows.filter((r) => r.key !== row.key) }));
  }

  onScopeChange(e: GroupScopeChange): void {
    this.patch(this.metric(), (m) => applyScopeChange(m, e.row.key, e.column, e.size));
  }

  onThresholdChange(e: GroupThresholdChange): void {
    this.patch(this.metric(), (m) => ({
      ...m,
      rows: m.rows.map((r) => (r.key === e.row.key ? { ...r, [e.field]: e.hours } : r)),
    }));
  }

  setFallback(field: 'warn' | 'risk', e: Event): void {
    const v = Number(targetValue(e));
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

function emptySimplified(): Record<CutoffMetricId, { before: number; after: number }> {
  return {
    idle: { before: 0, after: 0 },
    cycle: { before: 0, after: 0 },
    timeInColumn: { before: 0, after: 0 },
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
