// Cutoff resolution, the composite power-mean, and the HEALTH registry semantics
// (evaluateTicket / cardTier / tierCounts) — the rules that decide what the board
// flags. Pure functions, no clock, no Jira.
import { describe, expect, it } from 'vitest';
import type { RiskCutoffs, RiskFieldConfigEntry } from '@shared/risk';
import {
  HARD_FALLBACK,
  compositeScore,
  resolveCutoff,
  sizeBucket,
} from '../src/risk/logic/scoring';
import { evaluateTicket, tierCounts, type HealthInput } from '../src/risk/logic/health';
import { DEFAULT_COMPOSITE, DEFAULT_CUTOFFS } from '../src/risk/logic/defaults';

describe('sizeBucket', () => {
  it('buckets points onto the Fibonacci ladder', () => {
    expect(sizeBucket(null)).toBe('none');
    expect(sizeBucket(1)).toBe(1);
    expect(sizeBucket(4)).toBe(5); // rounds UP to the next bucket
    expect(sizeBucket(13)).toBe(13);
    expect(sizeBucket(100)).toBe(20); // overflow clamps to the top bucket
  });
});

describe('resolveCutoff', () => {
  // Deliberately listed least-specific-first: specificity, not order, decides.
  const cutoffs: RiskCutoffs = {
    idle: [
      { default: true, warn: 99, risk: 199 },
      { size: 5, warn: 9, risk: 19 },
      { column: 'Code Review', warn: 1, risk: 2 },
      { column: 'Code Review', size: 5, warn: 3, risk: 6 },
      { column: 'Blocked', warn: 50 }, // no risk value -> never counts
    ],
    cycle: [],
    timeInColumn: [],
  };

  it('prefers column+size, then column, then size, then the default rule', () => {
    expect(resolveCutoff(cutoffs, 'idle', 'Code Review', 5)).toEqual({ warn: 3, risk: 6 });
    expect(resolveCutoff(cutoffs, 'idle', 'Code Review', 8)).toEqual({ warn: 1, risk: 2 });
    expect(resolveCutoff(cutoffs, 'idle', 'To Do', 5)).toEqual({ warn: 9, risk: 19 });
    expect(resolveCutoff(cutoffs, 'idle', 'To Do', 8)).toEqual({ warn: 99, risk: 199 });
  });

  it('skips a matching rule that lacks real warn/risk numbers', () => {
    // The Blocked rule matches but is half-filled, so the default wins.
    expect(resolveCutoff(cutoffs, 'idle', 'Blocked', 8)).toEqual({ warn: 99, risk: 199 });
  });

  it('falls back to the hard floor when config is missing or has no rules', () => {
    expect(resolveCutoff(null, 'idle', 'To Do', 5)).toEqual(HARD_FALLBACK.idle);
    expect(resolveCutoff(cutoffs, 'cycle', 'To Do', 5)).toEqual(HARD_FALLBACK.cycle);
    expect(resolveCutoff(cutoffs, 'timeInColumn', 'To Do', 5)).toEqual(HARD_FALLBACK.timeInColumn);
  });

  // The cutoffs editor advertises both of these facts to admins (a pinned
  // "Everything else" row showing the effective numbers, and a warning naming the
  // winner of an equal-specificity tie), so pin the behavior they describe.
  it('falls to HARD_FALLBACK — not the table’s own numbers — when no default rule exists', () => {
    const noDefault: RiskCutoffs = {
      idle: [{ column: 'To Do', warn: 1, risk: 2 }],
      cycle: [{ size: 5, warn: 19, risk: 32 }],
      timeInColumn: [],
    };
    // A cycle table tuned around 19/32 silently jumps to 160/240 for anything its
    // size rules don't match.
    expect(resolveCutoff(noDefault, 'cycle', 'To Do', 13)).toEqual({ warn: 160, risk: 240 });
    expect(HARD_FALLBACK.cycle).toEqual({ warn: 160, risk: 240 });
    expect(resolveCutoff(noDefault, 'idle', 'Elsewhere', 5)).toEqual(HARD_FALLBACK.idle);
  });

  it('resolves an equal-specificity tie by ARRAY ORDER (column-only vs size-only)', () => {
    const columnFirst: RiskCutoffs = {
      idle: [],
      cycle: [
        { column: 'Code Review', warn: 1, risk: 2 },
        { size: 5, warn: 9, risk: 19 },
      ],
      timeInColumn: [],
    };
    const sizeFirst: RiskCutoffs = { ...columnFirst, cycle: [...columnFirst.cycle].reverse() };
    expect(resolveCutoff(columnFirst, 'cycle', 'Code Review', 5)).toEqual({ warn: 1, risk: 2 });
    expect(resolveCutoff(sizeFirst, 'cycle', 'Code Review', 5)).toEqual({ warn: 9, risk: 19 });
  });

  it('resolves the shipped default tables', () => {
    expect(resolveCutoff(DEFAULT_CUTOFFS, 'idle', 'In Progress', 3)).toEqual({ warn: 4, risk: 9 });
    expect(resolveCutoff(DEFAULT_CUTOFFS, 'timeInColumn', 'In Progress', 8)).toEqual({
      warn: 9,
      risk: 14,
    });
    expect(resolveCutoff(DEFAULT_CUTOFFS, 'cycle', 'Anything', null)).toEqual({ warn: 19, risk: 32 });
  });
});

