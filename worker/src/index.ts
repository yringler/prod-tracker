import { Dao } from './db/dao';
import type { Env } from './env';
import { authenticate, error, requireAdmin } from './http';
import { runPoll } from './cron/poller';
import { reportPersonalData } from './cron/pd-report';
import { escalate } from './cron/escalate';
import { log, errFields } from './log';
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
  listFields,
  listMemberships,
  listOrgMembers,
  listTeams as adminListTeams,
  revokeAdmin,
  setDoneStatuses,
  setFields,
} from './routes/admin';
import { allAggregates, teamAggregate } from './routes/aggregates';
import { claimedTrends, clearPending, getPending, myRatings, submitRating } from './routes/ratings';
import { updateMySettings } from './routes/settings';
import { subscribe, vapidPublicKey } from './routes/push';
import { isDevEnv, seedPending } from './routes/dev';
import { resolve } from './notifications/registry';

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
      log.error('route: unhandled error', { method: req.method, path: url.pathname, ...errFields(e) });
      return error(500, 'internal error');
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const dao = new Dao(env.DB);
    // One id per tick so every poll line correlates in Logs Explorer.
    const tick = log.child({ runId: crypto.randomUUID() });
    const startedAt = Date.now();
    // runPoll was unguarded: any throw aborted the whole tick invisibly.
    try {
      await runPoll(env, dao, tick);
    } catch (e) {
      tick.error('poll: runPoll threw', errFields(e));
    }
    // GDPR personal-data reporting. Must never break polling, so it's isolated.
    try {
      await reportPersonalData(env, dao);
    } catch (e) {
      tick.error('pd-report failed', errFields(e));
    }
    // Escalate un-acted pending prompts to fallback channels. Isolated so it can
    // never abort the poll or the pd-report job.
    try {
      await escalate(env, dao, tick);
    } catch (e) {
      tick.error('escalate failed', errFields(e));
    }
    tick.info('tick: done', { ms: Date.now() - startedAt });
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

  // Public inbound notification webhooks (e.g. Zulip outgoing-webhook link flow).
  // Above the auth gate — the request carries no session, only the adapter's own
  // shared secret, which the adapter verifies. index.ts is the single sanctioned
  // webhook-wiring point (not covered by the adapter wall); it reaches the adapter
  // ONLY via the registry and hands it the neutral registerChannel callback so a
  // successful link writes user_channels without the adapter touching dao.
  const whMatch = p.match(/^\/api\/notifications\/([^/]+)\/webhook$/);
  if (whMatch && m === 'POST') {
    const adapter = resolve(env, decodeURIComponent(whMatch[1]!));
    if (adapter?.handleInbound) {
      return adapter.handleInbound(req, {
        registerChannel: (u, c, l) => dao.registerChannel(u, c, l),
      });
    }
    return error(404, 'not found');
  }

  // --- Authenticated routes ---
  const ctx = await authenticate(req, env, dao);
  if (!ctx) return error(401, 'not authenticated');

  // Sites / current selection
  if (p === '/api/sites' && m === 'GET') return listSites(ctx);
  if (p === '/api/session/site' && m === 'POST') return switchSite(req, ctx);

  // Personal (hard-scoped to ctx.accountId)
  if (p === '/api/pending' && m === 'GET') return getPending(ctx);
  if (p === '/api/pending' && m === 'DELETE') return clearPending(ctx);
  // Dev-only: inject a made-up pending prompt (the cron poller doesn't run
  // locally). 404s in production via the isDevEnv guard.
  if (p === '/api/__dev/pending' && m === 'POST') {
    if (!isDevEnv(env)) return error(404, 'not found');
    return seedPending(ctx);
  }
  if (p === '/api/ratings' && m === 'POST') return submitRating(req, ctx);
  if (p === '/api/me/ratings' && m === 'GET') return myRatings(ctx);
  if (p === '/api/me/claimed-trends' && m === 'GET') return claimedTrends(ctx);
  if (p === '/api/me/settings' && m === 'PUT') return updateMySettings(req, ctx);
  if (p === '/api/push/subscribe' && m === 'POST') return subscribe(req, ctx);

  // Aggregates (team-grouped, sums only)
  if (p === '/api/aggregates' && m === 'GET') return allAggregates(ctx);
  const aggMatch = p.match(/^\/api\/aggregates\/([^/]+)$/);
  if (aggMatch && m === 'GET') return teamAggregate(ctx, decodeURIComponent(aggMatch[1]!));

  if (p === '/api/teams' && m === 'GET') return adminListTeams(ctx);

  // --- Admin routes ---
  if (p.startsWith('/api/admin/')) {
    if (!(await requireAdmin(ctx))) return error(403, 'admin required');

    if (p === '/api/admin/users' && m === 'GET') return listOrgMembers(ctx);
    if (p === '/api/admin/teams' && m === 'POST') return createTeam(req, ctx);
    if (p === '/api/admin/memberships' && m === 'POST') return assignMembership(req, ctx);
    if (p === '/api/admin/admins' && m === 'POST') return appointAdmin(req, ctx);
    if (p === '/api/admin/config' && m === 'GET') return adminGetConfig(ctx);
    if (p === '/api/admin/config/done-statuses' && m === 'PUT') return setDoneStatuses(req, ctx);
    if (p === '/api/admin/fields' && m === 'GET') return listFields(ctx);
    if (p === '/api/admin/config/fields' && m === 'PUT') return setFields(req, ctx);

    const memMatch = p.match(/^\/api\/admin\/teams\/([^/]+)\/memberships$/);
    if (memMatch && m === 'GET') return listMemberships(ctx, decodeURIComponent(memMatch[1]!));

    const revMatch = p.match(/^\/api\/admin\/admins\/([^/]+)$/);
    if (revMatch && m === 'DELETE') return revokeAdmin(ctx, decodeURIComponent(revMatch[1]!));
  }

  return error(404, 'not found');
}
