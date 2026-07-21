import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { ApiError } from '@shared/contracts';
import type {
  RiskBand,
  RiskCompositeConfig,
  RiskCutoffs,
  RiskPreviewBoard,
  RiskPreviewResponse,
  RiskTierCounts,
  RiskWorkSchedule,
} from '@shared/risk';
import { ApiService } from '../api.service';
import { sinceLabel } from './format';

/** Debounce: the editor emits on every keystroke, and this is a DB read per board. */
const DEBOUNCE_MS = 500;

type TierKey = 'risk' | 'warn' | 'ok';

interface Tile {
  key: TierKey;
  label: string;
  icon: string;
  value: number;
  delta: number;
  /** Sign of "this delta is bad news": +1 = more is worse, -1 = more is better. */
  worseWhenUp: 1 | -1;
}

/** Fewer tiers than a chart deserves and every number is a headline, so this is a
 *  KPI row of stat tiles + a part-to-whole composition bar, not a bar chart.
 *  Tier hues are the board's own status palette (`--risk` / `--warn` / `--done`);
 *  those three are NOT far enough apart in light mode to carry meaning by hue, so
 *  every segment and tile ships an icon and a word beside the color. */
const TIERS: { key: TierKey; label: string; icon: string; worseWhenUp: 1 | -1 }[] = [
  { key: 'risk', label: 'At risk', icon: 'triangle-exclamation', worseWhenUp: 1 },
  { key: 'warn', label: 'Warning', icon: 'circle-exclamation', worseWhenUp: 1 },
  { key: 'ok', label: 'Healthy', icon: 'circle-check', worseWhenUp: -1 },
];

/**
 * The impact preview: what the candidate thresholds would do to the boards, before
 * the admin saves. "12 at risk / 9 warning / 40 healthy (was 6 / 8 / 47)".
 *
 * It is the strongest anti-footgun in this editor because it answers the only
 * question the numbers are a proxy for. Three things make it honest:
 *
 * - **It costs nothing.** `POST /api/admin/risk/preview` re-runs the SERVER'S
 *   scorer over each board's stored snapshot — zero Jira calls — so it can be
 *   debounced-on-typing rather than hidden behind a button.
 * - **It cannot drift.** The endpoint calls the same `evaluateTicket` the cron
 *   writes snapshots with; there is no second implementation to disagree.
 * - **It says what it can't show.** The stored clock values (idle / in-column /
 *   cycle) were measured on the schedule the snapshot was computed with. Editing
 *   the schedule in the same unsaved session makes those numbers stale, and the
 *   preview says so in words instead of pretending to have simulated it.
 */
