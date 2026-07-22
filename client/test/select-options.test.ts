// The only client-side test in the repo, and deliberately a small one: it covers a
// PURE, Angular-free module (`client/src/app/risk/select-options.ts`) under the
// existing root vitest run — one `include` glob, no jsdom, no TestBed.
//
// It pins the two invariants of the Web Awesome select contract
// (option-select.component.ts), which are what root cause B was about: WA's select
// filters the bound value against its own NON-DISABLED option set and returns null
// when it isn't there, blanking the display AND the read-back. So:
//   1. the current value is always present in the list;
//   2. "not offered" is OMISSION, never `disabled`.
//
// An Angular TestBed suite is deliberately NOT here — see DEFERRED.md: WA
// components are real custom elements with shadow DOM, so under jsdom they would
// not render the surface the bug lived on.
import { describe, expect, it } from 'vitest';
import {
  boardColumnsKnown,
  columnOptions,
  ensureValuePresent,
  FIELD_PICKER_CAP,
  fieldLabel,
  fieldListItems,
  filterFieldOptions,
  hasDoneColumnRule,
  resolveFieldDisplay,
  sizeOptions,
  statusOptions,
  UNKNOWN_FIELD_NOTE,
  UNKNOWN_STATUS_NOTE,
  type BoardColumns,
} from '../src/app/risk/select-options';
import { toEditorModel } from '@shared/risk-cutoffs';

const boards: BoardColumns[] = [
  {
    name: 'Sprint A',
    columns: ['To Do', 'In Progress', 'Done'],
    doneColumn: 'Done',
  },
];

describe('ensureValuePresent', () => {
  it('leaves a list that already offers the value alone', () => {
    const opts = [{ value: 'a', label: 'A' }];
    expect(ensureValuePresent(opts, 'a', 'note')).toEqual(opts);
  });

  it('synthesizes and annotates a value the list does not offer', () => {
    const out = ensureValuePresent([{ value: 'a', label: 'A' }], 'gone', 'not on any board');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ value: 'gone', label: 'gone', note: 'not on any board' });
  });

  it('synthesizes WITHOUT a note when the caller has nothing to assert', () => {
    // Presence is the invariant; the note is an optional claim.
    expect(ensureValuePresent([{ value: 'a', label: 'A' }], 'gone')[1]).toEqual({
      value: 'gone',
      label: 'gone',
    });
  });
});

describe('columnOptions', () => {
  it('always offers the "any column" sentinel first', () => {
    expect(columnOptions(boards, { value: '', showDone: false })[0]).toEqual({
      value: '',
      label: 'Any column',
    });
  });

  it('OMITS Done columns when the toggle is off — never disables them', () => {
    const out = columnOptions(boards, { value: '', showDone: false });
    expect(out.map((o) => o.value)).not.toContain('Done');
    // Rule 3: the type carries no `disabled` at all, so "not offered" cannot be
    // expressed any other way.
    expect(out.every((o) => !('disabled' in o))).toBe(true);
  });

  it('offers Done columns when the toggle is on, annotated', () => {
    const out = columnOptions(boards, { value: '', showDone: true });
    expect(out.find((o) => o.value === 'Done')?.note).toBe('Done — never scored');
  });

  it("ALWAYS shows a row's own Done column, toggle off or not", () => {
    // The shipped idle/timeInColumn tables both ship a Done rule; without this the
    // picker on that row renders blank and then writes '' back on the next change.
    const out = columnOptions(boards, { value: 'Done', showDone: false });
    expect(out.map((o) => o.value)).toContain('Done');
  });

  it('synthesizes a stored column that no board has any more, and SAYS so', () => {
    const out = columnOptions(boards, { value: 'Retired', showDone: false });
    expect(out.find((o) => o.value === 'Retired')?.note).toBe('not on any configured board');
  });

  // The annotation is a CLAIM about the board set. With no board data we are in no
  // position to make it — the screenshot that prompted this had EVERY row annotated
  // "not on any configured board" purely because the columns fetch returned nothing.
  // Rule 1 (the bound value is always present) is unaffected and non-negotiable.
  it('with ZERO known boards, still offers the value but claims nothing about it', () => {
    const out = columnOptions([], { value: 'In Progress', showDone: false });
    const opt = out.find((o) => o.value === 'In Progress');
    expect(opt).toBeDefined();
    expect(opt?.note).toBeUndefined();
  });

  it('treats a board whose columns failed to load as no evidence either', () => {
    // `listRiskColumns` degrades an unprobeable board to `columns: []` rather than
    // failing the endpoint — so counting BOARDS would re-assert the false claim.
    const blind: BoardColumns[] = [{ name: 'Sprint A', columns: [], doneColumn: null }];
    expect(boardColumnsKnown(blind)).toBe(false);
    expect(columnOptions(blind, { value: 'In Progress', showDone: false })[1]?.note).toBeUndefined();
  });

  it('boardColumnsKnown is true as soon as one board has a column', () => {
    expect(boardColumnsKnown(boards)).toBe(true);
  });

  it('groups columns by board and never repeats one', () => {
    const two: BoardColumns[] = [
      ...boards,
      { name: 'Sprint B', columns: ['To Do', 'QA'], doneColumn: null },
    ];
    const out = columnOptions(two, { value: '', showDone: true });
    expect(out.filter((o) => o.value === 'To Do')).toHaveLength(1);
    expect(out.find((o) => o.value === 'QA')?.group).toBe('Sprint B');
  });
});

