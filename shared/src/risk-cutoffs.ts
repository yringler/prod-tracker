// Sprint Risk Board — cutoff RESOLUTION + the config-editing vocabulary around it.
//
// Why this lives in shared/ (a deliberate narrowing of two documented rules):
// `shared/CLAUDE.md` used to say risk.ts is wire-types-only and the board's logic
// "has exactly one consumer"; `client/CLAUDE.md` says "No risk math happens
// client-side". Both were written for the SNAPSHOT READ PATH, which is unchanged —
// the snapshot still ships every computed ticket value and the client still never
// scores a ticket. What moved here is the *config* half: resolving which cutoff
// rule wins, and validating/normalizing a cutoff table. The admin editor has to
// answer "which rule wins for this column+size" interactively, and the only way it
// can't drift from the server is to run the server's own function.
//
// The narrowed rule: **no scoring of ticket data client-side; config-editing math
// is shared.**
//
// Pure and framework-free (no worker/client imports, no date-fns needed).
// Deletable with the feature: `rm shared/src/risk-cutoffs.ts` + its barrel line.

import type {
  RiskConfigIssue,
  RiskCutoffRule,
  RiskCutoffs,
  RiskWeekday,
  RiskWorkSchedule,
} from './risk';

/** Story-point buckets the cutoff tables are keyed by. */
export const FIB_BUCKETS = [1, 2, 3, 5, 8, 13, 20] as const;

/** Metrics whose thresholds are column/size-sensitive (the configurable tables). */
export type CutoffMetricId = 'idle' | 'cycle' | 'timeInColumn';

export interface Cutoff {
  warn: number;
  risk: number;
}

/** Absolute code-level floor. Guarantees a real {warn,risk} even if config is
 *  missing, malformed, or every matching rule still has null values. */
export const HARD_FALLBACK: Record<CutoffMetricId, Cutoff> = {
  idle: { warn: 24, risk: 72 },
  cycle: { warn: 160, risk: 240 },
  timeInColumn: { warn: 24, risk: 56 },
};

export function sizeBucket(points: number | null): number | 'none' {
  if (points == null) return 'none';
  for (const b of FIB_BUCKETS) if (points <= b) return b;
  return FIB_BUCKETS[FIB_BUCKETS.length - 1] as number; // overflow: clamp to the top bucket
}

/**
 * The {warn, risk} thresholds this ticket resolves to for `metric`.
 * Most specific matching rule first (column+size beats column-only beats
 * size-only beats neither), INDEPENDENT of how rules are ordered in config; a
 * rule only counts if it actually carries real warn+risk numbers. Then the
 * `default` rule, then the hard fallback.
 *
 * CAVEAT (see `ambiguousPairs`): column-only and size-only rules score the SAME
 * specificity, and `Array.prototype.sort` is stable — so when both match one
 * ticket, array position decides. That is a real, if rare, order dependency.
 */
export function resolveCutoff(
  cutoffs: RiskCutoffs | null,
  metric: CutoffMetricId,
  column: string,
  points: number | null,
): Cutoff {
  return resolveRules(cutoffs?.[metric] ?? [], column, sizeBucket(points)) ?? HARD_FALLBACK[metric];
}

/** The body of `resolveCutoff`, over one metric's rule list and an already-computed
 *  bucket. `null` = nothing matched, so the caller applies `HARD_FALLBACK`. Exists
 *  so `collapseRedundantRules` can prove equivalence with the SAME code path the
 *  scorer runs — not a re-implementation of it. */
export function resolveRules(
  rules: readonly RiskCutoffRule[],
  column: string,
  bucket: SizeBucketKey,
): Cutoff | null {
  const candidates = rules
    .filter(
      (r) =>
        !r.default &&
        (r.column === undefined || r.column === column) &&
        (r.size === undefined || r.size === bucket),
    )
    .sort((a, b) => specificity(b) - specificity(a));
  for (const r of candidates) {
    if (r.warn != null && r.risk != null) return { warn: r.warn, risk: r.risk };
  }
  const def = rules.find((r) => r.default);
  if (def && def.warn != null && def.risk != null) return { warn: def.warn, risk: def.risk };
  return null;
}

function specificity(r: { column?: string; size?: number | 'none' }): number {
  return (r.column !== undefined ? 1 : 0) + (r.size !== undefined ? 1 : 0);
}

