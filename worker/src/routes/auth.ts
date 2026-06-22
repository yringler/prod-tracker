import type {
  AuthStartResponse,
  MeResponse,
  SitesResponse,
  SwitchSiteRequest,
} from '@shared/contracts';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import {
  type AuthedCtx,
  authenticate,
  error,
  json,
  parseCookies,
  readJson,
  setCookie,
} from '../http';
import {
  accessibleResources,
  buildAuthorizeUrl,
  exchangeCode,
  fetchMyself,
} from '../jira/oauth';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

/** GET /api/auth/start — returns the consent URL + sets the state cookie. */
export async function authStart(_req: Request, env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  const res = json({ authorizeUrl: buildAuthorizeUrl(env, state) } satisfies AuthStartResponse);
  res.headers.append(
    'Set-Cookie',
    setCookie('oauth_state', state, { maxAge: 600, httpOnly: true }),
  );
  return res;
}

/** GET /api/auth/callback?code&state — exchange, store rotating token, session. */
export async function authCallback(req: Request, env: Env, dao: Dao): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = parseCookies(req)['oauth_state'];
  if (!code || !state || !expectedState || state !== expectedState) {
    return error(400, 'invalid oauth state');
  }

  const tokens = await exchangeCode(env, code);
  const resources = await accessibleResources(tokens.accessToken);
  if (resources.length === 0) return error(403, 'no accessible Jira sites');

  // The Atlassian account id is global, so any reachable site resolves the same
  // identity. Use the first to fetch it; the default selected site is also the first.
  const defaultSite = resources[0]!;
  const me = await fetchMyself(tokens.accessToken, defaultSite.id);
  const accountId = me.account_id;
  const displayName = me.display_name ?? me.name ?? accountId;

  // One grant per account (the rotating refresh token is shared across sites).
  await dao.upsertToken({
    accountId,
    refreshToken: tokens.refreshToken, // rotating — persisted here
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  });
  await dao.upsertUser(accountId, displayName, defaultSite.id);

  // Record every reachable site (the picker's options) + its deep-link base.
  for (const r of resources) {
    await dao.upsertSite(accountId, { cloudId: r.id, name: r.name, siteUrl: r.url });
    await dao.setSiteUrl(r.id, r.url);
  }
  const cloudId = defaultSite.id;

  // Bootstrap the first admin if this account is the configured recovery hatch.
  if (
    env.BOOTSTRAP_ADMIN_ACCOUNT_ID &&
    accountId === env.BOOTSTRAP_ADMIN_ACCOUNT_ID &&
    (await dao.countAdmins()) === 0
  ) {
    await dao.appointAdmin(accountId, null);
  }

  const sid = await dao.createSession(accountId, cloudId, SESSION_TTL);
  const res = new Response(null, { status: 302, headers: { Location: '/' } });
  res.headers.append('Set-Cookie', setCookie('sid', sid, { maxAge: SESSION_TTL, httpOnly: true }));
  res.headers.append('Set-Cookie', setCookie('oauth_state', '', { maxAge: 0 }));
  return res;
}

export async function authLogout(req: Request, env: Env, dao: Dao): Promise<Response> {
  const sid = parseCookies(req)['sid'];
  if (sid) await dao.deleteSession(sid);
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', setCookie('sid', '', { maxAge: 0 }));
  return res;
}

export async function me(req: Request, env: Env, dao: Dao): Promise<Response> {
  const ctx = await authenticate(req, env, dao);
  if (!ctx) return error(401, 'not authenticated');
  const role = await dao.roleFor(ctx.accountId, env.BOOTSTRAP_ADMIN_ACCOUNT_ID);
  const needsReauth = await dao.getUserNeedsReauth(ctx.accountId);
  const sites = await dao.listSites(ctx.accountId);
  const body: MeResponse = {
    accountId: ctx.accountId,
    displayName: await dao.getDisplayName(ctx.accountId),
    cloudId: ctx.cloudId,
    sites: sites.map((s) => ({ cloudId: s.cloudId, name: s.name, url: s.siteUrl })),
    role,
    needsReauth,
  };
  return json(body);
}

/** GET /api/sites — the sites this account's token can reach. */
export async function listSites(ctx: AuthedCtx): Promise<Response> {
  const sites = await ctx.dao.listSites(ctx.accountId);
  const body: SitesResponse = {
    sites: sites.map((s) => ({ cloudId: s.cloudId, name: s.name, url: s.siteUrl })),
    currentCloudId: ctx.cloudId,
  };
  return json(body);
}

/**
 * POST /api/session/site — switch the selected site for this session. Guarded:
 * the cloudId must be one the account's token can actually reach.
 */
export async function switchSite(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<SwitchSiteRequest>(req);
  if (!body?.cloudId) return error(400, 'cloudId required');
  if (!(await ctx.dao.accountHasSite(ctx.accountId, body.cloudId))) {
    return error(403, 'not a reachable site for this account');
  }
  await ctx.dao.updateSessionCloud(ctx.sid, body.cloudId);
  return json({ ok: true, cloudId: body.cloudId });
}
