// AGGREGATE endpoints. Team-grouped, sums only. There is deliberately NO route
// that accepts a raterAccountId or returns a per-developer figure. The response
// shapes (TeamAggregateResponse / ClaimedVsDone) carry no account column, and
// dao.teamSeries() takes no rater filter. This is the aggregate half of the
// privacy invariant.
//
// There is also a minimum-team-size floor: a team with fewer than MIN_TEAM_SIZE
// current members returns NO aggregate data at all (empty series, belowMinSize
// true). On a tiny team even a sum or average is a thin disguise over individual
// data — `team_sum − your_number` reveals the other person.

import { UTCDate } from '@date-fns/utc';
import type {
  AllTeamsAggregateResponse,
  TeamAggregateResponse,
} from '@shared/contracts';
import { MIN_TEAM_SIZE } from '@shared/domain';
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

/**
 * Build one team's aggregate response. A team below the minimum-size floor gets
 * an empty series and `belowMinSize: true` — we skip the teamSeries() query
 * entirely so no aggregate figure ever leaves the server for a tiny team.
 */
async function buildTeamAggregate(
  ctx: AuthedCtx,
  team: { teamId: string; name: string; cloudId: string },
  since: string,
): Promise<TeamAggregateResponse> {
  const size = await ctx.dao.teamSize(team.teamId);
  if (size < MIN_TEAM_SIZE) {
    return { teamId: team.teamId, teamName: team.name, cloudId: team.cloudId, series: [], belowMinSize: true };
  }
  return {
    teamId: team.teamId,
    teamName: team.name,
    cloudId: team.cloudId,
    series: await ctx.dao.teamSeries(ctx.cloudId, team.teamId, since),
    belowMinSize: false,
  };
}

export async function allAggregates(ctx: AuthedCtx): Promise<Response> {
  // Org-wide aggregate viewing: every team in a cloud the user's token can reach.
  // (Here: the user's own cloud.)
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  const since = await aggregateSince(ctx);
  const out: TeamAggregateResponse[] = [];
  for (const t of teams) {
    out.push(await buildTeamAggregate(ctx, t, since));
  }
  const body: AllTeamsAggregateResponse = { teams: out };
  return json(body);
}

export async function teamAggregate(ctx: AuthedCtx, teamId: string): Promise<Response> {
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  const team = teams.find((t) => t.teamId === teamId);
  if (!team) return error(404, 'team not found');
  const since = await aggregateSince(ctx);
  const body = await buildTeamAggregate(ctx, team, since);
  return json(body);
}