// --- Editor vocabulary --------------------------------------------------------

export const CUTOFF_METRIC_IDS: readonly CutoffMetricId[] = ['idle', 'timeInColumn', 'cycle'];

export interface CutoffMetricInfo {
  id: CutoffMetricId;
  label: string;
  help: string;
}

/** Labels deliberately match the board's METRIC_LABELS (client/src/app/risk/format.ts)
 *  so the admin page and the board say the same words for the same metric. */
export const CUTOFF_METRICS: readonly CutoffMetricInfo[] = [
  {
    id: 'idle',
    label: 'Last movement',
    help: 'Work hours since anything happened on the ticket.',
  },
  {
    id: 'timeInColumn',
    label: 'In column',
    help: 'Work hours the ticket has spent in its current board column.',
  },
  {
    id: 'cycle',
    label: 'Cycle',
    help: 'Work hours since the ticket first entered the In Progress status.',
  },
];

export type SizeBucketKey = number | 'none';

/** Every bucket a rule may target, in display order. */
export const SIZE_BUCKET_KEYS: readonly SizeBucketKey[] = ['none', ...FIB_BUCKETS];

/**
 * Buckets rendered as the point RANGES they actually capture — the single best
 * teaching device against the size-bucket trap (an admin who types `4` means
 * "4 points", which `sizeBucket` folds into the `5` bucket). Derived from
 * `FIB_BUCKETS`/`sizeBucket` so the labels can't drift from the matcher.
 */
export const SIZE_BUCKET_LABELS: Record<string, string> = buildSizeBucketLabels();

function buildSizeBucketLabels(): Record<string, string> {
  const out: Record<string, string> = { none: 'Unpointed' };
  let prev = 0;
  FIB_BUCKETS.forEach((b, i) => {
    const top = i === FIB_BUCKETS.length - 1;
    const lo = prev + 1;
    const range = lo === b ? `${b}` : `${lo}–${b}`;
    out[String(b)] = top ? `${range} (and ${b + 1}+)` : range;
    prev = b;
  });
  return out;
}

export function sizeBucketLabel(size: SizeBucketKey | null | undefined): string {
  if (size == null) return 'Any size';
  return SIZE_BUCKET_LABELS[String(size)] ?? String(size);
}

/** One WORK day. The metrics are measured on a work-hours clock, so "3 days" in
 *  the UI means 24 work hours, not 72 wall-clock ones. (Was duplicated as
 *  `HOURS_PER_WORKDAY` in client/src/app/risk/format.ts — that now imports this.) */
export const WORK_HOURS_PER_DAY = 8;

const WEEKDAY_ORDER: readonly RiskWeekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Total scheduled work hours in one week of the EFFECTIVE schedule. */
export function workHoursPerWeek(schedule: RiskWorkSchedule): number {
  let total = 0;
  for (const day of WEEKDAY_ORDER) {
    const w = schedule.days?.[day];
    if (!w) continue;
    const [open, close] = w;
    if (typeof open === 'number' && typeof close === 'number' && close > open) total += close - open;
  }
  return total;
}

/** Mean hours per WORKING day (days off excluded). Falls back to
 *  `WORK_HOURS_PER_DAY` for a schedule with no working days at all. */
export function workHoursPerDay(schedule: RiskWorkSchedule): number {
  let days = 0;
  for (const day of WEEKDAY_ORDER) {
    const w = schedule.days?.[day];
    if (w && typeof w[0] === 'number' && typeof w[1] === 'number' && w[1] > w[0]) days++;
  }
  if (days === 0) return WORK_HOURS_PER_DAY;
  return workHoursPerWeek(schedule) / days;
}

/** "Mon–Thu 9–18, Fri 9–13" — the human summary of a schedule's working days. */
export function scheduleDaysSummary(schedule: RiskWorkSchedule): string {
  const parts: string[] = [];
  let run: { from: RiskWeekday; to: RiskWeekday; hours: string } | null = null;
  const flush = (): void => {
    if (!run) return;
    parts.push(`${run.from === run.to ? run.from : `${run.from}–${run.to}`} ${run.hours}`);
    run = null;
  };
  for (const day of WEEKDAY_ORDER) {
    const w = schedule.days?.[day];
    if (!w) {
      flush();
      continue;
    }
    const hours = `${w[0]}–${w[1]}`;
    if (run && run.hours === hours) run.to = day;
    else {
      flush();
      run = { from: day, to: day, hours };
    }
  }
  flush();
  return parts.join(', ');
}

