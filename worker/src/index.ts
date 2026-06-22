import { Dao } from './db/dao';
import type { Env } from './env';
import { authenticate, error, requireAdmin } from './http';
import { runPoll } from './cron/poller';
import { reportPersonalData } from './cron/pd-report';
import {
  authCallback,
  authLogout,
  authStart,
  listSites,
  me,
  switchSite,
} from './routes/auth';
import {
  appointAdmin,
  assignMembership,
  createTeam,
  getConfig as adminGetConfig,
  listMemberships,
  listTeams as adminListTeams,
  revokeAdmin,
  setDoneStatuses,
} from './routes/admin';
import { allAggregates, teamAggregate } from './routes/aggregates';
import { getPending, myRatings, submitRating } from './routes/ratings';
import { subscribe, vapidPublicKey } from './routes/push';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      // Everything else is the Angular SPA (static assets + SPA fallback).
      return env.ASSETS.fetch(req);
    }
    try {
      return await route(req, env, url);
    } catch (e) {
      console.error('unhandled route error:', e);
      return error(500, 'internal error');
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const dao = new Dao(env.DB);
    await runPoll(env, dao);
    // GDPR personal-data reporting. Must never break polling, so it's isolated.
    try {
      await reportPersonalData(env, dao);
    } catch (e) {
      console.error('pd-report failed:', e);
    }
  },
};

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const dao = new Dao(env.DB);
  const p = url.pathname;
  const m = req.method;

  // --- Public auth routes ---
  if (p === '/api/auth/start' && m === 'GET') return authStart(req, env);
  if (p === '/api/auth/callback' && m === 'GET') return authCallback(req, env, dao);
  if (p === '/api/auth/logout' && m === 'POST') return authLogout(req, env, dao);
  if (p === '/api/me' && m === 'GET') return me(req, env, dao);
  if (p === '/api/push/vapid-public-key' && m === 'GET') return vapidPublicKey(env);

  // --- Authenticated routes ---
  const ctx = await authenticate(req, env, dao);
  if (!ctx) return error(401, 'not authenticated');

  // Sites / current selection
  if (p === '/api/sites' && m === 'GET') return listSites(ctx);
  if (p === '/api/session/site' && m === 'POST') return switchSite(req, ctx);

  // Personal (hard-scoped to ctx.accountId)
  if (p === '/api/pending' && m === 'GET') return getPending(ctx);
  if (p === '/api/ratings' && m === 'POST') return submitRating(req, ctx);
  if (p === '/api/me/ratings' && m === 'GET') return myRatings(ctx);
  if (p === '/api/push/subscribe' && m === 'POST') return subscribe(req, ctx);

  // Aggregates (team-grouped, sums only)
  if (p === '/api/aggregates' && m === 'GET') return allAggregates(ctx);
  const aggMatch = p.match(/^\/api\/aggregates\/([^/]+)$/);
  if (aggMatch && m === 'GET') return teamAggregate(ctx, decodeURIComponent(aggMatch[1]!));

  if (p === '/api/teams' && m === 'GET') return adminListTeams(ctx);

  // --- Admin routes ---
  if (p.startsWith('/api/admin/')) {
    if (!(await requireAdmin(ctx))) return error(403, 'admin required');

    if (p === '/api/admin/teams' && m === 'POST') return createTeam(req, ctx);
    if (p === '/api/admin/memberships' && m === 'POST') return assignMembership(req, ctx);
    if (p === '/api/admin/admins' && m === 'POST') return appointAdmin(req, ctx);
    if (p === '/api/admin/config' && m === 'GET') return adminGetConfig(ctx);
    if (p === '/api/admin/config/done-statuses' && m === 'PUT') return setDoneStatuses(req, ctx);

    const memMatch = p.match(/^\/api\/admin\/teams\/([^/]+)\/memberships$/);
    if (memMatch && m === 'GET') return listMemberships(ctx, decodeURIComponent(memMatch[1]!));

    const revMatch = p.match(/^\/api\/admin\/admins\/([^/]+)$/);
    if (revMatch && m === 'DELETE') return revokeAdmin(ctx, decodeURIComponent(revMatch[1]!));
  }

  return error(404, 'not found');
}
