// All risk-board persistence. This is the ONLY module that touches the risk_*
// tables, and it does so via env.DB — never through the app's dao. Same boundary
// the notification adapters keep (see adapters/zulip/store.ts): a feature owns its
// tables, so deleting the feature is `rm -rf` + a DROP TABLE migration, and the
// privacy-invariant file (db/dao.ts) never enters this feature's diff.
//
// Nothing stored here is secret — board ids, cutoff tables, a refresher account id
// — so unlike the Zulip config there is no encryption. Every row is org-scoped by
// cloud_id.

import type {
  RiskBoardRef,
  RiskBoardSnapshot,
  RiskCompositeConfig,
  RiskCutoffs,
  RiskDegradedReason,
  RiskFieldIds,
  RiskWorkSchedule,
} from '@shared/risk';
import { runChanges } from '../db/driver';
import type { Env } from '../env';

/** Consecutive failed refreshes before a board is reported as degraded. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export interface RiskOrgConfig {
  cloudId: string;
  boards: RiskBoardRef[];
  cutoffs: RiskCutoffs | null;
  composite: RiskCompositeConfig | null;
  schedule: RiskWorkSchedule | null;
  fields: RiskFieldIds;
  inProgressStatus: string | null;
  devStatusAvailable: boolean | null;
  refresherAccountId: string | null;
  configuredBy: string | null;
  updatedAt: string;
  /** Degraded-notice CAS state (see claimDegradedNotice): when the org's admins
   *  were last told its boards stopped updating, and about what. NULL = no open
   *  episode. Per ORG, so a 5-board org sends one message, not five. */
  degradedNotifiedAt: string | null;
  degradedNotifiedReason: RiskDegradedReason | null;
}

/** The writable half of a config row: updatedAt is stamped here, and the two
 *  degraded-notice columns are owned exclusively by the CAS helpers below (an
 *  admin re-saving the config must not wipe an open episode). */
export type RiskOrgConfigInput = Omit<
  RiskOrgConfig,
  'updatedAt' | 'degradedNotifiedAt' | 'degradedNotifiedReason'
>;

export interface RiskBoardState {
  cloudId: string;
  boardId: number;
  lastViewedAt: string | null;
  lastRefreshAt: string | null;
  lastAttemptAt: string | null;
  failures: number;
  degradedReason: RiskDegradedReason | null;
}

interface ConfigRow {
  cloud_id: string;
  boards_json: string;
  cutoffs_json: string | null;
  composite_json: string | null;
  work_schedule_json: string | null;
  fields_json: string | null;
  in_progress_status: string | null;
  dev_status_available: number | null;
  refresher_account_id: string | null;
  configured_by: string | null;
  updated_at: string;
  degraded_notified_at: string | null;
  degraded_notified_reason: string | null;
}