describe('compositeScore', () => {
  const t = (score: number | null, weight = 1): { score: number | null; weight: number } => ({
    score,
    weight,
  });

  it('is a weighted power mean over the non-null scores', () => {
    // p=2: sqrt((0.5^2 + 1^2) / 2) = sqrt(0.625)
    expect(compositeScore([t(0.5), t(1)], 2)).toBeCloseTo(Math.sqrt(0.625), 12);
    // p=1 is the plain weighted average of the same two.
    expect(compositeScore([t(0.5), t(1)], 1)).toBeCloseTo(0.75, 12);
    // Weighting the worse term 3:1 pulls the mean toward it.
    expect(compositeScore([t(0.5), t(1, 3)], 1)).toBeCloseTo(0.875, 12);
  });

  it('excludes null scores and zero-weighted terms, and returns null with no contributors', () => {
    expect(compositeScore([t(1), t(null)], 2)).toBe(1);
    expect(compositeScore([t(1), t(0, 0)], 1)).toBe(1);
    expect(compositeScore([t(null), t(null)], 2)).toBeNull();
    expect(compositeScore([], 2)).toBeNull();
  });
});

describe('evaluateTicket', () => {
  const COLUMNS = ['To Do', 'In Progress', 'Code Review', 'Done'];
  const ticket = (over: Partial<HealthInput> = {}): HealthInput => ({
    column: 'In Progress',
    points: 3,
    blocked: false,
    started: true,
    idleHours: 1,
    timeInColumnHours: 1,
    cycleHours: 1,
    fieldValues: {},
    ...over,
  });
  // The old hardcoded rejections metric, expressed as what it now is: a count
  // field entry with the same warn 2 / risk 4.
  const REJ_ENTRY: RiskFieldConfigEntry = {
    label: 'Rejections',
    fieldId: 'customfield_9001',
    kind: 'count',
    warn: 2,
    risk: 4,
  };
  const FLAG_ENTRY: RiskFieldConfigEntry = {
    label: 'Flagged',
    fieldId: 'customfield_9002',
    kind: 'flag',
  };

  it('bands each metric against the ticket’s own resolved thresholds', () => {
    const r = evaluateTicket(
      ticket({
        idleHours: 10,
        timeInColumnHours: 7,
        fieldValues: { [REJ_ENTRY.fieldId]: 3 },
      }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [REJ_ENTRY],
    );
    // idle in In Progress @3pt: warn 4 / risk 9 -> 10h is risk.
    expect(r.metrics.idle).toMatchObject({ band: 'risk', warn: 4, risk: 9 });
    expect(r.metrics.idle.score).toBeCloseTo(10 / 9, 12);
    // in-column in In Progress @3pt: warn 3 / risk 6 -> 7h is risk too.
    expect(r.metrics.timeInColumn).toMatchObject({ band: 'risk', warn: 3, risk: 6 });
    expect(r.fieldMetrics[REJ_ENTRY.fieldId]).toMatchObject({
      value: 3,
      band: 'warn',
      warn: 2,
      risk: 4,
    });
    expect(r.metrics.blocked).toMatchObject({ value: false, band: 'ok', score: 0 });
    expect(r.tier).toBe('risk');
  });

  it('bands a count field ok at zero and blocked as a binary risk', () => {
    const r = evaluateTicket(
      ticket({ blocked: true, fieldValues: { [REJ_ENTRY.fieldId]: null } }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [REJ_ENTRY],
    );
    // Key present but null on the issue: reads 0, bands ok (the old semantics).
    expect(r.fieldMetrics[REJ_ENTRY.fieldId]).toMatchObject({ value: 0, band: 'ok', score: 0 });
    expect(r.metrics.blocked).toMatchObject({ value: true, band: 'risk', score: 1 });
    expect(r.tier).toBe('risk');
  });

  it('bands a flag field as a binary risk, and its own metric — not blocked', () => {
    const r = evaluateTicket(
      ticket({ fieldValues: { [FLAG_ENTRY.fieldId]: true } }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [FLAG_ENTRY],
    );
    expect(r.fieldMetrics[FLAG_ENTRY.fieldId]).toMatchObject({ value: true, band: 'risk', score: 1 });
    expect(r.metrics.blocked).toMatchObject({ value: false, band: 'ok' });
    expect(r.tier).toBe('risk');

    const off = evaluateTicket(
      ticket({ fieldValues: { [FLAG_ENTRY.fieldId]: false } }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [FLAG_ENTRY],
    );
    expect(off.fieldMetrics[FLAG_ENTRY.fieldId]).toMatchObject({ value: false, band: 'ok', score: 0 });
  });

  it('degrades a field with NO fieldValues key to none/null (old snapshot, new field)', () => {
    const r = evaluateTicket(
      ticket({ fieldValues: {} }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [REJ_ENTRY, FLAG_ENTRY],
    );
    expect(r.fieldMetrics[REJ_ENTRY.fieldId]).toEqual({ value: null, band: 'none', score: null });
    expect(r.fieldMetrics[FLAG_ENTRY.fieldId]).toEqual({ value: null, band: 'none', score: null });
    // ...and it contributes nothing to the composite or the tier.
    expect(r.tier).toBe('ok');
  });

  it('keeps showing but stops flagging a done-column ticket', () => {
    const r = evaluateTicket(
      ticket({
        column: 'Done',
        idleHours: 500,
        blocked: true,
        fieldValues: { [REJ_ENTRY.fieldId]: 9 },
      }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [REJ_ENTRY],
    );
    expect(Object.values(r.metrics).map((m) => m.band)).toEqual(['none', 'none', 'none', 'none']);
    expect(Object.values(r.metrics).every((m) => m.score === null)).toBe(true);
    expect(r.fieldMetrics[REJ_ENTRY.fieldId]).toMatchObject({ value: 9, band: 'none', score: null });
    expect(r.metrics.idle.value).toBe(500);
    expect(r.composite).toEqual({ score: null, band: 'none' });
    expect(r.tier).toBeNull();
  });

  it('leaves the clock metrics pending until the ticket starts', () => {
    const r = evaluateTicket(
      ticket({ started: false, idleHours: 40, timeInColumnHours: null, cycleHours: null }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
    );
    expect(r.metrics.idle.band).toBe('none');
    expect(r.metrics.timeInColumn.band).toBe('none');
    expect(r.metrics.cycle.band).toBe('none');
    // blocked still scores, so the composite is still a number.
    expect(r.metrics.blocked.band).toBe('ok');
    expect(r.composite.score).toBe(0);
    expect(r.tier).toBe('ok');
  });

  it('pins a hand-computed composite', () => {
    // Unpointed ticket in To Do: idle warn 16 / risk 48, cycle warn 19 / risk 32,
    // in-column warn 16 / risk 48. Scores: blocked 0, idle 24/48 = .5,
    // inCol 24/48 = .5, cycle 16/32 = .5 -> p=2, equal weights over 4 terms.
    const r = evaluateTicket(
      ticket({
        column: 'To Do',
        points: null,
        idleHours: 24,
        timeInColumnHours: 24,
        cycleHours: 16,
      }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
    );
    expect(r.composite.score).toBeCloseTo(Math.sqrt((0.25 * 3) / 4), 12);
    expect(r.composite.band).toBe('ok'); // sqrt(0.1875) ~ 0.433, under COMP.warn (0.7)
    expect(r.tier).toBe('warn'); // idle 24 >= warn 16

    // The same ticket with a weighted count field at its risk line: the field's
    // score 1 joins the mean under entry.weight (2), pushing it past COMP.warn.
    const withField = evaluateTicket(
      ticket({
        column: 'To Do',
        points: null,
        idleHours: 24,
        timeInColumnHours: 24,
        cycleHours: 16,
        fieldValues: { [REJ_ENTRY.fieldId]: 4 },
      }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
      [{ ...REJ_ENTRY, weight: 2 }],
    );
    expect(withField.composite.score).toBeCloseTo(Math.sqrt((0.25 * 3 + 2 * 1) / 6), 12);
    expect(withField.tier).toBe('risk'); // the field metric itself is at risk
  });
});

describe('tierCounts', () => {
  it('counts firing tiers and ignores tier-less tickets', () => {
    expect(tierCounts(['risk', 'risk', 'warn', 'ok', null, null])).toEqual({
      risk: 2,
      warn: 1,
      ok: 1,
    });
  });
});
