// The risk board's write path. refreshBoard runs against a structural stub client
// (canned board-config / issues / changelog JSON); the fleet scheduler runs for
// real against SqliteD1 + a stubbed global fetch, mirroring pd-report.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskWorkSchedule } from '@shared/risk';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { log } from '../src/log';
import type { RiskJiraClient } from '../src/risk/jira';
import {
  ACTIVE_REFRESH_MS,
  BACKOFF_CAP_MS,
  BOARD_COST_ESTIMATE,
  IDLE_REFRESH_MS,
  TICK_SUBREQUEST_BUDGET,
  isEligible,
  refreshBoard,
  refreshRiskBoards,
} from '../src/risk/refresh';
import {
  getConfig,
  getSnapshot,
  getState,
  putConfig,
  type RiskOrgConfig,
} from '../src/risk/store';
import { DEFAULT_CUTOFFS } from '../src/risk/logic/defaults';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const OTHER = 'cloud-2';
const REFRESHER = 'acct-refresher';

const silent = log.child({ quiet: true });

/** 24/7 clock: work-hours == wall-clock hours, so the goldens are readable. */
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

const BASE = Date.parse('2026-03-02T00:00:00Z'); // a Monday
const at = (h: number): string => new Date(BASE + h * 3.6e6).toISOString();
const NOW = BASE + 100 * 3.6e6;

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = { DB: db, APP_ORIGIN: 'http://localhost:8787' } as unknown as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Canned Jira ---------------------------------------------------------------

const BOARD_CONFIG = {
  columnConfig: {
    columns: [
      { name: 'To Do', statuses: [{ id: '1' }] },
      { name: 'In Progress', statuses: [{ id: '2' }] },
      { name: 'Code Review 1', statuses: [{ id: '3' }] },
      { name: 'Done', statuses: [{ id: '9' }] },
    ],
  },
};
const STATUSES = [
  { id: '1', statusCategory: { key: 'new' } },
  { id: '2', statusCategory: { key: 'indeterminate' } },
  { id: '3', statusCategory: { key: 'indeterminate' } },
  { id: '9', statusCategory: { key: 'done' } },
];

function issue(
  id: string,
  key: string,
  statusId: string,
  statusName: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    key,
    fields: {
      summary: `${key} summary`,
      status: {
        id: statusId,
        name: statusName,
        statusCategory: { key: statusId === '9' ? 'done' : 'indeterminate' },
      },
      issuetype: { name: 'Story' },
      assignee: {
        accountId: 'acct-ann',
        displayName: 'Ann A',
        avatarUrls: { '32x32': 'https://av/ann' },
      },
      created: at(0),
      customfield_pts: 3,
      ...extra,
    },
  };
}

const ISSUES = [
  // Stuck in Code Review since h=20 — well past the 3-point cutoffs.
  issue('101', 'RB-1', '3', 'Code Review 1'),
  // Moved into In Progress an hour ago: healthy.
  issue('102', 'RB-2', '2', 'In Progress'),
  // Sitting in the board's Done column: shown, never flagged.
  issue('103', 'RB-3', '9', 'Done'),
];

const CHANGELOGS: Record<string, unknown> = {
  '101': {
    total: 2,
    values: [
      {
        created: at(10),
        author: { displayName: 'Ann A' },
        items: [{ field: 'status', from: '1', fromString: 'To Do', to: '2', toString: 'In Progress' }],
      },
      {
        created: at(20),
        author: { displayName: 'Ann A' },
        items: [
          { field: 'status', from: '2', fromString: 'In Progress', to: '3', toString: 'Code Review 1' },
        ],
      },
    ],
  },
  '102': {
    total: 1,
    values: [
      {
        created: at(99),
        author: { displayName: 'Bob B' },
        items: [{ field: 'status', from: '1', fromString: 'To Do', to: '2', toString: 'In Progress' }],
      },
    ],
  },
  '103': {
    total: 2,
    values: [
      {
        created: at(10),
        author: { displayName: 'Ann A' },
        items: [{ field: 'status', from: '1', fromString: 'To Do', to: '2', toString: 'In Progress' }],
      },
      {
        created: at(30),
        author: { displayName: 'Ann A' },
        items: [{ field: 'status', from: '2', fromString: 'In Progress', to: '9', toString: 'Done' }],
      },
    ],
  },
};

