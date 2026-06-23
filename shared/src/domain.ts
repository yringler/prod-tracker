// Domain primitives shared by client + worker. The only dependency is date-fns
// (with @date-fns/utc) for date math — see CLAUDE.md.
import { UTCDate } from '@date-fns/utc';
import { format, startOfISOWeek } from 'date-fns';

/** The four self-rating buttons. Stored as a fraction, multiplied by story points. */
export const RATING_FRACTIONS = [0, 0.25, 0.5, 1] as const;
export type RatingFraction = (typeof RATING_FRACTIONS)[number];

export function isRatingFraction(v: unknown): v is RatingFraction {
  return typeof v === 'number' && (RATING_FRACTIONS as readonly number[]).includes(v);
}

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
  /** Uncapped sum of ratingFraction * storyPointsAtRating across all raters. */
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
 * Monday (UTC) of the ISO week containing `iso`, as a `YYYY-MM-DD` string. Used
 * to fold day-bucketed claimed sums into weeks in one tested place (rather than
 * leaning on SQLite's `strftime('%W')`, whose week numbering is fiddly). Inputs
 * are `rated_at` values, which are stored as UTC `toISOString()`.
 */
export function weekStartOf(iso: string): string {
  // UTCDate keeps startOfISOWeek/format in UTC regardless of the runtime's local
  // timezone; startOfISOWeek anchors to Monday.
  return format(startOfISOWeek(new UTCDate(iso)), 'yyyy-MM-dd');
}
