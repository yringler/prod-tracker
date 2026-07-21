// The risk feature's ONLY crossing of the notification seam. It composes a
// channel-neutral NotificationPayload and reaches channels exclusively through
// `registry.resolve()` — it never imports an adapter and never builds a
// vendor-shaped string (the same rule cron/escalate.ts follows; eslint-enforced
// for worker/src/risk/** in .eslintrc.cjs).
//
// Why this exists: a board whose refresher revoked consent, left, or was erased is
// marked `degraded_reason = 'needs_reauth'`, which until now was only a badge on
// /risk — visible to whoever happened to open the page, and to no admin. Meanwhile
// a needs_reauth org self-heals only when the refresher's grant comes back
// (refresh.ts) or an admin re-designates. So we push one message per degraded
// EPISODE per ORG to the admins who can actually fix it, and one when it recovers.
//
// Dedup lives in two columns on risk_board_config, claimed with the
// claim-before-send CAS in store.ts (store.claimDegradedNotice) — per org, not per
// board, so a 5-board org gets one message rather than five.

import type { RiskDegradedReason } from '@shared/risk';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import { errFields, type Logger } from '../log';
import type { NotificationPayload } from '../notifications/contract';
import { resolve } from '../notifications/registry';
import {
  claimDegradedNotice,
  clearDegradedNotice,
  type RiskBoardState,
  type RiskOrgConfig,
} from './store';

/** While a degradation persists, re-tell the admins at most this often. */
export const DEGRADED_RENOTIFY_MS = 24 * 60 * 60_000;
/** Ceiling on how many admins one notice fans out to. */
export const MAX_NOTIFIED_ADMINS = 10;

/**
 * Pure policy: notify on a new episode, on a change of reason (needs_reauth <->
 * errors is a materially different fix), or once a day while it persists.
 */
export function mayNotifyDegraded(
  prevAtIso: string | null,
  prevReason: RiskDegradedReason | null,
  reason: RiskDegradedReason,
  nowMs: number,
): boolean {
  if (prevAtIso == null) return true; // new episode
  if (prevReason !== reason) return true; // the fix changed
  const prevMs = Date.parse(prevAtIso);
  if (Number.isNaN(prevMs)) return true; // unreadable stamp: treat as new
  return nowMs - prevMs >= DEGRADED_RENOTIFY_MS;
}

/**
 * Pure: the org's worst open degradation across its boards — `needs_reauth`
 * (nothing retries until a human acts) outranks `errors`. Null when every board
 * is healthy, which is what closes an episode.
 */
export function worstDegraded(
  states: Array<RiskBoardState | null>,
): RiskDegradedReason | null {
  let worst: RiskDegradedReason | null = null;
  for (const s of states) {
    const r = s?.degradedReason ?? null;
    if (r === 'needs_reauth') return 'needs_reauth';
    if (r === 'errors') worst = 'errors';
  }
  return worst;
}

/**
 * The admins who can actually fix THIS org: `admins` is global (no cloud_id), so
 * the only available org scoping is the intersection with the org's members —
 * exactly how every other admin surface scopes. Capped, with
 * BOOTSTRAP_ADMIN_ACCOUNT_ID as the last resort when the intersection is empty
 * (e.g. the bootstrap admin never switched to that site). Composed from existing
 * DAO methods on purpose: dao.ts stays out of this feature's diff.
 */
export async function orgAdmins(env: Env, dao: Dao, cloudId: string): Promise<string[]> {
  const members = await dao.listOrgMembers(cloudId);
  const out: string[] = [];
  for (const m of members) {
    if (out.length >= MAX_NOTIFIED_ADMINS) break;
    if (await dao.isAdmin(m.accountId)) out.push(m.accountId);
  }
  if (out.length === 0 && env.BOOTSTRAP_ADMIN_ACCOUNT_ID) return [env.BOOTSTRAP_ADMIN_ACCOUNT_ID];
  return out;
}

function degradedPayload(
  env: Env,
  reason: RiskDegradedReason,
  boards: number,
): NotificationPayload {
  const deepLink = `${env.APP_ORIGIN}/risk/admin`;
  const plural = boards === 1 ? 'board' : 'boards';
  if (reason === 'needs_reauth') {
    return {
      title: 'Sprint Risk Board has stopped updating',
      body:
        `The designated refresher account can no longer reach Jira, so this org's ` +
        `${boards} risk ${plural} are frozen. Re-designate a refresher (or have the ` +
        `current one sign in again) to resume updates.`,
      deepLink,
      urgency: 'high',
    };
  }
  return {
    title: 'Sprint Risk Board refresh is failing',
    body:
      `Refreshes for this org's risk ${plural} have failed repeatedly, so the shown ` +
      `data is going stale. Check the board configuration.`,
    deepLink,
    urgency: 'normal',
  };
}