/** Ordering used by both `ambiguousPairs` and the editor's display sort. */
export function ruleSpecificity(rule: RiskCutoffRule): number {
  return rule.default ? -1 : specificity(rule);
}

// --- Validation ---------------------------------------------------------------

/** Optional context. The worker runs the context-free subset (it has no board
 *  columns at PUT time without spending Jira calls); the client passes the full
 *  context from `GET /api/admin/risk/columns`, so the *warnings* are strictly
 *  richer client-side while the *errors* are identical on both.
 *
 *  Deviation from the plan's `{ columns, doneColumns, ... }`: the per-board
 *  warning it asks for ("matches Sprint A but not Sprint B") needs the columns
 *  grouped BY board, so this carries a board list instead of two flat arrays. */
export interface CutoffValidationContext {
  boards?: { name: string; columns: string[]; doneColumn: string | null }[];
  /** False when no Story Points field is resolved for the site — every ticket then
   *  buckets as 'none' and size rules can never fire. */
  pointsFieldConfigured?: boolean;
}

export interface CutoffValidation {
  errors: RiskConfigIssue[];
  warnings: RiskConfigIssue[];
}

const RULE_KEYS = ['column', 'size', 'warn', 'risk', 'default'];

function isBucket(size: unknown): size is SizeBucketKey {
  return size === 'none' || (typeof size === 'number' && FIB_BUCKETS.includes(size as 1));
}

function scopeLabel(r: RiskCutoffRule): string {
  const col = r.column ?? 'any column';
  const size = r.size === undefined ? 'any size' : sizeBucketLabel(r.size);
  return `${col} / ${size}`;
}

/**
 * Every footgun in the cutoff shape, split into save-blocking errors and advisory
 * warnings. Deliberately tolerant of `unknown` input: the worker hands this raw
 * JSON straight off the wire.
 *
 * BACK-COMPAT CAVEAT: three cases that the old `validCutoffs` *accepted* are errors
 * here (a half-filled rule, a `size` that isn't a bucket, a duplicated default), so
 * a legacy blob containing one cannot be re-saved unchanged. Reads are unaffected —
 * `store.ts` parseJson stays tolerant — and the editor's loader auto-repairs all
 * three (see `toEditorModel`) with a visible diff before the first save.
 */
export function validateCutoffs(cutoffs: unknown, ctx?: CutoffValidationContext): CutoffValidation {
  const errors: RiskConfigIssue[] = [];
  const warnings: RiskConfigIssue[] = [];

  if (!cutoffs || typeof cutoffs !== 'object' || Array.isArray(cutoffs)) {
    errors.push({ code: 'NOT_AN_OBJECT', message: 'cutoffs must be an object' });
    return { errors, warnings };
  }
  const table = cutoffs as Record<string, unknown>;

  for (const metric of CUTOFF_METRIC_IDS) {
    const rules = table[metric];
    if (!Array.isArray(rules)) {
      errors.push({
        metric,
        code: 'MISSING_METRIC',
        message: `cutoffs.${metric} must be an array of rules`,
      });
      continue;
    }
    validateMetric(metric, rules as unknown[], ctx, errors, warnings);
  }
  return { errors, warnings };
}

