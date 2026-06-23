import { DecimalPipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import type { ClaimedTrendsResponse, TeamAggregateResponse } from '@shared/contracts';
import { ApiService } from '../api.service';
import { ClaimedTrendsComponent } from '../ui/claimed-trends.component';
import { LineChartComponent } from '../ui/line-chart.component';

// Stats page. Top: personal-vs-team claimed trends over calendar time. Below:
// per-team claimed-vs-done by sprint (raw lines + ratio toggle, plus coverage and
// claimed-per-active-rater so a dip reads as "real" vs "people didn't rate").
@Component({
  selector: 'sp-aggregates',
  standalone: true,
  imports: [DecimalPipe, ClaimedTrendsComponent, LineChartComponent],
  template: `
    @if (trends(); as t) {
      <h2>My trends</h2>
      <sp-claimed-trends [data]="t" />
    }

    <h2>Team aggregates</h2>
    <p class="muted">Effort-claimed (uncapped sum of self-ratings × points) vs real Jira done points, per sprint.</p>

    @if (teams().length === 0) {
      <div class="panel muted">No teams yet. An admin can create teams and assign members.</div>
    }

    @for (t of teams(); track t.teamId) {
      <div class="panel">
        <h3>{{ t.teamName }}</h3>
        <sp-line-chart [series]="t.series" />
        <table style="margin-top:12px">
          <thead>
            <tr><th>Sprint</th><th>Claimed</th><th>Done</th><th>Ratio</th><th>Coverage</th><th>Claimed / rater</th></tr>
          </thead>
          <tbody>
            @for (s of t.series; track s.sprintId) {
              <tr>
                <td>{{ s.sprintName }}</td>
                <td>{{ s.claimedPoints | number: '1.0-1' }}</td>
                <td>{{ s.donePoints | number: '1.0-1' }}</td>
                <td>{{ s.ratio === null ? '—' : (s.ratio | number: '1.0-2') }}</td>
                <td>{{ s.ratingCoverage.ratedDoneTickets }}/{{ s.ratingCoverage.totalDoneTickets }}</td>
                <td>{{ s.claimedPerActiveRater === null ? '—' : (s.claimedPerActiveRater | number: '1.0-1') }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class AggregatesComponent implements OnInit {
  private api = inject(ApiService);
  teams = signal<TeamAggregateResponse[]>([]);
  trends = signal<ClaimedTrendsResponse | null>(null);

  ngOnInit(): void {
    this.api.aggregates().subscribe((r) => this.teams.set(r.teams));
    this.api.claimedTrends().subscribe((r) => this.trends.set(r));
  }
}
