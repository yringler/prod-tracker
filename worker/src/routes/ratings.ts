// Personal endpoints. Pending prompts, rating submission, and personal history
// are ALL hard-scoped to the authenticated account. None of these return another
// account's data — that scoping is the personal half of the privacy invariant.

import type {
  MyRatingsResponse,
  PendingRatingsResponse,
  SubmitRatingRequest,
  SubmitRatingResponse,
} from '@shared/contracts';
import { isRatingFraction, isStaleTransition, sprintForTimestamp } from '@shared/domain';
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
  if (!body || !isRatingFraction(body.ratingFraction)) {
    return error(400, 'invalid rating');
  }
  const pending = await ctx.dao.getPending(body.pendingId);
  if (!pending) return error(404, 'pending not found');
  // A user can only rate THEIR OWN pending prompt.
  if (pending.accountId !== ctx.accountId) return error(403, 'not your pending');

  // Bucket the rating into the sprint that contained the transition, and snapshot
  // story points + team id at rating time (historical re-aggregation stays honest).
  const sprints = await ctx.dao.sprintWindows(ctx.cloudId);
  const sprintId = sprintForTimestamp(pending.transitionedAt, sprints);
  const teamIdAtRating = await ctx.dao.teamAt(ctx.accountId, pending.transitionedAt);

  const id = await ctx.dao.insertRating({
    cloudId: ctx.cloudId,
    issueKey: pending.issueKey,
    raterAccountId: ctx.accountId,
    ratingFraction: body.ratingFraction,
    storyPointsAtRating: pending.storyPoints,
    teamIdAtRating,
    sprintId,
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

export async function myRatings(ctx: AuthedCtx): Promise<Response> {
  // getRatingsForOwner filters WHERE rater_account_id = ctx.accountId in SQL.
  const rows = await ctx.dao.getRatingsForOwner(ctx.accountId);
  const body: MyRatingsResponse = {
    ratings: rows.map((r) => ({
      id: r.id,
      issueKey: r.issueKey,
      ratingFraction: r.ratingFraction as MyRatingsResponse['ratings'][number]['ratingFraction'],
      storyPointsAtRating: r.storyPointsAtRating,
      sprintId: r.sprintId,
      ratedAt: r.ratedAt,
    })),
  };
  return json(body);
}