/** Structural client over the canned data; records the paths it was asked for. */
function stubClient(calls: string[] = []): RiskJiraClient {
  return {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.endsWith('/configuration')) return BOARD_CONFIG as T;
      if (path === '/rest/api/3/status') return STATUSES as T;
      if (/^\/rest\/agile\/1\.0\/board\/\d+$/.test(path)) return { type: 'kanban', name: 'Board' } as T;
      if (path.includes('/issue?')) return { issues: ISSUES, total: ISSUES.length } as T;
      const cl = path.match(/\/rest\/api\/3\/issue\/(\d+)\/changelog/);
      if (cl) return CHANGELOGS[cl[1]!] as T;
      throw new Error(`unexpected path ${path}`);
    },
  };
}

function orgConfig(over: Partial<RiskOrgConfig> = {}): RiskOrgConfig {
  return {
    cloudId: CLOUD,
    boards: [{ boardId: 5, name: 'Sites' }],
    cutoffs: DEFAULT_CUTOFFS,
    composite: null,
    schedule: ALWAYS_OPEN,
    fields: {},
    inProgressStatus: null,
    // Off: the dev-status probe is exercised separately, not in every golden.
    devStatusAvailable: false,
    refresherAccountId: REFRESHER,
    configuredBy: 'acct-admin',
    updatedAt: at(0),
    ...over,
  };
}

