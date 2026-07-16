// configureZulipOrg: field validation, live credential verification (stubbed
// fetch), encrypt-at-rest persistence, webhook-token hashing, upsert semantics,
// and the cross-org duplicate-token guard. Real SQL (SqliteD1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { makeZulipAdapter } from '../src/notifications/adapters/zulip/adapter';
import { configureZulipOrg } from '../src/notifications/adapters/zulip/org-config';
import { open, sha256Hex } from '../src/notifications/secretbox';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const ADMIN = 'acct-admin';

const FIELDS = {
  site: 'https://org.zulipchat.com',
  botEmail: 'notify-bot@org.zulipchat.com',
  apiKey: 'apikey',
  webhookToken: 'tok',
};

let db: SqliteD1;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  env = { DB: db, SECRETS_KEY: TEST_SECRETS_KEY } as unknown as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response);
}

async function storedRow(
  cloudId: string,
): Promise<{ secrets_enc: string; webhook_token_hash: string } | null> {
  return db
    .prepare(`SELECT secrets_enc, webhook_token_hash FROM zulip_org_config WHERE cloud_id = ?`)
    .bind(cloudId)
    .first<{ secrets_enc: string; webhook_token_hash: string }>();
}

describe('configureZulipOrg', () => {
  it('live-verifies, then persists encrypted secrets + the hashed webhook token', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureZulipOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r).toEqual({ ok: true });

    // Verification call: cheapest authenticated endpoint, Basic bot creds.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://org.zulipchat.com/api/v1/users/me');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + btoa('notify-bot@org.zulipchat.com:apikey'),
    );

    const row = await storedRow(CLOUD);
    expect(row).not.toBeNull();
    // At rest: no plaintext secret, only the sealed blob + the token hash.
    expect(row!.secrets_enc).not.toContain('apikey');
    expect(JSON.parse(await open(TEST_SECRETS_KEY, row!.secrets_enc))).toEqual({
      site: FIELDS.site,
      botEmail: FIELDS.botEmail,
      apiKey: FIELDS.apiKey,
    });
    expect(row!.webhook_token_hash).toBe(await sha256Hex('tok'));
  });

  it('trims fields and strips a trailing slash from the site', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureZulipOrg(
      env,
      CLOUD,
      { ...FIELDS, site: ' https://org.zulipchat.com/ ', apiKey: ' apikey ' },
      ADMIN,
    );
    expect(r).toEqual({ ok: true });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://org.zulipchat.com/api/v1/users/me', // no double slash
    );
    const row = await storedRow(CLOUD);
    const secrets = JSON.parse(await open(TEST_SECRETS_KEY, row!.secrets_enc)) as {
      site: string;
      apiKey: string;
    };
    expect(secrets.site).toBe('https://org.zulipchat.com');
    expect(secrets.apiKey).toBe('apikey');
  });

  it('rejects a missing field without calling Zulip or persisting', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureZulipOrg(env, CLOUD, { ...FIELDS, apiKey: '  ' }, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('rejects a non-URL site without calling Zulip', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureZulipOrg(env, CLOUD, { ...FIELDS, site: 'org dot chat' }, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a valid URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an http:// site (bot creds would go over the wire in cleartext)', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureZulipOrg(env, CLOUD, { ...FIELDS, site: 'http://org.zulipchat.com' }, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('allows http:// for localhost (self-hosted dev Zulip)', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureZulipOrg(env, CLOUD, { ...FIELDS, site: 'http://localhost:9991' }, ADMIN);
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a Zulip credential rejection and persists nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: false, status: 401, text: async () => 'Invalid API key' }) as unknown as Response,
      ),
    );

    const r = await configureZulipOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('401');
      expect(r.error).toContain('Invalid API key');
    }
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('reports an unreachable site as a friendly error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    const r = await configureZulipOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Could not reach/);
  });

  it('reports a missing SECRETS_KEY as an operator error, without calling Zulip', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const noKey = { DB: db } as unknown as Env;

    const r = await configureZulipOrg(noKey, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/SECRETS_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-configuring the same org upserts (one row, new values)', async () => {
    vi.stubGlobal('fetch', okFetch());
    expect((await configureZulipOrg(env, CLOUD, FIELDS, ADMIN)).ok).toBe(true);
    expect(
      (await configureZulipOrg(env, CLOUD, { ...FIELDS, apiKey: 'rotated', webhookToken: 'tok2' }, ADMIN))
        .ok,
    ).toBe(true);

    const { results } = await db.prepare(`SELECT cloud_id FROM zulip_org_config`).all();
    expect(results).toHaveLength(1);
    const row = await storedRow(CLOUD);
    const secrets = JSON.parse(await open(TEST_SECRETS_KEY, row!.secrets_enc)) as {
      apiKey: string;
    };
    expect(secrets.apiKey).toBe('rotated');
    expect(row!.webhook_token_hash).toBe(await sha256Hex('tok2'));
  });

  it("rejects a webhook token already used by ANOTHER org (it's the inbound router)", async () => {
    vi.stubGlobal('fetch', okFetch());
    await seedZulipOrgConfig(env, 'cloud-other', { webhookToken: 'tok' });

    const r = await configureZulipOrg(env, CLOUD, FIELDS, ADMIN); // same 'tok'
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already in use/);
    expect(await storedRow(CLOUD)).toBeNull();
  });
});

describe('zulip adapter — describe/configureOrg wiring', () => {
  it('advertises the write-only requestedFields on the descriptor', async () => {
    const d = await makeZulipAdapter(env).describe();
    expect(d.requestedFields).toEqual(['site', 'botEmail', 'apiKey', 'webhookToken']);
  });

  it('configureOrg flips isConfigured for that org only', async () => {
    vi.stubGlobal('fetch', okFetch());
    const adapter = makeZulipAdapter(env);
    expect(await adapter.isConfigured!(CLOUD)).toBe(false);
    const r = await adapter.configureOrg!(CLOUD, FIELDS, ADMIN);
    expect(r).toEqual({ ok: true });
    expect(await adapter.isConfigured!(CLOUD)).toBe(true);
    expect(await adapter.isConfigured!('cloud-other')).toBe(false);
  });
});
