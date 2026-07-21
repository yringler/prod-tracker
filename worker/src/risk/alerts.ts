// Sprint Risk Board Phase 2 — health-change nudges. The SECOND crossing of the
// notification seam in this slice (the first is notify.ts's admin degraded
// notices). Like notify.ts it is pure policy + channel-neutral payloads and it
// reaches channels ONLY through notify.ts's deliverToAccount (registry.resolve()
// under the hood) — it never imports an adapter and never builds a vendor string
// (eslint-walled for worker/src/risk/** in .eslintrc.cjs).
//
// What it does: when a ticket has sat continuously at the `risk` tier for a
// conservative number of WORK-hours, its assignee gets one private nudge through
// their already-linked channels. Hysteresis is transition-only — one message on
// the edge into "struggling", silence while it stays there, re-arm only after the
// ticket returns to ok / leaves the board / goes done, and a cooldown before it
// can fire again. The accumulator is a stored timestamp (risk_since) measured by
// the org's work clock, NOT a refresh counter, so a re-run of the same refresh
// recomputes the identical verdict (idempotent under overlapping poll windows).
//
// Ordering is claim-before-send (store.claimAlertFiring, the repo-wide CAS idiom):
// persist the latch, then deliver, accepting "lost, never duplicated" — a crash
// costs one missed nudge, not a duplicate. See 2_notifications-plan.md §5.

import type { RiskBoardRef, RiskMetricId, RiskTicket } from '@shared/risk';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import { errFields, type Logger } from '../log';
import type { NotificationPayload } from '../notifications/contract';
import { deliverToAccount } from './notify';
import type { RiskOrgConfig } from './store';
import {
  claimAlertFiring,
  deleteAlertState,
  getAlertMuted,
  listAlertStates,
  upsertAlertState,
} from './store';
import { MS_PER_HOUR, type WorkClock } from './logic/workhours';

/** Continuous work-hours at `risk` tier before a ticket's first nudge fires.
 *  8h = one full workday past the risk line (arch §9's own example). */
export const FIRE_AFTER_RISK_WORK_HOURS = 8;
/** After a recovery, a re-fire also needs this many work-hours since the last
 *  nudge — slow to re-fire (arch §14). 16h = two workdays. */
export const REFIRE_COOLDOWN_WORK_HOURS = 16;
/** Cap on tickets listed in one aggregated message ("…and k more" past this). */
export const MAX_ALERT_TICKETS = 10;
/** A recovered row older than this past cooldown is garbage-collected. */
export const RECOVERED_ROW_TTL_MS = 14 * 24 * 60 * 60_000;

/** A "day" in the nudge copy is one 8-hour WORK day (matches the client's
 *  fmtWorkHM and the work-hours-only clock the metrics are measured in). */
const HOURS_PER_WORKDAY = 8;

// --- Signals + state machine (pure) -------------------------------------------

/** Tri-state alert signal from a ticket: 'risk' | 'mid' | 'ok'.
 *  'ok' = tier 'ok' OR tier null (done column / nothing scoreable) — the ONLY
 *  state that re-arms. 'mid' (warn) is the hysteresis gap: breaks at-risk
 *  continuity while armed, but does NOT clear a firing latch. */
export function alertSignal(t: RiskTicket): 'risk' | 'mid' | 'ok' {
  if (t.tier === 'risk') return 'risk';
  if (t.tier === 'warn') return 'mid';
  return 'ok';
}

/** The hysteresis state, one ticket. Mirrors the row (camelCase); `updatedAt` is
 *  load-bearing for the recovered-row TTL GC. */
export interface AlertState {
  phase: 'armed' | 'firing' | 'recovered';
  riskSince: string | null;
  riskStreak: number;
  lastNotifiedAt: string | null;
  lastPayloadHash: string | null;
  updatedAt: string;
}

export type AlertStep =
  | { action: 'none' } // no write needed
  | { action: 'upsert'; next: AlertState } // accumulate / latch / recover
  | { action: 'delete' } // clean past TTL, or departed → drop the row
  | { action: 'fire'; next: AlertState }; // crossed the line THIS run (next = held accumulator)

/**
 * The hysteresis state machine for one ticket at one refresh. Pure and
 * re-run-safe: accrual is derived from `riskSince` + the work clock, never from a
 * counter that a re-run could double-apply. A 'fire' step is only a *candidate* —
 * quiet hours and the claim CAS still gate it in processBoardAlerts. Its `next`
 * carries the accumulator (phase still armed/recovered) so a quiet-hours hold can
 * persist it; the claim is what flips the row to 'firing'.
 */