describe('refreshBoard', () => {
  it('computes a snapshot: bands, tier, sort order and the done-column freeze', async () => {
    const cfg = orgConfig();
    const snap = await refreshBoard(env, stubClient(), cfg, cfg.boards[0]!, {
      storyPointsFieldId: 'customfield_pts',
      nowMs: NOW,
      pacingMs: 0,
      dao,
    });

    expect(snap.boardId).toBe(5);
    expect(snap.columns).toEqual(['To Do', 'In Progress', 'Code Review 1', 'Done']);
    // Worst composite first; the done ticket (null composite) sorts last.
    expect(snap.tickets.map((t) => t.key)).toEqual(['RB-1', 'RB-2', 'RB-3']);

    const stuck = snap.tickets[0]!;
    expect(stuck.column).toBe('Code Review 1');
    expect(stuck.assigneeAccountId).toBe('acct-ann'); // recipient key for Phase-2 nudges
    expect(stuck.started).toBe(true);
    expect(stuck.idleHours).toBe(80); // in Code Review since h=20
    expect(stuck.cycleHours).toBe(90); // In Progress from h=10
    expect(stuck.metrics.idle.band).toBe('risk'); // Code Review @3pt: warn 2 / risk 4
    expect(stuck.metrics.idle.warn).toBe(2);  // the shipped Code Review 1 table
    expect(stuck.tier).toBe('risk');
    expect(stuck.recentUpdaters).toEqual([]); // last edit was 80h ago

    const healthy = snap.tickets[1]!;
    expect(healthy.metrics.idle.band).toBe('ok'); // 1h in In Progress
    expect(healthy.tier).toBe('ok');
    expect(healthy.recentUpdaters).toEqual(['Bob B']);

    const done = snap.tickets[2]!;
    expect(done.done).toBe(true);
    expect(done.tier).toBeNull();
    expect(Object.values(done.metrics).every((m) => m.band === 'none')).toBe(true);
    expect(done.timeInColumnHours).toBe(20); // frozen at the move into Done, on Code…
    expect(snap.tierCounts).toEqual({ risk: 1, warn: 0, ok: 1 }); // done excluded

    // `prs` is omitted entirely when the org's dev-status probe failed.
    expect('prs' in stuck).toBe(false);
  });

  it('flags a ticket blocked by an open inward Blocks link', async () => {
    const blockedIssue = issue('104', 'RB-4', '2', 'In Progress', {
      issuelinks: [
        {
          type: { name: 'Blocks' },
          inwardIssue: { key: 'RB-9', fields: { status: { id: '2', statusCategory: { key: 'indeterminate' } } } },
        },
        {
          type: { name: 'Blocks' },
          inwardIssue: { key: 'RB-8', fields: { status: { id: '9', statusCategory: { key: 'done' } } } },
        },
      ],
    });
    const client: RiskJiraClient = {
      async get<T>(path: string): Promise<T> {
        if (path.includes('/issue?')) return { issues: [blockedIssue], total: 1 } as T;
        const cl = path.match(/\/rest\/api\/3\/issue\/(\d+)\/changelog/);
        if (cl) return { total: 0, values: [] } as T;
        return stubClient().get<T>(path);
      },
    };
    const cfg = orgConfig();
    const snap = await refreshBoard(env, client, cfg, cfg.boards[0]!, {
      storyPointsFieldId: 'customfield_pts',
      nowMs: NOW,
      pacingMs: 0,
      dao,
    });
    const t = snap.tickets[0]!;
    expect(t.blocked).toBe(true);
    expect(t.blockedByOpen).toEqual(['RB-9']); // the done blocker doesn't count
    expect(t.metrics.blocked).toMatchObject({ band: 'risk', score: 1 });
  });

  it('is idempotent: two runs produce one identical row', async () => {
    const cfg = orgConfig();
    const opts = { storyPointsFieldId: 'customfield_pts', nowMs: NOW, pacingMs: 0, dao };
    const a = await refreshBoard(env, stubClient(), cfg, cfg.boards[0]!, opts);
    const b = await refreshBoard(env, stubClient(), cfg, cfg.boards[0]!, opts);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const rows = await db.prepare('SELECT * FROM risk_snapshots').all();
    expect(rows.results).toHaveLength(1);
    expect(await getSnapshot(env, CLOUD, 5)).toEqual(JSON.parse(JSON.stringify(a)));
  });
});

