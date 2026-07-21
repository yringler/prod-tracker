// The cutoff-editor's shared half: validation (one case per row of the plan's §3
// matrix), the editor-model transforms, the behavior-preserving collapse, and the
// work-hours vocabulary the units caption is written from.
//
// NOTE: the shipped DEFAULT_CUTOFFS / DEFAULT_SCHEDULE live in
// worker/src/risk/logic/defaults.ts, which shared/ must not import (eslint
// boundary). The round-trip + collapse assertions over the *real* defaults are in
// worker/test/risk-cutoff-editor.test.ts; here we use equivalent local fixtures.
import { describe, expect, it } from 'vitest';
import type { RiskCutoffs, RiskWorkSchedule } from '../src/risk';
import {
  FIB_BUCKETS,
  HARD_FALLBACK,
  SIZE_BUCKET_LABELS,
  WORK_HOURS_PER_DAY,
  ambiguousPairs,
  collapseRedundantRules,
  equivalentRules,
  fromEditorModel,
  resolveCutoff,
  scheduleDaysSummary,
  sizeBucket,
  sizeBucketLabel,
  sortRowsForDisplay,
  toEditorModel,
  validateCutoffs,
  workHoursPerDay,
  workHoursPerWeek,
} from '../src/risk-cutoffs';

const ok = (over: Partial<RiskCutoffs> = {}): RiskCutoffs => ({
  idle: [{ default: true, warn: 24, risk: 72 }],
  cycle: [{ default: true, warn: 19, risk: 32 }],
  timeInColumn: [{ default: true, warn: 24, risk: 56 }],
  ...over,
});

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

describe('validateCutoffs — errors (block the save)', () => {
  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 3, 'x', []]) {
      expect(codes(validateCutoffs(bad).errors)).toContain('NOT_AN_OBJECT');
    }
  });

  it('names the metric key that is missing or not an array', () => {
    const r = validateCutoffs({ idle: [], cycle: 'nope' });
    expect(r.errors.filter((e) => e.code === 'MISSING_METRIC').map((e) => e.metric).sort()).toEqual([
      'cycle',
      'timeInColumn',
    ]);
  });

  it('rejects a rule with only warn or only risk (it can never fire)', () => {
    const r = validateCutoffs(ok({ idle: [{ column: 'Blocked', warn: 4 }, { default: true, warn: 1, risk: 2 }] }));
    const e = r.errors.find((x) => x.code === 'INCOMPLETE_RULE');
    expect(e).toMatchObject({ metric: 'idle', index: 0, field: 'risk' });
  });

  it('rejects a size that is not a bucket, and says which bucket 4 points lands in', () => {
    const r = validateCutoffs(ok({ cycle: [{ size: 4, warn: 1, risk: 2 }, { default: true, warn: 1, risk: 2 }] }));
    const e = r.errors.find((x) => x.code === 'NOT_A_BUCKET');
    expect(e).toMatchObject({ metric: 'cycle', index: 0, field: 'size' });
    expect(e?.message).toContain('4–5');
  });

  it('rejects two default rules in one metric', () => {
    const r = validateCutoffs(
      ok({ idle: [{ default: true, warn: 1, risk: 2 }, { default: true, warn: 3, risk: 4 }] }),
    );
    expect(codes(r.errors)).toContain('DUPLICATE_DEFAULT');
  });

  it('rejects a duplicated (column,size) scope', () => {
    const r = validateCutoffs(
      ok({
        idle: [
          { column: 'To Do', size: 5, warn: 1, risk: 2 },
          { column: 'To Do', size: 5, warn: 3, risk: 4 },
          { default: true, warn: 1, risk: 2 },
        ],
      }),
    );
    expect(r.errors.find((x) => x.code === 'DUPLICATE_SCOPE')).toMatchObject({ index: 1 });
  });

  it('rejects risk = 0, non-finite values and risk < warn, per row with an index', () => {
    const r = validateCutoffs(
      ok({
        idle: [
          { default: true, warn: 10, risk: 0 },
          { column: 'A', warn: Number.NaN, risk: 5 },
          { column: 'B', warn: 40, risk: 10 },
        ],
      }),
    );
    expect(r.errors.filter((e) => e.code === 'INVALID_THRESHOLD').map((e) => e.index)).toEqual([0, 1]);
    expect(r.errors.find((e) => e.code === 'INVERTED_THRESHOLD')).toMatchObject({ index: 2, field: 'risk' });
  });

  it('accepts the shape it is meant to accept', () => {
    expect(validateCutoffs(ok()).errors).toEqual([]);
  });
});

