import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  DestroyRef,
  Input,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { ChartConfiguration, ScriptableContext } from 'chart.js';
import { workdayPace } from '@shared/domain';
import { format, parseISO, startOfDay } from 'date-fns';
import { ThemeService } from '../theme.service';
import { ChartComponent } from './chart.component';
import { themeColors, timeOfDayOptions } from './chart-theme';

/** One claim that counts toward today: when it happened and what it was worth. */
export interface GoalEvent {
  at: string; // ISO — the transition time the "Done today" strip groups on
  points: number;
}

// The bridge between one item of progress and a whole day of productivity: a
// meter toward the user's daily goal with quarter milestones (goal 16 → 4 · 8 ·
// 12 · 16), a stage message that celebrates the next/last milestone, and a
// cumulative time-of-day line showing when the points landed — with the rest of
// the day as runway toward the goal gridline.
@Component({
  selector: 'sp-goal-progress',
  standalone: true,
  imports: [ChartComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="panel">
      <div class="row" style="justify-content:space-between; align-items:baseline">
        <h3 style="margin:0">Daily goal</h3>
        <div>
          <span style="font-size:22px; font-weight:600">{{ fmt(total()) }}</span>
          <span class="muted"> / {{ fmt(goalSig()) }} pts</span>
        </div>
      </div>

      <div
        class="meter"
        role="meter"
        aria-valuemin="0"
        [attr.aria-valuemax]="goalSig()"
        [attr.aria-valuenow]="total()"
      >
        <div class="fill" [class.hit]="total() >= goalSig()" [style.width.%]="fillPct()"></div>
        <div class="tick" style="left:25%"></div>
        <div class="tick" style="left:50%"></div>
        <div class="tick" style="left:75%"></div>
      </div>
      <div class="milestones">
        @for (mi of milestones(); track mi.pct) {
          <span [class.reached]="mi.reached" [style.left.%]="mi.pct" [class.last]="mi.pct === 100">
            {{ mi.label }}
          </span>
        }
      </div>

      <p class="muted" style="margin:6px 0 12px">{{ message() }}</p>

      @if (paceMsg(); as pm) {
        @if (pace().state === 'behind') {
          <wa-callout variant="warning" size="small" style="margin-bottom:12px">
            <wa-icon slot="icon" name="triangle-exclamation" variant="regular"></wa-icon>
            {{ pm }}
          </wa-callout>
        } @else {
          <p class="muted pace">
            <wa-icon name="stopwatch"></wa-icon>
            {{ pm }}
          </p>
        }
      }

      <sp-chart [config]="config()" style="height:180px" />
    </div>
  `,
  styles: [
    `
      .meter {
        position: relative;
        height: 14px;
        border-radius: 7px;
        margin-top: 14px;
        background: color-mix(in oklab, var(--claimed) 18%, transparent);
        overflow: hidden;
      }
      .fill {
        height: 100%;
        background: var(--claimed);
        border-radius: 0 4px 4px 0; /* rounded data-end, square at the baseline */
        transition: width 0.3s ease;
      }
      .fill.hit {
        background: var(--done);
        border-radius: 0;
      }
      .tick {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--panel); /* surface gap, not a stroke */
      }
      .milestones {
        position: relative;
        height: 18px;
        margin-top: 4px;
        font-size: 12px;
        color: var(--muted);
      }
      .milestones span {
        position: absolute;
        transform: translateX(-50%);
      }
      .milestones span.last {
        transform: translateX(-100%);
      }
      .milestones span.reached {
        color: var(--ink);
        font-weight: 600;
      }
      .pace {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 12px;
        font-size: 13px;
      }
    `,
  ],
})
export class GoalProgressComponent {
  protected readonly goalSig = signal(1);
  @Input({ required: true }) set goal(v: number) {
    this.goalSig.set(v > 0 ? v : 1);
  }

  protected readonly eventsSig = signal<GoalEvent[]>([]);
  @Input({ required: true }) set events(v: GoalEvent[]) {
    this.eventsSig.set(v ?? []);
  }

  private theme = inject(ThemeService);

  // Re-read "now" once a minute so the pace line (and the chart's now-anchor)
  // advances while the tab sits open, not only when a claim lands.
  private readonly clock = signal(Date.now());
  constructor() {
    const id = setInterval(() => this.clock.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  total = computed(() => this.eventsSig().reduce((sum, e) => sum + e.points, 0));
  fillPct = computed(() => Math.min((this.total() / this.goalSig()) * 100, 100));

  /** Quarter milestones: value labels under the meter at 25/50/75/100%. */
  milestones = computed(() => {
    const goal = this.goalSig();
    const total = this.total();
    return [1, 2, 3, 4].map((i) => {
      const value = (goal / 4) * i;
      return { pct: i * 25, label: this.fmt(value), reached: total >= value };
    });
  });

  /** The stage copy — each quarter is its own emotional beat. */
  message = computed(() => {
    const goal = this.goalSig();
    const total = this.total();
    const q = goal / 4;
    if (total <= 0) return `Nothing claimed yet — the first point gets you moving.`;
    if (total < q) return `On the board — ${this.fmt(q - total)} pts to your first milestone.`;
    if (total < 2 * q) return `First milestone down — halfway is ${this.fmt(2 * q)}.`;
    if (total < 3 * q) return `Halfway there — that's a big deal. Next stop ${this.fmt(3 * q)}.`;
    if (total < goal) return `Almost there — just ${this.fmt(goal - total)} pts to go.`;
    if (total === goal) return `Goal reached. ${this.fmt(goal)} points is a huge day.`;
    return `Goal smashed — ${this.fmt(total - goal)} pts past your ${this.fmt(goal)}. Huge day.`;
  });

  // Time-pacing against the 9–6 workday: which quarter target to chase and by
  // when. Wall-clock local by design — see workdayPace in shared/domain.
  pace = computed(() => workdayPace(this.goalSig(), this.total(), new Date(this.clock())));

  /** The pace line above the chart; null when the goal is already reached. */
  paceMsg = computed(() => {
    const p = this.pace();
    if (p.state === 'done') return null; // message() already celebrates
    const by = format(p.deadline, 'p');
    if (p.state === 'behind') {
      return p.dayOver
        ? `The workday's over with ${this.fmt(p.pointsRemaining)} pts still open — log what you did, or start fresh tomorrow.`
        : `Behind pace — catch up to ${this.fmt(p.targetPoints)} pts by ${by} to get back on track.`;
    }
    if (p.state === 'ahead') {
      return `Ahead of pace — next up ${this.fmt(p.targetPoints)} pts by ${by}.`;
    }
    return `Finish ${this.fmt(p.targetPoints)} pts by ${by} to stay on pace.`;
  });

  // Cumulative step line across the local day: starts at midnight/0, steps up at
  // each claim, holds at the current total until "now". The x-axis runs to the
  // end of the day so what's left reads as runway toward the goal gridline.
  config = computed<ChartConfiguration<'line'>>(() => {
    this.theme.theme(); // re-read CSS-var colors when the theme switches
    const c = themeColors();
    const goal = this.goalSig();
    const events = [...this.eventsSig()].sort((a, b) => a.at.localeCompare(b.at));

    const now = this.clock();
    const dayStart = startOfDay(new Date(now)).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    let cum = 0;
    const data = [
      { x: dayStart, y: 0 },
      ...events.map((e) => ({ x: parseISO(e.at).getTime(), y: (cum += e.points) })),
      { x: now, y: cum },
    ];
    const lastIdx = data.length - 1;

    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'claimed today',
            data,
            stepped: true,
            borderColor: c.claimed,
            // ~10% wash under the line; theme colors are hex, so append alpha.
            backgroundColor: c.claimed.startsWith('#') ? `${c.claimed}1a` : c.claimed,
            fill: 'origin',
            // Dots only on real claims — the midnight/now anchors are synthetic.
            pointRadius: (ctx: ScriptableContext<'line'>) =>
              ctx.dataIndex === 0 || ctx.dataIndex === lastIdx ? 0 : 4,
            pointBackgroundColor: c.claimed,
            // Surface ring so dots stay legible where they sit on the line.
            pointBorderColor: cssPanel(),
            pointBorderWidth: 2,
          },
        ],
      },
      options: timeOfDayOptions(goal, dayStart, dayEnd),
    };
  });

  fmt(v: number): string {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  }
}

/** The chart surface color (panel), for the point surface-ring. */
function cssPanel(): string {
  if (typeof document === 'undefined') return '#151b30';
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#151b30'
  );
}
