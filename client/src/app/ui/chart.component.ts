import {
  type AfterViewInit,
  Component,
  ElementRef,
  Input,
  type OnChanges,
  type OnDestroy,
  ViewChild,
} from '@angular/core';
import {
  CategoryScale,
  Chart,
  type ChartConfiguration,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js';

// Register only the pieces our line charts use (smaller bundle than registerables).
// We avoid Chart.js's TimeScale (and its stale date adapters): the trend charts
// use a linear x-axis over epoch-ms and format ticks/tooltips with date-fns.
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Title,
  Filler, // area wash under the goal-progress line
);

// Thin reusable Chart.js wrapper: hand it a ChartConfiguration, it owns the
// canvas + chart lifecycle. The shared abstraction behind every chart in the app.
@Component({
  selector: 'sp-chart',
  standalone: true,
  template: `<canvas #canvas></canvas>`,
  styles: [`:host{display:block;position:relative;height:260px}`],
})
export class ChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input({ required: true }) config!: ChartConfiguration;

  private chart?: Chart;

  ngAfterViewInit(): void {
    this.render();
  }

  ngOnChanges(): void {
    // First change fires before the view is ready; ngAfterViewInit does the
    // initial render. Later config swaps (e.g. ratio toggle, the goal panel's
    // minutely clock) update the live chart in place: destroy+recreate would
    // replay the from-zero entry animation on every swap, so instead only the
    // delta animates. A type change still needs a full rebuild.
    if (!this.chart) return;
    if ((this.chart.config as ChartConfiguration).type !== this.config.type) {
      this.render();
      return;
    }
    const live = this.chart.data;
    live.labels = this.config.data.labels ?? [];
    // Chart.js matches dataset metadata by object identity (getDatasetMeta's
    // `_dataset === dataset`), so a rebuilt config's fresh dataset objects would
    // orphan the meta and replay the entry animation. Merge into the existing
    // dataset objects (matched by index — every chart here has a fixed series
    // list) so references survive and only the data delta animates.
    const incoming = this.config.data.datasets;
    incoming.forEach((ds, i) => {
      const existing = live.datasets[i] as Record<string, unknown> | undefined;
      if (existing) {
        for (const key of Object.keys(existing)) {
          if (!(key in ds)) delete existing[key];
        }
        Object.assign(existing, ds);
      } else {
        live.datasets[i] = ds;
      }
    });
    live.datasets.length = incoming.length;
    if (this.config.options) this.chart.options = this.config.options;
    this.chart.update();
  }

  private render(): void {
    this.chart?.destroy();
    this.chart = new Chart(this.canvasRef.nativeElement, this.config);
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }
}
