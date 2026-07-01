// Cron entry. Per stored user: refresh config/sprints as needed, pull changed
// issues, diff transitions by changelog id (exactly-once), emit pending ratings
// + push, and record done-status transitions into the done series.

import { isDoneTransition, isStaleTransition, sprintForTimestamp } from '@shared/domain';
import type { StatusTransition } from '@shared/domain';
import type { Dao, OAuthTokenRow } from '../db/dao';
import type { Env } from '../env';
import { extractStatusTransitions, diffNewTransitions, transitionOwnership } from '../jira/changelog';
import { selectPushTransition } from '../pending';
import { JiraClient, ReauthRequiredError } from '../jira/client';
import { discoverFields } from '../jira/fields';
import {
  listBoards,
  listSprints,
  readStoryPoints,
  searchChangedIssues,
} from '../jira/search';
import { sendPush } from '../push/webpush';
import { log as rootLog, errFields, type Logger } from '../log';

export async function runPoll(env: Env, dao: Dao, log: Logger = rootLog): Promise<void> {
  const tokens = await dao.allTokens();
  const refreshedClouds = new Set<string>();
  log.info('poll: start', { tokens: tokens.length });

  // One grant per account; poll each site (cloud) that grant can reach.
  for (const token of tokens) {
    if (await dao.getUserNeedsReauth(token.accountId)) {
      // Silent skip was invisible: a stale grant simply produced no data.
      log.warn('poll: skip account (needs reauth)', { accountId: token.accountId });
      continue;
    }
    const sites = await dao.listSites(token.accountId);
    for (const site of sites) {
      const slog = log.child({ accountId: token.accountId, cloudId: site.cloudId });
      try {
        const client = new JiraClient(env, dao, token, site.cloudId);
        await pollOneSite(env, dao, client, token, site.cloudId, refreshedClouds, slog);
      } catch (e) {
        if (e instanceof ReauthRequiredError) {
          slog.warn('poll: grant dead, skipping account sites');
          break; // grant dead — skip its sites
        }
        slog.error('poll: site failed', errFields(e));
      }
    }
  }
  log.info('poll: done');
}

async function pollOneSite(
  env: Env,
  dao: Dao,
  client: JiraClient,
  token: OAuthTokenRow,
  cloudId: string,
  refreshedClouds: Set<string>,
  log: Logger,
): Promise<void> {
  let config = await dao.getConfig(cloudId);

  // Discover field ids once per cloud.
  if (!config.storyPointsFieldId || !config.sprintFieldId) {
    const disc = await discoverFields(client);
    if (disc.ambiguous.storyPoints.length || disc.ambiguous.sprint.length) {
      // Flag rather than guess — see "Things to flag" in the spec.
      log.warn('poll: field discovery ambiguous', { ambiguous: disc.ambiguous });
    }
    if (disc.storyPointsFieldId && disc.sprintFieldId) {
      await dao.setFieldIds(cloudId, disc.storyPointsFieldId, disc.sprintFieldId);
      config = await dao.getConfig(cloudId);
      log.info('poll: field ids discovered', {
        storyPointsFieldId: disc.storyPointsFieldId,
        sprintFieldId: disc.sprintFieldId,
      });
    } else {
      // The poll continues, but with null field ids points/sprints stay empty.
      log.warn('poll: field ids unresolved', {
        storyPoints: disc.storyPointsFieldId,
        sprint: disc.sprintFieldId,
      });
    }
  }

  // Refresh sprint windows once per cloud per poll run.
  if (!refreshedClouds.has(cloudId)) {
    refreshedClouds.add(cloudId);
    await refreshSprints(dao, client, cloudId, log);
  }
  const sprints = await dao.sprintWindows(cloudId);

  const issues = await searchChangedIssues(client, {
    storyPointsFieldId: config.storyPointsFieldId,
    sprintFieldId: config.sprintFieldId,
  });
  log.info('poll: search', { issues: issues.length });

  for (const issue of issues) {
    const transitions = extractStatusTransitions(issue);
    const cursor = await dao.getLastSeenChangelogId(cloudId, issue.key);
    const { toEmit, newLastSeen } = diffNewTransitions(transitions, cursor);
    log.debug('poll: issue', {
      issueKey: issue.key,
      transitions: transitions.length,
      cursor,
      toEmit: toEmit.length,
    });
    if (toEmit.length === 0) continue;

    const storyPoints = readStoryPoints(issue, config.storyPointsFieldId);
    const title = (issue.fields.summary as string | undefined) ?? issue.key;
    const base = config.siteUrl ?? 'https://your-site.atlassian.net';
    const url = `${base}/browse/${issue.key}`;
    const idFor = (t: StatusTransition) => `${cloudId}:${issue.key}:${t.changelogId}`;

    // The broadened JQL (assignee WAS currentUser) can surface transitions a
    // reviewer performed after a hand-off. Only act on transitions that are
    // actually the user's — assignee was them just before or just after. This
    // gates both the pending/push and the done-series attribution below.
    const owned = transitionOwnership(issue, token.accountId);

    // Whether this issue already had a live (fresh) pending BEFORE this poll's
    // inserts — the push-dedup input, read now so the rows we insert below don't
    // count as "already live". isStaleTransition here judges the live-ness of
    // EXISTING rows: a separate check from the read transform's freshness filter,
    // not a duplicate of it.
    const existingPending = await dao.getPendingForIssue(token.accountId, cloudId, issue.key);
    const hadLive = existingPending.some((p) => !isStaleTransition(p.transitionedAt));

    // 1. Pending inserts. Prompt on EVERY owned transition (the human decides if
    //    it was worth points) — but only while fresh. Day-old transitions (first
    //    poll of a long history, or after downtime) are never surfaced; the cursor
    //    still advances below, so they are ignored for good. Done events (step 2)
    //    are recorded regardless of freshness.
    const ownedFresh = toEmit.filter(
      (t) => owned.get(t.changelogId) !== false && !isStaleTransition(t.at),
    );
    for (const t of ownedFresh) {
      await dao.insertPending({
        pendingId: idFor(t),
        cloudId,
        accountId: token.accountId,
        issueKey: issue.key,
        title,
        url,
        storyPoints,
        toStatus: t.toStatus,
        changelogId: t.changelogId,
        transitionedAt: t.at,
      });
      log.info('poll: pending inserted', {
        issueKey: issue.key,
        changelogId: t.changelogId,
        toStatus: t.toStatus,
      });
    }
    const staleSkipped = toEmit.filter(
      (t) => owned.get(t.changelogId) !== false && isStaleTransition(t.at),
    ).length;
    if (staleSkipped > 0) {
      log.info('poll: pending skipped (stale)', { issueKey: issue.key, count: staleSkipped });
    }

    // 2. Done series. Record owned done-status transitions, bucketed by the
    //    CHANGELOG timestamp's sprint window (not the current sprint).
    const toCat = issue.fields.status?.statusCategory?.key as
      | 'new'
      | 'indeterminate'
      | 'done'
      | undefined;
    for (const t of toEmit) {
      if (owned.get(t.changelogId) === false) continue;
      if (!isDoneTransition(t.toStatus, config.doneStatusNames, toCat)) continue;
      const sprintId = sprintForTimestamp(t.at, sprints);
      await dao.insertDoneEvent({
        cloudId,
        issueKey: issue.key,
        storyPoints,
        sprintId,
        transitionedToDoneAt: t.at,
        changelogId: t.changelogId,
        accountId: token.accountId,
        teamIdAtDone: await dao.teamAt(token.accountId, t.at),
      });
    }

    // 3. Notify, after the writes: one push per issue per flurry — the oldest
    //    fresh-owned transition, or silence if the issue already had a live
    //    pending (see selectPushTransition).
    const target = selectPushTransition(ownedFresh, hadLive);
    if (target) {
      await pushPending(
        env,
        dao,
        token.accountId,
        { pendingId: idFor(target), issueKey: issue.key, title, toStatus: target.toStatus },
        log,
      );
    }

    if (newLastSeen) await dao.setLastSeenChangelogId(cloudId, issue.key, newLastSeen);
  }
}