describe('eligibility', () => {
  const now = Date.parse('2026-07-01T12:00:00.000Z');
  const ago = (ms: number): string => new Date(now - ms).toISOString();

  it('refreshes a board that has never been refreshed', () => {
    expect(isEligible(CLOUD, 5, null, now)).toBe(true);
    expect(isEligible(CLOUD, 5, { lastViewedAt: null, lastRefreshAt: null }, now)).toBe(true);
  });

  it('uses the fast cadence only while a board is actively viewed', () => {
    const viewed = ago(60_000);
    expect(
      isEligible(CLOUD, 5, { lastViewedAt: viewed, lastRefreshAt: ago(ACTIVE_REFRESH_MS - 1000) }, now),
    ).toBe(false);
    expect(
      isEligible(CLOUD, 5, { lastViewedAt: viewed, lastRefreshAt: ago(ACTIVE_REFRESH_MS + 1000) }, now),
    ).toBe(true);
    // Viewed an hour ago = no longer active: the fast cadence doesn't apply.
    expect(
      isEligible(
        CLOUD,
        5,
        { lastViewedAt: ago(60 * 60_000), lastRefreshAt: ago(ACTIVE_REFRESH_MS + 1000) },
        now,
      ),
    ).toBe(false);
  });

  it('backs off exponentially while a board keeps failing', () => {
    const failing = (failures: number, attemptAgo: number) => ({
      lastViewedAt: null,
      lastRefreshAt: null, // never succeeded: cadence alone would elect it every tick
      lastAttemptAt: ago(attemptAgo),
      failures,
      degradedReason: 'errors' as const,
    });
    // 3 failures -> 2^3 * 5 min = 40 min of quiet.
    expect(isEligible(CLOUD, 5, failing(3, 10 * 60_000), now)).toBe(false);
    expect(isEligible(CLOUD, 5, failing(3, 8 * 60 * 60_000), now)).toBe(true);
    // ...but never longer than the cap, however many failures pile up.
    expect(isEligible(CLOUD, 5, failing(20, BACKOFF_CAP_MS - 60_000), now)).toBe(false);
    expect(isEligible(CLOUD, 5, failing(20, BACKOFF_CAP_MS + 60_000), now)).toBe(true);
    // A board that has never failed is unaffected.
    expect(
      isEligible(CLOUD, 5, { lastViewedAt: null, lastRefreshAt: null, lastAttemptAt: null }, now),
    ).toBe(true);
  });

  it('retries a needs_reauth board only after the config is touched', () => {
    const state = {
      lastViewedAt: null,
      lastRefreshAt: null,
      lastAttemptAt: ago(60_000),
      failures: 0, // markDegraded deliberately doesn't count a failure
      degradedReason: 'needs_reauth' as const,
    };
    expect(isEligible(CLOUD, 5, state, now, ago(60 * 60_000))).toBe(false);
    expect(isEligible(CLOUD, 5, state, now, ago(30_000))).toBe(true);
    // ...and an untouched config with an unusable grant stays parked.
    expect(isEligible(CLOUD, 5, state, now, ago(60 * 60_000), false)).toBe(false);
  });

  it('self-heals a needs_reauth board once the refresher grant is usable again', () => {
    const state = {
      lastViewedAt: null,
      lastRefreshAt: null,
      lastAttemptAt: ago(60_000),
      failures: 0,
      degradedReason: 'needs_reauth' as const,
    };
    // No admin touched anything; the refresher just logged back in.
    expect(isEligible(CLOUD, 5, state, now, ago(60 * 60_000), true)).toBe(true);
  });

  it('a re-elected needs_reauth board still obeys the failure backoff', () => {
    // A usable grant that nonetheless keeps failing must fall THROUGH to the
    // backoff rather than hot-looping every tick.
    const state = {
      lastViewedAt: null,
      lastRefreshAt: null,
      lastAttemptAt: ago(10 * 60_000),
      failures: 3, // 2^3 * 5 min = 40 min of quiet
      degradedReason: 'needs_reauth' as const,
    };
    expect(isEligible(CLOUD, 5, state, now, ago(60 * 60_000), true)).toBe(false);
    expect(
      isEligible(
        CLOUD,
        5,
        { ...state, lastAttemptAt: ago(8 * 60 * 60_000) },
        now,
        ago(60 * 60_000),
        true,
      ),
    ).toBe(true);
  });

  it('falls back to the idle cadence, jittered per board', () => {
    const state = (age: number) => ({ lastViewedAt: null, lastRefreshAt: ago(age) });
    expect(isEligible(CLOUD, 5, state(IDLE_REFRESH_MS - 60_000), now)).toBe(false);
    expect(isEligible(CLOUD, 5, state(IDLE_REFRESH_MS + 30 * 60_000), now)).toBe(true);
    // Just past the hour, the deterministic jitter staggers boards across ticks
    // instead of firing all of them on the same one.
    const justPast = state(IDLE_REFRESH_MS + 3 * 60_000);
    const verdicts = Array.from({ length: 20 }, (_, i) => isEligible(CLOUD, i + 1, justPast, now));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
    // ...but it is deterministic: same board, same answer.
    expect(isEligible(CLOUD, 7, justPast, now)).toBe(isEligible(CLOUD, 7, justPast, now));
  });
});

// --- Fleet scheduling (real store + stubbed global fetch) ----------------------

