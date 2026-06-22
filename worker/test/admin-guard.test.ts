import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import type { AuthedCtx } from '../src/http';
import type { Env } from '../src/env';
import { revokeAdmin } from '../src/routes/admin';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;
const env = { BOOTSTRAP_ADMIN_ACCOUNT_ID: '' } as Env;

function ctx(accountId: string): AuthedCtx {
  return { accountId, cloudId: 'c1', sid: 'sess-1', dao, env };
}

beforeEach(() => {
  dao = new Dao(new SqliteD1());
});

describe('last-admin guard', () => {
  it('refuses to revoke the only admin', async () => {
    await dao.appointAdmin('admin-1', null);
    const res = await revokeAdmin(ctx('admin-2'), 'admin-1');
    expect(res.status).toBe(409);
    expect(await dao.isAdmin('admin-1')).toBe(true);
  });

  it('refuses self-revoke when sole admin', async () => {
    await dao.appointAdmin('admin-1', null);
    const res = await revokeAdmin(ctx('admin-1'), 'admin-1');
    expect(res.status).toBe(409);
    expect(await dao.isAdmin('admin-1')).toBe(true);
  });

  it('allows revoking an admin when others remain', async () => {
    await dao.appointAdmin('admin-1', null);
    await dao.appointAdmin('admin-2', 'admin-1');
    const res = await revokeAdmin(ctx('admin-1'), 'admin-2');
    expect(res.status).toBe(200);
    expect(await dao.isAdmin('admin-2')).toBe(false);
    expect(await dao.isAdmin('admin-1')).toBe(true);
  });
});
