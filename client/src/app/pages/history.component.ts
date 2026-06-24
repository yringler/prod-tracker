import { CUSTOM_ELEMENTS_SCHEMA, Component, OnInit, computed, inject, signal } from '@angular/core';
import type { MyRatingsResponse } from '@shared/contracts';
import { format, isThisWeek, parseISO } from 'date-fns';
import { ApiService } from '../api.service';

type MyRating = MyRatingsResponse['ratings'][number];
interface DayGroup {
  key: string;
  label: string;
  ratings: MyRating[];
}

// Personal weekly history — everything you claimed points on this (local) week,
// grouped by day, newest first. Reuses GET /api/me/ratings (owner-scoped) and
// filters client-side. Meant to be looked back on with pride, not measured.
@Component({
  selector: 'sp-history',
  standalone: true,
  imports: [],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="row" style="justify-content:space-between">
      <h2>This week</h2>
      @if (!loading() && weekRatings().length > 0) {
        <wa-tag size="small" variant="success" appearance="outlined">
          {{ totalPoints() }} pts · {{ weekRatings().length }} item{{ weekRatings().length === 1 ? '' : 's' }}
        </wa-tag>
      }
    </div>

    @if (loading()) {
      <div class="row" style="gap:8px"><wa-spinner></wa-spinner> <span class="muted">Loading…</span></div>
    } @else if (weekRatings().length === 0) {
      <div class="panel muted">Nothing claimed yet this week. Rate a ticket and it'll show up here.</div>
    } @else {
      @for (g of groups(); track g.key) {
        <h3 style="margin-top:24px">{{ g.label }}</h3>
        @for (r of g.ratings; track r.id) {
          <div class="panel">
            <div class="row" style="justify-content:space-between">
              <div>
                @if (r.url) {
                  <a [href]="r.url" target="_blank" rel="noopener">
                    <strong>{{ r.issueKey }}</strong>
                    <wa-icon name="arrow-up-right-from-square"></wa-icon>
                  </a>
                } @else {
                  <strong>{{ r.issueKey }}</strong>
                }
                @if (r.title) { — {{ r.title }} }
              </div>
              <wa-tag size="small" variant="success" appearance="outlined">{{ r.claimedPoints }} pts</wa-tag>
            </div>
            @if (r.notes) {
              <div class="muted" style="margin-top:6px; white-space:pre-wrap">{{ r.notes }}</div>
            }
          </div>
        }
      }
    }
  `,
})
export class HistoryComponent implements OnInit {
  private api = inject(ApiService);

  loading = signal(true);
  weekRatings = signal<MyRating[]>([]);

  totalPoints = computed(() => this.weekRatings().reduce((sum, r) => sum + r.claimedPoints, 0));

  // Group this week's ratings by the local calendar day the work transitioned
  // (falling back to ratedAt for rows without a stored transition), newest day
  // first. myRatings returns rows ordered rated_at DESC, which for typical
  // same-day claims also lands the transition days newest-first.
  groups = computed<DayGroup[]>(() => {
    const byDay = new Map<string, DayGroup>();
    for (const r of this.weekRatings()) {
      const d = parseISO(r.transitionedAt ?? r.ratedAt);
      const key = format(d, 'yyyy-MM-dd');
      let g = byDay.get(key);
      if (!g) {
        g = { key, label: format(d, 'EEEE, MMM d'), ratings: [] };
        byDay.set(key, g);
      }
      g.ratings.push(r);
    }
    return [...byDay.values()];
  });

  ngOnInit(): void {
    this.api.myRatings().subscribe({
      next: (r) => {
        // "This week" is the user's local week (Monday start) — a reflective
        // grouping, intentionally local rather than the UTC trend buckets. Bucketed
        // by when the work transitioned, not when it was claimed (older rows without
        // a stored transition fall back to ratedAt).
        this.weekRatings.set(
          r.ratings.filter((x) => isThisWeek(parseISO(x.transitionedAt ?? x.ratedAt), { weekStartsOn: 1 })),
        );
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
