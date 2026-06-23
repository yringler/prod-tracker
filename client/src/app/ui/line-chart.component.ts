import { Component, Input, computed, signal } from '@angular/core';
import type { ChartConfiguration } from 'chart.js';
import type { ClaimedVsDone } from '@shared/domain';
import { ChartComponent } from './chart.component';
import { categoryOptions, themeColors } from './chart-theme';

// Per-sprint claimed-vs-done: two raw lines (so scale stays visible) plus a ratio
// toggle. Renders through the shared <sp-chart>; x-axis is the sprint names.
@Component({
  selector: 'sp-line-chart',
  standalone: true,
  imports: [ChartComponent],
  template: `
    <div class="row" style="justify-content:flex-end">
      <button (click)="ratioMode.set(!ratioMode())">
        {{ ratioMode() ? 'Show raw lines' : 'Show ratio' }}
      </button>
    </div>

    @if (seriesSig().length === 0) {
      <p class="muted">No sprint data yet.</p>
    } @else {
      <sp-chart [config]="config()" />
    }
  `,
})
export class LineChartComponent {
  protected readonly seriesSig = signal<ClaimedVsDone[]>([]);
  @Input({ required: true }) set series(v: ClaimedVsDone[]) {
    this.seriesSig.set(v ?? []);
  }

  ratioMode = signal(false);

  config = computed<ChartConfiguration>(() => {
    const s = this.seriesSig();
    const c = themeColors();
    const labels = s.map((x) => x.sprintName.replace(/^Sprint\s*/i, 'S'));
    const datasets: ChartConfiguration<'line'>['data']['datasets'] = this.ratioMode()
      ? [
          {
            label: 'claimed / done',
            data: s.map((x) => x.ratio ?? 0),
            borderColor: c.accent,
            backgroundColor: c.accent,
            tension: 0.2,
            pointRadius: 2,
          },
        ]
      : [
          {
            label: 'claimed',
            data: s.map((x) => x.claimedPoints),
            borderColor: c.claimed,
            backgroundColor: c.claimed,
            tension: 0.2,
            pointRadius: 2,
          },
          {
            label: 'done',
            data: s.map((x) => x.donePoints),
            borderColor: c.done,
            backgroundColor: c.done,
            tension: 0.2,
            pointRadius: 2,
          },
        ];
    return { type: 'line', data: { labels, datasets }, options: categoryOptions() };
  });
}
