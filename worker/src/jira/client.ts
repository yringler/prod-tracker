// Authenticated Jira client for one account, scoped to one cloud (site). The
// account's 3LO grant is shared across all its sites, so the rotating refresh
// token lives in a single oauth_tokens row. Before refreshing we RE-READ that row
// — a sibling client (another site, same account) may have already rotated it, in
// which case reusing our stale copy would trip a false invalid_grant.

import type { Dao, OAuthTokenRow } from '../db/dao';
import type { Env } from '../env';
import { InvalidGrantError, refresh } from './oauth';
import { missingScopes } from './scopes';

const API_BASE = 'https://api.atlassian.com/ex/jira';

/** A non-OK Jira response, carrying the status so callers can branch on it (429
 *  backoff, 401/403 scope diagnostics) without matching on the message text. The
 *  message keeps its original shape for existing log lines. */
export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
  ) {
    super(`jira GET ${path} -> ${status}`);
    this.name = 'JiraApiError';
  }
}

export class ReauthRequiredError extends Error {
  constructor(public accountId: string) {
    super(`account ${accountId} needs re-auth`);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * The grant is alive but was consented under an OLDER scope set, so it can never
 * satisfy this build. Deliberately a SUBCLASS of ReauthRequiredError: the remedy
 * is identical (re-authorize), and every caller that already handles a dead grant
 * — the poller's per-account skip, pd-report's bearer loop, risk/refresh.ts'
 * `markDegraded(..., 'needs_reauth')` and the admin notice hanging off it —
 * handles this correctly with no new branch and no second notification path.
 */
export class ScopeDriftError extends ReauthRequiredError {
  constructor(
    accountId: string,
    public readonly missing: string[],
  ) {
    super(accountId);
    this.name = 'ScopeDriftError';
    this.message =
      `account ${accountId} consented an older scope set; missing: ${missing.join(', ')}`;
  }
}

export class JiraClient {
  constructor(
    private readonly env: Env,
    private readonly dao: Dao,
    private token: OAuthTokenRow,
    public readonly cloudId: string,
  ) {}

  /** Memoized scope verdict, keyed by the exact token string it was computed
   *  from — so the JWT decode and (at most one) DB write happen once per token,
   *  not once per Jira call. */
  private scopeVerdict: { token: string; missing: string[] } | null = null;

  private isFresh(t: OAuthTokenRow): boolean {
    return !!(t.accessToken && t.expiresAt && Date.parse(t.expiresAt) > Date.now());
  }

  /**
   * Scope-drift gate. A grant minted before a scope was added keeps refreshing
   * happily and keeps minting tokens carrying the OLD scope set — no
   * `invalid_grant`, so nothing else in the app would ever notice; the new calls
   * would just 401 forever (see jira/scopes.ts for the full story).
   *
   * So the moment we hold a token we can read, we compare its `scope` claim
   * against what this build requires and, if it's short, flag `needs_reauth` (the
   * flag `/api/me` already surfaces as the "Re-connect Jira" prompt) and throw
   * ScopeDriftError — a ReauthRequiredError, so every existing dead-grant path
   * handles it unchanged.
   *
   * Anti-spam: the verdict is memoized per token string, and the DB write only
   * happens the first time a given token is judged short. Unreadable tokens
   * fail open (missingScopes returns []).
   */
  private async assertScopes(accessToken: string): Promise<void> {
    if (this.scopeVerdict?.token === accessToken) {
      if (this.scopeVerdict.missing.length) {
        throw new ScopeDriftError(this.token.accountId, this.scopeVerdict.missing);
      }
      return;
    }
    const missing = missingScopes(accessToken);
    this.scopeVerdict = { token: accessToken, missing };
    if (missing.length === 0) return;
    await this.dao.setNeedsReauth(this.token.accountId, true);
    throw new ScopeDriftError(this.token.accountId, missing);
  }

  /**
   * Mint a valid bearer token for this account, refreshing (and persisting the
   * rotated refresh token) if needed. The token is account-scoped, not
   * cloud-scoped, so callers that only need a token — e.g. the GDPR
   * report-accounts cron — may construct a client with any (or empty) cloudId.
   */
  async bearer(): Promise<string> {
    return this.accessToken();
  }

  /** Mint, then gate on scope drift. Every path that produces a bearer goes
   *  through here, so there is exactly one place the check can be missed. */
  private async accessToken(): Promise<string> {
    const at = await this.mintAccessToken();
    await this.assertScopes(at);
    return at;
  }

  private async mintAccessToken(): Promise<string> {
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
      if (!res2.ok) throw new JiraApiError(res2.status, path);
      return (await res2.json()) as T;
    }
    if (!res.ok) throw new JiraApiError(res.status, path);
    return (await res.json()) as T;
  }
}
