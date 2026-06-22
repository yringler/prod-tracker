// Authenticated Jira client for one account, scoped to one cloud (site). The
// account's 3LO grant is shared across all its sites, so the rotating refresh
// token lives in a single oauth_tokens row. Before refreshing we RE-READ that row
// — a sibling client (another site, same account) may have already rotated it, in
// which case reusing our stale copy would trip a false invalid_grant.

import type { Dao, OAuthTokenRow } from '../db/dao';
import type { Env } from '../env';
import { InvalidGrantError, refresh } from './oauth';

const API_BASE = 'https://api.atlassian.com/ex/jira';

export class ReauthRequiredError extends Error {
  constructor(public accountId: string) {
    super(`account ${accountId} needs re-auth`);
    this.name = 'ReauthRequiredError';
  }
}

export class JiraClient {
  constructor(
    private readonly env: Env,
    private readonly dao: Dao,
    private token: OAuthTokenRow,
    public readonly cloudId: string,
  ) {}

  private isFresh(t: OAuthTokenRow): boolean {
    return !!(t.accessToken && t.expiresAt && Date.parse(t.expiresAt) > Date.now());
  }

  private async accessToken(): Promise<string> {
    if (this.isFresh(this.token)) return this.token.accessToken as string;

    // Re-read: a sibling client may already hold a valid, freshly-rotated token.
    const latest = await this.dao.getToken(this.token.accountId);
    if (latest && this.isFresh(latest)) {
      this.token = latest;
      return latest.accessToken as string;
    }

    try {
      const t = await refresh(this.env, (latest ?? this.token).refreshToken);
      // Persist the rotated refresh token immediately; discard the old one.
      const updated: OAuthTokenRow = {
        accountId: this.token.accountId,
        refreshToken: t.refreshToken,
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
      };
      await this.dao.upsertToken(updated);
      this.token = updated;
      return t.accessToken;
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        await this.dao.setNeedsReauth(this.token.accountId, true);
        throw new ReauthRequiredError(this.token.accountId);
      }
      throw e;
    }
  }

  /** GET an absolute Jira REST/Agile path (e.g. `/rest/api/3/field`). */
  async get<T>(path: string): Promise<T> {
    const at = await this.accessToken();
    const res = await fetch(`${API_BASE}/${this.cloudId}${path}`, {
      headers: { Authorization: `Bearer ${at}`, Accept: 'application/json' },
    });
    if (res.status === 401) {
      // Access token rejected mid-flight: force one refresh + retry.
      this.token = { ...this.token, accessToken: null, expiresAt: null };
      const at2 = await this.accessToken();
      const res2 = await fetch(`${API_BASE}/${this.cloudId}${path}`, {
        headers: { Authorization: `Bearer ${at2}`, Accept: 'application/json' },
      });
      if (!res2.ok) throw new Error(`jira GET ${path} -> ${res2.status}`);
      return (await res2.json()) as T;
    }
    if (!res.ok) throw new Error(`jira GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
}