@Component({
  selector: 'sp-risk-impact',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h3 style="margin:0">Impact preview</h3>
        @if (loading()) {
          <wa-spinner></wa-spinner>
        }
      </div>
      <p class="muted" style="font-size:12px">
        What these settings would do to the boards you've already saved, scored from
        each board's last snapshot with the server's own scorer. Nothing is saved
        until you press Save.
      </p>

      @if (errorText(); as err) {
        <wa-callout variant="danger">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>{{ err }}
        </wa-callout>
      } @else if (data(); as d) {
        @if (d.scheduleStale) {
          <wa-callout variant="warning" style="margin-bottom:8px">
            <wa-icon slot="icon" name="clock"></wa-icon>
            These counts use the clock times from the last refresh. Your work-schedule
            change will shift how long every ticket has been idle, in-column and
            in-flight — so the real numbers move again at the next refresh. Only the
            thresholds and weights are previewed here.
          </wa-callout>
        }

        @if (previewed().length) {
          <div class="verdict" [class]="'v-' + verdict().tone">
            <wa-icon [attr.name]="verdict().icon"></wa-icon>
            <strong>{{ verdict().text }}</strong>
          </div>

          @for (b of previewed(); track b.boardId) {
            <div class="board">
              <div class="row" style="justify-content:space-between; align-items:baseline">
                <strong>{{ b.name }}</strong>
                <span class="muted" style="font-size:11px">
                  snapshot {{ since(b.computedAt) }}
                </span>
              </div>

              <div class="tiles">
                @for (t of tiles(b); track t.key) {
                  <div class="tile">
                    <div class="tlabel">
                      <span class="dot" [class]="'c-' + t.key"></span>
                      <wa-icon [attr.name]="t.icon"></wa-icon>
                      {{ t.label }}
                    </div>
                    <div class="tval">
                      {{ t.value }}
                      <span class="delta" [class]="'d-' + tone(t)">{{ signed(t.delta) }}</span>
                    </div>
                  </div>
                }
              </div>

              <div class="bars">
                <div class="barrow">
                  <span class="blabel">Now</span>
                  <div class="bar">
                    @for (s of segments(b.before); track s.key) {
                      <span
                        class="seg"
                        [class]="'c-' + s.key"
                        [style.flex]="s.count"
                        [attr.title]="s.count + ' ' + s.label"
                      ></span>
                    }
                  </div>
                </div>
                <div class="barrow">
                  <span class="blabel">After</span>
                  <div class="bar">
                    @for (s of segments(b.after); track s.key) {
                      <span
                        class="seg"
                        [class]="'c-' + s.key"
                        [style.flex]="s.count"
                        [attr.title]="s.count + ' ' + s.label"
                      ></span>
                    }
                  </div>
                </div>
              </div>

              @if (b.moved) {
                <ul class="movers">
                  @for (m of b.sampleMovers; track m.key) {
                    <li>
                      <code>{{ m.key }}</code>
                      <span class="muted">{{ m.summary }}</span>
                      <span class="move" [class]="'d-' + moveTone(m.from, m.to)">
                        {{ tierWord(m.from) }} → {{ tierWord(m.to) }}
                      </span>
                    </li>
                  }
                </ul>
                @if (b.sampleTruncated) {
                  <p class="muted" style="font-size:11px; margin:0">
                    Showing {{ b.sampleMovers.length }} of {{ b.moved }} changed tickets.
                  </p>
                }
              } @else {
                <p class="muted" style="font-size:12px; margin:4px 0 0">
                  No ticket changes tier on this board.
                </p>
              }
            </div>
          }
        } @else if (!d.boards.length) {
          <p class="muted" style="font-size:12px">
            No boards are saved for this site yet, so there's nothing to preview.
          </p>
        }

        @for (b of withoutSnapshot(); track b.boardId) {
          <p class="muted" style="font-size:12px; margin:4px 0 0">
            <wa-icon name="hourglass-half"></wa-icon>
            <strong>{{ b.name }}</strong> — no snapshot yet, nothing to preview. It'll
            appear once the refresher has run once.
          </p>
        }
      }
    </div>
  `,
  styles: [
    `
      .verdict {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--line);
        border-left-width: 4px;
        margin-bottom: 8px;
      }
      .verdict.v-worse {
        border-left-color: var(--risk);
      }
      .verdict.v-better {
        border-left-color: var(--done);
      }
      .verdict.v-same {
        border-left-color: var(--line);
        color: var(--muted);
      }
      .board {
        border-top: 1px solid var(--line);
        padding-top: 8px;
        margin-top: 8px;
      }
      .tiles {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        margin: 6px 0;
      }
      .tile {
        min-width: 120px;
      }
      .tlabel {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        color: var(--muted);
      }
      .tval {
        font-size: 22px;
        font-weight: 600;
        line-height: 1.2;
      }
      .delta {
        font-size: 12px;
        font-weight: 600;
        margin-left: 4px;
      }
      .d-worse {
        color: var(--risk);
      }
      .d-better {
        color: var(--done);
      }
      .d-same {
        color: var(--muted);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      .c-risk {
        background: var(--risk);
      }
      .c-warn {
        background: var(--warn);
      }
      .c-ok {
        background: var(--done);
      }
      .bars {
        display: grid;
        gap: 4px;
        margin: 4px 0 6px;
      }
      .barrow {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .blabel {
        font-size: 11px;
        color: var(--muted);
        min-width: 36px;
      }
      .bar {
        display: flex;
        flex: 1;
        /* 2px of surface between segments, so adjacent fills never merge. */
        gap: 2px;
        height: 10px;
        border-radius: 5px;
        overflow: hidden;
      }
      .seg {
        border-radius: 2px;
        min-width: 0;
      }
      .movers {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
        font-size: 12px;
      }
      .movers li {
        display: flex;
        gap: 6px;
        align-items: baseline;
        padding: 1px 0;
      }
      .movers .muted {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .move {
        font-weight: 600;
        white-space: nowrap;
      }
    `,
  ],
})
export class RiskImpactPreviewComponent {
  private api = inject(ApiService);

  /** The CANDIDATE config, exactly as it would be PUT. null = inherit defaults. */
  readonly cutoffs = input<RiskCutoffs | null>(null);
  readonly composite = input<RiskCompositeConfig | null>(null);
  /** The candidate schedule — sent only so the server can tell us the stored clock
   *  values are stale relative to it (it cannot re-measure them). */
  readonly schedule = input<RiskWorkSchedule | null>(null);
  /** Flipped by the parent after a save, to re-run against the fresh config. */
  readonly reloadKey = input(0);

  data = signal<RiskPreviewResponse | null>(null);
  loading = signal(false);
  errorText = signal<string | null>(null);

  /** Ignore a response that a newer request has already superseded. */
  private seq = 0;

  constructor() {
    effect((onCleanup) => {
      const body = {
        cutoffs: this.cutoffs(),
        composite: this.composite(),
        schedule: this.schedule(),
      };
      this.reloadKey();
      const timer = setTimeout(() => this.run(body), DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private run(body: {
    cutoffs: RiskCutoffs | null;
    composite: RiskCompositeConfig | null;
    schedule: RiskWorkSchedule | null;
  }): void {
    const mine = ++this.seq;
    this.loading.set(true);
    this.api.adminRiskPreview(body).subscribe({
      next: (r) => {
        if (mine !== this.seq) return;
        this.loading.set(false);
        this.errorText.set(null);
        this.data.set(r);
      },
      error: (e: { error?: ApiError }) => {
        if (mine !== this.seq) return;
        this.loading.set(false);
        const issues = e.error?.issues ?? [];
        // A 400 here means the editor above is already showing the same per-rule
        // errors; don't repeat them all, just say why the numbers are missing.
        this.errorText.set(
          issues.length
            ? `Can't preview yet — fix the ${issues.length} problem(s) flagged above.`
            : (e.error?.error ?? "Couldn't compute the preview."),
        );
      },
    });
  }

  // --- Derived views ----------------------------------------------------------

  readonly previewed = computed<RiskPreviewBoard[]>(() =>
    (this.data()?.boards ?? []).filter((b) => b.status === 'previewed'),
  );
  readonly withoutSnapshot = computed<RiskPreviewBoard[]>(() =>
    (this.data()?.boards ?? []).filter((b) => b.status === 'no-snapshot'),
  );

  /** The at-a-glance answer, in words + an icon + a colored edge — never color
   *  alone. "Worse" is judged on the risk tier, which is what people act on. */
  readonly verdict = computed<{ tone: 'worse' | 'better' | 'same'; icon: string; text: string }>(
    () => {
      const t = this.data()?.totals;
      const delta = (t?.after.risk ?? 0) - (t?.before.risk ?? 0);
      const moved = t?.moved ?? 0;
      if (delta > 0) {
        return {
          tone: 'worse',
          icon: 'arrow-trend-up',
          text: `${delta} more ticket${delta === 1 ? '' : 's'} at risk (${moved} change tier)`,
        };
      }
      if (delta < 0) {
        return {
          tone: 'better',
          icon: 'arrow-trend-down',
          text: `${-delta} fewer ticket${delta === -1 ? '' : 's'} at risk (${moved} change tier)`,
        };
      }
      return {
        tone: 'same',
        icon: 'equals',
        text: moved
          ? `Same number at risk, but ${moved} ticket${moved === 1 ? '' : 's'} change tier`
          : 'No ticket changes tier',
      };
    },
  );

  tiles(b: RiskPreviewBoard): Tile[] {
    return TIERS.map((t) => ({
      key: t.key,
      label: t.label,
      icon: t.icon,
      value: b.after[t.key],
      delta: b.after[t.key] - b.before[t.key],
      worseWhenUp: t.worseWhenUp,
    }));
  }

  segments(c: RiskTierCounts): { key: TierKey; label: string; count: number }[] {
    return TIERS.map((t) => ({ key: t.key, label: t.label, count: c[t.key] })).filter(
      (s) => s.count > 0,
    );
  }

  tone(t: Tile): 'worse' | 'better' | 'same' {
    if (t.delta === 0) return 'same';
    return t.delta * t.worseWhenUp > 0 ? 'worse' : 'better';
  }

  moveTone(from: RiskBand | null, to: RiskBand | null): 'worse' | 'better' | 'same' {
    const rank = (b: RiskBand | null): number =>
      b === 'risk' ? 3 : b === 'warn' ? 2 : b === 'ok' ? 1 : 0;
    const d = rank(to) - rank(from);
    return d > 0 ? 'worse' : d < 0 ? 'better' : 'same';
  }

  tierWord(b: RiskBand | null): string {
    return b === 'risk' ? 'at risk' : b === 'warn' ? 'warning' : b === 'ok' ? 'healthy' : 'unranked';
  }

  signed(n: number): string {
    return n === 0 ? '±0' : n > 0 ? `+${n}` : String(n);
  }

  since(iso: string | null): string {
    return sinceLabel(iso);
  }
}
