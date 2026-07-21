// Sprint Risk Board Phase 2 — health-change nudges. Two layers, mirroring
// risk-notify.test.ts: the pure hysteresis policy (no D1/fetch), then the diff
// step through processBoardAlerts against real SQL (SqliteD1) + a stubbed global
// fetch (every fetch here is a Zulip DM).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskBand, RiskMetricState, RiskTicket, RiskWorkSchedule } from '@shared/risk';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { log } from '../src/log';
import {
  FIRE_AFTER_RISK_WORK_HOURS,
  REFIRE_COOLDOWN_WORK_HOURS,
  alertDrivers,
  alertPayloadHash,
  alertSignal,
  composeAlertPayload,
  fmtWorkHours,
  isWorkOpen,
  processBoardAlerts,
  stepAlertState,
  type AlertState,
} from '../src/risk/alerts';
import { listAlertStates, setAlertMuted, upsertAlertState } from '../src/risk/store';
import type { RiskOrgConfig } from '../src/risk/store';
import { makeWorkClock } from '../src/risk/logic/workhours';
import { DEFAULT_SCHEDULE } from '../src/risk/logic/defaults';
import { saveLink } from '../src/notifications/adapters/zulip/store';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const BOARD = 5;
const ASSIGNEE = 'acct-ann';
const OTHER_USER = 'acct-bob';

const silent = log.child({ quiet: true });

/** 24/7 UTC clock: work-hours == wall-clock hours, so thresholds read literally. */
const ALWAYS_OPEN: RiskWorkSchedule = {
  timeZone: 'UTC',
  days: {
    Mon: [0, 24],
    Tue: [0, 24],
    Wed: [0, 24],
    Thu: [0, 24],
    Fri: [0, 24],
    Sat: [0, 24],
    Sun: [0, 24],
  },
};
const open = makeWorkClock(ALWAYS_OPEN);
const ny = makeWorkClock(DEFAULT_SCHEDULE); // Mon-Thu 9-18, Fri 9-13, weekends closed

const T0 = Date.parse('2026-03-02T00:00:00Z'); // a Monday, 00:00 UTC
const at = (h: number): number => T0 + h * 3.6e6;
const iso = (h: number): string => new Date(at(h)).toISOString();

function metric(band: RiskBand): RiskMetricState {
  return { value: null, band, score: band === 'risk' ? 1 : 0 };
}

