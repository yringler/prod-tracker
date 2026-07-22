// Code defaults for the risk board — the per-org DB config (risk_board_config)
// overrides any of these; NULL there means "use the value below".
//
// DEFAULT_CUTOFFS is the userscript's RB_CFG.riskCutoffs table verbatim
// (0_userscript.js L85-245): one rule list per metric, matched most-specific-first
// by resolveCutoff (NOT top-to-bottom), so the redundant per-size rows below are
// kept exactly as the original org tuned them.

import type {
  RiskCompositeConfig,
  RiskCutoffs,
  RiskFieldConfigEntry,
  RiskWorkSchedule,
} from '@shared/risk';

export const DEFAULT_CUTOFFS: RiskCutoffs = {
  idle: [
    { column: 'Blocked', size: 'none', warn: 24, risk: 72 },
    { column: 'Blocked', size: 1, warn: 24, risk: 72 },
    { column: 'Blocked', size: 2, warn: 24, risk: 72 },
    { column: 'Blocked', size: 3, warn: 24, risk: 72 },
    { column: 'Blocked', size: 5, warn: 24, risk: 72 },
    { column: 'Blocked', size: 8, warn: 24, risk: 72 },
    { column: 'Blocked', size: 13, warn: 24, risk: 72 },
    { column: 'Blocked', size: 20, warn: 24, risk: 72 },
    { column: 'Blocked', warn: 24, risk: 72 },

    { column: 'To Do', size: 'none', warn: 16, risk: 48 },
    { column: 'To Do', size: 1, warn: 16, risk: 48 },
    { column: 'To Do', size: 2, warn: 16, risk: 48 },
    { column: 'To Do', size: 3, warn: 16, risk: 48 },
    { column: 'To Do', size: 5, warn: 16, risk: 48 },
    { column: 'To Do', size: 8, warn: 16, risk: 48 },
    { column: 'To Do', size: 13, warn: 16, risk: 48 },
    { column: 'To Do', size: 20, warn: 16, risk: 48 },
    { column: 'To Do', warn: 16, risk: 48 },

    { column: 'In Progress', size: 'none', warn: 4, risk: 9 },
    { column: 'In Progress', size: 1, warn: 4, risk: 9 },
    { column: 'In Progress', size: 2, warn: 4, risk: 9 },
    { column: 'In Progress', size: 3, warn: 4, risk: 9 },
    { column: 'In Progress', size: 5, warn: 4, risk: 9 },
    { column: 'In Progress', size: 8, warn: 4, risk: 9 },
    { column: 'In Progress', size: 13, warn: 4, risk: 9 },
    { column: 'In Progress', size: 20, warn: 4, risk: 9 },
    { column: 'In Progress', warn: 4, risk: 9 },

    { column: 'Code Review 1', size: 'none', warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 1, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 2, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 3, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 5, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 8, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 13, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 20, warn: 2, risk: 4 },
    { column: 'Code Review 1', warn: 2, risk: 4 },

    { column: 'Code Review 2', size: 'none', warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 1, warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 2, warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 3, warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 5, warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 8, warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 13, warn: 3, risk: 6 },
    { column: 'Code Review 2', size: 20, warn: 3, risk: 6 },
    { column: 'Code Review 2', warn: 3, risk: 6 },

    { column: 'Pending QA', size: 'none', warn: 4, risk: 8 },
    { column: 'Pending QA', size: 1, warn: 4, risk: 8 },
    { column: 'Pending QA', size: 2, warn: 4, risk: 8 },
    { column: 'Pending QA', size: 3, warn: 4, risk: 8 },
    { column: 'Pending QA', size: 5, warn: 4, risk: 8 },
    { column: 'Pending QA', size: 8, warn: 4, risk: 8 },
    { column: 'Pending QA', size: 13, warn: 4, risk: 8 },
    { column: 'Pending QA', size: 20, warn: 4, risk: 8 },
    { column: 'Pending QA', warn: 4, risk: 8 },

    { column: 'Done', size: 'none', warn: 48, risk: 120 },
    { column: 'Done', size: 1, warn: 48, risk: 120 },
    { column: 'Done', size: 2, warn: 48, risk: 120 },
    { column: 'Done', size: 3, warn: 48, risk: 120 },
    { column: 'Done', size: 5, warn: 48, risk: 120 },
    { column: 'Done', size: 8, warn: 48, risk: 120 },
    { column: 'Done', size: 13, warn: 48, risk: 120 },
    { column: 'Done', size: 20, warn: 48, risk: 120 },
    { column: 'Done', warn: 48, risk: 120 },

    { default: true, warn: 24, risk: 72 },
  ],
  cycle: [
    { size: 'none', warn: 19, risk: 32 },
    { size: 1, warn: 6, risk: 12 },
    { size: 2, warn: 8, risk: 15 },
    { size: 3, warn: 12, risk: 20 },
    { size: 5, warn: 19, risk: 32 },
    { size: 8, warn: 24, risk: 38 },
    { size: 13, warn: 32, risk: 50 },
    { size: 20, warn: 44, risk: 65 },
    { default: true, warn: 19, risk: 32 },
  ],
  timeInColumn: [
    { column: 'Blocked', size: 'none', warn: 24, risk: 72 },
    { column: 'Blocked', size: 1, warn: 24, risk: 72 },
    { column: 'Blocked', size: 2, warn: 24, risk: 72 },
    { column: 'Blocked', size: 3, warn: 24, risk: 72 },
    { column: 'Blocked', size: 5, warn: 24, risk: 72 },
    { column: 'Blocked', size: 8, warn: 24, risk: 72 },
    { column: 'Blocked', size: 13, warn: 24, risk: 72 },
    { column: 'Blocked', size: 20, warn: 24, risk: 72 },
    { column: 'Blocked', warn: 24, risk: 72 },

    { column: 'To Do', size: 'none', warn: 16, risk: 48 },
    { column: 'To Do', size: 1, warn: 16, risk: 48 },
    { column: 'To Do', size: 2, warn: 16, risk: 48 },
    { column: 'To Do', size: 3, warn: 16, risk: 48 },
    { column: 'To Do', size: 5, warn: 16, risk: 48 },
    { column: 'To Do', size: 8, warn: 16, risk: 48 },
    { column: 'To Do', size: 13, warn: 16, risk: 48 },
    { column: 'To Do', size: 20, warn: 16, risk: 48 },
    { column: 'To Do', warn: 16, risk: 48 },

    { column: 'In Progress', size: 'none', warn: 6, risk: 12 },
    { column: 'In Progress', size: 1, warn: 1, risk: 2 },
    { column: 'In Progress', size: 2, warn: 1, risk: 2 },
    { column: 'In Progress', size: 3, warn: 3, risk: 6 },
    { column: 'In Progress', size: 5, warn: 5, risk: 9 },
    { column: 'In Progress', size: 8, warn: 9, risk: 14 },
    { column: 'In Progress', size: 13, warn: 23, risk: 32 },
    { column: 'In Progress', size: 20, warn: 36, risk: 48 },
    { column: 'In Progress', warn: 6, risk: 12 },

    { column: 'Code Review 1', size: 'none', warn: 4, risk: 8 },
    { column: 'Code Review 1', size: 1, warn: 1, risk: 2 },
    { column: 'Code Review 1', size: 2, warn: 1, risk: 3 },
    { column: 'Code Review 1', size: 3, warn: 2, risk: 4 },
    { column: 'Code Review 1', size: 5, warn: 4, risk: 8 },
    { column: 'Code Review 1', size: 8, warn: 6, risk: 12 },
    { column: 'Code Review 1', size: 13, warn: 10, risk: 18 },
    { column: 'Code Review 1', size: 20, warn: 14, risk: 24 },
    { column: 'Code Review 1', warn: 4, risk: 8 },

    { column: 'Code Review 2', size: 'none', warn: 5, risk: 10 },
    { column: 'Code Review 2', size: 1, warn: 2, risk: 3 },
    { column: 'Code Review 2', size: 2, warn: 2, risk: 4 },
    { column: 'Code Review 2', size: 3, warn: 3, risk: 5 },
    { column: 'Code Review 2', size: 5, warn: 5, risk: 10 },
    { column: 'Code Review 2', size: 8, warn: 7, risk: 14 },
    { column: 'Code Review 2', size: 13, warn: 12, risk: 20 },
    { column: 'Code Review 2', size: 20, warn: 16, risk: 28 },
    { column: 'Code Review 2', warn: 5, risk: 10 },

    { column: 'Pending QA', size: 'none', warn: 6, risk: 12 },
    { column: 'Pending QA', size: 1, warn: 2, risk: 4 },
    { column: 'Pending QA', size: 2, warn: 3, risk: 5 },
    { column: 'Pending QA', size: 3, warn: 4, risk: 7 },
    { column: 'Pending QA', size: 5, warn: 6, risk: 12 },
    { column: 'Pending QA', size: 8, warn: 9, risk: 16 },
    { column: 'Pending QA', size: 13, warn: 14, risk: 24 },
    { column: 'Pending QA', size: 20, warn: 20, risk: 32 },
    { column: 'Pending QA', warn: 6, risk: 12 },

    { column: 'Done', size: 'none', warn: 100, risk: 250 },
    { column: 'Done', size: 1, warn: 100, risk: 250 },
    { column: 'Done', size: 2, warn: 100, risk: 250 },
    { column: 'Done', size: 3, warn: 100, risk: 250 },
    { column: 'Done', size: 5, warn: 100, risk: 250 },
    { column: 'Done', size: 8, warn: 100, risk: 250 },
    { column: 'Done', size: 13, warn: 100, risk: 250 },
    { column: 'Done', size: 20, warn: 100, risk: 250 },
    { column: 'Done', warn: 100, risk: 250 },

    { default: true, warn: 72, risk: 168 },
  ],
};

