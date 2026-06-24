// Personal endpoints. Pending prompts, rating submission, and personal history
// are ALL hard-scoped to the authenticated account. None of these return another
// account's data — that scoping is the personal half of the privacy invariant.

import type {
  ClaimedTrendsResponse,
  MyRatingsResponse,
  PendingRatingsResponse,
  SubmitRatingRequest,
  SubmitRatingResponse,
  TrendPoint,
} from '@shared/contracts';
import {
  isStaleTransition,
  sprintForTimestamp,
  weekStartOf,
} from '@shared/domain';
import { type AuthedCtx, error, json, readJson } from '../http';

export async function getPending(ctx: AuthedCtx): Promise<Response> {
  const rows = await ctx.dao.getPendingForOwner(ctx.accountId);
  // Hide prompts whose transition is more than a day old. New ones are no longer
  // inserted by the poller, but rows predating that change (or that aged out
  // while sitting unrated) still need filtering here.
  const fresh = rows.filter((p) => !isStaleTransition(p.transitionedAt));
  const body: PendingRatingsResponse = {
    items: fresh.map((p) => ({
      pendingId: p.pendingId,
      issueKey: p.issueKey,
      title: p.title,
      url: p.url,
      storyPoints: p.storyPoints,
      toStatus: p.toStatus,
      transitionedAt: p.transitionedAt,
    })),
  };
  return json(body);
}

/** Dismiss ALL of the caller's pending prompts at once (no ratings recorded). */
export async function clearPending(ctx: AuthedCtx): Promise<Response> {
  await ctx.dao.deletePendingForOwner(ctx.accountId);
  return json({ ok: true });
}

export async function submitRating(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<SubmitRatingRequest>(req);
  if (
    !body ||
    typeof body.claimedPoints !== 'number' ||
    !Number.isFinite(body.claimedPoints) ||
    body.claimedPoints < 0
  ) {
    return error(400, 'invalid rating');
  }
  // Optional diary note: must be a string if present; trim and cap at 2000 chars,
  // and treat empty as absent so blank textareas don't store "".
  if (body.notes !== undefined && typeof body.notes !== 'string') {
    return error(400, 'invalid notes');
  }
  const trimmedNotes = body.notes?.trim() ?? '';
  if (trimmedNotes.length > 2000) {
    return error(400, 'notes too long');
  }
  const notes = trimmedNotes.length > 0 ? trimmedNotes : null;
  const pending = await ctx.dao.getPending(body.pendingId);
  if (!pending) return error(404, 'pending not found');
  // A user can only rate THEIR OWN pending prompt.
  if (pending.accountId !== ctx.accountId) return error(403, 'not your pending');
  // A claim can't exceed 2× the ticket's points — the old 200% ceiling, in
  // absolute terms now that the percentage lives only in the UI.
  if (body.claimedPoints > 2 * (pending.storyPoints ?? 0)) {
    return error(400, 'claim exceeds ticket points');
  }

  // Bucket the rating into the sprint that contained the transition, and snapshot
  // story points + team id at rating time (historical re-aggregation stays honest).
  const sprints = await ctx.dao.sprintWindows(ctx.cloudId);
  const sprintId = sprintForTimestamp(pending.transitionedAt, sprints);
  const teamIdAtRating = await ctx.dao.teamAt(ctx.accountId, pending.transitionedAt);

  const id = await ctx.dao.insertRating({
    cloudId: ctx.cloudId,
    issueKey: pending.issueKey,
    raterAccountId: ctx.accountId,
    claimedPoints: body.claimedPoints,
    storyPointsAtRating: pending.storyPoints,
    teamIdAtRating,
    sprintId,
    notes,
    // Snapshot title/url from the pending prompt, which is about to be deleted —
    // the personal history views render these without a live Jira lookup.
    title: pending.title,
    url: pending.url,
  });
  await ctx.dao.deletePending(body.pendingId);

  const res: SubmitRatingResponse = {
    id,
    storyPointsAtRating: pending.storyPoints,
    sprintId,
    teamIdAtRating,
  };
  return json(res);
}

