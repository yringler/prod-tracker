// API request/response shapes for /api/*. Imported by both client and worker.
import type { ClaimedVsDone, Role } from './domain';

// --- Auth / identity ---------------------------------------------------------

export interface SiteRef {
  cloudId: string;
  name: string;
  url: string;
}

export interface MeResponse {
  accountId: string;
  displayName: string;
  /** The currently-selected site. Aggregates/teams are scoped to this cloud. */
  cloudId: string;
  /** Every site this account's token can reach — the site-picker options. */
  sites: SiteRef[];
  role: Role;
  needsReauth: boolean;
}

export interface SwitchSiteRequest {
  cloudId: string;
}

export interface SitesResponse {
  sites: SiteRef[];
  currentCloudId: string;
}

export interface AuthStartResponse {
  /** Atlassian consent URL the client redirects to. */
  authorizeUrl: string;
}

// --- Pending ratings (personal) ----------------------------------------------

export interface PendingRating {
  /** issue_state-derived: one pending per unseen status transition. */
  pendingId: string;
  issueKey: string;
  title: string;
  /** Deep link into Jira. */
  url: string;
  storyPoints: number | null;
  toStatus: string;
  transitionedAt: string;
}

export interface PendingRatingsResponse {
  items: PendingRating[];
}

export interface SubmitRatingRequest {
  pendingId: string;
  issueKey: string;
  /** Absolute points the rater claims — the UI's chosen Fibonacci/custom point value. */
  claimedPoints: number;
  /** Optional free-text diary note about the work. Trimmed; empty is treated as absent. */
  notes?: string;
}

export interface SubmitRatingResponse {
  id: string;
  storyPointsAtRating: number | null;
  sprintId: number | null;
  teamIdAtRating: string | null;
}

/** Personal history — hard-scoped to req.user.accountId, never another account. */
export interface MyRatingsResponse {
  ratings: Array<{
    id: string;
    issueKey: string;
    claimedPoints: number;
    storyPointsAtRating: number | null;
    sprintId: number | null;
    /** When the claim was submitted. */
    ratedAt: string;
    /**
     * The Jira transition time the work was done — what day/week groupings bucket
     * on. Null for rows predating this field; fall back to ratedAt for grouping.
     */
    transitionedAt: string | null;
    /** Snapshot of the issue title at rating time. Null for rows predating this field. */
    title: string | null;
    /** Snapshot of the Jira deep-link at rating time. Null for rows predating this field. */
    url: string | null;
    /** Optional free-text diary note the rater wrote when claiming. */
    notes: string | null;
  }>;
}

// --- Aggregates (team-grouped, sums only — NO per-account fields ever) --------

export interface TeamAggregateResponse {
  teamId: string;
  teamName: string;
  cloudId: string;
  series: ClaimedVsDone[];
  /**
   * True when the team has fewer than `MIN_TEAM_SIZE` current members. In that
   * case `series` is `[]` and no aggregate figures (sums, ratio, coverage,
   * averages) are returned — a tiny team's aggregate is too close to an
   * individual's numbers to be private.
   */
  belowMinSize: boolean;
}

export interface AllTeamsAggregateResponse {
  teams: TeamAggregateResponse[];
}

/** One point on a claimed-trend line. `date` is a `YYYY-MM-DD` day or week-start (Monday). */
export interface TrendPoint {
  date: string;
  value: number;
}

/**
 * Personal-vs-team claimed-points trends for the signed-in user. Personal lines
 * are hard-scoped to the caller; team lines are a team-grouped sum ÷ team size
 * (no per-account breakdown), exposed only weekly. Team lines are empty when the
 * caller is on no team.
 */
export interface ClaimedTrendsResponse {
  teamId: string | null;
  teamName: string | null;
  /**
   * True when the caller is on a team but it has fewer than `MIN_TEAM_SIZE`
   * members. Distinguishes "no team" from "team too small" — both leave the
   * `teamWeekly` lines empty, but only the latter is worth explaining in the UI.
   */
  teamBelowMinSize: boolean;
  /** Personal = that day's claimed sum; team = avg per person per day, weekly (week's sum ÷ size ÷ 7). */
  last30Days: { personalDaily: TrendPoint[]; teamWeekly: TrendPoint[] };
  /** Both lines are per-day averages within the week (week's sum ÷ 7, team also ÷ size). */
  last6Months: { personalWeekly: TrendPoint[]; teamWeekly: TrendPoint[] };
}

// --- Web Push ----------------------------------------------------------------

export interface PushSubscriptionRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidPublicKeyResponse {
  publicKey: string;
}

// --- Admin -------------------------------------------------------------------

export interface Team {
  teamId: string;
  cloudId: string;
  name: string;
}

export interface TeamMembership {
  accountId: string;
  displayName: string;
  teamId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** A person in the admin's current org (cloudId), for member-picker dropdowns. */
export interface OrgMember {
  accountId: string;
  displayName: string;
}

export interface OrgMembersResponse {
  members: OrgMember[];
}

export interface CreateTeamRequest {
  cloudId: string;
  name: string;
}

export interface AssignMembershipRequest {
  accountId: string;
  teamId: string;
  /** Defaults to now if omitted; prior open membership is closed at this instant. */
  effectiveFrom?: string;
}

export interface AppointAdminRequest {
  accountId: string;
}

export interface DoneStatusConfigRequest {
  cloudId: string;
  doneStatusNames: string[];
}

export interface ConfigResponse {
  cloudId: string;
  storyPointsFieldId: string | null;
  sprintFieldId: string | null;
  doneStatusNames: string[];
}

/** A Jira custom field the admin can pick (id + human-readable name). */
export interface FieldOption {
  id: string;
  name: string;
}

/** Candidate Story Points / Sprint fields for the admin picker, plus the
 *  currently-configured ids so the UI can pre-select them. */
export interface FieldCandidatesResponse {
  storyPoints: FieldOption[];
  sprint: FieldOption[];
  current: {
    storyPointsFieldId: string | null;
    sprintFieldId: string | null;
  };
}

export interface SetFieldsRequest {
  cloudId: string;
  storyPointsFieldId: string;
  sprintFieldId: string;
}

export interface ApiError {
  error: string;
  code?: string;
}