async function refreshSprints(
  dao: Dao,
  client: JiraClient,
  cloudId: string,
  log: Logger,
): Promise<void> {
  const boards = await listBoards(client).catch((e) => {
    log.warn('poll: sprint refresh failed', errFields(e));
    return null;
  });
  if (!boards) return;

  let n = 0;
  let skipped = 0;
  for (const board of boards) {
    // Only Scrum boards have sprints; the sprint endpoint 400s for Kanban (and
    // other non-Scrum) boards. Skip per-board so one unsupported board doesn't
    // abort the refresh for the rest.
    if (board.type === 'kanban') {
      skipped++;
      continue;
    }
    const sprints = await listSprints(client, board.id).catch((e) => {
      log.debug('poll: board sprints skipped', { boardId: board.id, ...errFields(e) });
      return null;
    });
    if (!sprints) {
      skipped++;
      continue;
    }
    for (const s of sprints) {
      await dao.upsertSprint({
        cloudId,
        sprintId: s.id,
        boardId: board.id,
        name: s.name,
        startAt: s.startDate ?? null,
        endAt: s.endDate ?? null,
      });
      n++;
    }
  }
  log.info('poll: sprints refreshed', { boards: boards.length, sprints: n, skipped });
}

async function pushPending(
  env: Env,
  dao: Dao,
  accountId: string,
  data: { pendingId: string; issueKey: string; title: string; toStatus: string },
  log: Logger,
): Promise<void> {
  const subs = await dao.subscriptionsFor(accountId);
  if (subs.length === 0) {
    log.warn('push: no subscriptions', { accountId, issueKey: data.issueKey });
    return;
  }
  for (const sub of subs) {
    try {
      const r = await sendPush(
        env,
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        {
          kind: 'rate',
          pendingId: data.pendingId,
          issueKey: data.issueKey,
          title: data.title,
          toStatus: data.toStatus,
        },
      );
      log.info('push: sent', { accountId, issueKey: data.issueKey, status: r.status });
      if (r.status === 404 || r.status === 410) {
        await dao.deleteSubscription(accountId, sub.endpoint); // gone — prune
      }
    } catch (e) {
      log.warn('push: failed', { accountId, ...errFields(e) });
    }
  }
}
