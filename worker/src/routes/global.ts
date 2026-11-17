// Operator (global admin) routes. Gated in index.ts by isGlobalAdmin() — the
// GLOBAL_ADMIN_ACCOUNT_IDS secret — which is independent of per-org admin.
// Non-operators get a 404, not a 403, so the endpoint isn't advertised.

import { subDays, subHours } from 'date-fns';
import { UTCDate } from '@date-fns/utc';
import type {
  GlobalOverviewResponse,
  UsageBySource,
  UsageHourPoint,
} from '@shared/contracts';
import { type AuthedCtx, json } from '../http';
import { earliestUsageBucket, hourBucket, usageSince, type UsageRow } from '../usage/store';

function bySource(rows: UsageRow[]): UsageBySource[] {
  const m = new Map<string, UsageBySource>();
  for (const r of rows) {
    const acc = m.get(r.source) ?? {
      source: r.source,
      invocations: 0,
      queries: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
    acc.invocations += r.invocations;
    acc.queries += r.queries;
    acc.rowsRead += r.rowsRead;
    acc.rowsWritten += r.rowsWritten;
    m.set(r.source, acc);
  }
  return [...m.values()].sort((a, b) => b.rowsWritten - a.rowsWritten || b.rowsRead - a.rowsRead);
}

function hourly(rows: UsageRow[]): UsageHourPoint[] {
  const m = new Map<string, UsageHourPoint>();
  for (const r of rows) {
    const acc = m.get(r.bucket) ?? { bucket: r.bucket, rowsRead: 0, rowsWritten: 0, invocations: 0 };
    acc.rowsRead += r.rowsRead;
    acc.rowsWritten += r.rowsWritten;
    acc.invocations += r.invocations;
    m.set(r.bucket, acc);
  }
  return [...m.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** GET /api/global/overview */
export async function globalOverview(ctx: AuthedCtx): Promise<Response> {
  const now = new UTCDate();
  const nowIso = now.toISOString();
  const since24h = subHours(now, 24);
  const since7d = subDays(now, 7);
  const since7dIso = since7d.toISOString();
  const since24hIso = since24h.toISOString();

  const [usage7d, trackingSince, tables, orgs, users] = await Promise.all([
    usageSince(ctx.env.DB, hourBucket(since7d.getTime())),
    earliestUsageBucket(ctx.env.DB),
    ctx.dao.operatorTableCounts(),
    ctx.dao.operatorOrgs(since7dIso),
    ctx.dao.operatorUsers(nowIso),
  ]);
  const usage24h = usage7d.filter((r) => r.bucket >= hourBucket(since24h.getTime()));

  const body: GlobalOverviewResponse = {
    generatedAt: nowIso,
    totals: {
      users: users.length,
      activeUsers24h: users.filter((u) => (u.lastActiveAt ?? '') >= since24hIso).length,
      activeUsers7d: users.filter((u) => (u.lastActiveAt ?? '') >= since7dIso).length,
      orgs: orgs.length,
      ratingsTotal: orgs.reduce((n, o) => n + o.ratingsTotal, 0),
      ratings7d: orgs.reduce((n, o) => n + o.ratings7d, 0),
      pending: orgs.reduce((n, o) => n + o.pending, 0),
      activeSessions: users.reduce((n, u) => n + u.activeSessions, 0),
    },
    usage: {
      trackingSince,
      last24h: bySource(usage24h),
      last7d: bySource(usage7d),
      hourly: hourly(usage7d),
    },
    tables,
    orgs,
    users,
  };
  return json(body);
}
