import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;
const CLOUD = 'c1';

beforeEach(() => {
  dao = new Dao(new SqliteD1());
});

describe('effective-dated membership', () => {
  it('reports the team an account belonged to at a given instant', async () => {
    const a = await dao.createTeam(CLOUD, 'Alpha');
    const b = await dao.createTeam(CLOUD, 'Beta');
    await dao.assignMembership('u1', a, '2026-01-01T00:00:00.000Z');
    await dao.assignMembership('u1', b, '2026-03-01T00:00:00.000Z'); // moved teams

    expect(await dao.teamAt('u1', '2026-02-01T00:00:00.000Z')).toBe(a);
    expect(await dao.teamAt('u1', '2026-04-01T00:00:00.000Z')).toBe(b);
    expect(await dao.teamAt('u1', '2025-12-01T00:00:00.000Z')).toBeNull();
  });

  it('keeps at most one open membership (assign closes the prior)', async () => {
    const a = await dao.createTeam(CLOUD, 'Alpha');
    const b = await dao.createTeam(CLOUD, 'Beta');
    await dao.assignMembership('u1', a, '2026-01-01T00:00:00.000Z');
    await dao.assignMembership('u1', b, '2026-03-01T00:00:00.000Z');
    const rows = await dao.listMemberships(a);
    expect(rows[0]!.effectiveTo).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('rating reflection fields (notes/title/url)', () => {
  it('round-trips notes, title and url through insertRating → getRatingsForOwner', async () => {
    await dao.insertRating({
      cloudId: CLOUD,
      issueKey: 'X-1',
      raterAccountId: 'u1',
      claimedPoints: 5,
      storyPointsAtRating: 5,
      teamIdAtRating: null,
      sprintId: null,
      transitionedAt: '2026-06-22T09:00:00.000Z',
      notes: 'Wrapped up the tricky migration — proud of this one.',
      title: 'Migrate the thing',
      url: 'https://acme.atlassian.net/browse/X-1',
    });

    const rows = await dao.getRatingsForOwner('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transitionedAt).toBe('2026-06-22T09:00:00.000Z');
    expect(rows[0]!.notes).toBe('Wrapped up the tricky migration — proud of this one.');
    expect(rows[0]!.title).toBe('Migrate the thing');
    expect(rows[0]!.url).toBe('https://acme.atlassian.net/browse/X-1');
  });

  it('leaves the fields null when omitted', async () => {
    await dao.insertRating({
      cloudId: CLOUD,
      issueKey: 'X-2',
      raterAccountId: 'u1',
      claimedPoints: 3,
      storyPointsAtRating: null,
      teamIdAtRating: null,
      sprintId: null,
    });

    const rows = await dao.getRatingsForOwner('u1');
    expect(rows[0]!.transitionedAt).toBeNull();
    expect(rows[0]!.notes).toBeNull();
    expect(rows[0]!.title).toBeNull();
    expect(rows[0]!.url).toBeNull();
  });
});

describe('done_event idempotency', () => {
  it('records a done transition exactly once per changelog id', async () => {
    const input = {
      cloudId: CLOUD,
      issueKey: 'X-1',
      storyPoints: 5,
      sprintId: 1,
      transitionedToDoneAt: '2026-05-10T00:00:00.000Z',
      changelogId: '7777',
      accountId: 'u1',
      teamIdAtDone: null,
    };
    await dao.insertDoneEvent(input);
    await dao.insertDoneEvent(input); // overlapping window re-poll
    await dao.upsertSprint({
      cloudId: CLOUD,
      sprintId: 1,
      boardId: 1,
      name: 'S1',
      startAt: '2026-05-01T00:00:00.000Z',
      endAt: '2026-05-15T00:00:00.000Z',
    });
    const team = await dao.createTeam(CLOUD, 'T');
    // Re-attribute to a team for the series check.
    await dao.insertDoneEvent({ ...input, changelogId: '7777', teamIdAtDone: team }); // still dupe
    const series = await dao.teamSeries(CLOUD, team, '1970-01-01T00:00:00.000Z');
    // The original event had teamIdAtDone null, so this team's done is 0 — but
    // the key point: only ONE row exists for changelog 7777 (no double count).
    expect(series.reduce((n, s) => n + s.donePoints, 0)).toBe(0);
  });
});

describe('deletePendingForOwner', () => {
  const pending = (pendingId: string, accountId: string) => ({
    pendingId,
    cloudId: CLOUD,
    accountId,
    issueKey: 'X-1',
    title: 'X-1',
    url: 'https://example.atlassian.net/browse/X-1',
    storyPoints: 3,
    toStatus: 'Done',
    changelogId: pendingId,
    transitionedAt: '2026-06-22T00:00:00.000Z',
  });

  it('clears all of one owner without touching another owner', async () => {
    await dao.insertPending(pending('p1', 'u1'));
    await dao.insertPending(pending('p2', 'u1'));
    await dao.insertPending(pending('p3', 'u2'));

    await dao.deletePendingForOwner('u1');

    expect(await dao.getPendingForOwner('u1')).toHaveLength(0);
    expect(await dao.getPendingForOwner('u2')).toHaveLength(1);
  });
});

describe('issue_state cursor', () => {
  it('persists and advances the last-seen changelog id', async () => {
    expect(await dao.getLastSeenChangelogId(CLOUD, 'X-1')).toBeNull();
    await dao.setLastSeenChangelogId(CLOUD, 'X-1', '100');
    expect(await dao.getLastSeenChangelogId(CLOUD, 'X-1')).toBe('100');
    await dao.setLastSeenChangelogId(CLOUD, 'X-1', '205');
    expect(await dao.getLastSeenChangelogId(CLOUD, 'X-1')).toBe('205');
  });
});

describe('claimed trends (date-bucketed)', () => {
  const ALICE = 'acct-alice';
  const BOB = 'acct-bob';
  let db: SqliteD1;
  let team: string;

  // Insert a rating at an explicit rated_at (dao.insertRating stamps now()), and an
  // optional transitioned_at — the day views bucket on COALESCE(transitioned_at,
  // rated_at), so leaving it off exercises the legacy fallback to rated_at.
  async function rate(opts: {
    rater: string;
    team: string | null;
    frac: number;
    pts: number;
    at: string;
    transitionedAt?: string;
  }): Promise<void> {
    await db
      .prepare(
        `INSERT INTO ratings
           (id, cloud_id, issue_key, rater_account_id, claimed_points,
            story_points_at_rating, team_id_at_rating, sprint_id, rated_at, transitioned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(), CLOUD, 'X-1', opts.rater, opts.frac * opts.pts,
        opts.pts, opts.team, null, opts.at, opts.transitionedAt ?? null,
      )
      .run();
  }

  beforeEach(async () => {
    db = new SqliteD1();
    dao = new Dao(db);
    team = await dao.createTeam(CLOUD, 'Alpha');
    await dao.assignMembership(ALICE, team, '2026-05-01T00:00:00.000Z');
    await dao.assignMembership(BOB, team, '2026-05-01T00:00:00.000Z');

    // Two same-day Alice ratings (5 + 0.5*4 = 7), one later day (3); one Bob (0.5*8 = 4).
    await rate({ rater: ALICE, team, frac: 1, pts: 5, at: '2026-06-01T10:00:00.000Z' });
    await rate({ rater: ALICE, team, frac: 0.5, pts: 4, at: '2026-06-01T12:00:00.000Z' });
    await rate({ rater: ALICE, team, frac: 1, pts: 3, at: '2026-06-09T09:00:00.000Z' });
    await rate({ rater: BOB, team, frac: 0.5, pts: 8, at: '2026-06-01T08:00:00.000Z' });
    // Outside the query window — must be excluded by the date filter.
    await rate({ rater: ALICE, team, frac: 1, pts: 99, at: '2026-04-01T00:00:00.000Z' });
  });

  it('personalClaimedByDay returns only the owner, summed per UTC day', async () => {
    const rows = await dao.personalClaimedByDay(
      ALICE, CLOUD, '2026-05-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
    );
    expect(rows).toEqual([
      { day: '2026-06-01', claimed: 7 }, // not 11 — Bob excluded
      { day: '2026-06-09', claimed: 3 },
    ]);
  });

  it('teamClaimedByDay sums every rater on the team, no account column', async () => {
    const rows = await dao.teamClaimedByDay(
      CLOUD, team, '2026-05-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
    );
    expect(rows).toEqual([
      { day: '2026-06-01', claimed: 11 }, // 7 (Alice) + 4 (Bob)
      { day: '2026-06-09', claimed: 3 },
    ]);
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(ALICE);
    expect(blob).not.toContain(BOB);
  });

  it('buckets on transitioned_at, not rated_at, when present', async () => {
    // Claimed 2026-06-15 for work that transitioned 2026-06-09. It must land on the
    // transition day, AND the window filter must judge inclusion on that same day.
    await rate({
      rater: ALICE, team, frac: 1, pts: 2,
      at: '2026-06-15T10:00:00.000Z',
      transitionedAt: '2026-06-09T23:00:00.000Z',
    });

    const personal = await dao.personalClaimedByDay(
      ALICE, CLOUD, '2026-05-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
    );
    expect(personal).toEqual([
      { day: '2026-06-01', claimed: 7 }, // legacy rows (no transition) fall back to rated_at
      { day: '2026-06-09', claimed: 5 }, // 3 (legacy) + 2 (bucketed by its transition, not 06-15)
    ]);

    const teamRows = await dao.teamClaimedByDay(
      CLOUD, team, '2026-05-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
    );
    expect(teamRows).toEqual([
      { day: '2026-06-01', claimed: 11 },
      { day: '2026-06-09', claimed: 5 },
    ]);
  });

  it('teamSize counts open memberships', async () => {
    expect(await dao.teamSize(team)).toBe(2);
    await dao.assignMembership(BOB, await dao.createTeam(CLOUD, 'Beta')); // Bob leaves Alpha
    expect(await dao.teamSize(team)).toBe(1);
  });
});
