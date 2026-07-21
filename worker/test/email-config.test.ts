// configureEmailOrg: field validation, live transport verification (stubbed fetch),
// encrypt-at-rest persistence, the deliberately-cleartext from_address column, and
// upsert semantics. A near-clone of zulip-config.test.ts — the point of the
// admin-provisioning model is that the two adapters differ only in vendor detail.
// Real SQL (SqliteD1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { makeEmailAdapter } from '../src/notifications/adapters/email/adapter';
import { configureEmailOrg, loadEmailSecrets } from '../src/notifications/adapters/email/org-config';
import { open } from '../src/notifications/secretbox';
import { SqliteD1 } from './support/sqlite-d1';
import { TEST_SECRETS_KEY } from './support/org-channels';

const CLOUD = 'cloud-1';
const ADMIN = 'acct-admin';

const FIELDS = { fromAddress: 'notify@org.com', apiKey: 'ek-live' };

let db: SqliteD1;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  // No EMAIL_* env: these tests are about the admin-provisioned path.
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
): Promise<{ secrets_enc: string; from_address: string; configured_by: string | null } | null> {
  return db
    .prepare(
      `SELECT secrets_enc, from_address, configured_by FROM email_org_config WHERE cloud_id = ?`,
    )
    .bind(cloudId)
    .first<{ secrets_enc: string; from_address: string; configured_by: string | null }>();
}

describe('configureEmailOrg', () => {
  it('live-verifies the key, then persists encrypted secrets + a cleartext From:', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureEmailOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r).toEqual({ ok: true });

    // Verification call: a cheap authenticated GET on the same transport, which
    // sends no mail.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/domains');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ek-live');

    const row = await storedRow(CLOUD);
    expect(row).not.toBeNull();
    // At rest: the api key only inside the sealed blob; the From: address in the
    // clear ON PURPOSE (the admin UI echoes it without opening the box).
    expect(row!.secrets_enc).not.toContain('ek-live');
    expect(row!.from_address).toBe('notify@org.com');
    expect(row!.configured_by).toBe(ADMIN);
    expect(JSON.parse(await open(TEST_SECRETS_KEY, row!.secrets_enc))).toEqual({
      apiKey: 'ek-live',
      fromAddress: 'notify@org.com',
    });
  });

  it('trims fields', async () => {
    vi.stubGlobal('fetch', okFetch());
    const r = await configureEmailOrg(
      env,
      CLOUD,
      { fromAddress: '  notify@org.com ', apiKey: ' ek-live ' },
      ADMIN,
    );
    expect(r).toEqual({ ok: true });
    expect((await storedRow(CLOUD))!.from_address).toBe('notify@org.com');
  });

  it('rejects a missing field without calling the transport or persisting', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureEmailOrg(env, CLOUD, { ...FIELDS, apiKey: '  ' }, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('rejects a malformed fromAddress without calling the transport', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const r = await configureEmailOrg(env, CLOUD, { ...FIELDS, fromAddress: 'garbage' }, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a valid email address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('reports a missing SECRETS_KEY as an operator error, without calling the transport', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const noKey = { DB: db } as unknown as Env;

    const r = await configureEmailOrg(noKey, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/SECRETS_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a transport rejection verbatim and persists nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: false, status: 401, text: async () => 'API key is invalid' }) as unknown as Response,
      ),
    );

    const r = await configureEmailOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('401');
      expect(r.error).toContain('API key is invalid');
    }
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('a send-only (restricted) API key passes verification', async () => {
    // A least-privilege "Sending access" key can POST /emails but not READ
    // /domains — the 401 it answers with PROVES the key is live.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            text: async () =>
              JSON.stringify({
                statusCode: 401,
                name: 'restricted_api_key',
                message: 'This API key is restricted to only send emails',
              }),
          }) as unknown as Response,
      ),
    );

    expect(await configureEmailOrg(env, CLOUD, FIELDS, ADMIN)).toEqual({ ok: true });
    expect(await storedRow(CLOUD)).not.toBeNull();
  });

  it('a genuine 401 still fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            text: async () =>
              JSON.stringify({ name: 'validation_error', message: 'API key is invalid' }),
          }) as unknown as Response,
      ),
    );

    const r = await configureEmailOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    expect(await storedRow(CLOUD)).toBeNull();
  });

  it('a configured org NEVER falls back to the legacy env pair', async () => {
    vi.stubGlobal('fetch', okFetch());
    expect((await configureEmailOrg(env, CLOUD, FIELDS, ADMIN)).ok).toBe(true);

    // SECRETS_KEY gone (rotated away), env pair present: the org HAS a row, so the
    // deployment-wide legacy credentials must not silently stand in for it.
    const noKey = {
      DB: db,
      EMAIL_API_KEY: 'legacy-key',
      EMAIL_FROM: 'legacy@org.com',
    } as unknown as Env;
    expect(await loadEmailSecrets(noKey, CLOUD)).toBeNull();
  });

  it('reports an unreachable transport as a friendly error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    const r = await configureEmailOrg(env, CLOUD, FIELDS, ADMIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Could not reach/);
  });

  it('re-configuring the same org upserts (one row, new values)', async () => {
    vi.stubGlobal('fetch', okFetch());
    expect((await configureEmailOrg(env, CLOUD, FIELDS, ADMIN)).ok).toBe(true);
    expect(
      (
        await configureEmailOrg(
          env,
          CLOUD,
          { fromAddress: 'other@org.com', apiKey: 'rotated' },
          ADMIN,
        )
      ).ok,
    ).toBe(true);

    const { results } = await db.prepare(`SELECT cloud_id FROM email_org_config`).all();
    expect(results).toHaveLength(1);
    expect(await loadEmailSecrets(env, CLOUD)).toEqual({
      apiKey: 'rotated',
      fromAddress: 'other@org.com',
    });
  });
});

describe('email adapter — describe/configureOrg wiring', () => {
  it('advertises requestedFields and the per-user identity prompt', async () => {
    const d = await makeEmailAdapter(env).describe();
    expect(d.requestedFields).toEqual(['fromAddress', 'apiKey']);
    expect(d.requiresUserIdentity).toBe(true);
    expect(d.identityPrompt).toBe('an email address');
  });

  it('configureOrg flips isConfigured for that org only', async () => {
    vi.stubGlobal('fetch', okFetch());
    const adapter = makeEmailAdapter(env);
    expect(await adapter.isConfigured!(CLOUD)).toBe(false);
    expect(await adapter.configureOrg!(CLOUD, FIELDS, ADMIN)).toEqual({ ok: true });
    expect(await adapter.isConfigured!(CLOUD)).toBe(true);
    expect(await adapter.isConfigured!('cloud-other')).toBe(false);
  });

  it('unconfigureOrg removes just that org, and orgConfigSummary echoes only From:', async () => {
    vi.stubGlobal('fetch', okFetch());
    const adapter = makeEmailAdapter(env);
    await adapter.configureOrg!(CLOUD, FIELDS, ADMIN);
    await adapter.configureOrg!('cloud-2', { ...FIELDS, apiKey: 'k2' }, ADMIN);

    const summary = await adapter.orgConfigSummary!(CLOUD);
    expect(summary!.summary).toEqual({ fromAddress: 'notify@org.com' });
    expect(summary!.configuredBy).toBe(ADMIN);
    expect(JSON.stringify(summary)).not.toContain('ek-live');

    await adapter.unconfigureOrg!(CLOUD);
    expect(await adapter.isConfigured!(CLOUD)).toBe(false);
    expect(await adapter.isConfigured!('cloud-2')).toBe(true);
  });
});
