import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
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
  template: `
    <div class="row" style="justify-content:space-between">
      <h2>Rate your effort</h2>
      <div class="row" style="gap:8px">
        @if (pending().length > 0) {
          <button [disabled]="clearing()" (click)="clearAll()">Clear all</button>
        }
        @if (pushOn()) {
          <span class="tag">{{ pushMsg() || 'Notifications on' }}</span>
        } @else {
          <button (click)="enablePush()">{{ pushMsg() || 'Enable notifications' }}</button>
        }
      </div>
    </div>

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (pending().length === 0) {
      <div class="panel muted">Nothing to rate right now. You'll be prompted as your tickets change status.</div>
    } @else {
      @for (p of pending(); track p.pendingId) {
        <div class="panel">
          <div class="row" style="justify-content:space-between">
            <div>
              <a [href]="p.url" target="_blank" rel="noopener"><strong>{{ p.issueKey }}</strong></a>
              — {{ p.title }}
            </div>
            <span class="tag">{{ p.storyPoints ?? '—' }} pts · → {{ p.toStatus }}</span>
          </div>
          <div class="muted" style="font-size:12px">moved {{ p.transitionedAt | date: 'short' }}</div>
          <div class="row" style="margin-top:10px; gap:8px">
            @for (f of fractions; track f) {
              <button [class.primary]="busy() === p.pendingId" [disabled]="busy() === p.pendingId"
                      (click)="rate(p, f)">{{ f * 100 }}%</button>
            }
            <input #custom type="number" min="0" max="200" step="1" placeholder="%"
                   style="width:64px" [disabled]="busy() === p.pendingId" />
            <button [disabled]="busy() === p.pendingId || !custom.value"
                    (click)="rateCustom(p, custom.value)">Rate %</button>
          </div>
        </div>
      }
    }
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
    if (!confirm('Clear all pending events? This cannot be undone.')) return;
    this.clearing.set(true);
    this.api.clearPending().subscribe({
      next: () => {
        this.pending.set([]);
        this.clearing.set(false);
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
