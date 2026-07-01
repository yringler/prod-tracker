// The personal rating flow, tested against real SQL. Pending prompts bundle all
// of an issue's unrated transitions into ONE rateable item, and a single claim
// clears every one of them.
import { beforeEach, describe, expect, it } from 'vitest';
import type { PendingRatingsResponse } from '@shared/contracts';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { getPending, submitRating } from '../src/routes/ratings';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;
const CLOUD = 'c1';
const ACCT = 'u1';
const env = {} as Env;

// Transitions must be fresh (within the staleness window), so anchor them to the
// real clock rather than a fixed calendar date the >24h filter would drop.
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function ctx(): AuthedCtx {
  return { accountId: ACCT, cloudId: CLOUD, sid: 's1', dao, env };
}

const pending = (
  pendingId: string,
  issueKey: string,
  toStatus: string,
  transitionedAt: string,
  accountId = ACCT,
) => ({
  pendingId,
  cloudId: CLOUD,
  accountId,
  issueKey,
  title: `${issueKey} title`,
  url: `https://example.atlassian.net/browse/${issueKey}`,
  storyPoints: 5,
  toStatus,
  changelogId: pendingId,
  transitionedAt,
});

beforeEach(async () => {
  dao = new Dao(new SqliteD1());
  await dao.upsertUser(ACCT, 'Alice', CLOUD);
});

describe('getPending grouping', () => {
  it('bundles an issue\'s transitions into one item, oldest-first, representative=latest', async () => {
    await dao.insertPending(pending('p1', 'X-1', 'In Progress', minsAgo(30)));
    await dao.insertPending(pending('p2', 'X-1', 'In Review', minsAgo(20)));
    await dao.insertPending(pending('p3', 'X-1', 'Done', minsAgo(10)));
    await dao.insertPending(pending('p4', 'X-2', 'In Progress', minsAgo(15)));

    const body = (await (await getPending(ctx())).json()) as PendingRatingsResponse;

    expect(body.items).toHaveLength(2);
    const x1 = body.items.find((i) => i.issueKey === 'X-1')!;
    expect(x1.transitions.map((t) => t.toStatus)).toEqual(['In Progress', 'In Review', 'Done']);
    // Representative = latest transition.
    expect(x1.pendingId).toBe('p3');
    expect(x1.transitionedAt).toBe(x1.transitions.at(-1)!.transitionedAt);
  });

  it('hides stale transitions from the bundle', async () => {
    await dao.insertPending(pending('old', 'X-1', 'In Progress', minsAgo(60 * 48))); // 2 days old
    await dao.insertPending(pending('new', 'X-1', 'Done', minsAgo(5)));

    const body = (await (await getPending(ctx())).json()) as PendingRatingsResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.transitions.map((t) => t.toStatus)).toEqual(['Done']);
  });
});

describe('submitRating clears the whole issue', () => {
  it('one claim deletes every bundled pending row for that issue', async () => {
    await dao.insertPending(pending('p1', 'X-1', 'In Progress', minsAgo(30)));
    await dao.insertPending(pending('p2', 'X-1', 'In Review', minsAgo(20)));
    await dao.insertPending(pending('p3', 'X-1', 'Done', minsAgo(10)));
    await dao.insertPending(pending('p4', 'X-2', 'In Progress', minsAgo(15)));

    // Submit using the representative (latest) pending id, as the client would.
    const req = new Request('http://x/api/ratings', {
      method: 'POST',
      body: JSON.stringify({ pendingId: 'p3', issueKey: 'X-1', claimedPoints: 5 }),
    });
    const res = await submitRating(req, ctx());
    expect(res.status).toBe(200);

    // All of X-1's pendings are gone; X-2 is untouched.
    expect(await dao.getPendingForIssue(ACCT, CLOUD, 'X-1')).toHaveLength(0);
    expect(await dao.getPendingForIssue(ACCT, CLOUD, 'X-2')).toHaveLength(1);

    // Exactly one rating was recorded for the issue.
    const ratings = await dao.getRatingsForOwner(ACCT);
    expect(ratings).toHaveLength(1);
    expect(ratings[0]!.issueKey).toBe('X-1');
    expect(ratings[0]!.claimedPoints).toBe(5);
  });
});