function mkTicket(over: Partial<RiskTicket> & { key: string }): RiskTicket {
  const base: RiskTicket = {
    key: over.key,
    summary: `${over.key} needs a look`,
    type: 'Story',
    status: 'In Review',
    column: 'Code Review 1',
    assignee: 'Ann A',
    avatarUrl: null,
    assigneeAccountId: ASSIGNEE,
    points: 3,
    parentKey: null,
    implementor: null,
    codeReviewer: null,
    rejections: null,
    blocked: false,
    blockedByOpen: [],
    unassignedInProgress: false,
    done: false,
    started: true,
    idleHours: 40,
    timeInColumnHours: 27,
    cycleHours: 60,
    metrics: {
      rejections: metric('ok'),
      blocked: metric('ok'),
      idle: metric('risk'),
      timeInColumn: metric('ok'),
      cycle: metric('ok'),
    },
    composite: { score: 1, band: 'risk' },
    tier: 'risk',
    columnTotals: [],
    flow: {
      createdAt: new Date(0).toISOString(),
      startedAt: null,
      columnSegs: [],
      assigneeSegs: [],
      totalHours: 0,
    },
    recentUpdaters: [],
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

describe('alertSignal', () => {
  it('maps tier to the tri-state; only ok/null re-arms', () => {
    expect(alertSignal(mkTicket({ key: 'A', tier: 'risk' }))).toBe('risk');
    expect(alertSignal(mkTicket({ key: 'A', tier: 'warn' }))).toBe('mid');
    expect(alertSignal(mkTicket({ key: 'A', tier: 'ok' }))).toBe('ok');
    expect(alertSignal(mkTicket({ key: 'A', tier: null }))).toBe('ok'); // done / unscored
  });
});

describe('stepAlertState', () => {
  const armed = (over: Partial<AlertState> = {}): AlertState => ({
    phase: 'armed',
    riskSince: iso(0),
    riskStreak: 1,
    lastNotifiedAt: null,
    lastPayloadHash: null,
    updatedAt: iso(0),
    ...over,
  });

  it('starts an accumulator on first risk, and cannot fire on that first observation', () => {
    const step = stepAlertState(null, 'risk', open, at(0));
    expect(step.action).toBe('upsert');
    if (step.action !== 'upsert') throw new Error('unreachable');
    expect(step.next).toMatchObject({ phase: 'armed', riskSince: iso(0), riskStreak: 1 });
  });

  it('does not fire below the threshold and fires exactly at/past it', () => {
    const prev = armed({ riskSince: iso(0) });
    expect(stepAlertState(prev, 'risk', open, at(FIRE_AFTER_RISK_WORK_HOURS - 1)).action).toBe(
      'upsert',
    );
    expect(stepAlertState(prev, 'risk', open, at(FIRE_AFTER_RISK_WORK_HOURS)).action).toBe('fire');
    expect(stepAlertState(prev, 'risk', open, at(FIRE_AFTER_RISK_WORK_HOURS + 20)).action).toBe(
      'fire',
    );
  });

  it('accrues zero over a weekend (work-hours, not wall-clock)', () => {
    // riskSince Friday 13:00 EST (the early close); "now" Sunday — no work hours pass.
    const friClose = Date.parse('2026-03-06T18:00:00Z'); // Fri 13:00 EST
    const sun = Date.parse('2026-03-08T18:00:00Z');
    const prev = armed({ riskSince: new Date(friClose).toISOString(), updatedAt: new Date(friClose).toISOString() });
    expect(stepAlertState(prev, 'risk', ny, sun).action).toBe('upsert'); // calendar 2d, work 0h
  });

  it('resets an armed accumulator on mid, but does not unlatch a firing latch', () => {
    // armed + mid -> reset (delete, nothing else to remember).
    expect(stepAlertState(armed(), 'mid', open, at(1)).action).toBe('delete');
    // firing + mid -> stays firing (latched, quiet).
    const firing = armed({ phase: 'firing', lastNotifiedAt: iso(0) });
    const midStep = stepAlertState(firing, 'mid', open, at(1));
    expect(midStep.action).toBe('upsert');
    if (midStep.action !== 'upsert') throw new Error('unreachable');
    expect(midStep.next.phase).toBe('firing');
    // Only a full ok recovers a firing ticket.
    const okStep = stepAlertState(firing, 'ok', open, at(1));
    expect(okStep.action).toBe('upsert');
    if (okStep.action !== 'upsert') throw new Error('unreachable');
    expect(okStep.next).toMatchObject({ phase: 'recovered', riskSince: null, riskStreak: 0 });
  });

  it('re-fires from recovered only past the cooldown', () => {
    const recovered = armed({
      phase: 'recovered',
      riskSince: iso(0),
      riskStreak: 4,
      lastNotifiedAt: iso(0),
    });
    // 8 work-hours: past the fire threshold but inside the 16h cooldown.
    expect(stepAlertState(recovered, 'risk', open, at(FIRE_AFTER_RISK_WORK_HOURS)).action).toBe(
      'upsert',
    );
    // Past the cooldown: fires.
    expect(stepAlertState(recovered, 'risk', open, at(REFIRE_COOLDOWN_WORK_HOURS)).action).toBe(
      'fire',
    );
  });

  it('garbage-collects a long-quiet recovered row', () => {
    const stale = armed({
      phase: 'recovered',
      riskSince: null,
      riskStreak: 0,
      updatedAt: iso(0),
    });
    // Fresh: leave it (nothing to write).
    expect(stepAlertState(stale, 'ok', open, at(24)).action).toBe('none');
    // Way past the TTL: drop it.
    expect(stepAlertState(stale, 'ok', open, at(24 * 40)).action).toBe('delete');
  });

  it('is re-run safe: the same inputs yield the same output', () => {
    const prev = armed({ riskSince: iso(0) });
    const nowMs = at(FIRE_AFTER_RISK_WORK_HOURS + 3);
    expect(stepAlertState(prev, 'risk', open, nowMs)).toEqual(
      stepAlertState(prev, 'risk', open, nowMs),
    );
  });
});

describe('alertDrivers', () => {
  it('lists risk-band metrics in triage order, blocker keys inline', () => {
    const t = mkTicket({
      key: 'A',
      blockedByOpen: ['PROJ-9', 'PROJ-8'],
      idleHours: 49, // 6d 1h
      metrics: {
        rejections: metric('ok'),
        blocked: metric('risk'),
        idle: metric('risk'),
        timeInColumn: metric('warn'), // warn, not risk -> excluded
        cycle: metric('ok'),
      },
    });
    expect(alertDrivers(t)).toEqual([
      { metric: 'blocked', label: 'blocked by PROJ-9, PROJ-8' },
      { metric: 'idle', label: 'idle 6d 1h' },
    ]);
  });

  it('falls back to the composite when only it is at risk', () => {
    const t = mkTicket({
      key: 'A',
      metrics: {
        rejections: metric('ok'),
        blocked: metric('ok'),
        idle: metric('warn'),
        timeInColumn: metric('warn'),
        cycle: metric('warn'),
      },
      composite: { score: 1, band: 'risk' },
    });
    expect(alertDrivers(t)).toEqual([{ metric: 'composite', label: 'overall risk score' }]);
  });
});

describe('fmtWorkHours', () => {
  it('formats on the 8h workday', () => {
    expect(fmtWorkHours(2)).toBe('2h');
    expect(fmtWorkHours(8)).toBe('1d');
    expect(fmtWorkHours(17)).toBe('2d 1h');
    expect(fmtWorkHours(0)).toBe('0h');
  });
});

describe('alertPayloadHash', () => {
  it('is stable for the same content and differs when it changes', () => {
    const a = [{ key: 'A', drivers: alertDrivers(mkTicket({ key: 'A' })) }];
    expect(alertPayloadHash(a)).toBe(alertPayloadHash(a));
    const b = [{ key: 'B', drivers: alertDrivers(mkTicket({ key: 'B' })) }];
    expect(alertPayloadHash(a)).not.toBe(alertPayloadHash(b));
  });
});

describe('composeAlertPayload', () => {
  it('single ticket: driven-by line + deep link', () => {
    const t = mkTicket({ key: 'PROJ-1', summary: 'Fix login', column: 'Code Review', timeInColumnHours: 27 });
    const p = composeAlertPayload('https://app.example', 'Sites', [
      { ticket: t, drivers: alertDrivers(t), atRiskWorkHours: 8 },
    ]);
    expect(p.title).toBe('PROJ-1 looks stuck');
    expect(p.body).toContain('Fix login');
    // Body reports the threaded at-risk work-hours (8h → "1d"), not time-in-column.
    expect(p.body).toContain(`for ${fmtWorkHours(8)}`);
    expect(p.body).toContain('driven by:');
    expect(p.deepLink).toBe('https://app.example/risk');
    expect(p.urgency).toBe('normal');
  });

  it('aggregate: one line per ticket, capped', () => {
    const items = ['A', 'B'].map((k) => {
      const t = mkTicket({ key: k });
      return { ticket: t, drivers: alertDrivers(t), atRiskWorkHours: 8 };
    });
    const p = composeAlertPayload('https://app.example', 'Sites', items);
    expect(p.title).toBe('2 of your tickets look stuck');
    expect(p.body).toContain('A (');
    expect(p.body).toContain('B (');
  });
});

describe('isWorkOpen', () => {
  it('reflects the org work clock', () => {
    expect(isWorkOpen(open, at(3))).toBe(true); // 24/7
    // NY: Tue 02:00 EST closed, Tue 09:30 EST open.
    expect(isWorkOpen(ny, Date.parse('2026-01-06T07:00:00Z'))).toBe(false);
    expect(isWorkOpen(ny, Date.parse('2026-01-06T14:30:00Z'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration (processBoardAlerts, real store + stubbed fetch)
// ---------------------------------------------------------------------------

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    APP_ORIGIN: 'https://app.example',
    SECRETS_KEY: TEST_SECRETS_KEY,
  } as unknown as Env;
  await seedZulipOrgConfig(env, CLOUD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A user in CLOUD with a linked Zulip DM channel (unless linked:false). */
async function seedUser(accountId: string, opts: { linked?: boolean } = {}): Promise<void> {
  await dao.upsertUser(accountId, accountId, CLOUD);
  await dao.upsertSite(accountId, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://jira' });
  if (opts.linked !== false) {
    await saveLink(env, accountId, `zulip-${accountId}`, accountId, CLOUD);
    await dao.registerChannel(accountId, 'zulip', accountId);
  }
}

const board = { boardId: BOARD, name: 'Sites' };

function cfg(): RiskOrgConfig {
  return {
    cloudId: CLOUD,
    boards: [board],
    cutoffs: null,
    composite: null,
    schedule: null,
    fields: {},
    inProgressStatus: null,
    devStatusAvailable: false,
    refresherAccountId: 'acct-refresher',
    configuredBy: 'acct-admin',
    updatedAt: iso(0),
    degradedNotifiedAt: null,
    degradedNotifiedReason: null,
  };
}

const run = (tickets: RiskTicket[], nowMs: number, clock = open): Promise<void> =>
  processBoardAlerts(env, dao, cfg(), board, tickets, clock, silent, nowMs);

describe('processBoardAlerts: firing', () => {
  it('fires once on the edge, then stays quiet while it remains at risk', async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    const t = mkTicket({ key: 'AL-1' });

    await run([t], at(0)); // first observation: accrual starts, no message
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listAlertStates(env, CLOUD, BOARD)).get('AL-1')?.phase).toBe('armed');

    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 1)); // crosses the line: one nudge
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = (await listAlertStates(env, CLOUD, BOARD)).get('AL-1');
    expect(row?.phase).toBe('firing');
    expect(row?.lastNotifiedAt).toBeTruthy();

    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 2)); // still at risk: transition-only
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not nudge an assignee who has turned the channel off', async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    await dao.setChannelEnabled(ASSIGNEE, 'zulip', false); // opted out, still linked
    const t = mkTicket({ key: 'AL-1' });

    await run([t], at(0));
    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 1));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers under the ORG's config (deliver receives orgId = cfg.cloudId)", async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    // The assignee's link points at another org; the board belongs to CLOUD, so
    // CLOUD's admin-provisioned bot is the one that sends.
    await seedZulipOrgConfig(env, 'cloud-2', {
      site: 'https://two.zulipchat.com',
      webhookToken: 'tok-2',
    });
    await saveLink(env, ASSIGNEE, `zulip-${ASSIGNEE}`, ASSIGNEE, 'cloud-2');
    const t = mkTicket({ key: 'AL-1' });

    await run([t], at(0));
    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 1));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://org.zulipchat.com/api/v1/messages',
    );
  });

  it('aggregates two tickets for the same assignee into one message', async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    const tickets = [mkTicket({ key: 'AL-1' }), mkTicket({ key: 'AL-2' })];

    await run(tickets, at(0));
    await run(tickets, at(FIRE_AFTER_RISK_WORK_HOURS + 1));

    expect(fetchMock).toHaveBeenCalledTimes(1); // one DM, both tickets
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const bodySent = decodeURIComponent(String(init?.body ?? ''));
    expect(bodySent).toContain('AL-1');
    expect(bodySent).toContain('AL-2');
  });

  it('holds a fire during quiet hours and delivers it at the next work-open refresh', async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    const t = mkTicket({ key: 'AL-1' });
    // Pre-seed an accumulator that has already met the threshold by Tue: risk since
    // Mon 09:00 EST accrues 9 work-hours by Tue 02:00 (Mon 09-18).
    await upsertAlertState(env, CLOUD, BOARD, 'AL-1', {
      phase: 'armed',
      riskSince: '2026-01-05T14:00:00Z', // Mon 09:00 EST
      riskStreak: 1,
      lastNotifiedAt: null,
      lastPayloadHash: null,
      updatedAt: '2026-01-05T14:00:00Z',
    });

    // Tue 02:00 EST: closed. Held, not dropped or claimed.
    await run([t], Date.parse('2026-01-06T07:00:00Z'), ny);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listAlertStates(env, CLOUD, BOARD)).get('AL-1')?.phase).toBe('armed');

    // Tue 09:30 EST: open. The same candidate re-derives and fires.
    await run([t], Date.parse('2026-01-06T14:30:00Z'), ny);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await listAlertStates(env, CLOUD, BOARD)).get('AL-1')?.phase).toBe('firing');
  });

  it('re-running the alert pass for the same state sends only once (the latch)', async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    const t = mkTicket({ key: 'AL-1' });
    await run([t], at(0));

    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 1));
    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 1)); // exact re-run
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('first-ever refresh of a board deep at risk fires nothing (accrual starts now)', async () => {
    const fetchMock = okFetch();
    await seedUser(ASSIGNEE);
    // No prior alert row; ticket is already well past the risk line by wall-clock.
    await run([mkTicket({ key: 'AL-1' })], at(0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listAlertStates(env, CLOUD, BOARD)).get('AL-1')?.riskSince).toBe(iso(0));
  });
});