describe('validateCutoffs — warnings (advisory)', () => {
  it('warns about unknown extra keys instead of rejecting them', () => {
    const r = validateCutoffs(ok({ idle: [{ default: true, warn: 1, risk: 2, colour: 'red' }] as never }));
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toContain('UNKNOWN_KEY');
  });

  it('warns when a metric has no default rule, naming the hard floor it falls to', () => {
    const r = validateCutoffs({ idle: [], cycle: [], timeInColumn: [] });
    const cycle = r.warnings.find((w) => w.code === 'NO_DEFAULT' && w.metric === 'cycle');
    expect(cycle?.message).toContain(String(HARD_FALLBACK.cycle.risk)); // 240, not 32
  });

  it('warns on the equal-specificity tie and names the winner', () => {
    const r = validateCutoffs(
      ok({
        cycle: [
          { column: 'Code Review', warn: 1, risk: 2 },
          { size: 5, warn: 9, risk: 19 },
          { default: true, warn: 1, risk: 2 },
        ],
      }),
    );
    const w = r.warnings.find((x) => x.code === 'AMBIGUOUS_SPECIFICITY');
    expect(w?.message).toContain('rule 0 wins');
  });

  it('warns per board when a column exists on one board but not another', () => {
    const ctx = {
      boards: [
        { name: 'Sprint A', columns: ['To Do', 'Code Review', 'Done'], doneColumn: 'Done' },
        { name: 'Sprint B', columns: ['To Do', 'Done'], doneColumn: 'Done' },
      ],
    };
    const r = validateCutoffs(ok({ idle: [{ column: 'Code Review', warn: 1, risk: 2 }] }), ctx);
    const w = r.warnings.find((x) => x.code === 'COLUMN_NOT_ON_EVERY_BOARD');
    expect(w?.message).toContain('Sprint A');
    expect(w?.message).toContain('Sprint B');
  });

  it('warns when a column matches no configured board at all', () => {
    const ctx = { boards: [{ name: 'Sprint A', columns: ['To Do', 'Done'], doneColumn: 'Done' }] };
    const r = validateCutoffs(ok({ idle: [{ column: 'Nope', warn: 1, risk: 2 }] }), ctx);
    expect(codes(r.warnings)).toContain('UNKNOWN_COLUMN');
  });

  it('warns that a rule on a board’s Done column is dead', () => {
    const ctx = { boards: [{ name: 'Sprint A', columns: ['To Do', 'Done'], doneColumn: 'Done' }] };
    const r = validateCutoffs(ok({ idle: [{ column: 'Done', warn: 1, risk: 2 }] }), ctx);
    expect(codes(r.warnings)).toContain('DONE_COLUMN_RULE');
  });

  it('warns that size rules are dead with no Story Points field', () => {
    const withSize = ok({ cycle: [{ size: 5, warn: 1, risk: 2 }, { default: true, warn: 1, risk: 2 }] });
    expect(codes(validateCutoffs(withSize, { pointsFieldConfigured: false }).warnings)).toContain(
      'NO_POINTS_FIELD',
    );
    expect(codes(validateCutoffs(withSize, { pointsFieldConfigured: true }).warnings)).not.toContain(
      'NO_POINTS_FIELD',
    );
    // No size rules anywhere -> nothing to warn about.
    expect(codes(validateCutoffs(ok(), { pointsFieldConfigured: false }).warnings)).not.toContain(
      'NO_POINTS_FIELD',
    );
  });
});

