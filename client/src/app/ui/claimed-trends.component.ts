import { Component, computed, inject, input } from '@angular/core';
import type { ChartConfiguration } from 'chart.js';
import type { ClaimedTrendsResponse, TrendPoint } from '@shared/contracts';
import { MIN_TEAM_SIZE } from '@shared/domain';
import { ThemeService } from '../theme.service';
import { ChartComponent } from './chart.component';
import { dateLineOptions, themeColors } from './chart-theme';

// Personal-vs-team claimed-points trends. Two time-axis line charts: a 30-day
// view (your daily points + team weekly average) and a 6-month view (both weekly
// per-day averages). Personal = accent, team = done color, so the two lines read
// distinctly even though they share a y-axis.
@Component({
  selector: 'sp-claimed-trends',
  standalone: true,
  imports: [ChartComponent],
  template: `
    @if (data().teamBelowMinSize) {
      <p class="muted">Your team's trend appears once it has at least {{ minTeamSize }} members.</p>
    }
    <div class="panel">
      <h3>Claimed points — last 30 days</h3>
      <p class="muted">Your daily claimed points vs your team's average per person per day (weekly).</p>
      <sp-chart [config]="chart30()" />
    </div>
    <div class="panel">
      <h3>Claimed points — last 6 months</h3>
      <p class="muted">Weekly average claimed points per day: you vs your team's average per person.</p>
      <sp-chart [config]="chart6()" />
    </div>
  `,
})
export class ClaimedTrendsComponent {
  data = input.required<ClaimedTrendsResponse>();
  readonly minTeamSize = MIN_TEAM_SIZE;
  private theme = inject(ThemeService);

  chart30 = computed(() => {
    const d = this.data();
    return this.lineChart(d.last30Days.personalDaily, d.last30Days.teamWeekly, d.teamName);
  });

  chart6 = computed(() => {
    const d = this.data();
    return this.lineChart(d.last6Months.personalWeekly, d.last6Months.teamWeekly, d.teamName);
  });

  private lineChart(
    personal: TrendPoint[],
    team: TrendPoint[],
    teamName: string | null,
  ): ChartConfiguration {
    this.theme.theme(); // re-read CSS-var colors when the theme switches
    const c = themeColors();
    // x as epoch ms (the time scale's native numeric form) keeps Chart.js's
    // line-dataset point typing happy without a cast.
    const toXY = (pts: TrendPoint[]) => pts.map((p) => ({ x: new Date(p.date).getTime(), y: p.value }));
    const datasets: ChartConfiguration<'line'>['data']['datasets'] = [
      {
        label: 'You',
        data: toXY(personal),
        borderColor: c.accent,
        backgroundColor: c.accent,
        tension: 0.2,
        pointRadius: 2,
      },
    ];
    if (team.length > 0) {
      datasets.push({
        label: teamName ? `${teamName} (avg/person)` : 'Team (avg/person)',
        data: toXY(team),
        borderColor: c.done,
        backgroundColor: c.done,
        tension: 0.2,
        pointRadius: 2,
      });
    }
    return { type: 'line', data: { datasets }, options: dateLineOptions(21) };
  }
}