/**
 * Personal-vs-team claimed-points trends. The personal lines are self-scoped
 * (dao.personalClaimedByDay filters on rater_account_id); the team lines are a
 * team-grouped sum ÷ team size, exposed only weekly. "team" is the caller's
 * current team — empty lines when they're on none.
 */
export async function claimedTrends(ctx: AuthedCtx): Promise<Response> {
  const DAY = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const from30 = new Date(nowMs - 30 * DAY).toISOString();
  const from6mo = new Date(nowMs - 183 * DAY).toISOString();

  const teamId = await ctx.dao.teamAt(ctx.accountId);
  const teamName = teamId
    ? ((await ctx.dao.listTeams(ctx.cloudId)).find((t) => t.teamId === teamId)?.name ?? null)
    : null;
  const size = teamId ? await ctx.dao.teamSize(teamId) : 0;
  const haveTeam = teamId !== null && size > 0;

  // 30 days: personal daily (that day's sum). Team weekly is the team's average
  // per person per day (week's sum ÷ size ÷ 7) so it shares the daily personal
  // line's magnitude on one axis — just at weekly resolution.
  const personalDaily: TrendPoint[] = (
    await ctx.dao.personalClaimedByDay(ctx.accountId, ctx.cloudId, from30, nowIso)
  ).map((r) => ({ date: r.day, value: r.claimed }));

  const teamWeekly30: TrendPoint[] = haveTeam
    ? foldWeeks(await ctx.dao.teamClaimedByDay(ctx.cloudId, teamId, from30, nowIso)).map((w) => ({
        date: w.weekStart,
        value: w.claimed / size / 7,
      }))
    : [];

  // 6 months: both lines are per-day averages within the week (÷ 7; team also ÷ size).
  const personalWeekly: TrendPoint[] = foldWeeks(
    await ctx.dao.personalClaimedByDay(ctx.accountId, ctx.cloudId, from6mo, nowIso),
  ).map((w) => ({ date: w.weekStart, value: w.claimed / 7 }));

  const teamWeekly6: TrendPoint[] = haveTeam
    ? foldWeeks(await ctx.dao.teamClaimedByDay(ctx.cloudId, teamId, from6mo, nowIso)).map((w) => ({
        date: w.weekStart,
        value: w.claimed / size / 7,
      }))
    : [];

  const body: ClaimedTrendsResponse = {
    teamId,
    teamName,
    last30Days: { personalDaily, teamWeekly: teamWeekly30 },
    last6Months: { personalWeekly, teamWeekly: teamWeekly6 },
  };
  return json(body);
}

/** Fold day-bucketed claimed sums into Monday-anchored weeks (sorted ascending). */
function foldWeeks(
  rows: Array<{ day: string; claimed: number }>,
): Array<{ weekStart: string; claimed: number }> {
  const byWeek = new Map<string, number>();
  for (const r of rows) {
    const wk = weekStartOf(r.day);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + r.claimed);
  }
  return [...byWeek.entries()]
    .map(([weekStart, claimed]) => ({ weekStart, claimed }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export async function myRatings(ctx: AuthedCtx): Promise<Response> {
  // getRatingsForOwner filters WHERE rater_account_id = ctx.accountId in SQL.
  const rows = await ctx.dao.getRatingsForOwner(ctx.accountId);
  const body: MyRatingsResponse = {
    ratings: rows.map((r) => ({
      id: r.id,
      issueKey: r.issueKey,
      claimedPoints: r.claimedPoints,
      storyPointsAtRating: r.storyPointsAtRating,
      sprintId: r.sprintId,
      ratedAt: r.ratedAt,
      title: r.title,
      url: r.url,
      notes: r.notes,
    })),
  };
  return json(body);
}
