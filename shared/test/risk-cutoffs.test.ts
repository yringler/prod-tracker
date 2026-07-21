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
  NO_SUCH_COLUMN,
  SIZE_BUCKET_KEYS,
  ambiguousPairs,
  applyScopeChange,
  collapseRedundantRules,
  editorRowsInDisplayOrder,
  groupRowsByColumn,
  parseSizeValue,
  seedRowFor,
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

// --- The editor's mutation/grouping half -------------------------------------
//
// Everything semantically risky in the cutoffs editor is a pure function over
// EditorMetricModel/RiskCutoffs, which is why it lives here rather than behind an
// Angular TestBed: `fullTemplateTypeCheck` catches the template bug class, and
// these catch the four runtime defects it cannot (Number(null) === 0, a seeded row
// that silently re-bands a column, a row landing in no group, and a tie whose
// winner the UI misreports).

describe('parseSizeValue rejects rather than coerces', () => {
  it('maps the two sentinels', () => {
    expect(parseSizeValue('')).toBeNull(); // any size
    expect(parseSizeValue('none')).toBe('none'); // unpointed
  });

  it('accepts only real buckets', () => {
    for (const b of FIB_BUCKETS) expect(parseSizeValue(String(b))).toBe(b);
  });

  it('REJECTS everything else instead of coercing it to a number', () => {
    // `Number(null)` and `Number([])` are both 0 — the exact path that used to
    // write a `size: 0` the validator then refused to save.
    expect(parseSizeValue(null)).toBeUndefined();
    expect(parseSizeValue(undefined)).toBeUndefined();
    expect(parseSizeValue([])).toBeUndefined();
    expect(parseSizeValue(['3'])).toBeUndefined();
    expect(parseSizeValue('0')).toBeUndefined();
    expect(parseSizeValue('4')).toBeUndefined(); // off-ladder: 4 points is the 5 bucket
    expect(parseSizeValue('abc')).toBeUndefined();
  });
});

describe('seedRowFor — adding a rule changes no resolution', () => {
  const table: RiskCutoffs = {
    idle: [
      { column: 'Code Review', warn: 4, risk: 8 },
      { column: 'Code Review', size: 13, warn: 2, risk: 3 },
      { size: 1, warn: 6, risk: 12 },
      { default: true, warn: 24, risk: 72 },
    ],
    cycle: [{ default: true, warn: 160, risk: 240 }],
    timeInColumn: [{ default: true, warn: 24, risk: 56 }],
  };
  const columns = ['Code Review', 'In Progress', 'Nope'];

  it('seeds a fully-specified scope to exactly what that scope resolves to today', () => {
    for (const column of columns) {
      for (const size of SIZE_BUCKET_KEYS) {
        const before = resolveCutoff(table, 'idle', column, size === 'none' ? null : size);
        expect(seedRowFor(table, 'idle', column, size), `${column}/${String(size)}`).toEqual(before);
      }
    }
  });

  it('inserting that seeded rule changes NO resolution anywhere', () => {
    for (const column of columns) {
      for (const size of SIZE_BUCKET_KEYS) {
        const seed = seedRowFor(table, 'idle', column, size);
        const withRule: RiskCutoffs = {
          ...table,
          idle: sortRowsForDisplay([
            ...toEditorModel(table)[0]!.rows,
            { key: 'new', column, size, ...seed },
          ]).map((r) => ({
            ...(r.column !== null ? { column: r.column } : {}),
            ...(r.size !== null ? { size: r.size } : {}),
            warn: r.warn,
            risk: r.risk,
          })).concat([{ default: true, warn: 24, risk: 72 }]),
        };
        for (const probe of [...columns, NO_SUCH_COLUMN]) {
          for (const points of [null, 1, 2, 3, 5, 8, 13, 20, 40]) {
            expect(
              resolveCutoff(withRule, 'idle', probe, points),
              `added ${column}/${String(size)} then probed ${probe}/${String(points)}`,
            ).toEqual(resolveCutoff(table, 'idle', probe, points));
          }
        }
      }
    }
  });

  it('does NOT seed from the fallback when a column rule already covers the scope', () => {
    // The old behavior. `Code Review` resolves to 4/8, not the default's 24/72.
    expect(seedRowFor(table, 'idle', 'Code Review', 5)).toEqual({ warn: 4, risk: 8 });
    expect(seedRowFor(table, 'idle', 'Code Review', 5)).not.toEqual({ warn: 24, risk: 72 });
  });
});