function validateMetric(
  metric: CutoffMetricId,
  rules: unknown[],
  ctx: CutoffValidationContext | undefined,
  errors: RiskConfigIssue[],
  warnings: RiskConfigIssue[],
): void {
  const seenScopes = new Set<string>();
  let defaults = 0;
  let anySizeRule = false;

  rules.forEach((raw, index) => {
    const at = { metric, index } as const;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ ...at, code: 'INVALID_RULE', message: `rule ${index} must be an object` });
      return;
    }
    const r = raw as RiskCutoffRule & Record<string, unknown>;

    for (const key of Object.keys(r)) {
      if (!RULE_KEYS.includes(key)) {
        warnings.push({
          ...at,
          code: 'UNKNOWN_KEY',
          message: `rule ${index} has an unknown key "${key}" — it is ignored, and the editor strips it on save`,
        });
      }
    }

    if (r.column !== undefined && typeof r.column !== 'string') {
      errors.push({ ...at, field: 'column', code: 'INVALID_COLUMN', message: `rule ${index}: column must be a string` });
    }
    if (r.default !== undefined && typeof r.default !== 'boolean') {
      errors.push({ ...at, field: 'default', code: 'INVALID_DEFAULT', message: `rule ${index}: default must be a boolean` });
    }
    if (r.default === true) defaults++;

    if (r.size !== undefined) {
      anySizeRule = true;
      if (!isBucket(r.size)) {
        errors.push({
          ...at,
          field: 'size',
          code: 'NOT_A_BUCKET',
          message:
            typeof r.size === 'number'
              ? `rule ${index}: size ${r.size} is not a story-point bucket — ${r.size} points falls in the "${sizeBucketLabel(sizeBucket(r.size))}" bucket, so use size ${String(sizeBucket(r.size))}`
              : `rule ${index}: size must be one of ${SIZE_BUCKET_KEYS.join(', ')}`,
        });
      }
    }

    for (const field of ['warn', 'risk'] as const) {
      const v = r[field];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        errors.push({
          ...at,
          field,
          code: 'INVALID_THRESHOLD',
          message: `rule ${index}: ${field} must be a finite number above 0`,
        });
      }
    }
    // Only when both numbers are individually valid — otherwise `{warn:10, risk:0}`
    // would report two errors for one mistake.
    const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
    if (valid(r.warn) && valid(r.risk) && r.risk < r.warn) {
      errors.push({
        ...at,
        field: 'risk',
        code: 'INVERTED_THRESHOLD',
        message: `rule ${index}: risk (${r.risk}) is below warn (${r.warn}), so nothing could ever band as "warn"`,
      });
    }
    if ((r.warn === undefined) !== (r.risk === undefined)) {
      errors.push({
        ...at,
        field: r.warn === undefined ? 'warn' : 'risk',
        code: 'INCOMPLETE_RULE',
        message: `rule ${index} (${scopeLabel(r)}) sets only ${r.warn === undefined ? 'risk' : 'warn'} — a half-filled rule is silently skipped, so it can never fire`,
      });
    }

    if (r.default !== true) {
      const scope = `${r.column ?? ' '}|${r.size === undefined ? ' ' : String(r.size)}`;
      if (seenScopes.has(scope)) {
        errors.push({
          ...at,
          code: 'DUPLICATE_SCOPE',
          message: `rule ${index} repeats the scope "${scopeLabel(r)}" — only the first would ever apply`,
        });
      }
      seenScopes.add(scope);
    }

    // Dead Done rules: the board treats each board's LAST column as done, and done
    // tickets are never scored (logic/health.ts), so a rule targeting it never fires.
    if (typeof r.column === 'string' && ctx?.boards?.length) {
      const doneOn = ctx.boards.filter((b) => b.doneColumn === r.column).map((b) => b.name);
      if (doneOn.length) {
        warnings.push({
          ...at,
          field: 'column',
          code: 'DONE_COLUMN_RULE',
          message: `"${r.column}" is the Done column on ${doneOn.join(', ')} — done tickets are never scored, so this rule can never fire there`,
        });
      }
      const missing = ctx.boards.filter((b) => !b.columns.includes(r.column as string));
      if (missing.length && missing.length < ctx.boards.length) {
        warnings.push({
          ...at,
          field: 'column',
          code: 'COLUMN_NOT_ON_EVERY_BOARD',
          message: `cutoffs are org-wide but columns are per-board: "${r.column}" exists on ${ctx.boards
            .filter((b) => b.columns.includes(r.column as string))
            .map((b) => b.name)
            .join(', ')} but not on ${missing.map((b) => b.name).join(', ')}`,
        });
      } else if (missing.length === ctx.boards.length) {
        warnings.push({
          ...at,
          field: 'column',
          code: 'UNKNOWN_COLUMN',
          message: `no configured board has a column called "${r.column}" — this rule silently falls back to the default`,
        });
      }
    }
  });

  if (defaults > 1) {
    errors.push({
      metric,
      code: 'DUPLICATE_DEFAULT',
      message: `cutoffs.${metric} has ${defaults} default rules — only the first would ever apply`,
    });
  }
  if (defaults === 0) {
    const fb = HARD_FALLBACK[metric];
    warnings.push({
      metric,
      code: 'NO_DEFAULT',
      message: `cutoffs.${metric} has no default rule, so anything it doesn't match falls to the built-in floor (warn ${fb.warn}h / risk ${fb.risk}h)`,
    });
  }
  if (anySizeRule && ctx?.pointsFieldConfigured === false) {
    warnings.push({
      metric,
      code: 'NO_POINTS_FIELD',
      message: `no Story Points field is resolved for this site, so every ticket counts as Unpointed — the size-specific rules in ${metric} will never fire`,
    });
  }

  // Map (not filter) so a bad entry keeps its slot and the reported indices still
  // address the caller's array.
  for (const pair of ambiguousPairs(rules.map((r) => (isRuleObject(r) ? r : {})))) {
    warnings.push({
      metric,
      index: pair.loserIndex,
      code: 'AMBIGUOUS_SPECIFICITY',
      message: `a column-only and a size-only rule are equally specific, so ORDER decides: for "${pair.column}" at ${sizeBucketLabel(pair.size)}, rule ${pair.winnerIndex} wins (warn ${pair.winner.warn} / risk ${pair.winner.risk}) over rule ${pair.loserIndex}`,
    });
  }
}

