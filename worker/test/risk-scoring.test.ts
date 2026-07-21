// Cutoff resolution, the composite power-mean, and the HEALTH registry semantics
// (evaluateTicket / cardTier / tierCounts) — the rules that decide what the board
// flags. Pure functions, no clock, no Jira.
import { describe, expect, it } from 'vitest';
import type { RiskCompositeConfig, RiskCutoffs } from '@shared/risk';
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
  const cfg = (over: Partial<RiskCompositeConfig> = {}): RiskCompositeConfig => ({
    p: 2,
    weights: {},
    ...over,
  });

  it('is a weighted power mean over the non-null scores', () => {
    // p=2: sqrt((0.5^2 + 1^2) / 2) = sqrt(0.625)
    expect(compositeScore({ idle: 0.5, cycle: 1 }, cfg())).toBeCloseTo(Math.sqrt(0.625), 12);
    // p=1 is the plain weighted average of the same two.
    expect(compositeScore({ idle: 0.5, cycle: 1 }, cfg({ p: 1 }))).toBeCloseTo(0.75, 12);
    // Weighting cycle 3:1 pulls it toward the worse metric.
    expect(
      compositeScore({ idle: 0.5, cycle: 1 }, cfg({ p: 1, weights: { cycle: 3 } })),
    ).toBeCloseTo(0.875, 12);
  });

  it('excludes null scores and zero-weighted metrics, and returns null with no contributors', () => {
    expect(compositeScore({ idle: 1, cycle: null }, cfg())).toBe(1);
    expect(compositeScore({ idle: 1, cycle: 0 }, cfg({ p: 1, weights: { cycle: 0 } }))).toBe(1);
    expect(compositeScore({ idle: null, cycle: null }, cfg())).toBeNull();
    expect(compositeScore({}, cfg())).toBeNull();
  });
});

describe('evaluateTicket', () => {
  const COLUMNS = ['To Do', 'In Progress', 'Code Review', 'Done'];
  const ticket = (over: Partial<HealthInput> = {}): HealthInput => ({
    column: 'In Progress',
    points: 3,
    rejections: 0,
    blocked: false,
    started: true,
    idleHours: 1,
    timeInColumnHours: 1,
    cycleHours: 1,
    ...over,
  });

  it('bands each metric against the ticket’s own resolved thresholds', () => {
    const r = evaluateTicket(
      ticket({ idleHours: 10, timeInColumnHours: 7, rejections: 3 }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
    );
    // idle in In Progress @3pt: warn 4 / risk 9 -> 10h is risk.
    expect(r.metrics.idle).toMatchObject({ band: 'risk', warn: 4, risk: 9 });
    expect(r.metrics.idle.score).toBeCloseTo(10 / 9, 12);
    // in-column in In Progress @3pt: warn 3 / risk 6 -> 7h is risk too.
    expect(r.metrics.timeInColumn).toMatchObject({ band: 'risk', warn: 3, risk: 6 });
    expect(r.metrics.rejections).toMatchObject({ value: 3, band: 'warn' });
    expect(r.metrics.blocked).toMatchObject({ value: false, band: 'ok', score: 0 });
    expect(r.tier).toBe('risk');
  });

  it('bands rejections ok at zero and blocked as a binary risk', () => {
    const r = evaluateTicket(ticket({ blocked: true }), DEFAULT_CUTOFFS, DEFAULT_COMPOSITE, COLUMNS);
    expect(r.metrics.rejections).toMatchObject({ value: 0, band: 'ok', score: 0 });
    expect(r.metrics.blocked).toMatchObject({ value: true, band: 'risk', score: 1 });
    expect(r.tier).toBe('risk');
  });

  it('keeps showing but stops flagging a done-column ticket', () => {
    const r = evaluateTicket(
      ticket({ column: 'Done', idleHours: 500, rejections: 9, blocked: true }),
      DEFAULT_CUTOFFS,
      DEFAULT_COMPOSITE,
      COLUMNS,
    );
    expect(Object.values(r.metrics).map((m) => m.band)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(Object.values(r.metrics).every((m) => m.score === null)).toBe(true);
    expect(r.metrics.rejections.value).toBe(9); // raw values still display
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
    // rejections/blocked still score, so the composite is still a number.
    expect(r.metrics.rejections.band).toBe('ok');
    expect(r.composite.score).toBe(0);
    expect(r.tier).toBe('ok');
  });

  it('pins a hand-computed composite', () => {
    // Unpointed ticket in To Do: idle warn 16 / risk 48, cycle warn 19 / risk 32,
    // in-column warn 16 / risk 48. Scores: rejections 0, blocked 0,
    // idle 24/48 = .5, inCol 24/48 = .5, cycle 16/32 = .5 -> p=2, equal weights.
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
    expect(r.composite.score).toBeCloseTo(Math.sqrt((0.25 * 3) / 5), 12);
    expect(r.composite.band).toBe('ok'); // sqrt(0.15) ~ 0.387, under COMP.warn (0.7)
    expect(r.tier).toBe('warn'); // idle 24 >= warn 16
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
