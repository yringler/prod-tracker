import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AllTeamsAggregateResponse,
  AppointAdminRequest,
  AssignMembershipRequest,
  AuthStartResponse,
  ClaimedTrendsResponse,
  ConfigResponse,
  CreateTeamRequest,
  DoneStatusConfigRequest,
  FieldCandidatesResponse,
  MeResponse,
  MyRatingsResponse,
  OrgMembersResponse,
  PendingRatingsResponse,
  PushSubscriptionRequest,
  SetFieldsRequest,
  SubmitRatingRequest,
  SubmitRatingResponse,
  SwitchSiteRequest,
  Team,
  UpdateMySettingsRequest,
  TeamMembership,
  VapidPublicKeyResponse,
} from '@shared/contracts';
import type {
  AdminChannelConfigResponse,
  BeginSetupResponse,
  ChannelListResponse,
  ConfigureChannelRequest,
  LinkStatus,
  SetupSubmission,
} from '@shared/notifications';
import type {
  PutRiskAlertPrefsRequest,
  PutRiskConfigRequest,
  RiskAdminConfigResponse,
  RiskAlertPrefs,
  RiskBoardCandidatesResponse,
  RiskBoardResponse,
  RiskColumnsResponse,
  RiskBoardsResponse,
  RiskFieldCandidatesResponse,
  RiskPreviewRequest,
  RiskPreviewResponse,
} from '@shared/risk';

