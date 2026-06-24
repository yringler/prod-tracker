// JQL search (assignee = or WAS currentUser, status CHANGED) with changelog expand,
// and Agile-API sprint discovery. The query window is wider than the cron
// interval so a missed tick doesn't drop transitions — idempotency (by
// changelog id) makes the overlap safe.
//
// Uses the enhanced search endpoint /rest/api/3/search/jql. The legacy
// /rest/api/3/search was removed by Atlassian (returns 410 Gone) — the new
// endpoint is token-paginated and signals the last page by omitting
// nextPageToken (it does not return a total).

import type { JiraClient } from './client';
import type { JiraIssue } from './changelog';

/** Minutes of look-back in the JQL window. Cron is 3 min; query the last 10. */
export const POLL_WINDOW_MINUTES = 10;

interface SearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

/**
 * Issues assigned to the token's user whose status changed in the window, with
 * full changelog. Story Points + Sprint fields requested by their discovered
 * ids so we can snapshot them.
 */
export async function searchChangedIssues(
  client: JiraClient,
  opts: { storyPointsFieldId: string | null; sprintFieldId: string | null; windowMinutes?: number },
): Promise<JiraIssue[]> {
  const mins = opts.windowMinutes ?? POLL_WINDOW_MINUTES;
  // Also include tickets that were *recently* ours (`assignee WAS currentUser`),
  // not just currently ours: a transition that hands the ticket off (e.g. In
  // Progress → Pending Review reassigns to a reviewer) would otherwise drop the
  // issue out of the result set, silently losing the transition. Per-transition
  // ownership (see transitionOwnership) then filters out the reviewer's own
  // later moves that this wider net drags in.
  const jql =
    `status CHANGED AFTER "-${mins}m" ` +
    `AND (assignee = currentUser() OR assignee WAS currentUser() AFTER "-${mins}m")`;
  const fields = ['summary', 'status', 'assignee'];
  if (opts.storyPointsFieldId) fields.push(opts.storyPointsFieldId);
  if (opts.sprintFieldId) fields.push(opts.sprintFieldId);

  const params = new URLSearchParams({
    jql,
    expand: 'changelog',
    maxResults: '50',
    fields: fields.join(','),
  });
  const all: JiraIssue[] = [];
  // Page defensively; most polls return a handful of issues. The enhanced
  // endpoint ends a result set by omitting nextPageToken, so loop on that.
  let guard = 0;
  let path = `/rest/api/3/search/jql?${params.toString()}`;
  for (;;) {
    const res = await client.get<SearchResponse>(path);
    all.push(...(res.issues ?? []));
    if (!res.nextPageToken || ++guard > 20) break;
    const p = new URLSearchParams(params);
    p.set('nextPageToken', res.nextPageToken);
    path = `/rest/api/3/search/jql?${p.toString()}`;
  }
  return all;
}

export function readStoryPoints(issue: JiraIssue, fieldId: string | null): number | null {
  if (!fieldId) return null;
  const v = issue.fields[fieldId];
  return typeof v === 'number' ? v : null;
}

interface AgileBoard {
  id: number;
  name: string;
  /** 'scrum' | 'kanban' | 'simple' — only Scrum boards support the sprint endpoint. */
  type?: string;
}
interface AgileSprint {
  id: number;
  name: string;
  startDate?: string;
  endDate?: string;
}

export async function listBoards(client: JiraClient): Promise<AgileBoard[]> {
  const res = await client.get<{ values: AgileBoard[] }>('/rest/agile/1.0/board?maxResults=50');
  return res.values;
}

export async function listSprints(client: JiraClient, boardId: number): Promise<AgileSprint[]> {
  const res = await client.get<{ values: AgileSprint[] }>(
    `/rest/agile/1.0/board/${boardId}/sprint?maxResults=50&state=active,closed,future`,
  );
  return res.values;
}
