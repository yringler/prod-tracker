import { DatePipe, DecimalPipe } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA, Component, computed, inject, signal } from '@angular/core';
import type { ChartConfiguration } from 'chart.js';
import { UTCDate } from '@date-fns/utc';
import { format } from 'date-fns';
import type { GlobalOverviewResponse, UsageBySource } from '@shared/contracts';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';
import { ThemeService } from '../theme.service';
import { AvatarComponent } from '../ui/avatar.component';
import { ChartComponent } from '../ui/chart.component';
import { categoryOptions, themeColors } from '../ui/chart-theme';

/** Cloudflare D1 Free-plan daily caps — the reference line for "is this a lot?". */
export const D1_FREE_ROWS_WRITTEN_PER_DAY = 100_000;
export const D1_FREE_ROWS_READ_PER_DAY = 5_000_000;

// Operator page (/admin/global): cross-org usage for whoever runs this deployment.
// Gated by the GLOBAL_ADMIN_ACCOUNT_IDS worker secret — the server 404s everyone
// else; the nav link is hidden from them too. Read-only. Ratings appear only as
// per-org counts (privacy invariant); the user list is identity + activity.
@Component({
  selector: 'sp-global-admin',
  standalone: true,
  imports: [AvatarComponent, ChartComponent, DatePipe, DecimalPipe],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  styles: [
    `
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 10px;
      }
      .tile {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      .tile .v {
        font-size: 22px;
        font-weight: 600;
      }
      .tile .k {
        font-size: 12px;
      }
      .scroll {
        overflow-x: auto;
      }
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      code {
        font-size: 11px;
        word-break: break-all;
      }
      .over {
        color: var(--wa-color-danger-fill-loud, #e5484d);
      }
    `,
  ],
  template: `
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2>Global usage</h2>
      <wa-button size="small" appearance="outlined" [loading]="loading()" (click)="load()"
        >Refresh</wa-button
      >
    </div>

    @if (!auth.me()?.isGlobalAdmin) {
      <div class="panel muted">
        This page is for operators of this deployment. Add your account id (Settings) to the
        <code>GLOBAL_ADMIN_ACCOUNT_IDS</code> worker secret to unlock it.
      </div>
    } @else if (errorMsg(); as e) {
      <div class="panel">{{ e }}</div>
    } @else if (data(); as d) {
      <div class="tiles">
        <div class="tile">
          <div class="v">{{ d.totals.users }}</div>
          <div class="k muted">users ({{ d.totals.activeUsers24h }} active 24h · {{ d.totals.activeUsers7d }} 7d)</div>
        </div>
        <div class="tile">
          <div class="v">{{ d.totals.orgs }}</div>
          <div class="k muted">sites / orgs</div>
        </div>
        <div class="tile">
          <div class="v">{{ d.totals.ratings7d }}</div>
          <div class="k muted">ratings last 7d ({{ d.totals.ratingsTotal }} total)</div>
        </div>
        <div class="tile">
          <div class="v">{{ d.totals.pending }}</div>
          <div class="k muted">pending prompts</div>
        </div>
        <div class="tile">
          <div class="v" [class.over]="writes24h() > freeWrites">{{ writes24h() | number }}</div>
          <div class="k muted">
            D1 rows written 24h ({{ (writes24h() / freeWrites) * 100 | number: '1.0-0' }}% of free/day)
          </div>
        </div>
        <div class="tile">
          <div class="v" [class.over]="reads24h() > freeReads">{{ reads24h() | number }}</div>
          <div class="k muted">
            D1 rows read 24h ({{ (reads24h() / freeReads) * 100 | number: '1.0-0' }}% of free/day)
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">D1 {{ showReads() ? 'rows read' : 'rows written' }} per hour (7 days, UTC)</h3>
          <wa-button size="small" appearance="outlined" (click)="showReads.set(!showReads())">
            Show {{ showReads() ? 'writes' : 'reads' }}
          </wa-button>
        </div>
        @if (d.usage.trackingSince === null) {
          <p class="muted">
            No usage recorded yet. The meter flushes on every cron tick (3 min) and at most once a
            minute per worker isolate.
          </p>
        } @else {
          <p class="muted" style="font-size:12px">
            Metered since {{ d.usage.trackingSince | date: 'medium' }}. Approximate: an evicted
            isolate can lose up to a minute of request tallies; cron ticks are exact.
          </p>
          <sp-chart [config]="chart()" />
        }
      </div>

      <div class="panel">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">Where the database work comes from</h3>
          <wa-button size="small" appearance="outlined" (click)="window7d.set(!window7d())">
            {{ window7d() ? 'Last 24h' : 'Last 7 days' }}
          </wa-button>
        </div>
        <p class="muted" style="font-size:12px">
          {{ window7d() ? 'Last 7 days' : 'Last 24 hours' }}, by route or cron job, heaviest writer first.
        </p>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th class="num">Calls</th>
                <th class="num">Queries</th>
                <th class="num">Rows read</th>
                <th class="num">Rows written</th>
                <th class="num">Writes / call</th>
              </tr>
            </thead>
            <tbody>
              @for (s of sources(); track s.source) {
                <tr>
                  <td><code>{{ s.source }}</code></td>
                  <td class="num">{{ s.invocations | number }}</td>
                  <td class="num">{{ s.queries | number }}</td>
                  <td class="num">{{ s.rowsRead | number }}</td>
                  <td class="num">{{ s.rowsWritten | number }}</td>
                  <td class="num">{{ perCall(s) | number: '1.0-1' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="muted">Nothing metered in this window yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <h3>Sites</h3>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th class="num">Users</th>
                <th class="num">Active 7d</th>
                <th class="num">Ratings 7d</th>
                <th class="num">Ratings total</th>
                <th class="num">Pending</th>
                <th class="num">Teams</th>
                <th class="num">Sprints</th>
                <th class="num">Risk boards</th>
              </tr>
            </thead>
            <tbody>
              @for (o of d.orgs; track o.cloudId) {
                <tr>
                  <td>
                    @if (o.siteUrl) {
                      <a [href]="o.siteUrl" target="_blank" rel="noopener">{{ o.name }}</a>
                    } @else {
                      {{ o.name }}
                    }
                  </td>
                  <td class="num">{{ o.users }}</td>
                  <td class="num">{{ o.activeUsers7d }}</td>
                  <td class="num">{{ o.ratings7d }}</td>
                  <td class="num">{{ o.ratingsTotal }}</td>
                  <td class="num">{{ o.pending }}</td>
                  <td class="num">{{ o.teams }}</td>
                  <td class="num">{{ o.sprints }}</td>
                  <td class="num">{{ o.riskBoards }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <h3>Users</h3>
        <p class="muted" style="font-size:12px">
          Identity and activity only — no effort data. "Last active" is the last signed-in request,
          to the hour.
        </p>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Sites</th>
                <th>Last active</th>
                <th>Last login</th>
                <th class="num">Sessions</th>
                <th>Channels</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              @for (u of d.users; track u.accountId) {
                <tr>
                  <td>
                    <div class="row" style="gap:8px;flex-wrap:nowrap">
                      <sp-avatar [name]="u.displayName" [url]="u.avatarUrl" [size]="24" />
                      <div>
                        <div>{{ u.displayName }}</div>
                        <code class="muted">{{ u.accountId }}</code>
                      </div>
                    </div>
                  </td>
                  <td>{{ u.sites.join(', ') }}</td>
                  <td>{{ u.lastActiveAt ? (u.lastActiveAt | date: 'short') : '—' }}</td>
                  <td>{{ u.lastSeenAt ? (u.lastSeenAt | date: 'short') : '—' }}</td>
                  <td class="num">{{ u.activeSessions }}</td>
                  <td>{{ u.channels.join(', ') || '—' }}</td>
                  <td>
                    @if (u.isOrgAdmin) {
                      <wa-tag size="small" appearance="outlined">admin</wa-tag>
                    }
                    @if (u.needsReauth) {
                      <wa-tag size="small" variant="warning" appearance="outlined">needs re-auth</wa-tag>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <h3>Tables</h3>
        <div class="scroll">
          <table>
            <thead>
              <tr><th>Table</th><th class="num">Rows</th></tr>
            </thead>
            <tbody>
              @for (t of d.tables; track t.name) {
                <tr>
                  <td><code>{{ t.name }}</code></td>
                  <td class="num">{{ t.rows | number }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="muted" style="font-size:12px">Generated {{ d.generatedAt | date: 'medium' }}.</p>
      </div>
    } @else {
      <div class="row" style="gap:8px"><wa-spinner></wa-spinner> <span class="muted">Loading…</span></div>
    }
  `,
})
export class GlobalAdminComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private theme = inject(ThemeService);

  readonly freeWrites = D1_FREE_ROWS_WRITTEN_PER_DAY;
  readonly freeReads = D1_FREE_ROWS_READ_PER_DAY;

  data = signal<GlobalOverviewResponse | null>(null);
  loading = signal(false);
  errorMsg = signal<string | null>(null);
  showReads = signal(false);
  window7d = signal(false);

  sources = computed<UsageBySource[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.window7d() ? d.usage.last7d : d.usage.last24h;
  });
  writes24h = computed(() => (this.data()?.usage.last24h ?? []).reduce((n, s) => n + s.rowsWritten, 0));
  reads24h = computed(() => (this.data()?.usage.last24h ?? []).reduce((n, s) => n + s.rowsRead, 0));

  chart = computed<ChartConfiguration>(() => {
    this.theme.theme(); // re-read CSS-var colors when the theme switches
    const c = themeColors();
    const pts = this.data()?.usage.hourly ?? [];
    const reads = this.showReads();
    return {
      type: 'line',
      data: {
        labels: pts.map((p) => format(new UTCDate(p.bucket), 'EEE HH:00')),
        datasets: [
          {
            label: reads ? 'rows read' : 'rows written',
            data: pts.map((p) => (reads ? p.rowsRead : p.rowsWritten)),
            borderColor: reads ? c.done : c.accent,
            backgroundColor: reads ? c.done : c.accent,
            tension: 0.2,
            pointRadius: 0,
          },
        ],
      },
      options: categoryOptions(),
    };
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.api.globalOverview().subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.errorMsg.set('Could not load the overview (operator access required).');
      },
    });
  }

  perCall(s: UsageBySource): number {
    return s.invocations === 0 ? 0 : s.rowsWritten / s.invocations;
  }
}