describe('groupRowsByColumn', () => {
  const rows = toEditorModel({
    idle: [
      { column: 'In Progress', warn: 4, risk: 8 },
      { column: 'In Progress', size: 13, warn: 2, risk: 3 },
      { column: 'Ghost', warn: 9, risk: 9 },
      { size: 1, warn: 6, risk: 12 },
      { column: 'To Do', warn: 1, risk: 2 },
      { default: true, warn: 24, risk: 72 },
    ],
    cycle: [],
    timeInColumn: [],
  })[0]!.rows;

  it('puts every row in exactly one group', () => {
    const groups = groupRowsByColumn(rows, ['To Do', 'In Progress']);
    const placed = groups.flatMap((g) => [...(g.headerRow ? [g.headerRow] : []), ...g.sizeRows]);
    expect(placed).toHaveLength(rows.length);
    expect(new Set(placed.map((r) => r.key)).size).toBe(rows.length);
  });

  it('orders board columns first, then unknown columns, then the Any-column group', () => {
    const groups = groupRowsByColumn(rows, ['To Do', 'In Progress']);
    expect(groups.map((g) => g.column)).toEqual(['To Do', 'In Progress', 'Ghost', null]);
    expect(groups.find((g) => g.column === 'Ghost')?.known).toBe(false);
    expect(groups.find((g) => g.column === 'In Progress')?.known).toBe(true);
  });

  it('separates a column-only header row from its size rows', () => {
    const g = groupRowsByColumn(rows, ['In Progress']).find((x) => x.column === 'In Progress');
    expect(g?.headerRow?.size).toBeNull();
    expect(g?.sizeRows.map((r) => r.size)).toEqual([13]);
  });

  it('a group with no column-only rule reports headerRow null', () => {
    const g = groupRowsByColumn(rows, []).find((x) => x.column === null);
    expect(g?.headerRow).toBeNull();
    expect(g?.sizeRows).toHaveLength(1);
  });
});

describe('the editor serializes in DISPLAY order, so what you see is the tie-break', () => {
  // A deliberate tie: a column-only rule and a size-only rule are EQUALLY specific
  // to `resolveRules`, so array position decides. The editor renders column-only
  // above size-only, so that must be the stored order too.
  const tied: RiskCutoffs = {
    idle: [
      { size: 5, warn: 100, risk: 200 }, // stored FIRST — wins today
      { column: 'In Progress', warn: 1, risk: 2 },
      { default: true, warn: 24, risk: 72 },
    ],
    cycle: [{ default: true, warn: 160, risk: 240 }],
    timeInColumn: [{ default: true, warn: 24, risk: 56 }],
  };

  it('ambiguousPairs flags the tie in the first place', () => {
    expect(ambiguousPairs(tied.idle).length).toBeGreaterThan(0);
  });

  it('the display-order round trip makes the visible (column-only) rule the winner', () => {
    const round = fromEditorModel(editorRowsInDisplayOrder(toEditorModel(tied)));
    // Column-only sorts above size-only in the table, and now in the blob.
    expect(round.idle[0]?.column).toBe('In Progress');
    // USER-VISIBLE: this is the one change in the repair that can alter scoring.
    expect(resolveCutoff(tied, 'idle', 'In Progress', 5)).toEqual({ warn: 100, risk: 200 });
    expect(resolveCutoff(round, 'idle', 'In Progress', 5)).toEqual({ warn: 1, risk: 2 });
  });

  it('changes nothing for a table with no such tie', () => {
    const plain: RiskCutoffs = {
      idle: [
        { column: 'In Progress', warn: 1, risk: 2 },
        { column: 'In Progress', size: 5, warn: 3, risk: 4 },
        { default: true, warn: 24, risk: 72 },
      ],
      cycle: [{ default: true, warn: 160, risk: 240 }],
      timeInColumn: [{ default: true, warn: 24, risk: 56 }],
    };
    const round = fromEditorModel(editorRowsInDisplayOrder(toEditorModel(plain)));
    for (const column of ['In Progress', 'Other', NO_SUCH_COLUMN]) {
      for (const points of [null, 1, 5, 20]) {
        expect(resolveCutoff(round, 'idle', column, points)).toEqual(
          resolveCutoff(plain, 'idle', column, points),
        );
      }
    }
  });
});

describe('applyScopeChange', () => {
  const model = toEditorModel({
    idle: [
      { column: 'A', warn: 1, risk: 2 },
      { column: 'B', warn: 3, risk: 4 },
    ],
    cycle: [],
    timeInColumn: [],
  })[0]!;

  it('moves a row and re-keys it', () => {
    const row = model.rows[0]!;
    const next = applyScopeChange(model, row.key, 'C', 5);
    expect(next.rows[0]).toMatchObject({ column: 'C', size: 5 });
    expect(next.rows[0]!.key).not.toBe(row.key);
  });

  it('REFUSES a move onto an occupied scope rather than creating a duplicate', () => {
    const row = model.rows[0]!;
    expect(applyScopeChange(model, row.key, 'B', null)).toBe(model);
  });
});
