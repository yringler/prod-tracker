// Multi-site: one grant (token) per account, many reachable sites, and the
// site-switch guard (a session can only select a cloud the token can reach).
import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import type { AuthedCtx } from '../src/http';
import type { Env } from '../src/env';
import { switchSite } from '../src/routes/auth';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;
const env = { BOOTSTRAP_ADMIN_ACCOUNT_ID: '' } as Env;
const ACCT = 'acct-1';

async function authedCtx(sid: string, cloudId: string): Promise<AuthedCtx> {
  return { accountId: ACCT, cloudId, sid, dao, env };
}

beforeEach(async () => {
  dao = new Dao(new SqliteD1());
  await dao.upsertUser(ACCT, 'Alice', 'cloud-a');
  await dao.upsertToken({
    accountId: ACCT,
    refreshToken: 'r1',
    accessToken: 'a1',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await dao.upsertSite(ACCT, { cloudId: 'cloud-a', name: 'Acme', siteUrl: 'https://acme.atlassian.net' });
  await dao.upsertSite(ACCT, { cloudId: 'cloud-b', name: 'Beta', siteUrl: 'https://beta.atlassian.net' });
});

describe('one grant, many sites', () => {
  it('stores a single token per account regardless of site count', async () => {
    const tokens = await dao.allTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.accountId).toBe(ACCT);
    expect(tokens[0]!.refreshToken).toBe('r1');
  });

  it('lists every reachable site for the picker', async () => {
    const sites = await dao.listSites(ACCT);
    expect(sites.map((s) => s.cloudId).sort()).toEqual(['cloud-a', 'cloud-b']);
  });
});

describe('site-switch guard', () => {
  it('allows switching to a reachable site and updates the session', async () => {
    const sid = await dao.createSession(ACCT, 'cloud-a', 3600);
    const res = await switchSite(
      new Request('http://x/api/session/site', { method: 'POST', body: JSON.stringify({ cloudId: 'cloud-b' }) }),
      await authedCtx(sid, 'cloud-a'),
    );
    expect(res.status).toBe(200);
    const session = await dao.getSession(sid);
    expect(session!.cloudId).toBe('cloud-b'); // selection moved
  });

  it('refuses a cloud the account cannot reach (403, session unchanged)', async () => {
    const sid = await dao.createSession(ACCT, 'cloud-a', 3600);
    const res = await switchSite(
      new Request('http://x/api/session/site', { method: 'POST', body: JSON.stringify({ cloudId: 'cloud-evil' }) }),
      await authedCtx(sid, 'cloud-a'),
    );
    expect(res.status).toBe(403);
    const session = await dao.getSession(sid);
    expect(session!.cloudId).toBe('cloud-a'); // unchanged
  });
});