function isRuleObject(r: unknown): r is RiskCutoffRule {
  return !!r && typeof r === 'object' && !Array.isArray(r);
}

// --- Ambiguity ----------------------------------------------------------------

export interface AmbiguousPair {
  column: string;
  size: SizeBucketKey;
  winnerIndex: number;
  loserIndex: number;
  winner: RiskCutoffRule;
  loser: RiskCutoffRule;
}

/**
 * The order-dependency `resolveCutoff` can't rule out: `specificity()` scores a
 * column-only rule and a size-only rule identically, and `Array.prototype.sort` is
 * stable, so when both match one ticket the winner is decided by ARRAY POSITION.
 * The shipped defaults never hit this (idle/timeInColumn use column rules, cycle
 * uses size rules), but adding one column rule to `cycle` makes order matter
 * silently.
 *
 * Only pairs whose thresholds actually DIFFER are reported — an identical-value
 * tie is an order dependency with no observable consequence, and reporting it
 * would put a permanent warning on legal, well-tuned configs.
 */
export function ambiguousPairs(rules: readonly RiskCutoffRule[]): AmbiguousPair[] {
  const out: AmbiguousPair[] = [];
  const complete = (r: RiskCutoffRule): boolean => r.warn != null && r.risk != null && !r.default;
  rules.forEach((a, i) => {
    if (!complete(a) || a.column === undefined || a.size !== undefined) return;
    rules.forEach((b, j) => {
      if (i === j) return;
      if (!complete(b) || b.size === undefined || b.column !== undefined) return;
      if (a.warn === b.warn && a.risk === b.risk) return;
      const [winnerIndex, loserIndex] = i < j ? [i, j] : [j, i];
      out.push({
        column: a.column as string,
        size: b.size as SizeBucketKey,
        winnerIndex,
        loserIndex,
        winner: rules[winnerIndex] as RiskCutoffRule,
        loser: rules[loserIndex] as RiskCutoffRule,
      });
    });
  });
  return out;
}

// --- Collapse (behavior-preserving simplification) -----------------------------

/** Every (column, bucket) a rule set can distinguish, plus a sentinel column that
 *  matches no rule — enough to decide equivalence exhaustively. */
function probeSpace(sets: readonly (readonly RiskCutoffRule[])[]): {
  columns: string[];
  buckets: SizeBucketKey[];
} {
  const columns = new Set<string>(['  no such column  ']);
  for (const set of sets) for (const r of set) if (typeof r.column === 'string') columns.add(r.column);
  return { columns: [...columns], buckets: [...SIZE_BUCKET_KEYS] };
}

/** True iff two rule lists resolve identically for EVERY (column, bucket). */
export function equivalentRules(
  a: readonly RiskCutoffRule[],
  b: readonly RiskCutoffRule[],
): boolean {
  const { columns, buckets } = probeSpace([a, b]);
  for (const column of columns) {
    for (const bucket of buckets) {
      const x = resolveRules(a, column, bucket);
      const y = resolveRules(b, column, bucket);
      if (x === null || y === null) {
        if (x !== y) return false;
        continue;
      }
      if (x.warn !== y.warn || x.risk !== y.risk) return false;
    }
  }
  return true;
}

