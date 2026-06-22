// Atlassian OAuth 2.0 (3LO), authorization-code flow. ALL of this runs in the
// Worker; the client secret never reaches the browser. Refresh tokens ROTATE —
// every refresh returns a new one that must be persisted, old one discarded.

import type { Env } from '../env';
import { OAUTH_SCOPES } from '../env';

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export function buildAuthorizeUrl(env: Env, state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('audience', 'api.atlassian.com');
  u.searchParams.set('client_id', env.JIRA_CLIENT_ID);
  u.searchParams.set('scope', OAUTH_SCOPES);
  u.searchParams.set('redirect_uri', env.APP_ORIGIN + env.OAUTH_REDIRECT_PATH);
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token expires. */
  expiresAt: string;
}

/** Atlassian flags revoked consent / dead refresh tokens with invalid_grant. */
export class InvalidGrantError extends Error {
  constructor() {
    super('invalid_grant');
    this.name = 'InvalidGrantError';
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  error?: string;
}

export async function exchangeCode(env: Env, code: string): Promise<TokenSet> {
  return tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.APP_ORIGIN + env.OAUTH_REDIRECT_PATH,
  });
}

export async function refresh(env: Env, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function tokenRequest(env: Env, extra: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.JIRA_CLIENT_ID,
      client_secret: env.JIRA_CLIENT_SECRET,
      ...extra,
    }),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || body.error) {
    if (res.status === 400 || res.status === 401 || body.error === 'invalid_grant') {
      throw new InvalidGrantError();
    }
    throw new Error(`token endpoint ${res.status}: ${body.error ?? 'unknown'}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token, // ROTATED — caller must persist this one
    expiresAt: new Date(Date.now() + (body.expires_in - 60) * 1000).toISOString(),
  };
}

export interface AccessibleResource {
  id: string; // cloudId
  name: string;
  url: string;
  scopes: string[];
}

export async function accessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  const res = await fetch(RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`accessible-resources ${res.status}`);
  return (await res.json()) as AccessibleResource[];
}

export interface JiraMe {
  accountId: string;
  displayName?: string;
}

export async function fetchMyself(accessToken: string, cloudId: string): Promise<JiraMe> {
  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`myself ${res.status}`);
  return (await res.json()) as JiraMe;
}
