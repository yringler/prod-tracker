// API request/response shapes for /api/*. Imported by both client and worker.
import type { ClaimedVsDone, RatingFraction, Role } from './domain';

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
  ratingFraction: RatingFraction;
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
    ratingFraction: RatingFraction;
    storyPointsAtRating: number | null;
    sprintId: number | null;
    ratedAt: string;
  }>;
}

// --- Aggregates (team-grouped, sums only — NO per-account fields ever) --------

export interface TeamAggregateResponse {
  teamId: string;
  teamName: string;
  cloudId: string;
  series: ClaimedVsDone[];
}

export interface AllTeamsAggregateResponse {
  teams: TeamAggregateResponse[];
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

export interface ApiError {
  error: string;
  code?: string;
}