/**
 * Drop rules that change nothing — e.g. the shipped `idle` table's 8 identical
 * per-size rows under each column, which `resolveCutoff` already covers with the
 * column-only row (64 rules → 8).
 *
 * Provably behavior-preserving BY CONSTRUCTION rather than by pattern-matching:
 * a rule is dropped only if the resulting list still resolves identically to the
 * ORIGINAL for every (column, bucket) pair (`equivalentRules`). That makes it safe
 * on hand-written tables the plan's two patterns wouldn't cover, including ones
 * with equal-specificity ties. Runs to a fixpoint, so it is idempotent.
 *
 * Never auto-saved: the editor applies it on load and reports "simplified N rows".
 */
export function collapseRedundantRules(rules: readonly RiskCutoffRule[]): RiskCutoffRule[] {
  let out = [...rules];
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of [...out]) {
      const candidate = out.filter((x) => x !== r);
      if (equivalentRules(rules, candidate)) {
        out = candidate;
        changed = true;
      }
    }
  }
  return out;
}

/** `collapseRedundantRules` across all three metrics. */
export function collapseCutoffs(cutoffs: RiskCutoffs): RiskCutoffs {
  return {
    idle: collapseRedundantRules(cutoffs.idle),
    cycle: collapseRedundantRules(cutoffs.cycle),
    timeInColumn: collapseRedundantRules(cutoffs.timeInColumn),
  };
}

// --- Editor model -------------------------------------------------------------

export interface EditorRow {
  /** Stable identity for `@for` tracking; scope-derived, so rows are keyed and the
   *  UI can't produce a DUPLICATE_SCOPE. */
  key: string;
  column: string | null;
  size: SizeBucketKey | null;
  warn: number;
  risk: number;
}

export interface EditorMetricModel {
  metric: CutoffMetricId;
  rows: EditorRow[];
  /** The `{default:true}` rule's thresholds; null = none, so `HARD_FALLBACK` applies. */
  fallback: Cutoff | null;
  /** What the loader had to change to render the table — the "we repaired N rules
   *  on load" callout. Empty for a clean config. */
  unrepresentable: RiskConfigIssue[];
}

/**
 * Project a stored `RiskCutoffs` onto the editable table shape, auto-repairing the
 * three cases that are now save-blocking errors: a half-filled rule is dropped, an
 * off-ladder `size` is snapped to its real bucket, a second `default` is dropped.
 * Every repair is reported in `unrepresentable` so the UI can show the diff before
 * the admin saves it.
 */
export function toEditorModel(cutoffs: RiskCutoffs | null): EditorMetricModel[] {
  return CUTOFF_METRIC_IDS.map((metric) => {
    const rows: EditorRow[] = [];
    const unrepresentable: RiskConfigIssue[] = [];
    let fallback: Cutoff | null = null;
    const rules = Array.isArray(cutoffs?.[metric]) ? cutoffs[metric] : [];

    rules.forEach((raw, index) => {
      if (!isRuleObject(raw)) {
        unrepresentable.push({ metric, index, code: 'INVALID_RULE', message: `dropped rule ${index}: not an object` });
        return;
      }
      const r = raw;
      if (r.default === true) {
        if (r.warn == null || r.risk == null) {
          unrepresentable.push({ metric, index, code: 'INCOMPLETE_RULE', message: `dropped the default rule: it has no warn/risk pair` });
        } else if (fallback) {
          unrepresentable.push({ metric, index, code: 'DUPLICATE_DEFAULT', message: `dropped a second default rule (warn ${r.warn} / risk ${r.risk}); the first one wins` });
        } else {
          fallback = { warn: r.warn, risk: r.risk };
        }
        return;
      }
      if (r.warn == null || r.risk == null) {
        unrepresentable.push({ metric, index, code: 'INCOMPLETE_RULE', message: `dropped rule ${index} (${scopeLabel(r)}): a half-filled rule never fires` });
        return;
      }
      let size: SizeBucketKey | null = r.size === undefined ? null : (r.size as SizeBucketKey);
      if (size !== null && !isBucket(size)) {
        const snapped = typeof size === 'number' ? sizeBucket(size) : 'none';
        unrepresentable.push({
          metric,
          index,
          field: 'size',
          code: 'NOT_A_BUCKET',
          message: `size ${String(size)} is not a bucket — snapped to ${sizeBucketLabel(snapped)}`,
        });
        size = snapped;
      }
      const column = typeof r.column === 'string' ? r.column : null;
      const key = `${metric}:${column ?? '*'}:${size ?? '*'}`;
      if (rows.some((x) => x.key === key)) {
        unrepresentable.push({ metric, index, code: 'DUPLICATE_SCOPE', message: `dropped rule ${index} (${scopeLabel(r)}): that scope is already set above` });
        return;
      }
      rows.push({ key, column, size, warn: r.warn, risk: r.risk });
    });

    return { metric, rows, fallback, unrepresentable };
  });
}

