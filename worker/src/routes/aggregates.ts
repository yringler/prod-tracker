// AGGREGATE endpoints. Team-grouped, sums only. There is deliberately NO route
// that accepts a raterAccountId or returns a per-developer figure. The response
// shapes (TeamAggregateResponse / ClaimedVsDone) carry no account column, and
// dao.teamSeries() takes no rater filter. This is the aggregate half of the
// privacy invariant.

import { UTCDate } from '@date-fns/utc';
import type {
  AllTeamsAggregateResponse,
  TeamAggregateResponse,
} from '@shared/contracts';
import { isAfter, sub } from 'date-fns';
import { type AuthedCtx, error, json } from '../http';

/**
 * Lower bound for aggregate series: the later of (now − 12 months) and the
 * first claim in the cloud. Caps history at a year and trims empty leading
 * sprints from before the tracker was in use.
 */
async function aggregateSince(ctx: AuthedCtx): Promise<string> {
  const twelveMonthsAgo = sub(new UTCDate(), { months: 12 }).toISOString();
  const earliest = await ctx.dao.earliestClaimAt(ctx.cloudId);
  return earliest && isAfter(new UTCDate(earliest), new UTCDate(twelveMonthsAgo))
    ? earliest
    : twelveMonthsAgo;
}

export async function allAggregates(ctx: AuthedCtx): Promise<Response> {
  // Org-wide aggregate viewing: every team in a cloud the user's token can reach.
  // (Here: the user's own cloud.)
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  const since = await aggregateSince(ctx);
  const out: TeamAggregateResponse[] = [];
  for (const t of teams) {
    out.push({
      teamId: t.teamId,
      teamName: t.name,
      cloudId: t.cloudId,
      series: await ctx.dao.teamSeries(ctx.cloudId, t.teamId, since),
    });
  }
  const body: AllTeamsAggregateResponse = { teams: out };
  return json(body);
}

export async function teamAggregate(ctx: AuthedCtx, teamId: string): Promise<Response> {
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  const team = teams.find((t) => t.teamId === teamId);
  if (!team) return error(404, 'team not found');
  const since = await aggregateSince(ctx);
  const body: TeamAggregateResponse = {
    teamId: team.teamId,
    teamName: team.name,
    cloudId: team.cloudId,
    series: await ctx.dao.teamSeries(ctx.cloudId, teamId, since),
  };
  return json(body);
}
