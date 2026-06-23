import { DatePipe } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA, Component, OnInit, inject, signal } from '@angular/core';
import type { PendingRating } from '@shared/contracts';
import { RATING_FRACTIONS, type RatingFraction } from '@shared/domain';
import { ApiService } from '../api.service';
import { PushService } from '../push.service';

// Notification → rating UI. Each pending shows key, title, link, story points and
// the four effort buttons. Submitting writes to OUR db only — never back to Jira.
@Component({
  selector: 'sp-tracker',
  standalone: true,
  imports: [DatePipe],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="row" style="justify-content:space-between">
      <h2>Rate your effort</h2>
      <div class="row" style="gap:8px">
        @if (pending().length > 0) {
          <wa-button size="small" appearance="outlined" [loading]="clearing()" (click)="clearAll()">
            <wa-icon slot="start" name="trash"></wa-icon>
            Clear all
          </wa-button>
        }
        @if (pushOn()) {
          <wa-tag size="small" variant="success" appearance="outlined">
            <wa-icon slot="start" name="bell"></wa-icon>
            {{ pushMsg() || 'Notifications on' }}
          </wa-tag>
        } @else {
          <wa-button size="small" (click)="enablePush()">{{ pushMsg() || 'Enable notifications' }}</wa-button>
        }
      </div>
    </div>

    @if (loading()) {
      <div class="row" style="gap:8px"><wa-spinner></wa-spinner> <span class="muted">Loading…</span></div>
    } @else if (pending().length === 0) {
      <div class="panel muted">Nothing to rate right now. You'll be prompted as your tickets change status.</div>
    } @else {
      @for (p of pending(); track p.pendingId) {
        <div class="panel">
          <div class="row" style="justify-content:space-between">
            <div>
              <a [href]="p.url" target="_blank" rel="noopener">
                <strong>{{ p.issueKey }}</strong>
                <wa-icon name="arrow-up-right-from-square"></wa-icon>
              </a>
              — {{ p.title }}
            </div>
            <wa-tag size="small" appearance="outlined">{{ p.storyPoints ?? '—' }} pts · → {{ p.toStatus }}</wa-tag>
          </div>
          <div class="muted" style="font-size:12px">moved {{ p.transitionedAt | date: 'short' }}</div>
          <div class="row" style="margin-top:10px; gap:8px">
            <wa-button-group label="Effort">
              @for (f of fractions; track f) {
                <wa-button appearance="outlined" [loading]="busy() === p.pendingId"
                           [disabled]="busy() === p.pendingId" (click)="rate(p, f)">{{ f * 100 }}%</wa-button>
              }
            </wa-button-group>
            <wa-input #custom type="number" min="0" max="200" step="1" placeholder="%"
                      style="width:80px" [disabled]="busy() === p.pendingId"></wa-input>
            <wa-button appearance="outlined" [disabled]="busy() === p.pendingId || !custom.value"
                       (click)="rateCustom(p, custom.value)">Rate %</wa-button>
          </div>
        </div>
      }
    }

    <wa-dialog label="Clear all pending?" [open]="confirmOpen()" (wa-after-hide)="confirmOpen.set(false)">
      Clear all pending events? This cannot be undone.
      <wa-button slot="footer" appearance="outlined" (click)="confirmOpen.set(false)">Cancel</wa-button>
      <wa-button slot="footer" variant="danger" [loading]="clearing()" (click)="doClearAll()">Clear all</wa-button>
    </wa-dialog>
  `,
})
export class TrackerComponent implements OnInit {
  private api = inject(ApiService);
  private push = inject(PushService);

  readonly fractions = RATING_FRACTIONS;
  pending = signal<PendingRating[]>([]);
  loading = signal(true);
  busy = signal<string | null>(null);
  clearing = signal(false);
  pushMsg = signal<string>('');
  pushOn = signal(false);
  confirmOpen = signal(false);

  ngOnInit(): void {
    this.refresh();
    this.push.status().then((s) => this.pushOn.set(s === 'granted'));
  }

  refresh(): void {
    this.api.pending().subscribe({
      next: (r) => {
        this.pending.set(r.items);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  rate(p: PendingRating, f: RatingFraction): void {
    this.busy.set(p.pendingId);
    this.api.submitRating({ pendingId: p.pendingId, issueKey: p.issueKey, ratingFraction: f }).subscribe({
      next: () => {
        this.pending.update((list) => list.filter((x) => x.pendingId !== p.pendingId));
        this.busy.set(null);
      },
      error: () => this.busy.set(null),
    });
  }

  // Custom effort: a typed percentage (0–200%) submitted as a fraction.
  rateCustom(p: PendingRating, raw: string): void {
    const pct = Math.round(Number(raw));
    if (!Number.isFinite(pct) || pct < 0) return; // ignore blank/garbage
    this.rate(p, Math.min(pct, 200) / 100); // 200% -> fraction 2.0
  }

  clearAll(): void {
    this.confirmOpen.set(true);
  }

  doClearAll(): void {
    this.clearing.set(true);
    this.api.clearPending().subscribe({
      next: () => {
        this.pending.set([]);
        this.clearing.set(false);
        this.confirmOpen.set(false);
      },
      error: () => this.clearing.set(false),
    });
  }

  async enablePush(): Promise<void> {
    this.pushMsg.set('…');
    const r = await this.push.enable();
    this.pushOn.set(r === 'granted');
    this.pushMsg.set(
      r === 'granted' ? 'Notifications on' : r === 'denied' ? 'Blocked' : 'Unsupported',
    );
  }
}
