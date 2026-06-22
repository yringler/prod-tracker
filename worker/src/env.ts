import type { D1Like } from './db/driver';

/** Cloudflare bindings + secrets + vars. Secrets are set via `wrangler secret put`. */
export interface Env {
  DB: D1Like;
  ASSETS: { fetch(req: Request): Promise<Response> };

  // vars (wrangler.toml [vars])
  APP_ORIGIN: string;
  OAUTH_REDIRECT_PATH: string;
  VAPID_SUBJECT: string;
  BOOTSTRAP_ADMIN_ACCOUNT_ID: string;

  // secrets
  JIRA_CLIENT_ID: string;
  JIRA_CLIENT_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

// Requested at consent (the /authorize URL). Kept minimal — see README
// "Atlassian app setup" for the per-endpoint rationale. `offline_access` is a
// standard OAuth scope (not a Jira console permission) and yields the refresh
// token. `read:board-scope:jira-software` is documented to cover reading sprints
// too; add `read:sprint:jira-software` only if sprint reads 401.
export const OAUTH_SCOPES = [
  'read:jira-user',
  'read:jira-work',
  'read:board-scope:jira-software',
  'offline_access',
].join(' ');
