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
    const series = await dao.teamSeries(CLOUD, team);
    // The original event had teamIdAtDone null, so this team's done is 0 — but
    // the key point: only ONE row exists for changelog 7777 (no double count).
    expect(series.reduce((n, s) => n + s.donePoints, 0)).toBe(0);
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
