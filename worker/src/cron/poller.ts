// Cron entry. Per stored user: refresh config/sprints as needed, pull changed
// issues, diff transitions by changelog id (exactly-once), emit pending ratings
// + push, and record done-status transitions into the done series.

import { isDoneTransition, sprintForTimestamp } from '@shared/domain';
import type { Dao, OAuthTokenRow } from '../db/dao';
import type { Env } from '../env';
import { extractStatusTransitions, diffNewTransitions } from '../jira/changelog';
import { JiraClient, ReauthRequiredError } from '../jira/client';
import { discoverFields } from '../jira/fields';
import {
  listBoards,
  listSprints,
  readStoryPoints,
  searchChangedIssues,
} from '../jira/search';
import { sendPush } from '../push/webpush';

export async function runPoll(env: Env, dao: Dao): Promise<void> {
  const tokens = await dao.allTokens();
  const refreshedClouds = new Set<string>();

  // One grant per account; poll each site (cloud) that grant can reach.
  for (const token of tokens) {
    if (await dao.getUserNeedsReauth(token.accountId)) continue;
    const sites = await dao.listSites(token.accountId);
    for (const site of sites) {
      try {
        const client = new JiraClient(env, dao, token, site.cloudId);
        await pollOneSite(env, dao, client, token, site.cloudId, refreshedClouds);
      } catch (e) {
        if (e instanceof ReauthRequiredError) break; // grant dead — skip its sites
        console.error(`poll failed for ${token.accountId}/${site.cloudId}:`, e);
      }
    }
  }
}

async function pollOneSite(
  env: Env,
  dao: Dao,
  client: JiraClient,
  token: OAuthTokenRow,
  cloudId: string,
  refreshedClouds: Set<string>,
): Promise<void> {
  let config = await dao.getConfig(cloudId);

  // Discover field ids once per cloud.
  if (!config.storyPointsFieldId || !config.sprintFieldId) {
    const disc = await discoverFields(client);
    if (disc.ambiguous.storyPoints.length || disc.ambiguous.sprint.length) {
      // Flag rather than guess — see "Things to flag" in the spec.
      console.warn(`field discovery ambiguous on ${cloudId}:`, disc.ambiguous);
    }
    if (disc.storyPointsFieldId && disc.sprintFieldId) {
      await dao.setFieldIds(cloudId, disc.storyPointsFieldId, disc.sprintFieldId);
      config = await dao.getConfig(cloudId);
    }
  }

  // Refresh sprint windows once per cloud per poll run.
  if (!refreshedClouds.has(cloudId)) {
    refreshedClouds.add(cloudId);
    await refreshSprints(dao, client, cloudId);
  }
  const sprints = await dao.sprintWindows(cloudId);

  const issues = await searchChangedIssues(client, {
    storyPointsFieldId: config.storyPointsFieldId,
    sprintFieldId: config.sprintFieldId,
  });

  for (const issue of issues) {
    const transitions = extractStatusTransitions(issue);
    const cursor = await dao.getLastSeenChangelogId(cloudId, issue.key);
    const { toEmit, newLastSeen } = diffNewTransitions(transitions, cursor);
    if (toEmit.length === 0) continue;

    const storyPoints = readStoryPoints(issue, config.storyPointsFieldId);
    const title = (issue.fields.summary as string | undefined) ?? issue.key;
    const base = config.siteUrl ?? 'https://your-site.atlassian.net';
    const url = `${base}/browse/${issue.key}`;

    for (const t of toEmit) {
      // Prompt on EVERY transition (the human decides if it was worth points).
      const pendingId = `${cloudId}:${issue.key}:${t.changelogId}`;
      await dao.insertPending({
        pendingId,
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
      await pushPending(env, dao, token.accountId, {
        pendingId,
        issueKey: issue.key,
        title,
        toStatus: t.toStatus,
      });

      // Separately, record done-status transitions into the done series,
      // bucketed by the CHANGELOG timestamp's sprint window (not current sprint).
      const toCat = issue.fields.status?.statusCategory?.key as
        | 'new'
        | 'indeterminate'
        | 'done'
        | undefined;
      if (isDoneTransition(t.toStatus, config.doneStatusNames, toCat)) {
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
    }

    if (newLastSeen) await dao.setLastSeenChangelogId(cloudId, issue.key, newLastSeen);
  }
}

async function refreshSprints(dao: Dao, client: JiraClient, cloudId: string): Promise<void> {
  try {
    const boards = await listBoards(client);
    for (const board of boards) {
      const sprints = await listSprints(client, board.id);
      for (const s of sprints) {
        await dao.upsertSprint({
          cloudId,
          sprintId: s.id,
          boardId: board.id,
          name: s.name,
          startAt: s.startDate ?? null,
          endAt: s.endDate ?? null,
        });
      }
    }
  } catch (e) {
    console.warn(`sprint refresh failed for ${cloudId}:`, e);
  }
}

async function pushPending(
  env: Env,
  dao: Dao,
  accountId: string,
  data: { pendingId: string; issueKey: string; title: string; toStatus: string },
): Promise<void> {
  const subs = await dao.subscriptionsFor(accountId);
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
      if (r.status === 404 || r.status === 410) {
        await dao.deleteSubscription(accountId, sub.endpoint); // gone — prune
      }
    } catch (e) {
      console.warn(`push failed for ${accountId}:`, e);
    }
  }
}
