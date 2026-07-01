// Dev-only helpers. These exist to make local development usable: the cron
// poller (which creates pending prompts from real Jira activity) never runs in
// `wrangler dev`, so the tracker would otherwise sit empty. None of this is
// reachable in production — see isDevEnv and the route guard in index.ts.

import type { Env } from '../env';
import { type AuthedCtx, json } from '../http';

/**
 * True only when running locally. `.dev.vars` sets APP_ORIGIN to
 * http://localhost:8787; production (wrangler.toml) sets the real https origin.
 * Used to gate dev-only routes so they 404 anywhere but local.
 */
export function isDevEnv(env: Env): boolean {
  return env.APP_ORIGIN.startsWith('http://localhost');
}

const FAKE_TITLES = [
  'Refactor auth middleware',
  'Fix flaky sprint test',
  'Tidy up changelog parsing',
  'Add retry to Jira client',
  'Polish the tracker empty state',
  'Investigate slow aggregate query',
];

const FAKE_POINTS = [1, 2, 3, 5, 8] as const;

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

/**
 * Insert one made-up pending prompt for the caller, mimicking exactly what the
 * cron poller would emit for a fresh status transition. The rating itself is NOT
 * faked — the prompt then flows through the real submitRating path when the
 * developer clicks an effort button.
 */
export async function seedPending(ctx: AuthedCtx): Promise<Response> {
  const issueKey = `DEV-${100 + Math.floor(Math.random() * 900)}`;
  const title = pick(FAKE_TITLES);
  const storyPoints = pick(FAKE_POINTS);
  // Seed a short flurry of transitions for ONE issue so the grouped card (one item
  // listing every move, rated once) is exercisable. Oldest-first; all "now"-ish so
  // they survive the >1-day staleness filter in getPending.
  const flurry = ['In Progress', 'In Review', 'Done'];
  const baseMs = Date.now() - flurry.length * 60_000;
  for (let i = 0; i < flurry.length; i++) {
    const changelogId = crypto.randomUUID();
    await ctx.dao.insertPending({
      pendingId: `dev:${issueKey}:${changelogId}`,
      cloudId: ctx.cloudId,
      accountId: ctx.accountId,
      issueKey,
      title,
      url: `https://example.atlassian.net/browse/${issueKey}`,
      storyPoints,
      toStatus: flurry[i]!,
      changelogId,
      transitionedAt: new Date(baseMs + i * 60_000).toISOString(),
    });
  }
  return json({ ok: true });
}
