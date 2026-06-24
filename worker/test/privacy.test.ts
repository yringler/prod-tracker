// The load-bearing privacy invariant, tested against real SQL:
//   1. The personal endpoint refuses to return another account's rows.
//   2. No aggregate path exposes a per-account breakdown (sums only, no rater
//      filter, no account column).
import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import { SqliteD1 } from './support/sqlite-d1';

let db: SqliteD1;
let dao: Dao;

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';
const BOB = 'acct-bob';

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);

  await dao.upsertUser(ALICE, 'Alice', CLOUD);
  await dao.upsertUser(BOB, 'Bob', CLOUD);

  const teamId = await dao.createTeam(CLOUD, 'Site');
  await dao.assignMembership(ALICE, teamId, '2026-05-01T00:00:00.000Z');
  await dao.assignMembership(BOB, teamId, '2026-05-01T00:00:00.000Z');
  await dao.upsertSprint({
    cloudId: CLOUD,
    sprintId: 10,
    boardId: 1,
    name: 'Sprint 10',
    startAt: '2026-05-01T00:00:00.000Z',
    endAt: '2026-05-15T00:00:00.000Z',
  });

  // Alice claims 5 pts on ABC-1 (100% of 5); Bob claims 4 pts on ABC-2 (50% of 8).
  await dao.insertRating({
    cloudId: CLOUD,
    issueKey: 'ABC-1',
    raterAccountId: ALICE,
    claimedPoints: 5,
    storyPointsAtRating: 5,
    teamIdAtRating: teamId,
    sprintId: 10,
  });
  await dao.insertRating({
    cloudId: CLOUD,
    issueKey: 'ABC-2',
    raterAccountId: BOB,
    claimedPoints: 4,
    storyPointsAtRating: 8,
    teamIdAtRating: teamId,
    sprintId: 10,
  });
  // Real Jira done series for the same team/sprint.
  await dao.insertDoneEvent({
    cloudId: CLOUD,
    issueKey: 'ABC-1',
    storyPoints: 5,
    sprintId: 10,
    transitionedToDoneAt: '2026-05-10T00:00:00.000Z',
    changelogId: '9001',
    accountId: ALICE,
    teamIdAtDone: teamId,
  });
});

describe('personal endpoint scoping', () => {
  it('returns only the owner rows, never another account', async () => {
    const aliceRows = await dao.getRatingsForOwner(ALICE);
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0]!.issueKey).toBe('ABC-1');

    const bobRows = await dao.getRatingsForOwner(BOB);
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.issueKey).toBe('ABC-2');

    // Alice's view contains nothing of Bob's, by construction (WHERE rater = ?).
    expect(aliceRows.some((r) => r.issueKey === 'ABC-2')).toBe(false);
  });
});

describe('aggregate endpoint — team-grouped, sums only', () => {
  it('emits team sums with no per-account fields', async () => {
    const teams = await dao.listTeams(CLOUD);
    const series = await dao.teamSeries(CLOUD, teams[0]!.teamId, '1970-01-01T00:00:00.000Z');
    const s10 = series.find((s) => s.sprintId === 10)!;

    // claimed = 1*5 + 0.5*8 = 9 (uncapped across raters); done = 5; ratio = 1.8.
    expect(s10.claimedPoints).toBe(9);
    expect(s10.donePoints).toBe(5);
    expect(s10.ratio).toBeCloseTo(1.8);
    expect(s10.claimedPerActiveRater).toBeCloseTo(4.5); // 9 / 2 raters

    // Structural guarantee: no per-account key anywhere in an aggregate row.
    const keys = Object.keys(s10).join(',') + JSON.stringify(s10);
    expect(keys).not.toContain('account');
    expect(keys).not.toContain(ALICE);
    expect(keys).not.toContain(BOB);
  });

  it('teamSeries signature takes no rater filter (compile-time invariant)', () => {
    // Documented as a runtime check too: only cloudId + teamId + sinceIso are
    // accepted — a date window, never a rater.
    expect(dao.teamSeries.length).toBe(3);
  });
});

describe('claimed-trends — same personal/team split', () => {
  const ANY = '2000-01-01T00:00:00.000Z';
  const FUTURE = '2999-01-01T00:00:00.000Z';

  it('personalClaimedByDay is self-scoped; teamClaimedByDay leaks no account', async () => {
    // Personal: Alice sees only her own claim (5), never Bob's.
    const alice = await dao.personalClaimedByDay(ALICE, CLOUD, ANY, FUTURE);
    const aliceTotal = alice.reduce((n, r) => n + r.claimed, 0);
    expect(aliceTotal).toBe(5); // 1 * 5, not 5 + 0.5*8

    const teams = await dao.listTeams(CLOUD);
    const team = await dao.teamClaimedByDay(CLOUD, teams[0]!.teamId, ANY, FUTURE);
    const teamTotal = team.reduce((n, r) => n + r.claimed, 0);
    expect(teamTotal).toBe(9); // 5 + 0.5*8, summed across raters

    const blob = JSON.stringify(team);
    expect(blob).not.toContain('account');
    expect(blob).not.toContain(ALICE);
    expect(blob).not.toContain(BOB);
  });
});