describe('ambiguousPairs', () => {
  it('finds a column-only vs size-only tie and reports the array-order winner', () => {
    const rules = [
      { size: 5, warn: 9, risk: 19 },
      { column: 'Code Review', warn: 1, risk: 2 },
    ];
    const [pair, ...rest] = ambiguousPairs(rules);
    expect(rest).toEqual([]);
    expect(pair).toMatchObject({ column: 'Code Review', size: 5, winnerIndex: 0, loserIndex: 1 });
    // ...and the tie is real: resolveCutoff agrees with the reported winner.
    expect(resolveCutoff({ idle: rules, cycle: [], timeInColumn: [] }, 'idle', 'Code Review', 5)).toEqual({
      warn: 9,
      risk: 19,
    });
  });

  it('stays quiet when the two rules would resolve to the same numbers', () => {
    expect(ambiguousPairs([{ size: 5, warn: 1, risk: 2 }, { column: 'X', warn: 1, risk: 2 }])).toEqual([]);
  });

  it('stays quiet when specificity actually differs', () => {
    expect(ambiguousPairs([{ column: 'X', size: 5, warn: 1, risk: 2 }, { column: 'X', warn: 3, risk: 4 }])).toEqual(
      [],
    );
  });
});

describe('collapseRedundantRules', () => {
  const table = [
    ...FIB_BUCKETS.map((size) => ({ column: 'To Do', size, warn: 16, risk: 48 })),
    { column: 'To Do', size: 'none' as const, warn: 16, risk: 48 },
    { column: 'To Do', warn: 16, risk: 48 },
    { column: 'In Progress', size: 5, warn: 5, risk: 9 },
    { column: 'In Progress', warn: 6, risk: 12 },
    { default: true, warn: 24, risk: 72 },
  ];

  it('drops the redundant per-size rows and keeps the ones that differ', () => {
    const collapsed = collapseRedundantRules(table);
    expect(collapsed).toEqual([
      { column: 'To Do', warn: 16, risk: 48 },
      { column: 'In Progress', size: 5, warn: 5, risk: 9 },
      { column: 'In Progress', warn: 6, risk: 12 },
      { default: true, warn: 24, risk: 72 },
    ]);
  });

  it('is behavior-preserving and idempotent', () => {
    const once = collapseRedundantRules(table);
    expect(equivalentRules(table, once)).toBe(true);
    expect(collapseRedundantRules(once)).toEqual(once);
  });

  it('refuses to drop a rule that would change a resolution', () => {
    const rules = [
      { column: 'A', size: 5, warn: 1, risk: 2 },
      { column: 'A', warn: 3, risk: 4 },
    ];
    expect(collapseRedundantRules(rules)).toEqual(rules);
  });
});

