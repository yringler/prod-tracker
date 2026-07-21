// Scope drift: a grant minted under an OLDER scope set keeps refreshing happily
// (no invalid_grant), so nothing in the app would notice — the new Agile calls
// would just 401 forever. jira/scopes.ts reads the access token's own `scope`
// claim; jira/client.ts turns a short grant into needs_reauth + a
// ReauthRequiredError, reusing every existing dead-grant path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { OAUTH_SCOPE_LIST } from '../src/env';
import { JiraClient, ReauthRequiredError, ScopeDriftError } from '../src/jira/client';
import { REQUIRED_TOKEN_SCOPES, missingScopes, tokenScopes } from '../src/jira/scopes';
import { SqliteD1 } from './support/sqlite-d1';

const ACCT = 'acct-1';
const env = { BOOTSTRAP_ADMIN_ACCOUNT_ID: '' } as Env;

/** An unsigned JWT with the given payload — we only ever decode the payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const CURRENT = jwt({ scope: OAUTH_SCOPE_LIST.join(' ') });
/** What a grant consented before the Agile-scope fix actually carries. */
const LEGACY = jwt({
  scope:
    'offline_access read:jira-user read:jira-work read:board-scope:jira-software ' +
    'read:project:jira read:sprint:jira-software',
});

describe('required scopes', () => {
  it('requests the granular scopes the Agile endpoints need', () => {
    for (const s of [
      'read:board-scope.admin:jira-software',
      'read:issue-details:jira',
      'read:jql:jira',
      'read:board-scope:jira-software',
      'read:sprint:jira-software',
      'read:project:jira',
    ]) {
      expect(OAUTH_SCOPE_LIST).toContain(s);
    }
  });

  it('does not gate on offline_access (an OAuth protocol scope, not a permission)', () => {
    expect(OAUTH_SCOPE_LIST).toContain('offline_access');
    expect(REQUIRED_TOKEN_SCOPES).not.toContain('offline_access');
  });
});

describe('tokenScopes', () => {
  it('reads the space-delimited scope claim out of the JWT payload', () => {
    expect([...tokenScopes(jwt({ scope: 'a b c' }))!].sort()).toEqual(['a', 'b', 'c']);
  });

  it('accepts an array-valued claim too', () => {
    expect([...tokenScopes(jwt({ scope: ['a', 'b'] }))!].sort()).toEqual(['a', 'b']);
  });

  it('returns null for an opaque token, a malformed payload, or no scope claim', () => {
    expect(tokenScopes('opaque-token')).toBeNull();
    expect(tokenScopes('a.!!!not-base64!!!.c')).toBeNull();
    expect(tokenScopes(jwt({ sub: 'x' }))).toBeNull();
    expect(tokenScopes(null)).toBeNull();
  });
});

describe('missingScopes', () => {
  it('is empty for a token minted under the current scope set', () => {
    expect(missingScopes(CURRENT)).toEqual([]);
  });

  it('names exactly the scopes a pre-fix grant lacks', () => {
    expect(missingScopes(LEGACY).sort()).toEqual([
      'read:board-scope.admin:jira-software',
      'read:issue-details:jira',
      'read:jql:jira',
    ]);
  });

  it('FAILS OPEN on an unreadable token — a parse quirk must never lock a user out', () => {
    expect(missingScopes('opaque-token')).toEqual([]);
    expect(missingScopes('')).toEqual([]);
  });
});

describe('JiraClient scope gate', () => {
  let dao: Dao;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    dao = new Dao(new SqliteD1());
    await dao.upsertUser(ACCT, 'Alice', 'cloud-a');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function clientWith(accessToken: string): Promise<JiraClient> {
    await dao.upsertToken({
      accountId: ACCT,
      refreshToken: 'r1',
      accessToken,
      expiresAt: '2099-01-01T00:00:00.000Z', // fresh: no refresh round-trip
    });
    return new JiraClient(env, dao, (await dao.getToken(ACCT))!, 'cloud-a');
  }

  it('flags needs_reauth and throws before touching Jira when the grant is short', async () => {
    const client = await clientWith(LEGACY);
    await expect(client.get('/rest/agile/1.0/board/1/configuration')).rejects.toThrow(
      ScopeDriftError,
    );
    expect(fetchMock).not.toHaveBeenCalled(); // no point spending a subrequest
    expect(await dao.getUserNeedsReauth(ACCT)).toBe(true);
  });

  it('is a ReauthRequiredError, so every existing dead-grant path handles it', async () => {
    const client = await clientWith(LEGACY);
    const err = await client.bearer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as ScopeDriftError).missing).toContain('read:issue-details:jira');
    expect((err as ScopeDriftError).accountId).toBe(ACCT);
  });

  it('writes the flag once per token however many calls drift — no per-call spam', async () => {
    const client = await clientWith(LEGACY);
    const spy = vi.spyOn(dao, 'setNeedsReauth');
    for (let i = 0; i < 5; i++) await client.bearer().catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets a current grant through and never flags it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = await clientWith(CURRENT);
    await expect(client.get('/rest/api/3/field')).resolves.toEqual({ ok: true });
    expect(await dao.getUserNeedsReauth(ACCT)).toBe(false);
  });

  it('lets an opaque (non-JWT) token through — fail-open end to end', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = await clientWith('opaque-token');
    await expect(client.get('/rest/api/3/field')).resolves.toEqual({ ok: true });
    expect(await dao.getUserNeedsReauth(ACCT)).toBe(false);
  });
});