/** The inverse: an editor model back to the stored shape (the fallback last, as
 *  the shipped defaults write it). Unknown keys are dropped by construction. */
export function fromEditorModel(model: readonly EditorMetricModel[]): RiskCutoffs {
  const out: RiskCutoffs = { idle: [], cycle: [], timeInColumn: [] };
  for (const m of model) {
    const rules: RiskCutoffRule[] = m.rows.map((row) => {
      const rule: RiskCutoffRule = {};
      if (row.column !== null) rule.column = row.column;
      if (row.size !== null) rule.size = row.size;
      rule.warn = row.warn;
      rule.risk = row.risk;
      return rule;
    });
    if (m.fallback) rules.push({ default: true, warn: m.fallback.warn, risk: m.fallback.risk });
    out[m.metric] = rules;
  }
  return out;
}

/** Display order for the table: most specific first, so the winner is at the top
 *  and there is nothing to drag.
 *
 *  NOTE the deliberate disagreement with `resolveRules`: this scores a column-only
 *  rule 2 and a size-only rule 1, while `specificity()` scores BOTH 1 — for the
 *  resolver they are equally specific and the winner is decided by ARRAY POSITION
 *  (that is what `ambiguousPairs`/`AMBIGUOUS_SPECIFICITY` warns about). The editor
 *  therefore serializes in THIS order (`editorRowsInDisplayOrder` below), so the
 *  position that actually decides is the position you can see. */
export function sortRowsForDisplay(rows: readonly EditorRow[]): EditorRow[] {
  const spec = (r: EditorRow): number => (r.column !== null ? 2 : 0) + (r.size !== null ? 1 : 0);
  return [...rows].sort(
    (a, b) =>
      spec(b) - spec(a) ||
      (a.column ?? '').localeCompare(b.column ?? '') ||
      SIZE_BUCKET_KEYS.indexOf(a.size ?? 'none') - SIZE_BUCKET_KEYS.indexOf(b.size ?? 'none'),
  );
}

/**
 * The model the editor SERIALIZES: every metric's rows in display order.
 *
 * WHAT YOU SEE IS THE TIE-BREAK ORDER. `fromEditorModel` writes `m.rows` in model
 * order, and for a column-only/size-only tie the resolver's winner is decided by
 * array position — so before this, the UI asserted a precedence (column-only above
 * size-only) that the stored blob did not honor, and the position that actually
 * decided was invisible. USER-VISIBLE: for an org holding such a tied pair, this
 * can change which of the two wins.
 */
export function editorRowsInDisplayOrder(
  model: readonly EditorMetricModel[],
): EditorMetricModel[] {
  return model.map((m) => ({ ...m, rows: sortRowsForDisplay(m.rows) }));
}

// --- Editor mutations (pure EditorMetricModel math) ----------------------------

/** Rows are keyed by scope, so the key IS the uniqueness constraint that keeps the
 *  UI from ever producing a `DUPLICATE_SCOPE`. One builder, used everywhere. */
export function editorRowKey(
  metric: CutoffMetricId,
  column: string | null,
  size: SizeBucketKey | null,
): string {
  return `${metric}:${column ?? '*'}:${size ?? '*'}`;
}

/**
 * Read a size back off a `<wa-select>`. REJECTS rather than coerces:
 * - `''`         → `null`      (the explicit "any size" sentinel)
 * - `'none'`     → `'none'`    (Unpointed)
 * - `'1'|'2'|…`  → the bucket, but only if it IS a bucket
 * - anything else (including `null`, an array, `'0'`, `'4'`) → `undefined` = REJECT.
 *
 * The caller must return early on `undefined` rather than write it. This exists
 * because `Number(null) === 0` and `Number([]) === 0`, and a Web Awesome select
 * hands back `string | null | string[]` — so the old `Number(raw)` path silently
 * wrote `0`, which is not a `SizeBucketKey` and which the validator later rejects.
 */
