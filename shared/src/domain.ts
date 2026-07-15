// Domain primitives shared by client + worker. The only dependency is date-fns
// (with @date-fns/utc) for date math — see CLAUDE.md.
import { UTCDate } from '@date-fns/utc';
import { addHours, addMinutes, format, startOfDay, startOfISOWeek, subHours } from 'date-fns';

export type Role = 'user' | 'admin';

/**
 * Jira status categories. The "done" series defaults to every status whose
 * category is `done`, but the done-status *set* is admin-overridable by name
 * (see config.doneStatusNames).
 */
export type StatusCategoryKey = 'new' | 'indeterminate' | 'done';

/** A single status-transition extracted from a changelog entry. */
export interface StatusTransition {
  /** Changelog entry id — the idempotency key. Numeric-string from Jira. */
  changelogId: string;
  issueKey: string;
  fromStatus: string | null;
  toStatus: string;
  /** ISO-8601 from changelog `created`. */
  at: string;
}

/**
 * Decide whether a transition lands in a done-status. Name-based because the
 * admin-editable done set is by name; falls back to the status category when
 * the name set is empty.
 */
export function isDoneTransition(
  toStatus: string,
  doneStatusNames: readonly string[],
  toStatusCategory?: StatusCategoryKey,
): boolean {
  if (doneStatusNames.length > 0) {
    return doneStatusNames.some((n) => n.toLowerCase() === toStatus.toLowerCase());
  }
  return toStatusCategory === 'done';
}

/**
 * Pending prompts age out: we only surface (and only create) prompts for
 * transitions within the last day. Defined once so the poller (skip insert) and
 * the /api/pending route (skip display) agree on what "a day old" means.
 */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True when a transition is older than PENDING_MAX_AGE_MS. Parses with `Date`
 * (not string compare) because `transitionedAt` carries Jira's numeric tz
 * offset. An unparseable timestamp is treated as NOT stale (fail open — better
 * to show a prompt than silently drop it).
 */
export function isStaleTransition(transitionedAt: string, now: number = Date.now()): boolean {
  const t = new Date(transitionedAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t > PENDING_MAX_AGE_MS;
}

/**
 * How long after a pending prompt appears we wait before escalating it to another
 * notification channel. Coarser than the design doc's ~10 min is fine — the
 * 3-minute poll cron is the resolution floor anyway.
 */
export const ESCALATION_DELAY_MS = 10 * 60 * 1000;

/**
 * The `[notBefore, dueBefore)` window of `created_at` values ripe for escalation
 * at `now`. `dueBefore = now − ESCALATION_DELAY_MS` (waited long enough);
 * `notBefore = now − PENDING_MAX_AGE_MS` (don't force-escalate a post-outage
 * backlog of stale rows). UTCDate keeps the ISO output timezone-stable regardless
 * of the runtime's local zone.
 */
export function escalationWindow(
  now: number = Date.now(),
): { dueBeforeIso: string; notBeforeIso: string } {
  return {
    dueBeforeIso: new UTCDate(now - ESCALATION_DELAY_MS).toISOString(),
    notBeforeIso: new UTCDate(now - PENDING_MAX_AGE_MS).toISOString(),
  };
}

/** Compare two numeric-string changelog ids. Jira ids are monotonic per issue. */
export function changelogIdGreater(a: string, b: string | null): boolean {
  if (b === null) return true;
  // Ids can exceed Number.MAX_SAFE_INTEGER in theory; compare as BigInt.
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    // Non-numeric fallback: lexicographic on equal-length, else length.
    return a.length === b.length ? a > b : a.length > b.length;
  }
}

/** Bucket a done-event timestamp into the sprint whose window contains it. */
export interface SprintWindow {
  sprintId: number;
  startAt: string; // ISO
  endAt: string; // ISO
}

export function sprintForTimestamp(
  ts: string,
  sprints: readonly SprintWindow[],
): number | null {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  for (const s of sprints) {
    const start = Date.parse(s.startAt);
    const end = Date.parse(s.endAt);
    if (!Number.isNaN(start) && !Number.isNaN(end) && t >= start && t <= end) {
      return s.sprintId;
    }
  }
  return null;
}

export interface ClaimedVsDone {
  sprintId: number;
  sprintName: string;
  /** Uncapped sum of each rater's self-claimed points. */
  claimedPoints: number;
  /** Real Jira done sum from done_events. */
  donePoints: number;
  /** Derived ratio; null when donePoints === 0 to avoid divide-by-zero. */
  ratio: number | null;
  /** Done tickets that received >=1 rating / total done tickets. */
  ratingCoverage: { ratedDoneTickets: number; totalDoneTickets: number };
  /** claimedPoints / distinct active raters this sprint. */
  claimedPerActiveRater: number | null;
}

export function computeRatio(claimed: number, done: number): number | null {
  return done === 0 ? null : claimed / done;
}

/**
 * Minimum current team headcount for a team to exist as an aggregate. Below this,
 * team sums/averages are too close to an individual's numbers to be private — on a
 * two-person team the sum or average trivially reveals the other person once you
 * subtract your own. So a sub-floor team returns no aggregate data at all.
 */
export const MIN_TEAM_SIZE = 4;

/**
 * Upper bound on a self-claim for a ticket: twice its story points (you can
 * claim at most 200% of the recorded estimate). Tickets with no estimate — or
 * an implausibly tiny one (< 1) — would otherwise cap at ~0 and be unclaimable,
 * so they fall back to a flat ceiling. Enforced server-side in submitRating and
 * mirrored in the tracker UI (preset disabling + the custom input's max).
 */
export const FALLBACK_CLAIM_CEILING = 13;
export function claimCeiling(storyPoints: number | null): number {
  if (storyPoints == null || storyPoints < 1) return FALLBACK_CLAIM_CEILING;
  return 2 * storyPoints;
}