// Typed client for /api/*. Same-origin — the browser NEVER talks to Jira (no
// CORS path, no client secret in the bundle); everything goes through the Worker.
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  me(): Observable<MeResponse> {
    return this.http.get<MeResponse>('/api/me');
  }
  switchSite(cloudId: string): Observable<unknown> {
    return this.http.post('/api/session/site', { cloudId } satisfies SwitchSiteRequest);
  }
  authStart(): Observable<AuthStartResponse> {
    return this.http.get<AuthStartResponse>('/api/auth/start');
  }
  logout(): Observable<unknown> {
    return this.http.post('/api/auth/logout', {});
  }

  pending(): Observable<PendingRatingsResponse> {
    return this.http.get<PendingRatingsResponse>('/api/pending');
  }
  clearPending(): Observable<unknown> {
    return this.http.delete('/api/pending');
  }
  // Dev-only: ask the worker to inject a made-up pending prompt (route 404s in prod).
  seedDevPending(): Observable<unknown> {
    return this.http.post('/api/__dev/pending', {});
  }
  submitRating(body: SubmitRatingRequest): Observable<SubmitRatingResponse> {
    return this.http.post<SubmitRatingResponse>('/api/ratings', body);
  }
  myRatings(): Observable<MyRatingsResponse> {
    return this.http.get<MyRatingsResponse>('/api/me/ratings');
  }
  claimedTrends(): Observable<ClaimedTrendsResponse> {
    return this.http.get<ClaimedTrendsResponse>('/api/me/claimed-trends');
  }
  updateSettings(body: UpdateMySettingsRequest): Observable<unknown> {
    return this.http.put('/api/me/settings', body);
  }

  aggregates(): Observable<AllTeamsAggregateResponse> {
    return this.http.get<AllTeamsAggregateResponse>('/api/aggregates');
  }
  teams(): Observable<{ teams: Team[] }> {
    return this.http.get<{ teams: Team[] }>('/api/teams');
  }

  vapidPublicKey(): Observable<VapidPublicKeyResponse> {
    return this.http.get<VapidPublicKeyResponse>('/api/push/vapid-public-key');
  }
  subscribePush(body: PushSubscriptionRequest): Observable<unknown> {
    return this.http.post('/api/push/subscribe', body);
  }

  // --- notification channels (self-describing, vendor-agnostic) ---
  notificationChannels(): Observable<ChannelListResponse> {
    return this.http.get<ChannelListResponse>('/api/notifications/channels');
  }
  beginChannelSetup(channel: string): Observable<BeginSetupResponse> {
    return this.http.post<BeginSetupResponse>(
      `/api/notifications/${encodeURIComponent(channel)}/setup`,
      {},
    );
  }
  completeChannelSetup(channel: string, fields: Record<string, string>): Observable<LinkStatus> {
    return this.http.post<LinkStatus>(
      `/api/notifications/${encodeURIComponent(channel)}/complete`,
      { fields } satisfies SetupSubmission,
    );
  }
  channelStatus(channel: string): Observable<LinkStatus> {
    return this.http.get<LinkStatus>(`/api/notifications/${encodeURIComponent(channel)}/status`);
  }
  unlinkChannel(channel: string): Observable<unknown> {
    return this.http.delete(`/api/notifications/${encodeURIComponent(channel)}`);
  }

  // --- admin ---
  // Per-org notification-channel config (write-only secrets: the list returns
  // only descriptors + a configured flag, never stored values).
  adminChannelConfigs(): Observable<AdminChannelConfigResponse> {
    return this.http.get<AdminChannelConfigResponse>('/api/admin/notifications/channels');
  }
  configureChannel(channel: string, fields: Record<string, string>): Observable<unknown> {
    return this.http.put(
      `/api/admin/notifications/${encodeURIComponent(channel)}/config`,
      { fields } satisfies ConfigureChannelRequest,
    );
  }
  createTeam(body: CreateTeamRequest): Observable<Team> {
    return this.http.post<Team>('/api/admin/teams', body);
  }
  orgMembers(): Observable<OrgMembersResponse> {
    return this.http.get<OrgMembersResponse>('/api/admin/users');
  }
  memberships(teamId: string): Observable<{ members: TeamMembership[] }> {
    return this.http.get<{ members: TeamMembership[] }>(
      `/api/admin/teams/${encodeURIComponent(teamId)}/memberships`,
    );
  }
  assignMembership(body: AssignMembershipRequest): Observable<unknown> {
    return this.http.post('/api/admin/memberships', body);
  }
  appointAdmin(body: AppointAdminRequest): Observable<unknown> {
    return this.http.post('/api/admin/admins', body);
  }
  revokeAdmin(accountId: string): Observable<unknown> {
    return this.http.delete(`/api/admin/admins/${encodeURIComponent(accountId)}`);
  }
  adminConfig(): Observable<ConfigResponse> {
    return this.http.get<ConfigResponse>('/api/admin/config');
  }
  setDoneStatuses(body: DoneStatusConfigRequest): Observable<unknown> {
    return this.http.put('/api/admin/config/done-statuses', body);
  }
  adminFields(): Observable<FieldCandidatesResponse> {
    return this.http.get<FieldCandidatesResponse>('/api/admin/fields');
  }
  setFields(body: SetFieldsRequest): Observable<unknown> {
    return this.http.put('/api/admin/config/fields', body);
  }

  // --- risk board (delete with client/src/app/risk) ---
  riskBoards(): Observable<RiskBoardsResponse> {
    return this.http.get<RiskBoardsResponse>('/api/risk/boards');
  }
  riskBoard(boardId: number): Observable<RiskBoardResponse> {
    return this.http.get<RiskBoardResponse>(`/api/risk/board/${boardId}`);
  }
  // Dev-only: the cron that computes snapshots doesn't tick under `wrangler dev`
  // (route 404s in prod).
  refreshRiskDev(): Observable<unknown> {
    return this.http.post('/api/__dev/risk/refresh', {});
  }
  adminRiskConfig(): Observable<RiskAdminConfigResponse> {
    return this.http.get<RiskAdminConfigResponse>('/api/admin/risk/config');
  }
  putRiskConfig(body: PutRiskConfigRequest): Observable<unknown> {
    return this.http.put('/api/admin/risk/config', body);
  }
  /** `probe` also runs the board-configuration scope probe against that board. */
  adminRiskBoards(probe?: number): Observable<RiskBoardCandidatesResponse> {
    const q = probe == null ? '' : `?probe=${probe}`;
    return this.http.get<RiskBoardCandidatesResponse>(`/api/admin/risk/boards${q}`);
  }
  /** Per-board column vocabulary for the cutoffs editor. Served from the stored
   *  snapshots where possible, so this is normally free of Jira calls. */
  adminRiskColumns(): Observable<RiskColumnsResponse> {
    return this.http.get<RiskColumnsResponse>('/api/admin/risk/columns');
  }
  /** "What would these thresholds do to the boards?" — the server re-scores the
   *  STORED snapshots with the same scorer the cron uses, so this costs no Jira
   *  calls and cannot drift from what the next refresh will do. Debounce it; it is
   *  a POST because the whole candidate config is the query. */
  adminRiskPreview(body: RiskPreviewRequest): Observable<RiskPreviewResponse> {
    return this.http.post<RiskPreviewResponse>('/api/admin/risk/preview', body);
  }
  adminRiskFields(): Observable<RiskFieldCandidatesResponse> {
    return this.http.get<RiskFieldCandidatesResponse>('/api/admin/risk/fields');
  }
  /** The caller's own opt-out from struggling-ticket health nudges. */
  riskAlertPrefs(): Observable<RiskAlertPrefs> {
    return this.http.get<RiskAlertPrefs>('/api/risk/alerts/prefs');
  }
  putRiskAlertPrefs(body: PutRiskAlertPrefsRequest): Observable<RiskAlertPrefs> {
    return this.http.put<RiskAlertPrefs>('/api/risk/alerts/prefs', body);
  }
}
