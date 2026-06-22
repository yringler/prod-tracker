// GDPR personal-data reporting. Atlassian requires apps that store personal data
// (here: every accountId we hold, plus display names) to periodically report those
// accountIds and act on the response — erasing closed accounts and refreshing
// stale copies. This is the 3LO variant of the report-accounts API.
//
// Driven by the existing 3-minute cron (worker/src/index.ts). A per-account
// last_reported_at gate (pd_report_state) keeps it a no-op except roughly once per
// cycle period, which also satisfies the guide's resumability requirement: state
// lives in the DB, so an interrupted run simply resumes on the next tick.

import type { Dao } from '../db/dao';
import type { Env } from '../env';
import { JiraClient, ReauthRequiredError } from '../jira/client';
import { fetchMyself } from '../jira/oauth';

const REPORT_URL = 'https://api.atlassian.com/app/report-accounts/';
const DEFAULT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (Atlassian default)
const MAX_BATCH = 90; // API limit: <=90 accounts per request
const MAX_BATCHES_PER_TICK = 3; // bound CPU per cron tick; the rest resume next tick

interface ReportAction {
  accountId: string;
  status: 'closed' | 'updated';
}

export async function reportPersonalData(env: Env, dao: Dao): Promise<void> {
  const nowMs = Date.now();
  const due = await dao.accountsDueForReport(DEFAULT_CYCLE_MS, nowMs);
  if (due.length === 0) return;

  const bearer = await acquireBearer(env, dao);
  if (!bearer) {
    console.warn('pd-report: no valid grant to authenticate report-accounts; skipping');
    return;
  }

  const batches = chunk(due, MAX_BATCH).slice(0, MAX_BATCHES_PER_TICK);
  for (const batch of batches) {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        accounts: batch.map((a) => ({ accountId: a.accountId, updatedAt: a.updatedAt })),
      }),
    });

    if (res.status === 429) {
      // Back off; DB state means the next cron tick safely resumes where we stopped.
      console.warn(`pd-report: rate-limited, retry after ${res.headers.get('Retry-After') ?? '?'}s`);
      return;
    }

    const ids = batch.map((a) => a.accountId);

    if (res.status === 204) {
      // Nothing to do for any account in this batch.
      await dao.markReported(ids, isoNow());
      continue;
    }

    if (res.status === 200) {
      const body = (await res.json()) as { accounts?: ReportAction[] };
      const actions = body.accounts ?? [];
      const closed = new Set<string>();
      for (const a of actions) {
        if (a.status === 'closed') {
          await dao.eraseAccount(a.accountId);
          closed.add(a.accountId);
        } else if (a.status === 'updated') {
          await refreshOne(env, dao, a.accountId);
        }
      }
      // Mark everything reported EXCEPT closed accounts: erasure already removed
      // their state row, and re-inserting it would re-store an erased accountId.
      await dao.markReported(ids.filter((id) => !closed.has(id)), isoNow());
      continue;
    }

    // Other non-2xx: leave last_reported_at untouched so it retries next tick.
    console.error(`pd-report: report-accounts -> ${res.status}`);
  }
}

/** A bearer for any of the app's grants. Atlassian recommends the app owner's
 *  token, so try BOOTSTRAP_ADMIN_ACCOUNT_ID first, then any other valid grant. */
async function acquireBearer(env: Env, dao: Dao): Promise<string | null> {
  const tokens = await dao.allTokens();
  const owner = env.BOOTSTRAP_ADMIN_ACCOUNT_ID;
  const ordered = owner
    ? [...tokens].sort((a, b) => Number(b.accountId === owner) - Number(a.accountId === owner))
    : tokens;

  for (const token of ordered) {
    if (await dao.getUserNeedsReauth(token.accountId)) continue;
    try {
      // The bearer is account-scoped, not cloud-scoped: cloudId is unused here.
      return await new JiraClient(env, dao, token, '').bearer();
    } catch (e) {
      if (e instanceof ReauthRequiredError) continue;
      console.warn(`pd-report: bearer failed for ${token.accountId}:`, e);
    }
  }
  return null;
}

/** Handle a "updated" status: re-fetch the display name if we still hold the
 *  account's own grant, else drop our stale copy (replace the name with the
 *  non-name accountId). */
async function refreshOne(env: Env, dao: Dao, accountId: string): Promise<void> {
  const at = isoNow();
  const token = await dao.getToken(accountId);
  if (token && !(await dao.getUserNeedsReauth(accountId))) {
    const cloudId = (await dao.listSites(accountId))[0]?.cloudId;
    if (cloudId) {
      try {
        const client = new JiraClient(env, dao, token, cloudId);
        const me = await fetchMyself(await client.bearer(), cloudId);
        await dao.refreshDisplayName(accountId, me.displayName ?? accountId, at);
        return;
      } catch (e) {
        console.warn(`pd-report: refresh failed for ${accountId}:`, e);
      }
    }
  }
  await dao.refreshDisplayName(accountId, accountId, at);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const isoNow = () => new Date().toISOString();
