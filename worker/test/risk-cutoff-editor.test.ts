// THE load-bearing test for the cutoffs editor: the two transforms it applies to a
// stored table on load — `collapseRedundantRules` (which turns DEFAULT_CUTOFFS.idle
// from 64 rules into 8) and the editor-model round-trip — must not change a single
// resolution. Proven exhaustively over every (column, points) pair the shipped
// defaults can distinguish.
//
// It lives in worker/test/ rather than shared/test/ because DEFAULT_CUTOFFS lives in
// worker/src/risk/logic/defaults.ts and shared/ may not import worker/ (eslint
// boundary). The context-free half of the same surface is in
// shared/test/risk-cutoffs.test.ts.
import { describe, expect, it } from 'vitest';
import {
  CUTOFF_METRIC_IDS,
  collapseCutoffs,
  groupRowsByColumn,
  sortRowsForDisplay,
  fromEditorModel,
  resolveCutoff,
  toEditorModel,
  validateCutoffs,
  workHoursPerDay,
  workHoursPerWeek,
} from '@shared/risk-cutoffs';
import { DEFAULT_CUTOFFS, DEFAULT_SCHEDULE } from '../src/risk/logic/defaults';

// Every column the shipped tables mention, plus one they don't.
const COLUMNS = [
  'Blocked',
  'To Do',
  'In Progress',
  'Code Review 1',
  'Code Review 2',
  'Pending QA',
  'Done',
  'Nope',
];
const POINTS: (number | null)[] = [null, ...Array.from({ length: 26 }, (_, i) => i)];

function assertSameResolutions(a: typeof DEFAULT_CUTOFFS, b: typeof DEFAULT_CUTOFFS): void {
  for (const metric of CUTOFF_METRIC_IDS) {
    for (const column of COLUMNS) {
      for (const points of POINTS) {
        expect(
          resolveCutoff(b, metric, column, points),
          `${metric} / ${column} / ${String(points)}`,
        ).toEqual(resolveCutoff(a, metric, column, points));
      }
    }
  }
}

describe('cutoff-editor transforms over the shipped defaults', () => {
  it('collapseRedundantRules changes no resolution', () => {
    assertSameResolutions(DEFAULT_CUTOFFS, collapseCutoffs(DEFAULT_CUTOFFS));
  });

  it('collapses idle 64 rules -> 7 (one per column + the default)', () => {
    expect(DEFAULT_CUTOFFS.idle).toHaveLength(64);
    const collapsed = collapseCutoffs(DEFAULT_CUTOFFS);
    // The plan predicted 8 (7 columns + default). It is 7: `Blocked` carries the
    // same 24/72 as the default rule, so that column row is redundant too — which
    // is exactly the kind of drop only the exhaustive-equivalence collapse finds.
    expect(collapsed.idle).toHaveLength(7);
    expect(collapsed.idle.some((r) => r.column === 'Blocked')).toBe(false);
    // cycle's size:'none' row duplicates its default row, so it goes too.
    expect(collapsed.cycle.length).toBeLessThan(DEFAULT_CUTOFFS.cycle.length);
    // timeInColumn genuinely varies by size in four columns, so those rows survive.
    expect(collapsed.timeInColumn.length).toBeGreaterThan(8);
  });

  it('the editor-model round-trip changes no resolution — and is byte-identical here', () => {
    const round = fromEditorModel(toEditorModel(DEFAULT_CUTOFFS));
    assertSameResolutions(DEFAULT_CUTOFFS, round);
    expect(round).toEqual(DEFAULT_CUTOFFS);
  });

  it('round-trips the collapsed table too (what an admin actually saves)', () => {
    const collapsed = collapseCutoffs(DEFAULT_CUTOFFS);
    assertSameResolutions(DEFAULT_CUTOFFS, fromEditorModel(toEditorModel(collapsed)));
  });

  it('the shipped defaults pass the new validator with no errors and no repairs', () => {
    expect(validateCutoffs(DEFAULT_CUTOFFS).errors).toEqual([]);
    expect(toEditorModel(DEFAULT_CUTOFFS).flatMap((m) => m.unrepresentable)).toEqual([]);
    expect(validateCutoffs(collapseCutoffs(DEFAULT_CUTOFFS)).errors).toEqual([]);
  });
});

describe('the units caption is derived from the real schedule', () => {
  it('reads 40h/week and 8h/day off DEFAULT_SCHEDULE', () => {
    expect(workHoursPerWeek(DEFAULT_SCHEDULE)).toBe(40);
    expect(workHoursPerDay(DEFAULT_SCHEDULE)).toBe(8);
  });
});

// Pins the numbers the grouped presentation is designed around. `timeInColumn` is
// not "33 arbitrary rows": it is 7 COLUMNS, three of them one-liners and four of
// them genuine monotonic size ladders. If a defaults edit breaks that shape, the
// accordion's "idle/cycle degrade to the old flat UI, timeInColumn opens
// collapsed" property quietly stops holding — so it fails here instead.
describe('the shape the grouped editor is designed around', () => {
  const collapsed = collapseCutoffs(DEFAULT_CUTOFFS);
  const model = toEditorModel(collapsed);
  const groupsFor = (metric: (typeof CUTOFF_METRIC_IDS)[number]) => {
    const m = model.find((x) => x.metric === metric);
    if (!m) throw new Error(`no model for ${metric}`);
    return groupRowsByColumn(sortRowsForDisplay(m.rows), []);
  };

  it('timeInColumn collapses 64 rules -> 33', () => {
    expect(DEFAULT_CUTOFFS.timeInColumn).toHaveLength(64);
    expect(collapsed.timeInColumn).toHaveLength(33);
  });

  it('timeInColumn is 7 column groups, 3 of them single-row', () => {
    const groups = groupsFor('timeInColumn');
    expect(groups).toHaveLength(7);
    expect(groups.every((g) => g.column !== null && g.headerRow !== null)).toBe(true);
    // Flat columns: one column-only rule, no size ladder.
    expect(groups.filter((g) => g.sizeRows.length === 0).map((g) => g.column).sort()).toEqual([
      'Blocked',
      'Done',
      'To Do',
    ]);
    // Laddered columns: a real monotonic size ladder each.
    const ladders = groups.filter((g) => g.sizeRows.length > 0);
    expect(ladders.map((g) => g.column).sort()).toEqual([
      'Code Review 1',
      'Code Review 2',
      'In Progress',
      'Pending QA',
    ]);
    for (const g of ladders) {
      const warns = g.sizeRows.map((r) => r.warn);
      expect(warns, `${g.column} is a monotonic ladder`).toEqual([...warns].sort((a, b) => a - b));
    }
  });

  it('idle and cycle stay small enough to render exactly as the old flat table did', () => {
    // idle: one one-liner group per column, so every group is already "expanded".
    const idle = groupsFor('idle');
    expect(idle.every((g) => g.sizeRows.length === 0)).toBe(true);
    // cycle: a single "Any column" group of size rows, under the 10-row threshold.
    const cycle = groupsFor('cycle');
    expect(cycle).toHaveLength(1);
    expect(cycle[0]?.column).toBeNull();
    expect(cycle[0]!.sizeRows.length).toBeLessThan(10);
  });
});