export function stepAlertState(
  prev: AlertState | null,
  signal: 'risk' | 'mid' | 'ok',
  clock: WorkClock,
  nowMs: number,
): AlertStep {
  const nowIso = new Date(nowMs).toISOString();
  const fireMs = FIRE_AFTER_RISK_WORK_HOURS * MS_PER_HOUR;

  if (prev == null) {
    if (signal !== 'risk') return { action: 'none' };
    // First observation at risk: start the accumulator. Zero accrual so it cannot
    // fire yet; the row now exists for the next refresh to accrue against (which
    // is why a fire candidate is always backed by a real row at claim time).
    return {
      action: 'upsert',
      next: {
        phase: 'armed',
        riskSince: nowIso,
        riskStreak: 1,
        lastNotifiedAt: null,
        lastPayloadHash: null,
        updatedAt: nowIso,
      },
    };
  }

  if (prev.phase === 'firing') {
    if (signal === 'ok') {
      // Only a full recovery unlatches (the clear-low threshold); clear the run.
      return {
        action: 'upsert',
        next: { ...prev, phase: 'recovered', riskSince: null, riskStreak: 0, updatedAt: nowIso },
      };
    }
    // risk or mid while firing: latched, stay quiet; keep the streak ticking.
    return {
      action: 'upsert',
      next: {
        ...prev,
        riskStreak: prev.riskStreak + (signal === 'risk' ? 1 : 0),
        updatedAt: nowIso,
      },
    };
  }

  // phase 'armed' or 'recovered' — both accumulate; 'recovered' additionally gates
  // re-firing on the cooldown vs its last nudge.
  if (signal === 'risk') {
    const riskSince = prev.riskSince ?? nowIso;
    const next: AlertState = {
      ...prev,
      riskSince,
      riskStreak: prev.riskStreak + 1,
      updatedAt: nowIso,
    };
    const readyToFire = clock.workMs(Date.parse(riskSince), nowMs) >= fireMs;
    const cooldownOk =
      prev.phase === 'armed' ||
      prev.lastNotifiedAt == null ||
      clock.workMs(Date.parse(prev.lastNotifiedAt), nowMs) >=
        REFIRE_COOLDOWN_WORK_HOURS * MS_PER_HOUR;
    return { action: readyToFire && cooldownOk ? 'fire' : 'upsert', next };
  }

  // mid or ok while armed/recovered: reset the accumulator (or garbage-collect).
  if (prev.phase === 'recovered') {
    if (nowMs - Date.parse(prev.updatedAt) > RECOVERED_ROW_TTL_MS) return { action: 'delete' };
    if (prev.riskSince == null && prev.riskStreak === 0) return { action: 'none' };
    return {
      action: 'upsert',
      next: { ...prev, riskSince: null, riskStreak: 0, updatedAt: nowIso },
    };
  }
  // armed + mid/ok: nothing else to remember → drop; otherwise reset in place.
  if (prev.lastNotifiedAt == null) return { action: 'delete' };
  return {
    action: 'upsert',
    next: { ...prev, riskSince: null, riskStreak: 0, updatedAt: nowIso },
  };
}

/** Quiet hours: is the org's work clock open right now? Zero new workhours.ts code. */
export function isWorkOpen(clock: WorkClock, nowMs: number): boolean {
  return clock.workMs(nowMs, nowMs + 60_000) > 0;
}

// --- Drivers + formatting (pure) ----------------------------------------------

/** One firing metric of a ticket, in triage priority order, with a formatted value. */
export interface AlertDriver {
  metric: RiskMetricId | 'composite';
  label: string;
}

/** Triage priority (arch §11): which firing metric to read first. */
const DRIVER_ORDER: RiskMetricId[] = ['blocked', 'idle', 'timeInColumn', 'cycle', 'rejections'];

/** Firing metrics of one ticket (band 'risk'), in priority order — mirrors the
 *  triage row. When only the composite is at risk, a single 'overall risk score'. */
export function alertDrivers(t: RiskTicket): AlertDriver[] {
  const out: AlertDriver[] = [];
  for (const id of DRIVER_ORDER) {
    if (t.metrics[id].band !== 'risk') continue;
    out.push({ metric: id, label: driverLabel(id, t) });
  }
  if (out.length === 0 && t.composite.band === 'risk') {
    out.push({ metric: 'composite', label: 'overall risk score' });
  }
  return out;
}