interface StateRow {
  cloud_id: string;
  board_id: number;
  last_viewed_at: string | null;
  last_refresh_at: string | null;
  last_attempt_at: string | null;
  failures: number;
  degraded_reason: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Tolerate a hand-edited/legacy JSON column rather than 500ing the whole board. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapConfig(r: ConfigRow): RiskOrgConfig {
  return {
    cloudId: r.cloud_id,
    boards: parseJson<RiskBoardRef[]>(r.boards_json, []),
    cutoffs: parseJson<RiskCutoffs | null>(r.cutoffs_json, null),
    composite: parseJson<RiskCompositeConfig | null>(r.composite_json, null),
    schedule: parseJson<RiskWorkSchedule | null>(r.work_schedule_json, null),
    fields: parseJson<RiskFieldIds>(r.fields_json, {}),
    inProgressStatus: r.in_progress_status,
    devStatusAvailable: r.dev_status_available == null ? null : r.dev_status_available === 1,
    refresherAccountId: r.refresher_account_id,
    configuredBy: r.configured_by,
    updatedAt: r.updated_at,
    degradedNotifiedAt: r.degraded_notified_at,
    degradedNotifiedReason: (r.degraded_notified_reason as RiskDegradedReason | null) ?? null,
  };
}

function mapState(r: StateRow): RiskBoardState {
  return {
    cloudId: r.cloud_id,
    boardId: r.board_id,
    lastViewedAt: r.last_viewed_at,
    lastRefreshAt: r.last_refresh_at,
    lastAttemptAt: r.last_attempt_at,
    failures: r.failures,
    degradedReason: (r.degraded_reason as RiskDegradedReason | null) ?? null,
  };
}

// --- Config ------------------------------------------------------------------

export async function getConfig(env: Env, cloudId: string): Promise<RiskOrgConfig | null> {
  const r = await env.DB.prepare(`SELECT * FROM risk_board_config WHERE cloud_id = ?`)
    .bind(cloudId)
    .first<ConfigRow>();
  return r ? mapConfig(r) : null;
}

/** Every configured org — the fleet the refresh scheduler walks. */
export async function listConfigs(env: Env): Promise<RiskOrgConfig[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM risk_board_config ORDER BY cloud_id`,
  ).all<ConfigRow>();
  return results.map(mapConfig);
}

/** Note the two `degraded_notified_*` columns are deliberately absent from BOTH
 *  the insert list and the DO UPDATE SET list: an admin re-saving the config
 *  preserves the open degraded episode (it only moves `updated_at`, which already
 *  re-opens the eligibility gate). Only the CAS helpers below write them. */
export async function putConfig(env: Env, cfg: RiskOrgConfigInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_board_config (
       cloud_id, boards_json, cutoffs_json, composite_json, work_schedule_json,
       fields_json, in_progress_status, dev_status_available, refresher_account_id,
       configured_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id) DO UPDATE SET
       boards_json          = excluded.boards_json,
       cutoffs_json         = excluded.cutoffs_json,
       composite_json       = excluded.composite_json,
       work_schedule_json   = excluded.work_schedule_json,
       fields_json          = excluded.fields_json,
       in_progress_status   = excluded.in_progress_status,
       dev_status_available = excluded.dev_status_available,
       refresher_account_id = excluded.refresher_account_id,
       configured_by        = excluded.configured_by,
       updated_at           = excluded.updated_at`,
  )
    .bind(
      cfg.cloudId,
      JSON.stringify(cfg.boards),
      cfg.cutoffs ? JSON.stringify(cfg.cutoffs) : null,
      cfg.composite ? JSON.stringify(cfg.composite) : null,
      cfg.schedule ? JSON.stringify(cfg.schedule) : null,
      JSON.stringify(cfg.fields ?? {}),
      cfg.inProgressStatus,
      cfg.devStatusAvailable == null ? null : cfg.devStatusAvailable ? 1 : 0,
      cfg.refresherAccountId,
      cfg.configuredBy,
      nowIso(),
    )
    .run();
}

/** Persist the one-shot dev-status probe result (0 = never call the endpoint again). */
export async function setDevStatusAvailable(
  env: Env,
  cloudId: string,
  available: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE risk_board_config SET dev_status_available = ? WHERE cloud_id = ?`,
  )
    .bind(available ? 1 : 0, cloudId)
    .run();
}

// --- Snapshots (overwrite-only) ----------------------------------------------

export async function overwriteSnapshot(
  env: Env,
  cloudId: string,
  snapshot: RiskBoardSnapshot,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_snapshots (cloud_id, board_id, snapshot_json, computed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cloud_id, board_id) DO UPDATE SET
       snapshot_json = excluded.snapshot_json,
       computed_at   = excluded.computed_at`,
  )
    .bind(cloudId, snapshot.boardId, JSON.stringify(snapshot), snapshot.computedAt)
    .run();
}

export async function getSnapshot(
  env: Env,
  cloudId: string,
  boardId: number,
): Promise<RiskBoardSnapshot | null> {
  const r = await env.DB.prepare(
    `SELECT snapshot_json FROM risk_snapshots WHERE cloud_id = ? AND board_id = ?`,
  )
    .bind(cloudId, boardId)
    .first<{ snapshot_json: string }>();
  return r ? parseJson<RiskBoardSnapshot | null>(r.snapshot_json, null) : null;
}