/** Every JiraClient.get() ends up here; `fail` lets one org break. */
function stubFetch(opts: { fail?: (url: string) => number | null } = {}): ReturnType<typeof vi.fn> {
  const client = stubClient();
  const fn = vi.fn(async (url: string) => {
    const status = opts.fail?.(url) ?? null;
    if (status) return new Response('nope', { status });
    const path = url.replace(/^https:\/\/api\.atlassian\.com\/ex\/jira\/[^/]+/, '');
    const body = await client.get<unknown>(path);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Like stubFetch, but one board serves `count` issues over several pages — enough
 *  to blow past BOARD_COST_ESTIMATE and exercise the budget reconciliation. */
function stubFetchWithBigBoard(bigBoardId: number, count: number): ReturnType<typeof vi.fn> {
  const base = stubClient();
  const big = Array.from({ length: count }, (_, i) =>
    issue(String(1000 + i), `BIG-${i}`, '2', 'In Progress'),
  );
  const fn = vi.fn(async (url: string) => {
    const path = url.replace(/^https:\/\/api\.atlassian\.com\/ex\/jira\/[^/]+/, '');
    let body: unknown;
    if (path.startsWith(`/rest/agile/1.0/board/${bigBoardId}/issue`)) {
      const startAt = Number(new URL(`https://x${path}`).searchParams.get('startAt') ?? '0');
      body = { issues: big.slice(startAt, startAt + 50), total: big.length };
    } else if (/^\/rest\/api\/3\/issue\/1\d{3}\/changelog/.test(path)) {
      body = { total: 0, values: [] };
    } else {
      body = await base.get<unknown>(path);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function seedToken(accountId: string): Promise<void> {
  await dao.upsertToken({
    accountId,
    refreshToken: 'rt',
    accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

const boardsFor = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ boardId: i + 1, name: `${prefix}-${i + 1}` }));

describe('refreshRiskBoards (fleet)', () => {
  it('stops at the per-tick budget and resumes on the next tick', async () => {
    await seedToken(REFRESHER);
    const perTick = Math.floor(TICK_SUBREQUEST_BUDGET / BOARD_COST_ESTIMATE);
    const total = perTick + 4;
    await putConfig(env, { ...orgConfig({ boards: boardsFor(total, 'B') }) });
    stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0);
    let rows = await db.prepare('SELECT * FROM risk_snapshots').all();
    expect(rows.results).toHaveLength(perTick); // budget-capped

    await refreshRiskBoards(env, dao, silent, NOW, 0);
    rows = await db.prepare('SELECT * FROM risk_snapshots').all();
    expect(rows.results).toHaveLength(total); // the remainder resumed
  });

  it('interleaves orgs so a big org cannot starve a small one', async () => {
    await seedToken(REFRESHER);
    const perTick = Math.floor(TICK_SUBREQUEST_BUDGET / BOARD_COST_ESTIMATE);
    await putConfig(env, orgConfig({ boards: boardsFor(perTick, 'Big') }));
    await putConfig(env, orgConfig({ cloudId: OTHER, boards: boardsFor(2, 'Small') }));
    stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0);

    const rows = await db
      .prepare('SELECT cloud_id, COUNT(*) AS n FROM risk_snapshots GROUP BY cloud_id')
      .all<{ cloud_id: string; n: number }>();
    const bySmall = rows.results.find((r) => r.cloud_id === OTHER);
    expect(bySmall?.n).toBe(2); // the small org got in despite the big one's queue
    expect(rows.results.reduce((s, r) => s + r.n, 0)).toBe(perTick);
  });

  it('degrades only the failing org: a 429 in one leaves the others complete', async () => {
    await seedToken(REFRESHER);
    await putConfig(env, orgConfig());
    await putConfig(env, orgConfig({ cloudId: OTHER }));
    stubFetch({ fail: (url) => (url.includes(`/jira/${OTHER}`) ? 429 : null) });

    await refreshRiskBoards(env, dao, silent, NOW, 0);

    expect(await getSnapshot(env, CLOUD, 5)).not.toBeNull();
    expect(await getSnapshot(env, OTHER, 5)).toBeNull();
    expect((await getState(env, OTHER, 5))?.failures).toBe(1);
    expect((await getState(env, CLOUD, 5))?.failures).toBe(0);
  });

  it('marks needs_reauth and makes zero Jira calls when the refresher has no grant', async () => {
    await putConfig(env, orgConfig()); // no oauth_tokens row for REFRESHER
    const fetchFn = stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0);

    expect(fetchFn).not.toHaveBeenCalled();
    expect((await getState(env, CLOUD, 5))?.degradedReason).toBe('needs_reauth');
    expect(await getSnapshot(env, CLOUD, 5)).toBeNull();
  });

  it('marks needs_reauth when the refresher’s grant is flagged for re-auth', async () => {
    await seedToken(REFRESHER);
    await dao.upsertUser(REFRESHER, 'Refresher', CLOUD);
    await dao.setNeedsReauth(REFRESHER, true);
    await putConfig(env, orgConfig());
    const fetchFn = stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0);

    expect(fetchFn).not.toHaveBeenCalled();
    expect((await getState(env, CLOUD, 5))?.degradedReason).toBe('needs_reauth');
  });

  it('stops retrying a needs_reauth org while the refresher grant is still broken', async () => {
    await putConfig(env, orgConfig());
    // putConfig stamps updated_at from the wall clock; pin it behind the injected NOW.
    await db.prepare(`UPDATE risk_board_config SET updated_at = ?`).bind(at(0)).run();
    const first = stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0); // no grant -> degraded
    expect(first).not.toHaveBeenCalled();
    expect((await getState(env, CLOUD, 5))?.degradedReason).toBe('needs_reauth');
    const attempt = (await getState(env, CLOUD, 5))?.lastAttemptAt;

    // Still no grant: the board isn't even re-elected (markDegraded doesn't count a
    // failure, so backoff can't cover it — only a fixable cause re-elects it).
    vi.unstubAllGlobals();
    const second = stubFetch();
    await refreshRiskBoards(env, dao, silent, NOW + 60_000, 0);
    expect(second).not.toHaveBeenCalled();
    expect((await getState(env, CLOUD, 5))?.lastAttemptAt).toBe(attempt);

    // An admin saves the config (updated_at bumps) -> re-elected, and it attempts
    // again (still grant-less, so it re-degrades rather than fetching).
    await putConfig(env, orgConfig());
    vi.unstubAllGlobals();
    const third = stubFetch();
    await refreshRiskBoards(env, dao, silent, NOW + 120_000, 0);
    expect(third).not.toHaveBeenCalled();
    expect((await getState(env, CLOUD, 5))?.lastAttemptAt).not.toBe(attempt);
  });

  it('self-heals a needs_reauth org when the refresher logs back in', async () => {
    await seedToken(REFRESHER);
    await dao.upsertUser(REFRESHER, 'Refresher', CLOUD);
    await dao.setNeedsReauth(REFRESHER, true);
    await putConfig(env, orgConfig({ boards: boardsFor(3, 'B') }));
    await db.prepare(`UPDATE risk_board_config SET updated_at = ?`).bind(at(0)).run();
    stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0);
    for (const id of [1, 2, 3]) {
      expect((await getState(env, CLOUD, id))?.degradedReason).toBe('needs_reauth');
    }

    // The refresher signs in again: dao.upsertUser clears needs_reauth, and nobody
    // touches the risk config. The boards must come back on their own.
    await dao.upsertUser(REFRESHER, 'Refresher', CLOUD);
    vi.unstubAllGlobals();
    const after = stubFetch();
    await refreshRiskBoards(env, dao, silent, NOW + 60_000, 0);
    expect(after).toHaveBeenCalled();
    for (const id of [1, 2, 3]) {
      expect((await getState(env, CLOUD, id))?.degradedReason).toBeNull();
      expect(await getSnapshot(env, CLOUD, id)).not.toBeNull();
    }
  });

  it('holds a permanently failing board in backoff instead of retrying every tick', async () => {
    await seedToken(REFRESHER);
    await putConfig(
      env,
      orgConfig({
        boards: [
          { boardId: 1, name: 'Broken' },
          { boardId: 2, name: 'Good' },
        ],
      }),
    );
    stubFetch({ fail: (url) => (url.includes('/board/1') ? 500 : null) });

    await refreshRiskBoards(env, dao, silent, NOW, 0);
    // The broken board fails; the healthy one still got its snapshot.
    expect((await getState(env, CLOUD, 1))?.failures).toBe(1);
    expect(await getSnapshot(env, CLOUD, 1)).toBeNull();
    expect(await getSnapshot(env, CLOUD, 2)).not.toBeNull();

    // Next tick, inside the 2^1 * 5 min backoff: not attempted again.
    await refreshRiskBoards(env, dao, silent, NOW + 5 * 60_000, 0);
    expect(await getState(env, CLOUD, 1)).toMatchObject({
      failures: 1,
      lastAttemptAt: new Date(NOW).toISOString(),
    });

    // Well past the backoff, it is retried (and fails again).
    await refreshRiskBoards(env, dao, silent, NOW + 90 * 60_000, 0);
    expect((await getState(env, CLOUD, 1))?.failures).toBe(2);
  });

  it('counts the Jira calls it actually made and charges overruns to the tick', async () => {
    await seedToken(REFRESHER);
    // 12 boards = the whole budget pre-charged, so any overrun defers the rest.
    await putConfig(env, orgConfig({ boards: boardsFor(12, 'B') }));
    const fetchFn = stubFetchWithBigBoard(1, 60);
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const capturing = {
      debug: () => {},
      info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      error: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      child: () => capturing,
    };

    await refreshRiskBoards(env, dao, capturing, NOW, 0);

    // Board 1 alone costs 65 calls against its 50-unit pre-charge, so the org stops
    // there and the other 11 boards wait for the next tick.
    const rows = await db.prepare('SELECT * FROM risk_snapshots').all();
    expect(rows.results).toHaveLength(1);
    expect(lines.some((l) => l.msg.includes('budget overspent'))).toBe(true);

    // The logged call count is the real one, not the estimate.
    const tick = lines.find((l) => l.msg === 'risk: refresh tick done');
    expect(tick?.fields?.['jiraCalls']).toBe(fetchFn.mock.calls.length);
  });

  it('lets a rate-limited dev-status probe stop the org instead of shipping empty PRs', async () => {
    await seedToken(REFRESHER);
    await putConfig(
      env,
      orgConfig({
        devStatusAvailable: null, // unprobed: the refresher will try the endpoint
        boards: [
          { boardId: 1, name: 'One' },
          { boardId: 2, name: 'Two' },
        ],
      }),
    );
    stubFetch({ fail: (url) => (url.includes('/rest/dev-status/') ? 429 : null) });

    await refreshRiskBoards(env, dao, silent, NOW, 0);

    // A 429 is not "this issue has no PRs": the whole org backs off for this tick.
    expect(await getSnapshot(env, CLOUD, 1)).toBeNull();
    expect(await getSnapshot(env, CLOUD, 2)).toBeNull();
    expect((await getState(env, CLOUD, 1))?.failures).toBe(1);
    expect((await getState(env, CLOUD, 2))?.failures).toBe(1);
    // ...and the probe verdict is NOT latched off a transient failure.
    expect((await getConfig(env, CLOUD))?.devStatusAvailable).toBeNull();
  });

  it('skips boards that are not due', async () => {
    await seedToken(REFRESHER);
    await putConfig(env, orgConfig());
    stubFetch();

    await refreshRiskBoards(env, dao, silent, NOW, 0); // first run: never refreshed
    const first = (await getSnapshot(env, CLOUD, 5))?.computedAt;
    await refreshRiskBoards(env, dao, silent, NOW, 0); // immediately after: not due
    expect((await getSnapshot(env, CLOUD, 5))?.computedAt).toBe(first);
  });
});
