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
 */
export function ensureValuePresent(
  options: readonly SelectOption[],
  value: string,
  note: string,
): SelectOption[] {
  if (options.some((o) => o.value === value)) return [...options];
  return [...options, { value, label: value, note }];
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
  return ensureValuePresent(out, opts.value, 'not on any configured board');
}

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
