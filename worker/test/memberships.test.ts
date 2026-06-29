// Team-membership writes are effective-dated. assignMembership must be
// idempotent — re-assigning to the same team must NOT split one continuous
// membership into redundant rows — and listMemberships must surface only the
// current roster (open rows, one per account).
import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;
let teamA: string;
let teamB: string;

beforeEach(async () => {
  dao = new Dao(new SqliteD1());
  await dao.upsertUser('acct-yehuda', 'Yehuda', 'cloud-a');
  teamA = await dao.createTeam('cloud-a', 'dotnet');
  teamB = await dao.createTeam('cloud-a', 'platform');
});

describe('assignMembership', () => {
  it('is a no-op when re-assigning to the same team (no redundant split)', async () => {
    await dao.assignMembership('acct-yehuda', teamA, '2026-06-22T00:00:00.000Z');
    await dao.assignMembership('acct-yehuda', teamA, '2026-06-24T00:00:00.000Z');

    const rows = await dao.listMemberships(teamA);
    expect(rows).toEqual([
      { accountId: 'acct-yehuda', effectiveFrom: '2026-06-22T00:00:00.000Z', effectiveTo: null },
    ]);
  });

  it('closes the old membership and opens a new one when moving teams', async () => {
    await dao.assignMembership('acct-yehuda', teamA, '2026-06-22T00:00:00.000Z');
    await dao.assignMembership('acct-yehuda', teamB, '2026-06-24T00:00:00.000Z');

    // No longer on team A (its row was closed).
    expect(await dao.listMemberships(teamA)).toEqual([]);
    // Now on team B with a fresh open row.
    expect(await dao.listMemberships(teamB)).toEqual([
      { accountId: 'acct-yehuda', effectiveFrom: '2026-06-24T00:00:00.000Z', effectiveTo: null },
    ]);
    // teamAt reflects the current team.
    expect(await dao.teamAt('acct-yehuda', '2026-06-25T00:00:00.000Z')).toBe(teamB);
  });
});

describe('listMemberships', () => {
  it('returns only the current roster (open rows), one per account', async () => {
    await dao.upsertUser('acct-mordechai', 'Mordechai', 'cloud-a');
    // Yehuda: A -> B -> back to A leaves one closed A row and one open A row.
    await dao.assignMembership('acct-yehuda', teamA, '2026-06-22T00:00:00.000Z');
    await dao.assignMembership('acct-yehuda', teamB, '2026-06-24T00:00:00.000Z');
    await dao.assignMembership('acct-yehuda', teamA, '2026-06-26T00:00:00.000Z');
    await dao.assignMembership('acct-mordechai', teamA, '2026-06-29T00:00:00.000Z');

    const rows = await dao.listMemberships(teamA);
    // Each account appears once, only its current (open) membership.
    expect(rows.map((r) => r.accountId).sort()).toEqual(['acct-mordechai', 'acct-yehuda']);
    expect(rows.every((r) => r.effectiveTo === null)).toBe(true);
  });
});