/**
 * Every stored snapshot for one org, in ONE query — the zero-Jira-call source for
 * the admin editors (the cutoffs editor's column vocabulary via
 * `listSnapshotColumns`, and the impact preview's re-scoring corpus). A
 * corrupt/legacy `snapshot_json` yields `snapshot: null` (parseJson is deliberately
 * tolerant) rather than throwing the whole endpoint.
 */
export async function listSnapshots(
  env: Env,
  cloudId: string,
): Promise<{ boardId: number; snapshot: RiskBoardSnapshot | null; computedAt: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT board_id, snapshot_json, computed_at FROM risk_snapshots WHERE cloud_id = ? ORDER BY board_id`,
  )
    .bind(cloudId)
    .all<{ board_id: number; snapshot_json: string; computed_at: string | null }>();
  return results.map((r) => ({
    boardId: r.board_id,
    snapshot: parseJson<RiskBoardSnapshot | null>(r.snapshot_json, null),
    computedAt: r.computed_at,
  }));
}

/** Just the column lists — a projection of `listSnapshots`, kept as its own name
 *  because that is what the cutoffs editor's Scope picker asks for. */
export async function listSnapshotColumns(
  env: Env,
  cloudId: string,
): Promise<{ boardId: number; columns: string[]; computedAt: string | null }[]> {
  return (await listSnapshots(env, cloudId)).map((r) => ({
    boardId: r.boardId,
    columns: Array.isArray(r.snapshot?.columns) ? r.snapshot.columns : [],
    computedAt: r.computedAt,
  }));
}

// --- Per-board refresh state --------------------------------------------------

export async function getState(
  env: Env,
  cloudId: string,
  boardId: number,
): Promise<RiskBoardState | null> {
  const r = await env.DB.prepare(
    `SELECT * FROM risk_board_state WHERE cloud_id = ? AND board_id = ?`,
  )
    .bind(cloudId, boardId)
    .first<StateRow>();
  return r ? mapState(r) : null;
}

/** The demand signal: someone opened this board, so refresh it on the fast cadence. */
export async function markViewed(
  env: Env,
  cloudId: string,
  boardId: number,
  atIso: string = nowIso(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_board_state (cloud_id, board_id, last_viewed_at) VALUES (?, ?, ?)
     ON CONFLICT(cloud_id, board_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
  )
    .bind(cloudId, boardId, atIso)
    .run();
}

export async function recordSuccess(
  env: Env,
  cloudId: string,
  boardId: number,
  atIso: string = nowIso(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_board_state (cloud_id, board_id, last_refresh_at, last_attempt_at, failures, degraded_reason)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT(cloud_id, board_id) DO UPDATE SET
       last_refresh_at = excluded.last_refresh_at,
       last_attempt_at = excluded.last_attempt_at,
       failures        = 0,
       degraded_reason = NULL`,
  )
    .bind(cloudId, boardId, atIso, atIso)
    .run();
}

/** Consecutive failures; at MAX_CONSECUTIVE_FAILURES the board reports 'errors'. */
export async function recordFailure(
  env: Env,
  cloudId: string,
  boardId: number,
  atIso: string = nowIso(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_board_state (cloud_id, board_id, last_attempt_at, failures)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(cloud_id, board_id) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       failures        = risk_board_state.failures + 1,
       degraded_reason = CASE WHEN risk_board_state.failures + 1 >= ?
                              THEN 'errors' ELSE risk_board_state.degraded_reason END`,
  )
    .bind(cloudId, boardId, atIso, MAX_CONSECUTIVE_FAILURES)
    .run();
}

/** Flag a board as degraded without counting a failure (e.g. the refresher's
 *  grant needs re-auth — retrying can't help until an admin acts). */
export async function markDegraded(
  env: Env,
  cloudId: string,
  boardId: number,
  reason: RiskDegradedReason,
  atIso: string = nowIso(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_board_state (cloud_id, board_id, last_attempt_at, failures, degraded_reason)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(cloud_id, board_id) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       degraded_reason = excluded.degraded_reason`,
  )
    .bind(cloudId, boardId, atIso, reason)
    .run();
}

