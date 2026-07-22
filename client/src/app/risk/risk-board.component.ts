import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RiskBoardResponse, RiskBoardSummary, RiskTicket } from '@shared/risk';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';
import { AvatarComponent } from '../ui/avatar.component';
import { RiskDetailComponent } from './risk-detail.component';
import { selectValue } from './dom-events';
import { bandVariant, firingMetrics, sinceLabel, type MetricPill } from './format';

// The triage list (arch §11): one list, worst first, showing ONLY the metrics that
// are currently firing. The length of the list is the health signal — a quiet
// sprint is a short list. Every value/band/threshold is computed server-side and
// shipped in the snapshot; this component does no risk math.
@Component({
  selector: 'sp-risk-board',
  standalone: true,
  imports: [AvatarComponent, RiskDetailComponent, RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="row" style="justify-content:space-between; align-items:center">
      <h2>Sprint risk</h2>
      <div class="row" style="gap:8px">
        @if (boards().length > 1) {
          <wa-select size="small" [value]="selectedValue()" (change)="onPickBoard($event)">
            @for (b of boards(); track b.boardId) {
              <wa-option [value]="boardValue(b)">{{ b.name }}</wa-option>
            }
          </wa-select>
        }
        <wa-switch
          size="small"
          [checked]="muted()"
          (change)="onToggleMute($event)"
          title="Silence the private 'this ticket looks stuck' nudges for your assigned tickets"
        >
          Mute nudges
        </wa-switch>
        @if (auth.isAdmin()) {
          <wa-button size="small" appearance="plain" routerLink="/risk/admin">
            <wa-icon slot="start" name="gear"></wa-icon>
            Configure
          </wa-button>
        }
        @if (isDev) {
          <wa-button size="small" appearance="outlined" [loading]="refreshingNow()" (click)="devRefresh()">
            Refresh now
          </wa-button>
        }
      </div>
    </div>

    @if (loading()) {
      <div class="row" style="gap:8px"><wa-spinner></wa-spinner> <span class="muted">Loading…</span></div>
    } @else if (boards().length === 0) {
      <div class="panel muted">
        No board is configured for this site yet.
        @if (auth.isAdmin()) { <a routerLink="/risk/admin">Configure one</a>. }
      </div>
    } @else {
      @if (degradedReason(); as reason) {
        <wa-callout variant="warning" style="margin-bottom:12px">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          @if (reason === 'needs_reauth') {
            Refresh is degraded — the account that refreshes this board needs to sign in to Jira
            again.
            @if (auth.isAdmin()) { <a routerLink="/risk/admin">Pick another refresher</a>. }
          } @else {
            Refresh is degraded — recent updates from Jira failed. The numbers below may be stale.
          }
        </wa-callout>
      }

      @if (snapshot(); as snap) {
        <div class="row" style="gap:8px; align-items:center; margin-bottom:12px">
          <wa-tag size="small" variant="danger">{{ snap.tierCounts.risk }} at risk</wa-tag>
          <wa-tag size="small" variant="warning">{{ snap.tierCounts.warn }} warning</wa-tag>
          <wa-tag size="small" appearance="outlined">{{ snap.tierCounts.ok }} healthy</wa-tag>
          <span class="spacer"></span>
          <span class="muted" style="font-size:12px">updated {{ updatedLabel() }}</span>
        </div>

        @for (t of snap.tickets; track t.key) {
          <div
            class="panel risk-row"
            [class.tier-risk]="t.tier === 'risk'"
            [class.tier-warn]="t.tier === 'warn'"
            [class.faded]="t.tier !== 'risk' && t.tier !== 'warn'"
            (click)="selectedTicket.set(t)"
          >
            <div class="row" style="justify-content:space-between; align-items:flex-start">
              <div style="min-width:0">
                <div class="row" style="gap:8px; align-items:baseline">
                  <strong>{{ t.key }}</strong>
                  <span class="ellipsis">{{ t.summary }}</span>
                  <wa-tag size="small" appearance="outlined">{{ t.column }}</wa-tag>
                </div>
                <div class="row" style="gap:6px; margin-top:6px; flex-wrap:wrap">
                  @for (p of firing(t); track p.id) {
                    <wa-tag size="small" [attr.variant]="variant(p.band)">{{ p.text }}</wa-tag>
                  } @empty {
                    <span class="muted" style="font-size:12px">healthy</span>
                  }
                </div>
              </div>
              <sp-avatar [name]="t.assignee ?? 'Unassigned'" [url]="t.avatarUrl" [size]="28" />
            </div>
          </div>
        } @empty {
          <div class="panel muted">Nothing on this board right now.</div>
        }
      } @else {
        <div class="panel row" style="gap:8px">
          <wa-spinner></wa-spinner>
          <span class="muted">
            Building this board's first snapshot — it lands within a few minutes.
          </span>
        </div>
      }
    }

    <sp-risk-detail
      [ticket]="selectedTicket()"
      [fields]="snapshotFields()"
      (closed)="selectedTicket.set(null)"
    />
  `,
  styles: [
    `
      .risk-row {
        cursor: pointer;
        border-left: 3px solid transparent;
      }
      .risk-row.tier-risk {
        border-left-color: var(--risk);
      }
      .risk-row.tier-warn {
        border-left-color: var(--warn);
      }
      .risk-row.faded {
        opacity: 0.65;
      }
      .ellipsis {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class RiskBoardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  auth = inject(AuthService);

  readonly isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  boards = signal<RiskBoardSummary[]>([]);
  selected = signal<number | null>(null);
  board = signal<RiskBoardResponse | null>(null);
  loading = signal(true);
  refreshingNow = signal(false);
  muted = signal(false);

  snapshot = computed(() => this.board()?.snapshot ?? null);
  /** Pre-fields snapshots ship no `fields`; degrade to none (no pills, no rows). */
  snapshotFields = computed(() => this.snapshot()?.fields ?? []);
  degradedReason = computed(() => this.board()?.degradedReason ?? null);
  updatedLabel = computed(() => sinceLabel(this.board()?.computedAt ?? null));
  selectedTicket = signal<RiskTicket | null>(null);

  // While the board has no snapshot yet the cron is still working on it, so poll
  // until one lands (arch §3: the client never triggers a Jira call itself).
  private poll: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.api.riskBoards().subscribe({
      next: (r) => {
        this.boards.set(r.boards);
        const first = r.boards[0];
        if (first) this.loadBoard(first.boardId);
        else this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.api.riskAlertPrefs().subscribe({ next: (p) => this.muted.set(p.muted) });
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  /** `<wa-select>`/`<wa-option>` values are strings. These are component members on
   *  purpose: a template may NOT reach a JS global like `String`, and a
   *  `readonly String = String` field on the class would satisfy the compiler while
   *  re-hiding that whole bug class (it used to live right here). */
  selectedValue(): string {
    const id = this.selected();
    return id === null ? '' : String(id);
  }
  boardValue(b: RiskBoardSummary): string {
    return String(b.boardId);
  }

  onPickBoard(e: Event): void {
    const id = Number(selectValue(e));
    if (Number.isInteger(id)) this.loadBoard(id);
  }

  private loadBoard(boardId: number): void {
    // Kill any poller left over from the previous board: startPolling() no-ops while
    // one is running, so a stale interval would keep re-fetching the OLD board and
    // overwrite the page with it (picker says B, data says A).
    this.stopPolling();
    this.selected.set(boardId);
    this.loading.set(true);
    this.fetchBoard(boardId, () => this.loading.set(false));
  }

  private fetchBoard(boardId: number, done?: () => void): void {
    this.api.riskBoard(boardId).subscribe({
      next: (r) => {
        this.board.set(r);
        if (r.refreshing) this.startPolling(boardId);
        else this.stopPolling();
        done?.();
      },
      error: () => done?.(),
    });
  }

  private startPolling(boardId: number): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.fetchBoard(boardId), 20_000);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Local dev only: force the refresh the cron would have done. */
  devRefresh(): void {
    const boardId = this.selected();
    if (boardId == null) return;
    this.refreshingNow.set(true);
    this.api.refreshRiskDev().subscribe({
      next: () => {
        this.refreshingNow.set(false);
        this.fetchBoard(boardId);
      },
      error: () => this.refreshingNow.set(false),
    });
  }

  /** Persist the mute opt-out; reflect the server's echoed value (revert on error). */
  onToggleMute(e: Event): void {
    const next = (e.target as HTMLInputElement).checked;
    this.muted.set(next);
    this.api.putRiskAlertPrefs({ muted: next }).subscribe({
      next: (p) => this.muted.set(p.muted),
      error: () => this.muted.set(!next),
    });
  }

  firing(t: RiskTicket): MetricPill[] {
    return firingMetrics(t, this.snapshotFields());
  }
  variant(band: string): string {
    return bandVariant(band as 'ok' | 'warn' | 'risk' | 'none');
  }
}