describe('sizeOptions', () => {
  it("leads with the '' any-size sentinel and then the point RANGES", () => {
    const out = sizeOptions();
    expect(out[0]).toEqual({ value: '', label: 'Any size' });
    expect(out[1]).toEqual({ value: 'none', label: 'Unpointed' });
    // Ranges, not bare bucket numbers — so nobody reads "5" as "5 points only".
    expect(out.find((o) => o.value === '5')?.label).toBe('4–5');
  });
});

describe('hasDoneColumnRule', () => {
  const rows = (columns: (string | null)[]) =>
    toEditorModel({
      idle: columns.map((c) => ({ ...(c ? { column: c } : {}), warn: 1, risk: 2 })),
      cycle: [],
      timeInColumn: [],
    })[0]!.rows;

  it('is true when the table holds a rule on a board Done column', () => {
    expect(hasDoneColumnRule(rows(['Done']), boards)).toBe(true);
  });

  it('is false otherwise', () => {
    expect(hasDoneColumnRule(rows(['In Progress', null]), boards)).toBe(false);
  });
});

// The field-mapping picker. It exists because a bound `''` with no `''` OPTION is
// the exact case WA filters away: the control then reads as though the first
// field were configured when nothing is. "Pick a field…" has to be PICKable.
describe('filterFieldOptions', () => {
  const fields = [
    { id: 'customfield_1002', name: 'Flagged' },
    { id: 'customfield_2', name: 'Rejection count' },
    { id: 'labels', name: 'Labels' },
  ];

  it('matches case-insensitively over name AND id', () => {
    expect(filterFieldOptions(fields, 'FLAG').map((f) => f.id)).toEqual(['customfield_1002']);
    expect(filterFieldOptions(fields, '1002').map((f) => f.id)).toEqual(['customfield_1002']);
    expect(filterFieldOptions(fields, 'label').map((f) => f.id)).toEqual(['labels']);
  });

  it('keeps everything on a blank or whitespace query', () => {
    expect(filterFieldOptions(fields, '')).toHaveLength(3);
    expect(filterFieldOptions(fields, '   ')).toHaveLength(3);
  });

  it('ranks exact and prefix matches ahead of a bare substring match', () => {
    const ranked = [
      { id: 'cf_1', name: 'Story flag' }, // substring only → score 1
      { id: 'cf_2', name: 'Flagged' }, // name prefix → score 2
      { id: 'flag', name: 'Whatever' }, // exact id → score 3
    ];
    expect(filterFieldOptions(ranked, 'flag').map((f) => f.id)).toEqual(['flag', 'cf_2', 'cf_1']);
  });

  it('keeps Jira order among equal-rank matches (stable sort)', () => {
    const same = [
      { id: 'a', name: 'Zeta flag' },
      { id: 'b', name: 'Alpha flag' },
    ];
    expect(filterFieldOptions(same, 'flag').map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('fieldLabel', () => {
  it('formats a field as "Name (id)"', () => {
    expect(fieldLabel({ id: 'customfield_1002', name: 'Flagged' })).toBe('Flagged (customfield_1002)');
  });
});

describe('resolveFieldDisplay', () => {
  const fields = [
    { id: 'customfield_1002', name: 'Flagged' },
    { id: 'customfield_2', name: 'Rejection count' },
  ];

  it('labels a found field with its name (id) and no note', () => {
    expect(resolveFieldDisplay('customfield_1002', fields)).toEqual({
      label: 'Flagged (customfield_1002)',
      note: null,
    });
  });

  it('falls back to the bare id, annotated, for an unknown id when the list is held', () => {
    expect(resolveFieldDisplay('customfield_99', fields)).toEqual({
      label: 'customfield_99',
      note: UNKNOWN_FIELD_NOTE,
    });
  });

  it('claims nothing about an unknown id when the field list is empty', () => {
    // No field data (fetch failed / still loading) — we cannot assert it's unknown.
    expect(resolveFieldDisplay('customfield_99', [])).toEqual({
      label: 'customfield_99',
      note: null,
    });
  });

  it('resolves the empty value to an empty display', () => {
    expect(resolveFieldDisplay('', fields)).toEqual({ label: '', note: null });
  });
});

describe('fieldListItems', () => {
  const fields = [
    { id: 'customfield_1002', name: 'Flagged' },
    { id: 'customfield_2', name: 'Rejection count' },
    { id: 'labels', name: 'Labels' },
  ];

  it('labels every row "name (id)"', () => {
    const { items } = fieldListItems(fields, '', '');
    expect(items.map((i) => i.label)).toEqual([
      'Flagged (customfield_1002)',
      'Rejection count (customfield_2)',
      'Labels (labels)',
    ]);
  });

  it('flags the row matching selectedId, and only that one', () => {
    const { items } = fieldListItems(fields, '', 'customfield_2');
    expect(items.find((i) => i.id === 'customfield_2')?.selected).toBe(true);
    expect(items.filter((i) => i.selected)).toHaveLength(1);
  });

  it('respects the cap, reporting the remainder as overflow', () => {
    const many = Array.from({ length: FIELD_PICKER_CAP + 7 }, (_, i) => ({
      id: `customfield_${i}`,
      name: `Field ${i}`,
    }));
    const { items, overflow } = fieldListItems(many, '', '');
    expect(items).toHaveLength(FIELD_PICKER_CAP);
    expect(overflow).toBe(7);
  });

  it('honors an explicit cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `cf_${i}`, name: `Field ${i}` }));
    const { items, overflow } = fieldListItems(many, '', '', 5);
    expect(items).toHaveLength(5);
    expect(overflow).toBe(15);
  });

  it('simply omits a selected id the query filters out — no throw, no synthesis', () => {
    const { items } = fieldListItems(fields, 'reject', 'customfield_1002');
    expect(items.map((i) => i.id)).toEqual(['customfield_2']);
    expect(items.some((i) => i.id === 'customfield_1002')).toBe(false);
  });

  it('delegates order to filterFieldOptions (ranked: exact › prefix › substring)', () => {
    const ranked = [
      { id: 'cf_1', name: 'Story flag' }, // substring only
      { id: 'cf_2', name: 'Flagged' }, // name prefix
      { id: 'flag', name: 'Whatever' }, // exact id
    ];
    const { items } = fieldListItems(ranked, 'flag', '');
    expect(items.map((i) => i.id)).toEqual(['flag', 'cf_2', 'cf_1']);
  });
});

describe('statusOptions', () => {
  const statuses = [
    { name: 'To Do', category: 'new' },
    { name: 'In Progress', category: 'indeterminate' },
    { name: 'In Review', category: 'indeterminate' },
    { name: 'Done', category: 'done' },
  ];

  it("leads with '' naming the default it inherits, then in-progress statuses", () => {
    const out = statusOptions(statuses, { value: '', defaultStatus: 'In Progress' });
    expect(out[0]).toEqual({ value: '', label: 'Default — In Progress' });
    expect(out.slice(1, 3).map((o) => o.value)).toEqual(['In Progress', 'In Review']);
    expect(out[1]?.group).toBe('In progress');
  });

  it('sinks the other categories below one heading rather than omitting them', () => {
    // Omitting them would make a deliberate, working choice unselectable — and the
    // flat render list prints a heading per GROUP CHANGE, so they must be contiguous.
    const out = statusOptions(statuses, { value: '', defaultStatus: 'In Progress' });
    const others = out.filter((o) => o.group === 'Other statuses').map((o) => o.value);
    expect(others).toEqual(['To Do', 'Done']);
    expect(out.map((o) => o.group)).toEqual([
      undefined,
      'In progress',
      'In progress',
      'Other statuses',
      'Other statuses',
    ]);
  });

  it('offers a stored status the site no longer has, and says so', () => {
    const out = statusOptions(statuses, { value: 'Coding', defaultStatus: 'In Progress' });
    expect(out.find((o) => o.value === 'Coding')?.note).toBe(UNKNOWN_STATUS_NOTE);
  });

  // Same annotation discipline as columnOptions: with no status list we are in no
  // position to claim the status doesn't exist.
  it('claims nothing when the status read failed', () => {
    const out = statusOptions([], { value: 'Coding', defaultStatus: 'In Progress' });
    const opt = out.find((o) => o.value === 'Coding');
    expect(opt).toBeDefined();
    expect(opt?.note).toBeUndefined();
  });
});
