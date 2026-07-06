// Shared Chart.js styling so all charts match the app theme (dark CSS vars).
// Colors are read from :root custom properties at build-config time so a theme
// change flows through without hard-coding hexes here.
import { UTCDate } from '@date-fns/utc';
import type { ChartOptions } from 'chart.js';
import { format } from 'date-fns';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface ThemeColors {
  claimed: string;
  done: string;
  accent: string;
  muted: string;
  line: string;
}

export function themeColors(): ThemeColors {
  return {
    claimed: cssVar('--claimed', '#5b8cff'),
    done: cssVar('--done', '#46d39a'),
    accent: cssVar('--accent', '#5b8cff'),
    muted: cssVar('--muted', '#8b94b8'),
    line: cssVar('--line', '#25304f'),
  };
}

/** Common look for every line chart: themed grid, ticks, legend; y starts at 0. */
function baseOptions(): ChartOptions<'line'> {
  const c = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: c.muted } },
      tooltip: { mode: 'index', intersect: false },
    },
    scales: {
      y: {
        beginAtZero: true,
        grid: { color: c.line },
        ticks: { color: c.muted },
      },
    },
  };
}

/** Categorical x-axis (e.g. sprint names). */
export function categoryOptions(): ChartOptions<'line'> {
  const base = baseOptions();
  const c = themeColors();
  return {
    ...base,
    scales: {
      ...base.scales,
      x: { grid: { color: c.line }, ticks: { color: c.muted } },
    },
  };
}

/**
 * Time-of-day x-axis for the daily-goal progress chart. LOCAL time on purpose —
 * "my day" is the user's local day, matching the tracker's isToday grouping —
 * unlike the UTC trend charts. Linear axis over epoch-ms across the whole day so
 * the un-elapsed remainder reads as runway toward the goal. The y ticks step by
 * goal/4, making the gridlines themselves the quarter milestones, with the
 * goal's own gridline emphasized.
 */
export function timeOfDayOptions(
  goal: number,
  dayStartMs: number,
  dayEndMs: number,
): ChartOptions<'line'> {
  const base = baseOptions();
  const c = themeColors();
  const pts = (v: number | string): string => {
    const n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  return {
    ...base,
    plugins: {
      ...base.plugins,
      // Single series — the panel heading names it, so a one-swatch legend box
      // would only restate it.
      legend: { display: false },
      tooltip: {
        ...base.plugins?.tooltip,
        callbacks: {
          title: (items) => format(new Date(Number(items[0]?.parsed.x ?? 0)), 'p'),
          label: (item) => `${pts(item.parsed.y ?? 0)} pts so far`,
        },
      },
    },
    scales: {
      y: {
        ...base.scales?.y,
        suggestedMax: goal,
        ticks: { color: c.muted, stepSize: goal / 4, callback: (v) => pts(v as number) },
        grid: { color: (ctx) => (ctx.tick.value === goal ? c.muted : c.line) },
      },
      x: {
        type: 'linear',
        min: dayStartMs,
        max: dayEndMs,
        grid: { color: c.line },
        ticks: {
          color: c.muted,
          maxTicksLimit: 7,
          callback: (value) => format(new Date(Number(value)), 'HH:mm'),
        },
      },
    },
  };
}

/**
 * Date x-axis without Chart.js's TimeScale/date adapter: a linear axis over
 * epoch-ms (so a daily line and a weekly line space correctly by real time on one
 * chart) with ticks/tooltips formatted by date-fns. UTCDate keeps formatting in
 * UTC, matching how the timestamps are stored.
 */
export function dateLineOptions(suggestedMax?: number): ChartOptions<'line'> {
  const base = baseOptions();
  const c = themeColors();
  return {
    ...base,
    plugins: {
      ...base.plugins,
      tooltip: {
        ...base.plugins?.tooltip,
        callbacks: {
          title: (items) => format(new UTCDate(Number(items[0]?.parsed.x ?? 0)), 'PP'),
        },
      },
    },
    scales: {
      ...base.scales,
      // suggestedMax sets a sensible axis height (Fibonacci story points: 8 ≈
      // a good day) without clipping — the axis still grows past it for outliers.
      y: { ...base.scales?.y, suggestedMax },
      x: {
        type: 'linear',
        grid: { color: c.line },
        ticks: {
          color: c.muted,
          maxTicksLimit: 8,
          callback: (value) => format(new UTCDate(Number(value)), 'MMM d'),
        },
      },
    },
  };
}
