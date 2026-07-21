// Option lists for <sp-option-select>. Pure, Angular-free, no DOM — so it is unit
// testable under the root vitest run (`client/test/**/*.test.ts`), which is the
// smallest honest way to pin the two invariants the Web Awesome select contract
// rests on (see option-select.component.ts):
//
//   1. the currently-bound value is ALWAYS present in the option list;
//   2. "not offered" is expressed by OMITTING an option, never by disabling one.
//
// `SelectOption` is declared here rather than in the component so this file (and
// its test) stay free of Angular.

import { SIZE_BUCKET_KEYS, sizeBucketLabel, type EditorRow } from '@shared/risk-cutoffs';

export interface SelectOption {
  /** `''` is the explicit "any / nothing" sentinel, never `null`. */
  value: string;
  label: string;
  /** Renders as a small group heading above the option. */
  group?: string;
  /** Small trailing annotation, e.g. "not on any configured board". */
  note?: string;
}

export interface BoardColumns {
  name: string;
  columns: string[];
  doneColumn: string | null;
}

/**
 * Make sure `value` is selectable. Web Awesome's select filters the bound value
 * against its own option set and returns null when it isn't there, which blanks
 * BOTH the display and the read-back — so a stored column that no longer exists on
 * any board (or a Done column while the toggle is off) would silently render as an
 * empty picker that then writes `''` back on the next change event.
 *
 * `note` is OPTIONAL, and a falsy note annotates nothing. Presence is rule 1 and is
 * non-negotiable; the annotation is a CLAIM about the value, and a caller with no
 * evidence for the claim must pass nothing rather than assert it (see
 * `columnOptions`).
 */
export function ensureValuePresent(
  options: readonly SelectOption[],
  value: string,
  note?: string | null,
): SelectOption[] {
  if (options.some((o) => o.value === value)) return [...options];
  return [...options, { value, label: value, ...(note ? { note } : {}) }];
}

/** True when we actually hold column data for at least one board — i.e. when
 *  "this column is on no board" is a statement we are in a position to make. A
 *  board whose probe failed ships with `columns: []`, so counting BOARDS is not
 *  enough; the columns are the evidence. */
export function boardColumnsKnown(boards: readonly BoardColumns[]): boolean {
  return boards.some((b) => b.columns.length > 0);
}

/**
 * The Scope picker's columns, grouped by board.
 *
 * `showDone` means **"offer Done columns as new choices"**, not "grey them out".
 * A row already scoped to a Done column always lists that column regardless of the
 * toggle — otherwise the picker is blank on a row whose scope is plainly a Done
 * column, which is the exact self-contradiction the toggle was supposed to explain.
 * (The shipped `idle` and `timeInColumn` tables both ship a Done rule.)
 */
export function columnOptions(
  boards: readonly BoardColumns[],
  opts: { value: string; showDone: boolean },
): SelectOption[] {
  const out: SelectOption[] = [{ value: '', label: 'Any column' }];
  const seen = new Set<string>(['']);
  for (const b of boards) {
    for (const c of b.columns) {
      if (seen.has(c)) continue;
      const done = c === b.doneColumn;
      // OMIT rather than disable: a disabled option can never be the value (Web
      // Awesome filters those out too), so disabling is indistinguishable from
      // absent — except that it also blanks a row that legitimately holds it.
      if (done && !opts.showDone && c !== opts.value) continue;
      seen.add(c);
      out.push({
        value: c,
        label: c,
        group: b.name,
        ...(done ? { note: 'Done — never scored' } : {}),
      });
    }
  }
  // Only claim "not on any configured board" when we have board data to contradict
  // it. With zero known columns (no board configured, or the columns fetch failed)
  // EVERY value would be annotated with a fact we do not have — the option must
  // still be present and selectable, just unannotated.
  return ensureValuePresent(
    out,
    opts.value,
    boardColumnsKnown(boards) ? UNKNOWN_COLUMN_NOTE : null,
  );
}

/** The one wording for "we have board data, and this column isn't in it" — shared
 *  with the group header's badge so the two can't drift. */
export const UNKNOWN_COLUMN_NOTE = 'not on any configured board';

/**
 * The Fields panel's custom-field picker.
 *
 * The leading `''` option is the POINT: "don't use this signal" has to be a thing
 * you can CHOOSE, not just the absence of a choice. Without it the bound `''` is a
 * value the select doesn't offer (contract rule 1), so the control reads as though
 * the first discovered candidate were configured when nothing is.
 *
 * The note on a synthesized value says "not among the discovered candidates" and
 * not "no such field": this list is a NAME-REGEX subset of the site's fields
 * (`listRiskFieldCandidates`), so a stored id missing from it is entirely possibly
 * a real field that simply doesn't match the regex.
 */
export function fieldOptions(
  candidates: readonly { id: string; name: string }[],
  value: string,
): SelectOption[] {
  const out: SelectOption[] = [
    { value: '', label: 'None', note: 'this signal is not collected' },
    ...candidates.map((c) => ({ value: c.id, label: c.name })),
  ];
  return ensureValuePresent(out, value, 'not among the discovered candidates');
}

/**
 * The In Progress status picker. `''` = follow the built-in default, whose name is
 * shown inline so "blank" never reads as "no clock".
 *
 * Grouped by Jira's own status category, `indeterminate` first — that is Jira's
 * definition of "in progress", and it is the only group that can be RIGHT here.
 * The rest are still offered (omitting them would make a deliberate, working
 * choice unselectable) but sink below a heading that says what they are.
 */
export function statusOptions(
  statuses: readonly { name: string; category: string }[],
  opts: { value: string; defaultStatus: string },
): SelectOption[] {
  // Partitioned HERE rather than trusting the server's order: the flat render list
  // emits a group heading whenever `group` changes, so an interleaved list would
  // print "In progress" three times.
  const inProgress = statuses.filter((s) => s.category === 'indeterminate');
  const rest = statuses.filter((s) => s.category !== 'indeterminate');
  const out: SelectOption[] = [
    { value: '', label: `Default — ${opts.defaultStatus}` },
    ...inProgress.map((s) => ({ value: s.name, label: s.name, group: 'In progress' })),
    ...rest.map((s) => ({ value: s.name, label: s.name, group: 'Other statuses' })),
  ];
  // Same discipline as columnOptions: only claim the status is unknown when we
  // actually hold the site's status list to contradict it.
  return ensureValuePresent(out, opts.value, statuses.length ? UNKNOWN_STATUS_NOTE : null);
}

/** The one wording for "we have the site's statuses, and this isn't one". */
export const UNKNOWN_STATUS_NOTE = 'not a status on this site';

/** The Size picker: "any size", then every bucket as the point RANGE it captures. */
export function sizeOptions(): SelectOption[] {
  return [
    { value: '', label: 'Any size' },
    ...SIZE_BUCKET_KEYS.map((s) => ({ value: String(s), label: sizeBucketLabel(s) })),
  ];
}

/** True when the table already holds a rule scoped to some board's Done column —
 *  the condition under which `showDone` must DEFAULT to on, so the toggle never
 *  reads "off" next to a visible Done rule. */
export function hasDoneColumnRule(
  rows: readonly EditorRow[],
  boards: readonly BoardColumns[],
): boolean {
  const doneColumns = new Set(boards.map((b) => b.doneColumn).filter((c): c is string => !!c));
  return rows.some((r) => r.column !== null && doneColumns.has(r.column));
}
