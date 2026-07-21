// Scope-drift detection: does the grant we hold actually carry the scopes this
// build needs?
//
// WHY THIS EXISTS. Adding a scope to OAUTH_SCOPES does NOT invalidate existing
// grants. An old refresh token keeps working and keeps minting access tokens
// that carry the OLD scope set — so nothing fails at the OAuth layer, and the
// only symptom is that the newly-scoped API calls 401. `needs_reauth` used to be
// set in exactly one place (jira/client.ts, on InvalidGrantError during refresh),
// and a scope change never produces an `invalid_grant`. Result: after a scope
// change every existing user is silently under-scoped, the risk board's board
// reads throw a plain error, refresh.ts treats it as an ordinary failure and
// backs off, and boards look stale forever with nobody told.
//
// HOW. Atlassian access tokens are JWTs whose payload carries a `scope` claim
// listing exactly what was granted at consent. We decode it (no signature check
// — we are the audience-side reader of a token Atlassian just handed us, and we
// are reading it only to compare against our own required list, never to make an
// authorization decision) and compare. That makes the check observe GROUND TRUTH
// rather than our own bookkeeping.
//
// FAIL-OPEN. Anything we can't parse — opaque token, missing claim, malformed
// base64 — returns "nothing missing". A parse quirk must never lock a working
// user out of the app; the worst case is that we fall back to today's behavior.

import { OAUTH_SCOPE_LIST } from '../env';

/**
 * The scopes a token must carry for this build to work. `offline_access` is an
 * OAuth protocol scope, not an API permission: it governs refresh-token issuance
 * and its presence in the access token's claim is not something to gate on.
 */
export const REQUIRED_TOKEN_SCOPES: readonly string[] = OAUTH_SCOPE_LIST.filter(
  (s) => s !== 'offline_access',
);

function decodeSegment(seg: string): unknown {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
  // atob is available in Workers (and Node >= 16); payloads are ASCII JSON.
  return JSON.parse(atob(pad)) as unknown;
}

/**
 * The `scope` claim of an Atlassian access token, or `null` when the token isn't
 * a readable JWT / carries no scope claim. The claim is space-delimited in the
 * spec; some issuers use an array, so both are accepted.
 */
export function tokenScopes(accessToken: string | null | undefined): Set<string> | null {
  if (!accessToken) return null;
  const parts = accessToken.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  let payload: unknown;
  try {
    payload = decodeSegment(parts[1]);
  } catch {
    return null; // not a JWT, or not base64url JSON — fail open
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as Record<string, unknown>)['scope'];
  if (typeof raw === 'string') {
    const list = raw.split(/\s+/).filter(Boolean);
    return list.length ? new Set(list) : null;
  }
  if (Array.isArray(raw)) {
    const list = raw.filter((s): s is string => typeof s === 'string');
    return list.length ? new Set(list) : null;
  }
  return null;
}

/**
 * Which REQUIRED_TOKEN_SCOPES this access token lacks. Empty when the grant is
 * current — and also empty when the token is unreadable (fail-open, see above),
 * so callers can treat a non-empty result as a definite verdict.
 */
export function missingScopes(accessToken: string | null | undefined): string[] {
  const granted = tokenScopes(accessToken);
  if (granted == null) return [];
  return REQUIRED_TOKEN_SCOPES.filter((s) => !granted.has(s));
}

// `ScopeDriftError` lives in client.ts, not here: it extends ReauthRequiredError
// so every existing caller that already handles a dead grant (the poller's
// per-account skip, pd-report's bearer loop, risk/refresh.ts' markDegraded
// 'needs_reauth') handles scope drift identically, with no new branches and no
// second notification path.
