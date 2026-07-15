// Data-access layer. THE PRIVACY INVARIANT IS ENFORCED HERE.
//
//   - The ONLY method that returns individual rating rows is `getRatingsForOwner`,
//     and it REQUIRES the owner's accountId and filters by it in SQL. Route layer
//     passes req.user.accountId; there is no code path that passes someone else's.
//   - Every aggregate method groups by team and selects sums only. None of them
//     accept a raterAccountId parameter, so no caller can request a per-developer
//     slice. The return rows carry no account column.
//
// If you add a method here that returns per-account rows, it MUST take the owner
// id and filter on it, OR it breaks the "not a surveillance tool" guarantee.

import type {
  ClaimedVsDone,
  Role,
  SprintWindow,
} from '@shared/domain';
import { computeRatio } from '@shared/domain';
import type { D1Like } from './driver';

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export interface OAuthTokenRow {
  accountId: string;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: string | null;
}

export interface SiteRow {
  cloudId: string;
  name: string;
  siteUrl: string;
}

export interface PendingRow {
  pendingId: string;
  cloudId: string;
  accountId: string;
  issueKey: string;
  title: string;
  url: string;
  storyPoints: number | null;
  toStatus: string;
  changelogId: string;
  transitionedAt: string;
}

export interface UserChannel {
  channel: string;
  label: string;
}

export interface EscalationCandidate {
  pendingId: string;
  accountId: string;
  issueKey: string;
  title: string;
  url: string;
}

export interface DoneEventInput {
  cloudId: string;
  issueKey: string;
  storyPoints: number | null;
  sprintId: number | null;
  transitionedToDoneAt: string;
  changelogId: string;
  accountId: string;
  teamIdAtDone: string | null;
}

export class Dao {
  constructor(private readonly db: D1Like) {}

  // --- OAuth tokens (rotating refresh) ---------------------------------------

  async upsertToken(t: OAuthTokenRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (account_id, refresh_token, access_token, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           refresh_token = excluded.refresh_token,
           access_token  = excluded.access_token,
           expires_at    = excluded.expires_at`,
      )
      .bind(t.accountId, t.refreshToken, t.accessToken, t.expiresAt)
      .run();
  }

  async getToken(accountId: string): Promise<OAuthTokenRow | null> {
    const r = await this.db
      .prepare(`SELECT * FROM oauth_tokens WHERE account_id = ?`)
      .bind(accountId)
      .first();
    return r ? mapToken(r) : null;
  }

  async allTokens(): Promise<OAuthTokenRow[]> {
    const { results } = await this.db.prepare(`SELECT * FROM oauth_tokens`).all();
    return results.map(mapToken);
  }

  // --- User sites (cloudIds reachable by the account's token) -----------------

  async upsertSite(accountId: string, s: SiteRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_sites (account_id, cloud_id, name, site_url) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, cloud_id) DO UPDATE SET
           name = excluded.name, site_url = excluded.site_url`,
      )
      .bind(accountId, s.cloudId, s.name, s.siteUrl)
      .run();
  }

  async listSites(accountId: string): Promise<SiteRow[]> {
    const { results } = await this.db
      .prepare(`SELECT cloud_id, name, site_url FROM user_sites WHERE account_id = ? ORDER BY name`)
      .bind(accountId)
      .all<{ cloud_id: string; name: string; site_url: string }>();
    return results.map((r) => ({ cloudId: r.cloud_id, name: r.name, siteUrl: r.site_url }));
  }