/**
 * Sanity cap on the self-set daily claimed-points goal. Shared so the settings
 * form's input `max` and the server-side validation in /api/me/settings agree.
 */
export const MAX_DAILY_GOAL = 100;

/**
 * The workday the daily goal is paced against, in wall-clock hours. Quartering
 * 9→18 gives quarter deadlines of 11:15, 13:30, 15:45 and 18:00.
 */
export interface Workday {
  startHour: number;
  endHour: number;
}
export const DEFAULT_WORKDAY: Workday = { startHour: 9, endHour: 18 };

export type PaceState = 'ahead' | 'onTrack' | 'behind' | 'done';

export interface WorkdayPace {
  state: PaceState;
  /** Which quarter's cumulative target is in play (1–4). */
  quarter: 1 | 2 | 3 | 4;
  /** Cumulative points to have claimed by `deadline` (quarter/4 of the goal). */
  targetPoints: number;
  /** Wall-clock end of that quarter. */
  deadline: Date;
  /** Points still needed to hit `targetPoints`; 0 once met. */
  pointsRemaining: number;
  /** True once the whole workday has elapsed. */
  dayOver: boolean;
}

/**
 * Pace the daily goal across the workday: by the end of its i-th quarter you
 * should have claimed i/4 of the goal. The reported target is the first
 * cumulative quarter-target not yet met — hitting one mid-quarter advances the
 * display to the next ('ahead') — but never earlier than the quarter the clock
 * is in, so falling behind points at the *current* deadline as the catch-up
 * target ('behind'), not one that already passed.
 *
 * Deliberately wall-clock, not UTC (the exception to the UTCDate rule): the
 * workday is the user's local 9AM–6PM, so `now` is a plain local Date and
 * `deadline` is local too. Assumes goal > 0.
 */
export function workdayPace(
  goal: number,
  claimedPoints: number,
  now: Date,
  workday: Workday = DEFAULT_WORKDAY,
): WorkdayPace {
  const quarterMinutes = ((workday.endHour - workday.startHour) * 60) / 4;
  const workStart = addHours(startOfDay(now), workday.startHour);
  const deadlineOf = (q: number) => addMinutes(workStart, q * quarterMinutes);

  // How many quarter deadlines have already passed (0 before 11:15, 4 after 18:00).
  let elapsed = 0;
  while (elapsed < 4 && now.getTime() >= deadlineOf(elapsed + 1).getTime()) elapsed++;
  const dayOver = elapsed === 4;

  if (claimedPoints >= goal) {
    return {
      state: 'done',
      quarter: 4,
      targetPoints: goal,
      deadline: deadlineOf(4),
      pointsRemaining: 0,
      dayOver,
    };
  }

  // Smallest quarter whose cumulative target is unmet; exists since claimed < goal.
  let firstUnmet = 1;
  while (firstUnmet < 4 && claimedPoints >= (goal * firstUnmet) / 4) firstUnmet++;

  const behind = firstUnmet <= elapsed;
  const quarter = Math.min(Math.max(firstUnmet, elapsed + 1), 4) as 1 | 2 | 3 | 4;
  const targetPoints = (goal * quarter) / 4;
  return {
    state: behind ? 'behind' : firstUnmet > elapsed + 1 ? 'ahead' : 'onTrack',
    quarter,
    targetPoints,
    deadline: deadlineOf(quarter),
    pointsRemaining: Math.max(0, targetPoints - claimedPoints),
    dayOver,
  };
}

/**
 * Monday (UTC) of the ISO week containing `iso`, as a `YYYY-MM-DD` string. Used
 * to fold day-bucketed claimed sums into weeks in one tested place (rather than
 * leaning on SQLite's `strftime('%W')`, whose week numbering is fiddly). Inputs
 * are the day-bucketed `COALESCE(transitioned_at, rated_at)` values, stored as UTC
 * `toISOString()`.
 */
export function weekStartOf(iso: string): string {
  // UTCDate keeps startOfISOWeek/format in UTC regardless of the runtime's local
  // timezone; startOfISOWeek anchors to Monday.
  return format(startOfISOWeek(new UTCDate(iso)), 'yyyy-MM-dd');
}

/**
 * The personal reflective "day" starts at 3AM local, not midnight: late-night
 * work (a 2AM claim) belongs to the previous day's effort — nobody wakes at 2AM
 * to start a new workday. Used only by the client's local "today/yesterday" and
 * per-day groupings (Tools standup, "Done today", History); the UTC trend buckets
 * are a separate axis and don't use this.
 */
export const DAY_BOUNDARY_HOUR = 3;

/**
 * `yyyy-MM-dd` of the tracker day a local `Date` falls in, with the day starting
 * at DAY_BOUNDARY_HOUR: 2AM Tue → Mon, 3AM Tue → Tue. Deliberately wall-clock
 * local (the same documented exception to the UTCDate rule as `workdayPace`) —
 * "today" here is the user's local reflective day, not a UTC bucket.
 */
export function trackerDayKey(d: Date): string {
  return format(subHours(d, DAY_BOUNDARY_HOUR), 'yyyy-MM-dd');
}

/**
 * The wall-clock instant `d`'s tracker day began (local DAY_BOUNDARY_HOUR:00).
 * Handy for labelling/sorting a day group by its own date.
 */
export function trackerDayStart(d: Date): Date {
  return addHours(startOfDay(subHours(d, DAY_BOUNDARY_HOUR)), DAY_BOUNDARY_HOUR);
}

/** True when `d` falls in the same tracker day as `now` (both local). */
export function isTrackerToday(d: Date, now: Date): boolean {
  return trackerDayKey(d) === trackerDayKey(now);
}
