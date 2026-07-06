// The self-scoped settings endpoint: daily-goal validation + persistence, and
// the invariant that a re-login (upsertUser) never clobbers a saved goal.
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DAILY_GOAL } from '@shared/domain';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { updateMySettings } from '../src/routes/settings';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;
const ACCT = 'u1';
const env = {} as Env;

function ctx(): AuthedCtx {
  return { accountId: ACCT, cloudId: 'c1', sid: 's1', dao, env };
}

function put(body: unknown): Request {
  return new Request('https://x/api/me/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dao = new Dao(new SqliteD1());
  await dao.upsertUser(ACCT, 'Alice', 'c1');
});

describe('updateMySettings', () => {
  it('saves a goal and getUserSettings returns it', async () => {
    const res = await updateMySettings(put({ dailyGoal: 16 }), ctx());
    expect(res.status).toBe(200);
    expect((await dao.getUserSettings(ACCT)).dailyGoal).toBe(16);
  });

  it('null clears the goal', async () => {
    await updateMySettings(put({ dailyGoal: 16 }), ctx());
    const res = await updateMySettings(put({ dailyGoal: null }), ctx());
    expect(res.status).toBe(200);
    expect((await dao.getUserSettings(ACCT)).dailyGoal).toBeNull();
  });

  it.each([
    ['zero', { dailyGoal: 0 }],
    ['negative', { dailyGoal: -3 }],
    ['above the cap', { dailyGoal: MAX_DAILY_GOAL + 1 }],
    ['non-numeric', { dailyGoal: '16' }],
    ['missing field', {}],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await updateMySettings(put(body), ctx());
    expect(res.status).toBe(400);
    expect((await dao.getUserSettings(ACCT)).dailyGoal).toBeNull();
  });

  it('rejects Infinity (JSON 1e999) with 400', async () => {
    // NaN can't arrive through JSON, but an overflowing literal parses to Infinity.
    const req = new Request('https://x/api/me/settings', {
      method: 'PUT',
      body: '{"dailyGoal":1e999}',
    });
    const res = await updateMySettings(req, ctx());
    expect(res.status).toBe(400);
    expect((await dao.getUserSettings(ACCT)).dailyGoal).toBeNull();
  });
});

describe('upsertUser vs settings', () => {
  it('a re-login updates the avatar but preserves the saved goal', async () => {
    await dao.setDailyGoal(ACCT, 12);
    await dao.upsertUser(ACCT, 'Alice Renamed', 'c1', 'https://cdn/avatar.png');
    const s = await dao.getUserSettings(ACCT);
    expect(s.dailyGoal).toBe(12);
    expect(s.avatarUrl).toBe('https://cdn/avatar.png');
  });
});