  /** Whether `cloudId` is one of the account's reachable sites — the auth guard
   *  for switching sites: a user can only select a cloud their token can reach. */
  async accountHasSite(accountId: string, cloudId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT 1 AS x FROM user_sites WHERE account_id = ? AND cloud_id = ?`)
      .bind(accountId, cloudId)
      .first();
    return !!r;
  }

  // --- Users -----------------------------------------------------------------

  async upsertUser(
    accountId: string,
    displayName: string,
    cloudId: string,
    avatarUrl: string | null = null,
  ): Promise<void> {
    // daily_goal is deliberately NOT in the SET list — a re-login must never
    // clobber the user's saved goal.
    await this.db
      .prepare(
        `INSERT INTO users (account_id, display_name, cloud_id, avatar_url, last_seen_at, needs_reauth)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(account_id) DO UPDATE SET
           display_name = excluded.display_name,
           cloud_id     = excluded.cloud_id,
           avatar_url   = excluded.avatar_url,
           last_seen_at = excluded.last_seen_at,
           needs_reauth = 0`,
      )
      .bind(accountId, displayName, cloudId, avatarUrl, now())
      .run();
  }

  /** Self-scoped settings/profile extras for /api/me. */
  async getUserSettings(
    accountId: string,
  ): Promise<{ dailyGoal: number | null; avatarUrl: string | null }> {
    const r = await this.db
      .prepare(`SELECT daily_goal, avatar_url FROM users WHERE account_id = ?`)
      .bind(accountId)
      .first<{ daily_goal: number | null; avatar_url: string | null }>();
    return { dailyGoal: r?.daily_goal ?? null, avatarUrl: r?.avatar_url ?? null };
  }

  /** Set (or clear, with null) the account's daily claimed-points goal. */
  async setDailyGoal(accountId: string, dailyGoal: number | null): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET daily_goal = ? WHERE account_id = ?`)
      .bind(dailyGoal, accountId)
      .run();
  }

  async setNeedsReauth(accountId: string, needs: boolean): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET needs_reauth = ? WHERE account_id = ?`)
      .bind(needs ? 1 : 0, accountId)
      .run();
  }

  async getDisplayName(accountId: string): Promise<string> {
    const r = await this.db
      .prepare(`SELECT display_name FROM users WHERE account_id = ?`)
      .bind(accountId)
      .first<{ display_name: string }>();
    return r?.display_name ?? accountId;
  }

  /** Everyone in an org (whose token reaches `cloudId`), with display name, for
   *  the admin member-picker dropdowns. Org boundary = user_sites (same as
   *  accountHasSite/listSites). Erased accounts are gone from both tables. */
  async listOrgMembers(
    cloudId: string,
  ): Promise<Array<{ accountId: string; displayName: string }>> {
    const { results } = await this.db
      .prepare(
        `SELECT us.account_id AS account_id, u.display_name AS display_name
         FROM user_sites us
         JOIN users u ON u.account_id = us.account_id
         WHERE us.cloud_id = ?
         ORDER BY u.display_name`,
      )
      .bind(cloudId)
      .all<{ account_id: string; display_name: string }>();
    return results.map((r) => ({ accountId: r.account_id, displayName: r.display_name }));
  }

  /** Current roster of a team: open memberships only, one row per account (an
   *  account has at most one open membership globally). */
  async listMemberships(
    teamId: string,
  ): Promise<Array<{ accountId: string; effectiveFrom: string; effectiveTo: string | null }>> {
    const { results } = await this.db
      .prepare(
        `SELECT account_id, effective_from, effective_to FROM team_memberships
         WHERE team_id = ? AND effective_to IS NULL ORDER BY effective_from DESC`,
      )
      .bind(teamId)
      .all<{ account_id: string; effective_from: string; effective_to: string | null }>();
    return results.map((r) => ({
      accountId: r.account_id,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    }));
  }

  async getUserNeedsReauth(accountId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT needs_reauth FROM users WHERE account_id = ?`)
      .bind(accountId)
      .first<{ needs_reauth: number }>();
    return !!r && r.needs_reauth === 1;
  }

  // --- Admins ----------------------------------------------------------------

  async isAdmin(accountId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT 1 AS x FROM admins WHERE account_id = ?`)
      .bind(accountId)
      .first();
    return !!r;
  }

  async countAdmins(): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM admins`)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async appointAdmin(accountId: string, appointedBy: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO admins (account_id, appointed_by, appointed_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(accountId, appointedBy, now())
      .run();
  }

  async revokeAdmin(accountId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM admins WHERE account_id = ?`).bind(accountId).run();
  }

  async roleFor(accountId: string, bootstrapAdminId: string): Promise<Role> {
    if (bootstrapAdminId && accountId === bootstrapAdminId) return 'admin';
    return (await this.isAdmin(accountId)) ? 'admin' : 'user';
  }

  // --- Teams & effective-dated memberships -----------------------------------

  async createTeam(cloudId: string, name: string): Promise<string> {
    const teamId = uuid();
    await this.db
      .prepare(`INSERT INTO teams (team_id, cloud_id, name) VALUES (?, ?, ?)`)
      .bind(teamId, cloudId, name)
      .run();
    return teamId;
  }

  async listTeams(cloudId: string): Promise<Array<{ teamId: string; cloudId: string; name: string }>> {
    const { results } = await this.db
      .prepare(`SELECT team_id, cloud_id, name FROM teams WHERE cloud_id = ? ORDER BY name`)
      .bind(cloudId)
      .all<{ team_id: string; cloud_id: string; name: string }>();
    return results.map((r) => ({ teamId: r.team_id, cloudId: r.cloud_id, name: r.name }));
  }

  /** Move an account to a team: close the open membership, open a new one.
   *  No-op if the account is already on `teamId` at `at`, so re-assigning to the
   *  same team doesn't split one continuous membership into redundant rows. */
  async assignMembership(accountId: string, teamId: string, effectiveFrom?: string): Promise<void> {
    const at = effectiveFrom ?? now();
    if ((await this.teamAt(accountId, at)) === teamId) return;
    await this.db
      .prepare(
        `UPDATE team_memberships SET effective_to = ?
         WHERE account_id = ? AND effective_to IS NULL`,
      )
      .bind(at, accountId)
      .run();
    await this.db
      .prepare(
        `INSERT INTO team_memberships (id, account_id, team_id, effective_from, effective_to)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(uuid(), accountId, teamId, at)
      .run();
  }

  /** Team the account belonged to at instant `at` (defaults now). null if none. */
  async teamAt(accountId: string, at?: string): Promise<string | null> {
    const t = at ?? now();
    const r = await this.db
      .prepare(
        `SELECT team_id FROM team_memberships
         WHERE account_id = ? AND effective_from <= ?
           AND (effective_to IS NULL OR effective_to > ?)
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .bind(accountId, t, t)
      .first<{ team_id: string }>();
    return r?.team_id ?? null;
  }

  // --- Issue state (idempotency cursor) --------------------------------------

  async getLastSeenChangelogId(cloudId: string, issueKey: string): Promise<string | null> {
    const r = await this.db
      .prepare(`SELECT last_seen_changelog_id FROM issue_state WHERE cloud_id = ? AND issue_key = ?`)
      .bind(cloudId, issueKey)
      .first<{ last_seen_changelog_id: string | null }>();
    return r?.last_seen_changelog_id ?? null;
  }

  async setLastSeenChangelogId(cloudId: string, issueKey: string, id: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO issue_state (cloud_id, issue_key, last_seen_changelog_id) VALUES (?, ?, ?)
         ON CONFLICT(cloud_id, issue_key) DO UPDATE SET last_seen_changelog_id = excluded.last_seen_changelog_id`,
      )
      .bind(cloudId, issueKey, id)
      .run();
  }

  // --- Pending ratings -------------------------------------------------------

  async insertPending(p: PendingRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_ratings
           (pending_id, cloud_id, account_id, issue_key, title, url, story_points, to_status, changelog_id, transitioned_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pending_id) DO NOTHING`,
      )
      .bind(
        p.pendingId, p.cloudId, p.accountId, p.issueKey, p.title, p.url,
        p.storyPoints, p.toStatus, p.changelogId, p.transitionedAt, now(),
      )
      .run();
  }

  /** Pending prompts for ONE account. Scoped by accountId (the owner). */
  async getPendingForOwner(accountId: string): Promise<PendingRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM pending_ratings WHERE account_id = ? ORDER BY transitioned_at DESC`)
      .bind(accountId)
      .all();
    return results.map(mapPending);
  }

  /** All pending rows for ONE issue owned by ONE account. Account-scoped like the
   *  other pending reads. Used by the poller to dedup pushes (one per issue). */
  async getPendingForIssue(
    accountId: string,
    cloudId: string,
    issueKey: string,
  ): Promise<PendingRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM pending_ratings
         WHERE account_id = ? AND cloud_id = ? AND issue_key = ?
         ORDER BY transitioned_at DESC`,
      )
      .bind(accountId, cloudId, issueKey)
      .all();
    return results.map(mapPending);
  }

  async getPending(pendingId: string): Promise<PendingRow | null> {
    const r = await this.db
      .prepare(`SELECT * FROM pending_ratings WHERE pending_id = ?`)
      .bind(pendingId)
      .first();
    return r ? mapPending(r) : null;
  }

  async deletePending(pendingId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM pending_ratings WHERE pending_id = ?`).bind(pendingId).run();
  }

  /** Clear every pending row for ONE issue owned by ONE account — a composite
   *  claim rates the whole issue, so all its bundled transitions go at once. */
  async deletePendingForIssue(
    accountId: string,
    cloudId: string,
    issueKey: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM pending_ratings WHERE account_id = ? AND cloud_id = ? AND issue_key = ?`,
      )
      .bind(accountId, cloudId, issueKey)
      .run();
  }

  /** Clear ALL pending prompts for ONE account. Scoped by accountId (the owner). */
  async deletePendingForOwner(accountId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM pending_ratings WHERE account_id = ?`).bind(accountId).run();
  }

  // --- Ratings ---------------------------------------------------------------

  async insertRating(input: {
    cloudId: string;
    issueKey: string;
    raterAccountId: string;
    claimedPoints: number;
    storyPointsAtRating: number | null;
    teamIdAtRating: string | null;
    sprintId: number | null;
    // The Jira transition time this claim is about — what day/week views bucket on.
    // Stamped from the pending prompt; null only for the rare claim with no known
    // transition, which then falls back to rated_at in the bucketing queries.
    transitionedAt?: string | null;
    notes?: string | null;
    title?: string | null;
    url?: string | null;
  }): Promise<string> {
    const id = uuid();
    await this.db
      .prepare(
        `INSERT INTO ratings
           (id, cloud_id, issue_key, rater_account_id, claimed_points, story_points_at_rating, team_id_at_rating, sprint_id, rated_at, transitioned_at, notes, title, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, input.cloudId, input.issueKey, input.raterAccountId, input.claimedPoints,
        input.storyPointsAtRating, input.teamIdAtRating, input.sprintId, now(),
        input.transitionedAt ?? null, input.notes ?? null, input.title ?? null, input.url ?? null,
      )
      .run();
    return id;
  }

  /**
   * PERSONAL ENDPOINT. Returns individual rating rows for ONE owner only.
   * `ownerAccountId` is the authenticated caller; the WHERE clause makes it
   * impossible to read another account's rows. This is the single sanctioned
   * place that returns per-account data.
   */
  async getRatingsForOwner(ownerAccountId: string): Promise<
    Array<{
      id: string;
      issueKey: string;
      claimedPoints: number;
      storyPointsAtRating: number | null;
      sprintId: number | null;
      ratedAt: string;
      transitionedAt: string | null;
      title: string | null;
      url: string | null;
      notes: string | null;
    }>
  > {
    const { results } = await this.db
      .prepare(
        `SELECT id, issue_key, claimed_points, story_points_at_rating, sprint_id, rated_at, transitioned_at, title, url, notes
         FROM ratings WHERE rater_account_id = ? ORDER BY rated_at DESC`,
      )
      .bind(ownerAccountId)
      .all<{
        id: string;
        issue_key: string;
        claimed_points: number;
        story_points_at_rating: number | null;
        sprint_id: number | null;
        rated_at: string;
        transitioned_at: string | null;
        title: string | null;
        url: string | null;
        notes: string | null;
      }>();
    return results.map((r) => ({
      id: r.id,
      issueKey: r.issue_key,
      claimedPoints: r.claimed_points,
      storyPointsAtRating: r.story_points_at_rating,
      sprintId: r.sprint_id,
      ratedAt: r.rated_at,
      transitionedAt: r.transitioned_at,
      title: r.title,
      url: r.url,
      notes: r.notes,
    }));
  }

  // --- Done events -----------------------------------------------------------

  async insertDoneEvent(d: DoneEventInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO done_events
           (id, cloud_id, issue_key, story_points, sprint_id, transitioned_to_done_at, changelog_id, account_id, team_id_at_done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cloud_id, changelog_id) DO NOTHING`,
      )
      .bind(
        uuid(), d.cloudId, d.issueKey, d.storyPoints, d.sprintId,
        d.transitionedToDoneAt, d.changelogId, d.accountId, d.teamIdAtDone,
      )
      .run();
  }

  // --- Sprints ---------------------------------------------------------------

  async upsertSprint(s: {
    cloudId: string;
    sprintId: number;
    boardId: number;
    name: string;
    startAt: string | null;
    endAt: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sprints (cloud_id, sprint_id, board_id, name, start_at, end_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cloud_id, sprint_id) DO UPDATE SET
           board_id = excluded.board_id, name = excluded.name,
           start_at = excluded.start_at, end_at = excluded.end_at`,
      )
      .bind(s.cloudId, s.sprintId, s.boardId, s.name, s.startAt, s.endAt)
      .run();
  }

  async sprintWindows(cloudId: string): Promise<SprintWindow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT sprint_id, start_at, end_at FROM sprints
         WHERE cloud_id = ? AND start_at IS NOT NULL AND end_at IS NOT NULL`,
      )
      .bind(cloudId)
      .all<{ sprint_id: number; start_at: string; end_at: string }>();
    return results.map((r) => ({ sprintId: r.sprint_id, startAt: r.start_at, endAt: r.end_at }));
  }

  // --- Config ----------------------------------------------------------------

  async getConfig(cloudId: string): Promise<{
    cloudId: string;
    storyPointsFieldId: string | null;
    sprintFieldId: string | null;
    doneStatusNames: string[];
    siteUrl: string | null;
  }> {
    const r = await this.db
      .prepare(`SELECT * FROM config WHERE cloud_id = ?`)
      .bind(cloudId)
      .first<{
        cloud_id: string;
        story_points_field_id: string | null;
        sprint_field_id: string | null;
        done_status_names: string;
        site_url: string | null;
      }>();
    if (!r) {
      return {
        cloudId,
        storyPointsFieldId: null,
        sprintFieldId: null,
        doneStatusNames: [],
        siteUrl: null,
      };
    }
    return {
      cloudId: r.cloud_id,
      storyPointsFieldId: r.story_points_field_id,
      sprintFieldId: r.sprint_field_id,
      doneStatusNames: safeJsonArray(r.done_status_names),
      siteUrl: r.site_url,
    };
  }

  async setSiteUrl(cloudId: string, siteUrl: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (cloud_id, site_url) VALUES (?, ?)
         ON CONFLICT(cloud_id) DO UPDATE SET site_url = excluded.site_url`,
      )
      .bind(cloudId, siteUrl)
      .run();
  }

  async setFieldIds(cloudId: string, storyPointsFieldId: string, sprintFieldId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (cloud_id, story_points_field_id, sprint_field_id, done_status_names)
         VALUES (?, ?, ?, '[]')
         ON CONFLICT(cloud_id) DO UPDATE SET
           story_points_field_id = excluded.story_points_field_id,
           sprint_field_id = excluded.sprint_field_id`,
      )
      .bind(cloudId, storyPointsFieldId, sprintFieldId)
      .run();
  }

  async setDoneStatusNames(cloudId: string, names: string[]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (cloud_id, done_status_names) VALUES (?, ?)
         ON CONFLICT(cloud_id) DO UPDATE SET done_status_names = excluded.done_status_names`,
      )
      .bind(cloudId, JSON.stringify(names))
      .run();
  }

  // --- Push subscriptions ----------------------------------------------------

  async saveSubscription(accountId: string, endpoint: string, p256dh: string, auth: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .bind(accountId, endpoint, p256dh, auth)
      .run();
  }

  async subscriptionsFor(accountId: string): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
    const { results } = await this.db
      .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE account_id = ?`)
      .bind(accountId)
      .all<{ endpoint: string; p256dh: string; auth: string }>();
    return results;
  }

  async deleteSubscription(accountId: string, endpoint: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?`)
      .bind(accountId, endpoint)
      .run();
  }

  // --- Notification channels (app-owned registry) ----------------------------
  //
  // The app stores ONLY the channel enum + an opaque label it renders but never
  // parses. The vendor address (e.g. a zulip_user_id) lives inside the adapter's
  // own tables — the app never learns it. These reads are self-scoped by
  // account_id, like every other per-account read here.

  /** Idempotent upsert on (account_id, channel). Called from the app layer only
   *  (index.ts webhook wiring / routes), never from an adapter. */
  async registerChannel(accountId: string, channel: string, label: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_channels (account_id, channel, label, linked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, channel) DO UPDATE SET
           label = excluded.label, linked_at = excluded.linked_at`,
      )
      .bind(accountId, channel, label, now())
      .run();
  }

  async unregisterChannel(accountId: string, channel: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM user_channels WHERE account_id = ? AND channel = ?`)
      .bind(accountId, channel)
      .run();
  }

  /** Channels this account has linked. Self-scoped. Used by escalation + the list route. */
  async getUserChannels(accountId: string): Promise<UserChannel[]> {
    const { results } = await this.db
      .prepare(`SELECT channel, label FROM user_channels WHERE account_id = ? ORDER BY channel`)
      .bind(accountId)
      .all<{ channel: string; label: string }>();
    return results.map((r) => ({ channel: r.channel, label: r.label }));
  }

  // --- Escalation state ------------------------------------------------------

  /** Pending prompts a user has NOT acted on (row still exists) that are ripe for
   *  escalation: created before `dueBeforeIso` (past the delay) but after `notBeforeIso`
   *  (so a backlog after downtime isn't force-escalated), and not already escalated.
   *  A surviving pending_ratings row IS the "did not act" signal (rating deletes it). */
  async pendingDueForEscalation(
    dueBeforeIso: string,
    notBeforeIso: string,
  ): Promise<EscalationCandidate[]> {
    const { results } = await this.db
      .prepare(
        `SELECT pending_id, account_id, issue_key, title, url FROM pending_ratings
         WHERE escalated_at IS NULL AND created_at <= ? AND created_at > ?
         ORDER BY created_at`,
      )
      .bind(dueBeforeIso, notBeforeIso)
      .all<{
        pending_id: string;
        account_id: string;
        issue_key: string;
        title: string;
        url: string;
      }>();
    return results.map((r) => ({
      pendingId: r.pending_id,
      accountId: r.account_id,
      issueKey: r.issue_key,
      title: r.title,
      url: r.url,
    }));
  }

  /** Mark rows escalated (at most once). Batched like markReported(). */
  async markEscalated(pendingIds: string[], atIso: string): Promise<void> {
    if (pendingIds.length === 0) return;
    await this.db.batch(
      pendingIds.map((id) =>
        this.db
          .prepare(`UPDATE pending_ratings SET escalated_at = ? WHERE pending_id = ?`)
          .bind(atIso, id),
      ),
    );
  }

  // --- Sessions --------------------------------------------------------------

  async createSession(accountId: string, cloudId: string, ttlSeconds: number): Promise<string> {
    const sid = uuid();
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.db
      .prepare(`INSERT INTO sessions (session_id, account_id, cloud_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(sid, accountId, cloudId, now(), expires)
      .run();
    return sid;
  }

  async getSession(sid: string): Promise<{ accountId: string; cloudId: string } | null> {
    const r = await this.db
      .prepare(`SELECT account_id, cloud_id, expires_at FROM sessions WHERE session_id = ?`)
      .bind(sid)
      .first<{ account_id: string; cloud_id: string; expires_at: string }>();
    if (!r) return null;
    if (Date.parse(r.expires_at) < Date.now()) {
      await this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sid).run();
      return null;
    }
    return { accountId: r.account_id, cloudId: r.cloud_id };
  }

  async deleteSession(sid: string): Promise<void> {
    await this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sid).run();
  }

  /** Switch the currently-selected site for a session (validated by caller). */
  async updateSessionCloud(sid: string, cloudId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE sessions SET cloud_id = ? WHERE session_id = ?`)
      .bind(cloudId, sid)
      .run();
  }

  // --- GDPR personal-data reporting & erasure --------------------------------
  //
  // CRON-ONLY. accountsForReport/accountsDueForReport return account-level data
  // and MUST NOT be reachable from any HTTP route — that would re-create the
  // surveillance read-path the privacy invariant forbids. They feed the
  // report-accounts cron (worker/src/cron/pd-report.ts) exclusively.

  /**
   * Every accountId we store ANY personal data for, with the age (updatedAt) of
   * that data. The accountId itself is PD, so this is the union across every
   * account-bearing table. `updatedAt` is users.last_seen_at (when we fetched the
   * display name — the only non-id PD) or, for accounts with no profile row, now.
   * Already-anonymized rows (`erased:*`) are excluded.
   */
  async accountsForReport(): Promise<Array<{ accountId: string; updatedAt: string }>> {
    // Collect ids per account-bearing table and union in JS. A single SQL
    // statement UNION-ing all of these exceeded D1's compound-SELECT term limit.
    // The (table, column) pairs are hardcoded constants — no injection surface.
    const sources: Array<[table: string, column: string]> = [
      ['oauth_tokens', 'account_id'],
      ['user_sites', 'account_id'],
      ['users', 'account_id'],
      ['admins', 'account_id'],
      ['admins', 'appointed_by'],
      ['team_memberships', 'account_id'],
      ['ratings', 'rater_account_id'],
      ['done_events', 'account_id'],
      ['pending_ratings', 'account_id'],
      ['push_subscriptions', 'account_id'],
      // An account that has only linked a notification channel is still reportable.
      // Adapter-owned zulip_*/email_links are NOT listed here on purpose: linking
      // always writes user_channels for the same account_id (so the account is
      // already covered), and keeping vendor table names out of dao preserves
      // "the app never learns what a zulip_user_id is."
      ['user_channels', 'account_id'],
      ['sessions', 'account_id'],
    ];
    const ids = new Set<string>();
    for (const [table, column] of sources) {
      const { results } = await this.db
        .prepare(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IS NOT NULL`)
        .all<{ id: string }>();
      for (const r of results) {
        if (r.id && !r.id.startsWith('erased:')) ids.add(r.id); // skip already-anonymized
      }
    }

    // last_seen_at (the only non-id PD) ages each account; id-only accounts fall
    // back to a fresh timestamp.
    const { results: userRows } = await this.db
      .prepare(`SELECT account_id, last_seen_at FROM users`)
      .all<{ account_id: string; last_seen_at: string | null }>();
    const lastSeen = new Map(userRows.map((r) => [r.account_id, r.last_seen_at]));
    const fallback = now();
    return [...ids].map((accountId) => ({
      accountId,
      updatedAt: lastSeen.get(accountId) ?? fallback,
    }));
  }

  /** Accounts whose personal data is due to be (re-)reported: never reported, or
   *  last reported longer ago than the cycle period. */
  async accountsDueForReport(
    cycleMs: number,
    nowMs: number,
  ): Promise<Array<{ accountId: string; updatedAt: string }>> {
    const all = await this.accountsForReport();
    const { results } = await this.db
      .prepare(`SELECT account_id, last_reported_at FROM pd_report_state`)
      .all<{ account_id: string; last_reported_at: string }>();
    const lastReported = new Map(results.map((r) => [r.account_id, Date.parse(r.last_reported_at)]));
    return all.filter((a) => {
      const last = lastReported.get(a.accountId);
      return last === undefined || nowMs - last >= cycleMs;
    });
  }

  /** Record that these accounts were reported at `at` (resets the cycle clock). */
  async markReported(accountIds: string[], at: string): Promise<void> {
    if (accountIds.length === 0) return;
    await this.db.batch(
      accountIds.map((id) =>
        this.db
          .prepare(
            `INSERT INTO pd_report_state (account_id, last_reported_at) VALUES (?, ?)
             ON CONFLICT(account_id) DO UPDATE SET last_reported_at = excluded.last_reported_at`,
          )
          .bind(id, at),
      ),
    );
  }

  /**
   * Right to erasure. Hard-deletes the account's personal data everywhere, EXCEPT
   * ratings/done_events: those keep their aggregate value but have the accountId
   * irreversibly replaced by one fresh opaque `erased:*` id (no mapping retained →
   * anonymized, outside GDPR), so historical claimed-vs-done charts and
   * distinct-rater counts stay correct. admins.appointed_by references are nulled.
   */
  async eraseAccount(accountId: string): Promise<void> {
    const pseudonym = `erased:${uuid()}`;
    await this.db.batch([
      this.db.prepare(`DELETE FROM oauth_tokens      WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM user_sites        WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM users             WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM admins            WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`UPDATE admins SET appointed_by = NULL WHERE appointed_by = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM team_memberships  WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM pending_ratings   WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM push_subscriptions WHERE account_id = ?`).bind(accountId),
      // Adapter-owned zulip_*/email_links rows are erased separately, via the
      // registry unlink seam (routes/notifications), not from here.
      this.db.prepare(`DELETE FROM user_channels     WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM sessions          WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`DELETE FROM pd_report_state   WHERE account_id = ?`).bind(accountId),
      this.db.prepare(`UPDATE ratings     SET rater_account_id = ? WHERE rater_account_id = ?`).bind(pseudonym, accountId),
      this.db.prepare(`UPDATE done_events SET account_id = ?       WHERE account_id = ?`).bind(pseudonym, accountId),
    ]);
  }

  /** Replace our stored copy of an account's display name (the "updated" case). */
  async refreshDisplayName(accountId: string, displayName: string, at: string): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET display_name = ?, last_seen_at = ? WHERE account_id = ?`)
      .bind(displayName, at, accountId)
      .run();
  }

  // --- AGGREGATES (team-grouped, sums only; never per-account) ---------------

  /** Earliest rated_at across the whole cloud, or null if there are no ratings. */
  async earliestClaimAt(cloudId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT MIN(rated_at) AS m FROM ratings WHERE cloud_id = ?`)
      .bind(cloudId)
      .first<{ m: string | null }>();
    return row?.m ?? null;
  }

  /**
   * Claimed-vs-done series for ONE team. Groups by sprint, sums only.
   * Deliberately takes no rater filter — there is no way to ask for one rater.
   * `sinceIso` lower-bounds sprints by start_at so the series stays within a
   * recent window (see aggregateSince in routes/aggregates.ts).
   */
  async teamSeries(cloudId: string, teamId: string, sinceIso: string): Promise<ClaimedVsDone[]> {
    const sprintRows = await this.db
      .prepare(
        `SELECT sprint_id, name FROM sprints
         WHERE cloud_id = ? AND start_at >= ? ORDER BY start_at`,
      )
      .bind(cloudId, sinceIso)
      .all<{ sprint_id: number; name: string }>();

    // claimed: uncapped sum of self-claimed points, grouped by sprint, for this team snapshot.
    const claimedRows = await this.db
      .prepare(
        `SELECT sprint_id AS sid,
                COALESCE(SUM(claimed_points), 0) AS claimed,
                COUNT(DISTINCT rater_account_id) AS raters
         FROM ratings
         WHERE cloud_id = ? AND team_id_at_rating = ?
         GROUP BY sprint_id`,
      )
      .bind(cloudId, teamId)
      .all<{ sid: number | null; claimed: number; raters: number }>();

    // rating coverage: distinct done issue_keys that got >=1 rating, per sprint.
    const ratedKeyRows = await this.db
      .prepare(
        `SELECT sprint_id AS sid, COUNT(DISTINCT issue_key) AS rated
         FROM ratings WHERE cloud_id = ? AND team_id_at_rating = ?
         GROUP BY sprint_id`,
      )
      .bind(cloudId, teamId)
      .all<{ sid: number | null; rated: number }>();

    // done: real Jira sum + distinct done tickets, grouped by sprint, this team.
    const doneRows = await this.db
      .prepare(
        `SELECT sprint_id AS sid,
                COALESCE(SUM(story_points), 0) AS done,
                COUNT(DISTINCT issue_key) AS tickets
         FROM done_events
         WHERE cloud_id = ? AND team_id_at_done = ?
         GROUP BY sprint_id`,
      )
      .bind(cloudId, teamId)
      .all<{ sid: number | null; done: number; tickets: number }>();

    const claimedBy = indexBy(claimedRows.results, (r) => r.sid);
    const ratedBy = indexBy(ratedKeyRows.results, (r) => r.sid);
    const doneBy = indexBy(doneRows.results, (r) => r.sid);

    return sprintRows.results.map((s) => {
      const claimed = claimedBy.get(s.sprint_id)?.claimed ?? 0;
      const raters = claimedBy.get(s.sprint_id)?.raters ?? 0;
      const done = doneBy.get(s.sprint_id)?.done ?? 0;
      const totalDoneTickets = doneBy.get(s.sprint_id)?.tickets ?? 0;
      const ratedDoneTickets = Math.min(ratedBy.get(s.sprint_id)?.rated ?? 0, totalDoneTickets);
      return {
        sprintId: s.sprint_id,
        sprintName: s.name,
        claimedPoints: claimed,
        donePoints: done,
        ratio: computeRatio(claimed, done),
        ratingCoverage: { ratedDoneTickets, totalDoneTickets },
        claimedPerActiveRater: raters === 0 ? null : claimed / raters,
      } satisfies ClaimedVsDone;
    });
  }

  // --- CLAIMED TRENDS (date-bucketed) ----------------------------------------
  // Personal queries are self-scoped (WHERE rater_account_id = ?), the team query
  // is a team-grouped sum with no rater column — the same privacy split as the
  // personal endpoints vs teamSeries(). Bucketed by transitioned_at (when the work
  // was actually done), falling back to rated_at for legacy rows that predate that
  // column; the window filter uses the same COALESCE so a row's inclusion and its
  // bucket agree. Days come back as `YYYY-MM-DD` (UTC, since both timestamps are
  // stored via toISOString); callers fold days into weeks with weekStartOf() so week
  // numbering lives in one tested place.

  /** This account's daily claimed sum over [fromIso, toIso). Self-scoped. */
  async personalClaimedByDay(
    accountId: string,
    cloudId: string,
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ day: string; claimed: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT substr(COALESCE(transitioned_at, rated_at), 1, 10) AS day,
                COALESCE(SUM(claimed_points), 0) AS claimed
         FROM ratings
         WHERE rater_account_id = ? AND cloud_id = ?
           AND COALESCE(transitioned_at, rated_at) >= ? AND COALESCE(transitioned_at, rated_at) < ?
         GROUP BY day ORDER BY day`,
      )
      .bind(accountId, cloudId, fromIso, toIso)
      .all<{ day: string; claimed: number }>();
    return results;
  }

  /** A team's daily claimed sum over [fromIso, toIso). Sums only, no rater column. */
  async teamClaimedByDay(
    cloudId: string,
    teamId: string,
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ day: string; claimed: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT substr(COALESCE(transitioned_at, rated_at), 1, 10) AS day,
                COALESCE(SUM(claimed_points), 0) AS claimed
         FROM ratings
         WHERE team_id_at_rating = ? AND cloud_id = ?
           AND COALESCE(transitioned_at, rated_at) >= ? AND COALESCE(transitioned_at, rated_at) < ?
         GROUP BY day ORDER BY day`,
      )
      .bind(teamId, cloudId, fromIso, toIso)
      .all<{ day: string; claimed: number }>();
    return results;
  }

  /** Current headcount of a team (open memberships). Divisor for the team average. */
  async teamSize(teamId: string): Promise<number> {
    const r = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT account_id) AS n FROM team_memberships
         WHERE team_id = ? AND effective_to IS NULL`,
      )
      .bind(teamId)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }
}

// --- helpers -----------------------------------------------------------------

function mapToken(r: Record<string, unknown>): OAuthTokenRow {
  return {
    accountId: r['account_id'] as string,
    refreshToken: r['refresh_token'] as string,
    accessToken: (r['access_token'] as string | null) ?? null,
    expiresAt: (r['expires_at'] as string | null) ?? null,
  };
}

function mapPending(r: Record<string, unknown>): PendingRow {
  return {
    pendingId: r['pending_id'] as string,
    cloudId: r['cloud_id'] as string,
    accountId: r['account_id'] as string,
    issueKey: r['issue_key'] as string,
    title: r['title'] as string,
    url: r['url'] as string,
    storyPoints: (r['story_points'] as number | null) ?? null,
    toStatus: r['to_status'] as string,
    changelogId: r['changelog_id'] as string,
    transitionedAt: r['transitioned_at'] as string,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function indexBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const r of rows) m.set(key(r), r);
  return m;
}
