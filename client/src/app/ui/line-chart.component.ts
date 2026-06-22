import { Component, Input, computed, signal } from '@angular/core';
import type { ClaimedVsDone } from '@shared/domain';

// Hand-drawn SVG line chart: two raw lines (claimed + done) so scale stays
// visible, plus a ratio toggle. No charting library — small and boring.
@Component({
  selector: 'sp-line-chart',
  standalone: true,
  template: `
    <div class="row" style="justify-content:space-between">
      <div class="row" style="gap:14px">
        @if (!ratioMode()) {
          <span class="row" style="gap:6px"><i [style.background]="'var(--claimed)'" class="swatch"></i>claimed</span>
          <span class="row" style="gap:6px"><i [style.background]="'var(--done)'" class="swatch"></i>done</span>
        } @else {
          <span class="row" style="gap:6px"><i [style.background]="'var(--accent)'" class="swatch"></i>claimed / done</span>
        }
      </div>
      <button (click)="ratioMode.set(!ratioMode())">
        {{ ratioMode() ? 'Show raw lines' : 'Show ratio' }}
      </button>
    </div>

    @if (series.length === 0) {
      <p class="muted">No sprint data yet.</p>
    } @else {
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" width="100%" [attr.height]="H">
        <line [attr.x1]="pad" [attr.y1]="H - pad" [attr.x2]="W - pad" [attr.y2]="H - pad" stroke="var(--line)" />
        <line [attr.x1]="pad" [attr.y1]="pad" [attr.x2]="pad" [attr.y2]="H - pad" stroke="var(--line)" />

        @if (!ratioMode()) {
          <polyline [attr.points]="claimedPoints()" fill="none" stroke="var(--claimed)" stroke-width="2" />
          <polyline [attr.points]="donePoints()" fill="none" stroke="var(--done)" stroke-width="2" />
        } @else {
          <polyline [attr.points]="ratioPoints()" fill="none" stroke="var(--accent)" stroke-width="2" />
        }

        @for (lbl of xLabels(); track lbl.x) {
          <text [attr.x]="lbl.x" [attr.y]="H - pad + 16" fill="var(--muted)" font-size="10" text-anchor="middle">{{ lbl.text }}</text>
        }
        <text [attr.x]="pad" [attr.y]="pad - 6" fill="var(--muted)" font-size="10">max {{ yMax() | number: '1.0-1' }}</text>
      </svg>
    }
  `,
  styles: [`.swatch{display:inline-block;width:10px;height:10px;border-radius:2px}`],
})
export class LineChartComponent {
  @Input({ required: true }) series: ClaimedVsDone[] = [];
  ratioMode = signal(false);

  readonly W = 860;
  readonly H = 260;
  readonly pad = 36;

  private xs = computed(() => {
    const n = this.series.length;
    return this.series.map((_, i) =>
      n <= 1 ? this.pad : this.pad + (i * (this.W - 2 * this.pad)) / (n - 1),
    );
  });

  yMax = computed(() => {
    if (this.ratioMode()) {
      const vals = this.series.map((s) => s.ratio ?? 0);
      return Math.max(1, ...vals);
    }
    const vals = this.series.flatMap((s) => [s.claimedPoints, s.donePoints]);
    return Math.max(1, ...vals);
  });

  private y(v: number): number {
    const max = this.yMax();
    return this.H - this.pad - (v / max) * (this.H - 2 * this.pad);
  }

  claimedPoints = computed(() =>
    this.series.map((s, i) => `${this.xs()[i]},${this.y(s.claimedPoints)}`).join(' '),
  );
  donePoints = computed(() =>
    this.series.map((s, i) => `${this.xs()[i]},${this.y(s.donePoints)}`).join(' '),
  );
  ratioPoints = computed(() =>
    this.series.map((s, i) => `${this.xs()[i]},${this.y(s.ratio ?? 0)}`).join(' '),
  );

  xLabels = computed(() =>
    this.series.map((s, i) => ({ x: this.xs()[i]!, text: s.sprintName.replace(/^Sprint\s*/i, 'S') })),
  );
}
