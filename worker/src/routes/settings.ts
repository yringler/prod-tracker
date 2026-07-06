// Self-scoped user settings. Like the personal rating endpoints, everything here
// is hard-scoped to the authenticated account — settings are the caller's own.

import type { UpdateMySettingsRequest } from '@shared/contracts';
import { MAX_DAILY_GOAL } from '@shared/domain';
import { type AuthedCtx, error, json, readJson } from '../http';

/** PUT /api/me/settings — set or clear (null) the caller's daily goal. */
export async function updateMySettings(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<UpdateMySettingsRequest>(req);
  if (!body || !('dailyGoal' in body)) return error(400, 'dailyGoal required');
  const goal = body.dailyGoal;
  if (
    goal !== null &&
    (typeof goal !== 'number' || !Number.isFinite(goal) || goal <= 0 || goal > MAX_DAILY_GOAL)
  ) {
    return error(400, 'invalid daily goal');
  }
  await ctx.dao.setDailyGoal(ctx.accountId, goal);
  return json({ ok: true });
}
