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
      <button (click)="enablePush()">{{ pushMsg() || 'Enable notifications' }}</button>
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
  pushMsg = signal<string>('');

  ngOnInit(): void {
    this.refresh();
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

  async enablePush(): Promise<void> {
    this.pushMsg.set('…');
    const r = await this.push.enable();
    this.pushMsg.set(
      r === 'granted' ? 'Notifications on' : r === 'denied' ? 'Blocked' : 'Unsupported',
    );
  }
}