function driverLabel(id: RiskMetricId, t: RiskTicket): string {
  switch (id) {
    case 'blocked':
      return t.blockedByOpen.length ? `blocked by ${t.blockedByOpen.join(', ')}` : 'blocked';
    case 'idle':
      return `idle ${fmtWorkHours(t.idleHours ?? 0)}`;
    case 'timeInColumn':
      return `in ${t.column} ${fmtWorkHours(t.timeInColumnHours ?? 0)}`;
    case 'cycle':
      return `cycle ${fmtWorkHours(t.cycleHours ?? 0)}`;
    case 'rejections': {
      const n = typeof t.metrics.rejections.value === 'number' ? t.metrics.rejections.value : 0;
      return `${n} rejection${n === 1 ? '' : 's'}`;
    }
  }
}

/** Work-hours duration as "Nd Nh" on the 8h workday (worker-side twin of the
 *  client's fmtWorkHM; lives here, not shared/ — one consumer). */
export function fmtWorkHours(hours: number): string {
  const totalH = Math.max(0, Math.round(hours));
  const d = Math.floor(totalH / HOURS_PER_WORKDAY);
  const h = totalH - d * HOURS_PER_WORKDAY;
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  return `${h}h`;
}

/** Stable FNV-1a hex hash of the alert's semantic content (issue keys + driver
 *  labels), for the adapter idempotency key + last_payload_hash. Deterministic in
 *  the given item order — callers sort by key first. */