export function parseSizeValue(raw: unknown): SizeBucketKey | null | undefined {
  if (raw === '') return null;
  if (raw === 'none') return 'none';
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return isBucket(n) ? n : undefined;
}

/** The representative probe cell for a scope: the bucket's own point value, or
 *  `null` (unpointed) for 'none'/"any size". */
function probePoints(size: SizeBucketKey | null): number | null {
  return size === null || size === 'none' ? null : size;
}

/** A column no rule can match — the probe sentinel for an "any column" scope. */
export const NO_SUCH_COLUMN = '  no such column  ';

/**
 * The thresholds a NEW rule at `(column, size)` should start at: whatever that
 * scope resolves to TODAY.
 *
 * The invariant this buys — **adding a rule changes no resolution until you type in
 * it** — is what makes "Add rule" safe. Seeding from the table's `default`/fallback
 * (the old behavior) violates it whenever a column rule already covers the scope:
 * the row appears, claims to change nothing, and silently re-bands every ticket in
 * that column.
 *
 * EXACT for a fully-specified `(column, size)` scope, which is the only kind the
 * editor's "Add rule" produces. For a partially-specified scope (one of the two is
 * null) the rule spans several cells that may not all resolve alike, so this is the
 * value at the scope's representative probe — still strictly better than the
 * fallback, and the row is visibly new and focused so the admin types over it.
 */
export function seedRowFor(
  cutoffs: RiskCutoffs | null,
  metric: CutoffMetricId,
  column: string | null,
  size: SizeBucketKey | null,
): Cutoff {
  return resolveCutoff(cutoffs, metric, column ?? NO_SUCH_COLUMN, probePoints(size));
}

/**
 * Move one row to a new scope. Returns the model UNCHANGED if the target scope is
 * already occupied — refusing beats silently producing a duplicate the server
 * would 400 on.
 */
export function applyScopeChange(
  model: EditorMetricModel,
  rowKey: string,
  column: string | null,
  size: SizeBucketKey | null,
): EditorMetricModel {
  const key = editorRowKey(model.metric, column, size);
  if (model.rows.some((r) => r.key === key && r.key !== rowKey)) return model;
  return {
    ...model,
    rows: model.rows.map((r) => (r.key === rowKey ? { ...r, key, column, size } : r)),
  };
}

// --- Grouping (the per-column disclosure the editor renders) -------------------

export interface CutoffRowGroup {
  /** null = the "Any column" group. */
  column: string | null;
  /** The column-only rule (no size), if the table has one. */
  headerRow: EditorRow | null;
  /** Size-scoped rows within this column, in bucket order. */
  sizeRows: EditorRow[];
  /** False when no configured board has this column (the UNKNOWN_COLUMN case). */
  known: boolean;
}

/**
 * Group an editor table by column, in board-column order, then unknown columns,
 * then the "Any column" group. Every row lands in exactly one group.
 *
 * This is what turns `timeInColumn`'s 33 flat rows into 7 collapsible column
 * groups. The nesting IS the specificity order — a size row inside a column group
 * beats its header, which beats "Any column", which beats the fallback — so the
 * precedence the old flat list only asserted typographically becomes structural.
 *
 * Groups are ROW-DRIVEN: a board column with no rule at all gets no group. (The
 * plan left this open; rendering every board column would explode `idle`'s 7 rows
 * into one group per column and lose the "degrades to the current UI" property
 * that makes the accordion safe to ship.)
 */
export function groupRowsByColumn(
  rows: readonly EditorRow[],
  columnOrder: readonly string[],
): CutoffRowGroup[] {
  const byColumn = new Map<string | null, EditorRow[]>();
  for (const row of rows) {
    const list = byColumn.get(row.column);
    if (list) list.push(row);
    else byColumn.set(row.column, [row]);
  }

  const known = columnOrder.filter((c) => byColumn.has(c));
  const unknown = [...byColumn.keys()]
    .filter((c): c is string => c !== null && !columnOrder.includes(c))
    .sort((a, b) => a.localeCompare(b));
  const order: (string | null)[] = [...known, ...unknown];
  if (byColumn.has(null)) order.push(null);

  return order.map((column) => {
    const group = byColumn.get(column) ?? [];
    return {
      column,
      headerRow: group.find((r) => r.size === null) ?? null,
      sizeRows: sortRowsForDisplay(group.filter((r) => r.size !== null)),
      known: column === null || columnOrder.includes(column),
    };
  });
}
