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
    // initial render. Later config swaps (e.g. ratio toggle) re-render here.
    if (this.chart) this.render();
  }

  private render(): void {
    this.chart?.destroy();
    this.chart = new Chart(this.canvasRef.nativeElement, this.config);
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }
}
