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
  EMAIL_FROM: string; // From: address for escalation emails, e.g. notify@yourorg.com

  // secrets
  JIRA_CLIENT_ID: string;
  JIRA_CLIENT_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  // base64(32 random bytes) — AES-256-GCM master key for per-org adapter secrets
  // stored in D1 (notifications/secretbox.ts). Zulip credentials are admin-entered
  // per org (Admin → Notification channels), not env config.
  SECRETS_KEY: string;
  EMAIL_API_KEY: string; // transport API key (Resend/MailChannels-style) for sends
}

// Requested at consent (the /authorize URL). See README "Atlassian app setup"
// for the per-endpoint rationale. `offline_access` is a standard OAuth scope
// (not a Jira console permission) and yields the refresh token.
//
// JIRA SOFTWARE SUPPORTS NO CLASSIC SCOPES AT ALL. `read:jira-work` grants
// exactly nothing on `/rest/agile/...`; every Software operation needs granular
// scopes, and the *platform*-granular scopes those operations additionally
// require must appear LITERALLY even when the classic `read:jira-work` is
// present. Verified per-endpoint against Atlassian's live OpenAPI specs and by
// probing a real site:
//
//   /rest/agile/1.0/board (list)            board-scope
//   /rest/agile/1.0/board/{id}/sprint       board-scope + sprint
//   /rest/agile/1.0/board/{id}              board-scope + read:issue-details:jira
//   /rest/agile/1.0/board/{id}/issue        board-scope + read:issue-details:jira
//   /rest/agile/1.0/board/{id}/configuration
//                                    read:board-scope.admin:jira-software
//                                          + read:project:jira
//   /rest/agile/1.0/board/{id}/sprint/{sid}/issue
//                                    sprint + read:issue-details:jira + read:jql:jira
//
// NOTE `read:board-scope.admin:jira-software` is a SEPARATE scope from
// `read:board-scope:jira-software`, not a superset — the risk board's
// configuration read needs both listed. All of these must ALSO be ticked on the
// app in the developer console; listing them here only affects the consent URL.
// Scopes are frozen at consent, so changing this list requires every existing
// user to re-authorize (jira/scopes.ts detects an under-scoped grant and drives
// them there).
export const OAUTH_SCOPE_LIST = [
  'read:jira-user',
  'read:jira-work',
  'read:project:jira',
  'read:issue-details:jira',
  'read:jql:jira',
  'read:board-scope:jira-software',
  'read:board-scope.admin:jira-software',
  'read:sprint:jira-software',
  'offline_access',
] as const;

export const OAUTH_SCOPES = OAUTH_SCOPE_LIST.join(' ');