export function alertPayloadHash(items: Array<{ key: string; drivers: AlertDriver[] }>): string {
  let h = 2166136261;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  for (const it of items) {
    feed(it.key);
    feed(' ');
    for (const d of it.drivers) {
      feed(d.metric);
      feed('=');
      feed(d.label);
      feed('');
    }
    feed('');
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** One recipient's channel-neutral message for k tickets (mirrors the triage row). */
export function composeAlertPayload(
  appOrigin: string,
  boardName: string,
  items: Array<{ ticket: RiskTicket; drivers: AlertDriver[]; atRiskWorkHours: number }>,
): NotificationPayload {
  const deepLink = `${appOrigin}/risk`;
  if (items.length === 1) {
    const { ticket, drivers } = items[0]!;
    const dur = fmtWorkHours(items[0]!.atRiskWorkHours);
    const driven = drivers.map((d) => d.label).join(' · ');
    return {
      title: `${ticket.key} looks stuck`,
      body:
        `"${ticket.summary}" has been past its risk line in ${ticket.column} for ${dur}` +
        (driven ? ` — driven by: ${driven}.` : '.') +
        ' Worth a second pair of eyes?',
      deepLink,
      urgency: 'normal',
    };
  }
  const shown = items.slice(0, MAX_ALERT_TICKETS);
  const lines = shown.map(({ ticket, drivers }) => {
    const driven = drivers.map((d) => d.label).join(' · ');
    return `${ticket.key} (${ticket.column})${driven ? ` — ${driven}` : ''}`;
  });
  const extra = items.length - shown.length;
  if (extra > 0) lines.push(`…and ${extra} more`);
  return {
    title: `${items.length} of your tickets look stuck`,
    body: `On ${boardName}:\n${lines.join('\n')}`,
    deepLink,
    urgency: 'normal',
  };
}

// --- The diff step (the seam in refreshBoard) ---------------------------------

interface FireCandidate {
  ticket: RiskTicket;
  prev: AlertState;
  next: AlertState;
}

/**
 * One board's alert pass: load prior state, step every ticket, apply the non-fire
 * writes, gate on quiet hours, then resolve→claim→deliver the fire candidates
 * (reads before claims, claim before send). Runs at the landed seam in
 * refreshBoard, before overwriteSnapshot, wrapped so it can never fail the board.
 */
export async function processBoardAlerts(
  env: Env,
  dao: Dao,
  cfg: RiskOrgConfig,
  board: RiskBoardRef,
  tickets: RiskTicket[],
  clock: WorkClock,
  log: Logger,
  nowMs: number,
): Promise<void> {
  const cloudId = cfg.cloudId;
  const boardId = board.boardId;
  const nowIso = new Date(nowMs).toISOString();
  const prior = await listAlertStates(env, cloudId, boardId);

  const candidates: FireCandidate[] = [];
  const seen = new Set<string>();
  let recovered = 0;

  for (const t of tickets) {
    seen.add(t.key);
    const prev = prior.get(t.key) ?? null;
    const signal = alertSignal(t);
    if (prev?.phase === 'firing' && signal === 'ok') recovered++;
    const step = stepAlertState(prev, signal, clock, nowMs);
    switch (step.action) {
      case 'none':
        break;
      case 'delete':
        await deleteAlertState(env, cloudId, boardId, t.key);
        break;
      case 'upsert':
        await upsertAlertState(env, cloudId, boardId, t.key, step.next);
        break;
      case 'fire':
        if (prev == null) {
          // Defensive: a fire needs a prior row to accrue against, so this can't
          // happen — but if it ever did, persist the accumulator instead of firing.
          await upsertAlertState(env, cloudId, boardId, t.key, step.next);
        } else {
          candidates.push({ ticket: t, prev, next: step.next });
        }
        break;
    }
  }

  // Departed tickets (off-sprint / off-board): their episodes end silently.
  for (const key of prior.keys()) {
    if (!seen.has(key)) await deleteAlertState(env, cloudId, boardId, key);
  }

  if (candidates.length === 0) {
    if (recovered > 0) {
      log.info('risk: alerts', {
        cloudId,
        boardId,
        fired: 0,
        recipients: 0,
        held: 0,
        unreachable: 0,
        recovered,
      });
    }
    return;
  }

  // Quiet-hours gate: HOLD the transition (persist the accumulator, phase stays
  // armed/recovered), don't drop or claim it. The next refresh inside work hours
  // re-derives the same candidates and fires then.
  if (!isWorkOpen(clock, nowMs)) {
    for (const c of candidates) {
      await upsertAlertState(env, cloudId, boardId, c.ticket.key, c.next);
    }
    log.info('risk: alerts', {
      cloudId,
      boardId,
      fired: 0,
      recipients: 0,
      held: candidates.length,
      unreachable: 0,
      recovered,
    });
    return;
  }

  // Resolve recipients BEFORE any claim (the escalate.ts/notify.ts ordering rule:
  // a throwing read leaves state untouched for a clean retry).
  interface Resolved {
    candidate: FireCandidate;
    accountId: string | null;
    reachable: boolean;
  }
  const resolved: Resolved[] = [];
  for (const candidate of candidates) {
    const accountId = candidate.ticket.assigneeAccountId;
    let reachable = false;
    if (accountId == null) {
      log.info('risk: alert unreachable (unassigned)', { cloudId, boardId, key: candidate.ticket.key });
    } else if (await getAlertMuted(env, accountId)) {
      log.info('risk: alert suppressed (muted)', { cloudId, boardId, key: candidate.ticket.key });
    } else if ((await dao.getUserChannels(accountId)).length === 0) {
      log.info('risk: alert unreachable (no channel)', { cloudId, boardId, key: candidate.ticket.key });
    } else {
      reachable = true;
    }
    resolved.push({ candidate, accountId, reachable });
  }

  // Claim each ticket (CAS). Winners grouped per recipient for one aggregated send.
  const winners = new Map<
    string,
    Array<{ ticket: RiskTicket; drivers: AlertDriver[]; atRiskWorkHours: number }>
  >();
  let fired = 0;
  let unreachable = 0;
  for (const r of resolved) {
    const { ticket, prev, next } = r.candidate;
    const drivers = alertDrivers(ticket);
    const singleHash = alertPayloadHash([{ key: ticket.key, drivers }]);
    const prevPhase = prev.phase === 'recovered' ? 'recovered' : 'armed';
    const won = await claimAlertFiring(env, cloudId, boardId, ticket.key, prevPhase, prev.lastNotifiedAt, {
      riskStreak: next.riskStreak,
      lastNotifiedAt: r.reachable ? nowIso : null,
      lastPayloadHash: singleHash,
      updatedAt: nowIso,
    });
    if (!won) continue; // a concurrent tick already claimed it
    if (r.reachable && r.accountId != null) {
      fired++;
      const atRiskWorkHours = clock.workMs(Date.parse(next.riskSince!), nowMs) / MS_PER_HOUR;
      const list = winners.get(r.accountId) ?? [];
      list.push({ ticket, drivers, atRiskWorkHours });
      winners.set(r.accountId, list);
    } else {
      unreachable++;
    }
  }

  // Aggregate per recipient; deliver once (first delivered channel wins).
  let recipients = 0;
  for (const [accountId, items] of winners) {
    items.sort((a, b) => (a.ticket.key < b.ticket.key ? -1 : a.ticket.key > b.ticket.key ? 1 : 0));
    const hash = alertPayloadHash(items.map((it) => ({ key: it.ticket.key, drivers: it.drivers })));
    const payload = composeAlertPayload(env.APP_ORIGIN, board.name, items);
    const idempotencyKey = `risk-alert:${cloudId}:${boardId}:${accountId}:${hash}`;
    try {
      await deliverToAccount(env, dao, accountId, payload, idempotencyKey, log);
    } catch (e) {
      // The row is already latched (claim-before-send); a delivery failure just
      // costs this nudge, never a duplicate.
      log.warn('risk: alert delivery threw', { cloudId, boardId, ...errFields(e) });
    }
    recipients++;
  }

  log.info('risk: alerts', { cloudId, boardId, fired, recipients, held: 0, unreachable, recovered });
}
