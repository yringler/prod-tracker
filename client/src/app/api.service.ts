import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AllTeamsAggregateResponse,
  AppointAdminRequest,
  AssignMembershipRequest,
  AuthStartResponse,
  CheckoutSessionResponse,
  ClaimedTrendsResponse,
  ConfigResponse,
  CreateTeamRequest,
  DoneStatusConfigRequest,
  FieldCandidatesResponse,
  MeResponse,
  MyRatingsResponse,
  OrgMembersResponse,
  PendingRatingsResponse,
  PortalSessionResponse,
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

  // --- billing (redirect flows — no card UI) ---
  createCheckout(): Observable<CheckoutSessionResponse> {
    return this.http.post<CheckoutSessionResponse>('/api/billing/checkout', {});
  }
  createPortal(): Observable<PortalSessionResponse> {
    return this.http.post<PortalSessionResponse>('/api/billing/portal', {});
  }

  vapidPublicKey(): Observable<VapidPublicKeyResponse> {
    return this.http.get<VapidPublicKeyResponse>('/api/push/vapid-public-key');
  }
  subscribePush(body: PushSubscriptionRequest): Observable<unknown> {
    return this.http.post('/api/push/subscribe', body);
  }

  // --- admin ---
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
}
