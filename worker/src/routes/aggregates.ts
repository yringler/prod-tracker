// AGGREGATE endpoints. Team-grouped, sums only. There is deliberately NO route
// that accepts a raterAccountId or returns a per-developer figure. The response
// shapes (TeamAggregateResponse / ClaimedVsDone) carry no account column, and
// dao.teamSeries() takes no rater filter. This is the aggregate half of the
// privacy invariant.

import type {
  AllTeamsAggregateResponse,
  TeamAggregateResponse,
} from '@shared/contracts';
import { type AuthedCtx, error, json } from '../http';

export async function allAggregates(ctx: AuthedCtx): Promise<Response> {
  // Org-wide aggregate viewing: every team in a cloud the user's token can reach.
  // (Here: the user's own cloud.)
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  const out: TeamAggregateResponse[] = [];
  for (const t of teams) {
    out.push({
      teamId: t.teamId,
      teamName: t.name,
      cloudId: t.cloudId,
      series: await ctx.dao.teamSeries(ctx.cloudId, t.teamId),
    });
  }
  const body: AllTeamsAggregateResponse = { teams: out };
  return json(body);
}

export async function teamAggregate(ctx: AuthedCtx, teamId: string): Promise<Response> {
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  const team = teams.find((t) => t.teamId === teamId);
  if (!team) return error(404, 'team not found');
  const body: TeamAggregateResponse = {
    teamId: team.teamId,
    teamName: team.name,
    cloudId: team.cloudId,
    series: await ctx.dao.teamSeries(ctx.cloudId, teamId),
  };
  return json(body);
}