/** Weights are the userscript's (L248-257) MINUS `unassignedWip`: that weight was
 *  dead config — the original's compositeScore only ever iterated registered
 *  HEALTH metrics, which never included it. The `unassignedInProgress` field
 *  still ships in the snapshot; it just isn't scored. */
export const DEFAULT_COMPOSITE: RiskCompositeConfig = {
  p: 2,
  weights: {
    blocked: 1,
    idle: 1,
    timeInColumn: 1,
    cycle: 1,
  },
};

/** No field mappings by default — the panel starts empty and each org maps its
 *  own Jira fields. (Field weights live on the entries, not in `weights` above.) */
export const DEFAULT_FIELDS: RiskFieldConfigEntry[] = [];

/** Mon-Thu 09:00-18:00, Fri 09:00-13:00, America/New_York (the userscript's RB_WORK). */
export const DEFAULT_SCHEDULE: RiskWorkSchedule = {
  timeZone: 'America/New_York',
  days: {
    Mon: [9, 18],
    Tue: [9, 18],
    Wed: [9, 18],
    Thu: [9, 18],
    Fri: [9, 13],
    Sat: null,
    Sun: null,
  },
};

/** Cycle + in-column clocks start at the first entry into this status. */
export const DEFAULT_IN_PROGRESS_STATUS = 'In Progress';
