// Domain primitives shared by client + worker. Depends on nothing.

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