describe('editor model', () => {
  const cutoffs = ok({
    idle: [
      { column: 'To Do', warn: 16, risk: 48 },
      { column: 'In Progress', size: 5, warn: 4, risk: 9 },
      { default: true, warn: 24, risk: 72 },
    ],
  });

  it('round-trips a clean table', () => {
    expect(fromEditorModel(toEditorModel(cutoffs))).toEqual(cutoffs);
  });

  it('reports no repairs for a clean table', () => {
    expect(toEditorModel(cutoffs).every((m) => m.unrepresentable.length === 0)).toBe(true);
  });

  it('auto-repairs half-rules, off-ladder sizes and a second default, with a visible diff', () => {
    const [idle] = toEditorModel(
      ok({
        idle: [
          { column: 'A', warn: 4 }, // half rule -> dropped
          { column: 'B', size: 4, warn: 1, risk: 2 }, // size 4 -> snapped to 5
          { default: true, warn: 24, risk: 72 },
          { default: true, warn: 1, risk: 2 }, // second default -> dropped
        ],
      }),
    );
    expect(codes(idle!.unrepresentable)).toEqual(['INCOMPLETE_RULE', 'NOT_A_BUCKET', 'DUPLICATE_DEFAULT']);
    expect(idle!.rows).toEqual([{ key: 'idle:B:5', column: 'B', size: 5, warn: 1, risk: 2 }]);
    expect(idle!.fallback).toEqual({ warn: 24, risk: 72 });
    // The repaired model is now save-clean.
    expect(validateCutoffs(fromEditorModel(toEditorModel(ok()))).errors).toEqual([]);
  });

  it('strips unknown keys on the way back out', () => {
    const dirty = ok({ idle: [{ column: 'A', warn: 1, risk: 2, colour: 'red' }] as never });
    expect(fromEditorModel(toEditorModel(dirty)).idle).toEqual([{ column: 'A', warn: 1, risk: 2 }]);
  });

  it('renders a missing default as no fallback row, so the UI can show the hard floor', () => {
    const [, , cycle] = toEditorModel({ idle: [], cycle: [], timeInColumn: [] });
    expect(cycle!.metric).toBe('cycle');
    expect(cycle!.fallback).toBeNull();
  });

  it('sorts rows most-specific-first for display (there is nothing to drag)', () => {
    const rows = toEditorModel(
      ok({
        idle: [
          { warn: 1, risk: 2 },
          { size: 5, warn: 1, risk: 2 },
          { column: 'A', warn: 1, risk: 2 },
          { column: 'A', size: 5, warn: 1, risk: 2 },
        ],
      }),
    )[0]!.rows;
    expect(sortRowsForDisplay(rows).map((r) => r.key)).toEqual([
      'idle:A:5',
      'idle:A:*',
      'idle:*:5',
      'idle:*:*',
    ]);
  });
});

describe('size-bucket labels', () => {
  it('labels every bucket as the point range it actually captures', () => {
    expect(SIZE_BUCKET_LABELS).toEqual({
      none: 'Unpointed',
      '1': '1',
      '2': '2',
      '3': '3',
      '5': '4–5',
      '8': '6–8',
      '13': '9–13',
      '20': '14–20 (and 21+)',
    });
  });

  it('matches sizeBucket for every point value the labels claim', () => {
    for (let p = 1; p <= 25; p++) {
      const bucket = sizeBucket(p);
      expect(SIZE_BUCKET_LABELS[String(bucket)]).toBeTruthy();
    }
    expect(sizeBucket(21)).toBe(20); // the "(and 21+)" clamp
    expect(sizeBucketLabel(null)).toBe('Any size');
    expect(sizeBucketLabel('none')).toBe('Unpointed');
  });
});

describe('work-hours vocabulary', () => {
  // Same values as the shipped DEFAULT_SCHEDULE (worker/src/risk/logic/defaults.ts).
  const schedule: RiskWorkSchedule = {
    timeZone: 'America/New_York',
    days: { Mon: [9, 18], Tue: [9, 18], Wed: [9, 18], Thu: [9, 18], Fri: [9, 13], Sat: null, Sun: null },
  };

  it('derives the week and day from the effective schedule', () => {
    expect(workHoursPerWeek(schedule)).toBe(40);
    expect(workHoursPerDay(schedule)).toBe(8);
    expect(WORK_HOURS_PER_DAY).toBe(8);
  });

  it('summarizes the working days into runs', () => {
    expect(scheduleDaysSummary(schedule)).toBe('Mon–Thu 9–18, Fri 9–13');
  });

  it('falls back to the 8h day for a schedule with no working days', () => {
    const none: RiskWorkSchedule = {
      timeZone: 'UTC',
      days: { Mon: null, Tue: null, Wed: null, Thu: null, Fri: null, Sat: null, Sun: null },
    };
    expect(workHoursPerWeek(none)).toBe(0);
    expect(workHoursPerDay(none)).toBe(WORK_HOURS_PER_DAY);
  });
});