// --- Degraded-notice CAS (per org) --------------------------------------------
//
// A degraded board is only a badge on /risk until somebody is told, and a
// needs_reauth org can't self-heal without a human. risk/notify.ts pushes one
// message per EPISODE per ORG to that org's admins; these two helpers are its
// serialization point, mirroring dao.claimReminder: read the stamp, then write it
// back only if it is still what you read, so exactly one concurrent tick wins and
// therefore exactly one sends.

/**
 * Stamp this org's degraded episode iff the stored stamp is still `prevAtIso`
 * (the value the caller read from the config row; null = no open episode).
 * Returns true iff this caller won the claim and should deliver.
 */
export async function claimDegradedNotice(
  env: Env,
  cloudId: string,
  reason: RiskDegradedReason,
  prevAtIso: string | null,
  atIso: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE risk_board_config
        SET degraded_notified_at = ?, degraded_notified_reason = ?
      WHERE cloud_id = ? AND degraded_notified_at IS ?`,
  )
    .bind(atIso, reason, cloudId, prevAtIso)
    .run();
  return runChanges(res) > 0;
}

/** Close the episode (the org recovered). Same CAS shape, so only one tick
 *  announces the recovery. */
export async function clearDegradedNotice(
  env: Env,
  cloudId: string,
  prevAtIso: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE risk_board_config
        SET degraded_notified_at = NULL, degraded_notified_reason = NULL
      WHERE cloud_id = ? AND degraded_notified_at IS ?`,
  )
    .bind(cloudId, prevAtIso)
    .run();
  return runChanges(res) > 0;
}

/** Cleanup when a board is dropped from the org's config: its snapshot and its
 *  refresh state go with it, so a re-added board starts clean. */
export async function deleteBoardState(
  env: Env,
  cloudId: string,
  boardId: number,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM risk_board_state WHERE cloud_id = ? AND board_id = ?`)
    .bind(cloudId, boardId)
    .run();
  await env.DB.prepare(`DELETE FROM risk_snapshots WHERE cloud_id = ? AND board_id = ?`)
    .bind(cloudId, boardId)
    .run();
}

// --- GDPR erasure seam --------------------------------------------------------

/**
 * Erase an account's traces from the risk tables. This is the feature's hook into
 * GDPR erasure (called from cron/pd-report.ts right after dao.eraseAccount and the
 * notification adapters' unlink) — the risk_* tables live outside dao.ts, so
 * without this line erasure would silently miss the two raw Atlassian account ids
 * stored here (`configured_by`, `refresher_account_id`).
 *
 * Snapshots embed assignee/updater display names and avatar URLs. For an org whose
 * refresher still works those self-heal on the next overwrite (<= 1 h). This
 * handles the case where they can't: erasing the refresher leaves the org unable to
 * refresh, so its snapshots would go stale forever — we delete them and mark the
 * org's boards degraded so an admin re-designates.
 */
export async function riskEraseAccount(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(`UPDATE risk_board_config SET configured_by = NULL WHERE configured_by = ?`)
    .bind(accountId)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT cloud_id, boards_json FROM risk_board_config WHERE refresher_account_id = ?`,
  )
    .bind(accountId)
    .all<{ cloud_id: string; boards_json: string }>();

  for (const row of results) {
    // Reset the degraded-notice stamp in the same statement: an erasure-induced
    // degradation is a NEW episode (a different cause than whatever was open), so
    // the next tick's notice pass announces it instead of treating it as
    // already-reported.
    await env.DB.prepare(
      `UPDATE risk_board_config
          SET refresher_account_id = NULL,
              degraded_notified_at = NULL,
              degraded_notified_reason = NULL
        WHERE cloud_id = ?`,
    )
      .bind(row.cloud_id)
      .run();
    await env.DB.prepare(`DELETE FROM risk_snapshots WHERE cloud_id = ?`)
      .bind(row.cloud_id)
      .run();
    for (const b of parseJson<RiskBoardRef[]>(row.boards_json, [])) {
      await markDegraded(env, row.cloud_id, b.boardId, 'needs_reauth');
    }
  }
}