describe('processBoardAlerts: unreachable recipients', () => {
  async function fireUnreachable(t: RiskTicket): Promise<ReturnType<typeof vi.fn>> {
    const fetchMock = okFetch();
    await run([t], at(0));
    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 1));
    return fetchMock;
  }

  it('consumes an unassigned ticket silently, latched with a NULL stamp, no re-probe', async () => {
    const t = mkTicket({ key: 'AL-1', assigneeAccountId: null, assignee: null });
    const fetchMock = await fireUnreachable(t);
    expect(fetchMock).not.toHaveBeenCalled();
    const row = (await listAlertStates(env, CLOUD, BOARD)).get('AL-1');
    expect(row?.phase).toBe('firing');
    expect(row?.lastNotifiedAt).toBeNull();

    // Later refresh: latched, no channel re-probe.
    await run([t], at(FIRE_AFTER_RISK_WORK_HOURS + 3));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('consumes a ticket whose assignee has no linked channel', async () => {
    await seedUser(OTHER_USER, { linked: false });
    const fetchMock = await fireUnreachable(mkTicket({ key: 'AL-1', assigneeAccountId: OTHER_USER }));
    expect(fetchMock).not.toHaveBeenCalled();
    const row = (await listAlertStates(env, CLOUD, BOARD)).get('AL-1');
    expect(row).toMatchObject({ phase: 'firing', lastNotifiedAt: null });
  });

  it('consumes a muted assignee (opt-out) without sending', async () => {
    await seedUser(ASSIGNEE);
    await setAlertMuted(env, ASSIGNEE, true);
    const fetchMock = await fireUnreachable(mkTicket({ key: 'AL-1' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listAlertStates(env, CLOUD, BOARD)).get('AL-1')?.lastNotifiedAt).toBeNull();
  });
});

describe('processBoardAlerts: lifecycle housekeeping', () => {
  it('deletes the row of a ticket that left the board', async () => {
    await seedUser(ASSIGNEE);
    await upsertAlertState(env, CLOUD, BOARD, 'GONE-1', {
      phase: 'armed',
      riskSince: iso(0),
      riskStreak: 1,
      lastNotifiedAt: null,
      lastPayloadHash: null,
      updatedAt: iso(0),
    });
    // A refresh whose ticket set no longer includes GONE-1.
    await run([mkTicket({ key: 'AL-1', tier: 'ok' })], at(1));
    expect((await listAlertStates(env, CLOUD, BOARD)).has('GONE-1')).toBe(false);
  });

  it('never lets an alert-pass D1 failure fail the board (refreshBoard swallows it)', async () => {
    // A DB that throws for the alert tables but works for everything else. The alert
    // pass throws at listAlertStates; refreshBoard's try/catch keeps the snapshot.
    okFetch();
    const { refreshBoard } = await import('../src/risk/refresh');
    const throwingEnv = {
      ...env,
      DB: new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (sql: string) => {
              if (sql.includes('risk_alert_state')) throw new Error('injected alert-store failure');
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
    } as unknown as Env;

    const client = stubBoardClient();
    const snap = await refreshBoard(throwingEnv, client, cfg(), board, {
      storyPointsFieldId: null,
      nowMs: at(0),
      pacingMs: 0,
      dao,
      log: silent,
    });
    expect(snap.boardId).toBe(BOARD);
    // The snapshot was written despite the alert pass blowing up.
    const { getSnapshot } = await import('../src/risk/store');
    expect(await getSnapshot(throwingEnv, CLOUD, BOARD)).not.toBeNull();
  });
});

// A minimal structural Jira client: one healthy issue is enough — the alert pass
// throws before ticket health matters.
function stubBoardClient(): { get<T>(path: string): Promise<T> } {
  const BOARD_CONFIG = {
    columnConfig: {
      columns: [
        { name: 'To Do', statuses: [{ id: '1' }] },
        { name: 'Done', statuses: [{ id: '9' }] },
      ],
    },
  };
  const STATUSES = [
    { id: '1', statusCategory: { key: 'new' } },
    { id: '9', statusCategory: { key: 'done' } },
  ];
  const ISSUE = {
    id: '201',
    key: 'AL-1',
    fields: {
      summary: 'x',
      status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { name: 'Story' },
      assignee: null,
      created: iso(0),
    },
  };
  return {
    async get<T>(path: string): Promise<T> {
      if (path.endsWith('/configuration')) return BOARD_CONFIG as T;
      if (path === '/rest/api/3/status') return STATUSES as T;
      if (/^\/rest\/agile\/1\.0\/board\/\d+$/.test(path)) return { type: 'kanban', name: 'B' } as T;
      if (path.includes('/issue?')) return { issues: [ISSUE], total: 1 } as T;
      if (/\/rest\/api\/3\/issue\/\d+\/changelog/.test(path)) return { total: 0, values: [] } as T;
      throw new Error(`unexpected path ${path}`);
    },
  };
}
