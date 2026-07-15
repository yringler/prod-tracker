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
  ZULIP_SITE: string; // e.g. https://yourorg.zulipchat.com
  ZULIP_BOT_EMAIL: string; // e.g. notify-bot@yourorg.zulipchat.com

  // secrets
  JIRA_CLIENT_ID: string;
  JIRA_CLIENT_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  ZULIP_API_KEY: string; // bot API key — Basic auth for POST /api/v1/messages
  ZULIP_WEBHOOK_TOKEN: string; // shared secret verified on the inbound webhook
}

// Requested at consent (the /authorize URL). See README "Atlassian app setup"
// for the per-endpoint rationale. `offline_access` is a standard OAuth scope
// (not a Jira console permission) and yields the refresh token.
//
// The Agile API (`/rest/agile/...`) does NOT honor the classic `read:jira-work`
// scope — it requires GRANULAR scopes, and `GET /rest/agile/1.0/board` needs
// BOTH `read:board-scope:jira-software` AND the granular Jira *platform* scope
// `read:project:jira`. Requesting only the `-software` granular scope (as we did
// originally) leaves the token without `read:project:jira`, so board/sprint
// reads 401 even though the classic platform scopes work. `read:sprint:jira-software`
// covers sprint reads. All of these must also be ticked in the console; scopes
// are frozen at consent, so changing this requires a re-authorize.
export const OAUTH_SCOPES = [
  'read:jira-user',
  'read:jira-work',
  'read:project:jira',
  'read:board-scope:jira-software',
  'read:sprint:jira-software',
  'offline_access',
].join(' ');