function recoveryPayload(env: Env): NotificationPayload {
  return {
    title: 'Sprint Risk Board is updating again',
    body: 'The refresh problem cleared itself — this org’s risk boards are current again.',
    deepLink: `${env.APP_ORIGIN}/risk/admin`,
    urgency: 'normal',
  };
}

/**
 * Deliver one payload to one account across its linked channels: first success
 * wins, an unlinked channel falls through to the next, and nothing here throws
 * past the caller. Returns whether any channel accepted the message. Shared by
 * both crossings of the notification seam in this slice — the degraded/recovery
 * notice (below) and the Phase-2 health nudge (alerts.ts). registry.resolve() only.
 */
export async function deliverToAccount(
  env: Env,
  dao: Dao,
  accountId: string,
  payload: NotificationPayload,
  idempotencyKey: string,
  log: Logger,
): Promise<boolean> {
  const channels = await dao.getUserChannels(accountId);
  for (const { channel } of channels) {
    const adapter = resolve(env, channel);
    if (!adapter) {
      log.warn('risk: unknown channel (config drift)', { channel });
      continue;
    }
    try {
      const r = await adapter.deliver({ userId: accountId, payload, idempotencyKey });
      if (r.status === 'delivered') return true; // stop at the first success
      if (r.status === 'not_linked') continue; // try the next channel
      log.warn('risk: notice delivery failed', { channel, retryable: r.retryable });
    } catch (e) {
      log.warn('risk: notice adapter threw', { channel, ...errFields(e) });
    }
  }
  return false;
}

/** Fan out to each admin's linked channels (see deliverToAccount). */
async function deliverToAdmins(
  env: Env,
  dao: Dao,
  admins: string[],
  payload: NotificationPayload,
  idempotencyKey: string,
  log: Logger,
): Promise<void> {
  for (const accountId of admins) {
    await deliverToAccount(env, dao, accountId, payload, idempotencyKey, log);
  }
}

/**
 * One org's notice pass: tell the admins it broke, tell them it recovered, or do
 * nothing. Called from the refresh cron's CONFIG loop, not from refreshOrg —
 * a needs_reauth org is (by design) not always eligible for refresh, and an erased
 * refresher's org never is, so hanging this off refreshOrg would mean the message
 * that matters most is the one that never fires.
 */
export async function noticeDegradation(
  env: Env,
  dao: Dao,
  cfg: RiskOrgConfig,
  states: Array<RiskBoardState | null>,
  log: Logger,
  nowMs: number,
): Promise<void> {
  const reason = worstDegraded(states);
  const atIso = new Date(nowMs).toISOString();

  if (reason == null) {
    const prevAtIso = cfg.degradedNotifiedAt;
    if (prevAtIso == null) return; // healthy and nothing was ever announced
    // Read the admins BEFORE the CAS (below): if this read throws, the stamp is
    // untouched and the next tick retries cleanly instead of silently swallowing
    // the recovery — the same ordering, for the same reason, as cron/escalate.ts.
    const admins = await orgAdmins(env, dao, cfg.cloudId);
    if (!(await clearDegradedNotice(env, cfg.cloudId, prevAtIso))) return;
    await deliverToAdmins(
      env,
      dao,
      admins,
      recoveryPayload(env),
      `risk-recovered:${cfg.cloudId}:${prevAtIso}`,
      log,
    );
    log.info('risk: degraded-notice cleared', { cloudId: cfg.cloudId, admins: admins.length });
    return;
  }

  if (!mayNotifyDegraded(cfg.degradedNotifiedAt, cfg.degradedNotifiedReason, reason, nowMs)) {
    return;
  }
  // Same ordering rule as above: the throwing read happens before the claim.
  const admins = await orgAdmins(env, dao, cfg.cloudId);
  if (!(await claimDegradedNotice(env, cfg.cloudId, reason, cfg.degradedNotifiedAt, atIso))) {
    return;
  }
  // Claimed regardless of whether any admin actually resolves to a channel: an org
  // with zero linked admins must not re-attempt this on every 3-minute tick.
  await deliverToAdmins(
    env,
    dao,
    admins,
    degradedPayload(env, reason, cfg.boards.length),
    `risk-degraded:${cfg.cloudId}:${reason}:${atIso}`,
    log,
  );
  log.warn('risk: boards degraded; admins notified', {
    cloudId: cfg.cloudId,
    reason,
    admins: admins.length,
  });
}
