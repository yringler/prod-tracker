import type { ApiError } from '@shared/contracts';
import type { Dao } from './db/dao';
import type { Env } from './env';

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

/** `extra` carries the optional structured half of `ApiError` (today: `issues`, the
 *  per-rule cutoff findings) so a 400 can say WHICH field was wrong without every
 *  handler hand-rolling a body. Existing 2-and-3-arg callers are unaffected. */
export function error(
  status: number,
  message: string,
  code?: string,
  extra?: Omit<ApiError, 'error' | 'code'>,
): Response {
  const body: ApiError = { error: message, ...(code ? { code } : {}), ...(extra ?? {}) };
  return json(body, { status });
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('Cookie') ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; httpOnly?: boolean; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push('SameSite=Lax');
  parts.push('Secure');
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

/** Authenticated request context. */
export interface AuthedCtx {
  accountId: string;
  /** The site selected for this session; aggregates/teams scope to it. */
  cloudId: string;
  sid: string;
  dao: Dao;
  env: Env;
}

/** Resolution of users.last_active_at: re-stamped at most once per this window,
 *  so activity tracking costs ≤24 writes per user per day, not one per request. */
export const LAST_ACTIVE_RESOLUTION_MS = 60 * 60_000;

export async function authenticate(req: Request, env: Env, dao: Dao): Promise<AuthedCtx | null> {
  const sid = parseCookies(req)['sid'];
  if (!sid) return null;
  const session = await dao.getSession(sid);
  if (!session) return null;
  const nowMs = Date.now();
  const last = session.lastActiveAt ? Date.parse(session.lastActiveAt) : null;
  if (last === null || nowMs - last >= LAST_ACTIVE_RESOLUTION_MS) {
    await dao.touchLastActive(
      session.accountId,
      new Date(nowMs).toISOString(),
      new Date(nowMs - LAST_ACTIVE_RESOLUTION_MS).toISOString(),
    );
  }
  return { accountId: session.accountId, cloudId: session.cloudId, sid, dao, env };
}

/** Operator check: is this account listed in the GLOBAL_ADMIN_ACCOUNT_IDS secret?
 *  Deliberately NOT implied by org admin or BOOTSTRAP_ADMIN_ACCOUNT_ID. */
export function isGlobalAdmin(env: Env, accountId: string): boolean {
  const raw = env.GLOBAL_ADMIN_ACCOUNT_IDS;
  if (!raw) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .includes(accountId);
}

export async function requireAdmin(ctx: AuthedCtx): Promise<boolean> {
  if (ctx.env.BOOTSTRAP_ADMIN_ACCOUNT_ID && ctx.accountId === ctx.env.BOOTSTRAP_ADMIN_ACCOUNT_ID) {
    return true;
  }
  return ctx.dao.isAdmin(ctx.accountId);
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
