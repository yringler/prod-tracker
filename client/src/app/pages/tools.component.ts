import { CUSTOM_ELEMENTS_SCHEMA, Component, OnInit, computed, inject, signal } from '@angular/core';
import type { MyRatingsResponse } from '@shared/contracts';
import { format, isToday, parseISO } from 'date-fns';
import { ApiService } from '../api.service';

type MyRating = MyRatingsResponse['ratings'][number];
interface StandupDay {
  label: string;
  ratings: MyRating[];
}

// Builds an LLM prompt for a ~30-second informal standup script covering one
// day's claimed items. Pure so the prompt shape is easy to test/tweak.
export function buildStandupPrompt(day: StandupDay): string {
  const items = day.ratings
    .map((r) => {
      const lines = [`- ${r.issueKey}${r.title ? ` — ${r.title}` : ''}`];
      if (r.notes) lines.push(`  My notes: ${r.notes.replaceAll('\n', '\n  ')}`);
      return lines.join('\n');
    })
    .join('\n');
  return [
    `Write me a short standup script covering what I got done on ${day.label}.`,
    '',
    'Requirements:',
    '- About 30 seconds when read aloud.',
    "- Informal, first person, plain spoken language — like I'm telling my team, not filing a report.",
    '- One line per ticket, formatted exactly as "JIRA-ID: quick summary of what was done".',
    "- Base each summary on the ticket name and my notes below. Don't invent work I didn't mention.",
    '- Output only the script lines, nothing else.',
    '',
    'What I worked on:',
    items,
  ].join('\n');
}

// Small utilities that live on your own data. First (only, for now) tool: a
// copyable LLM prompt that turns the last reported day's items into a standup
// script. Reuses GET /api/me/ratings; everything is assembled client-side.
@Component({
  selector: 'sp-tools',
  standalone: true,
  imports: [],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <h2>Tools</h2>

    @if (loading()) {
      <div class="row" style="gap:8px"><wa-spinner></wa-spinner> <span class="muted">Loading…</span></div>
    } @else {
      <div class="panel">
        <div class="row" style="justify-content:space-between; align-items:flex-start">
          <div>
            <h3 style="margin:0">Standup prompt</h3>
            <p class="muted" style="margin:4px 0 0">
              Paste this into your favorite AI to get a ~30-second informal standup script — one line per
              ticket — built from what you reported on your last working day.
            </p>
          </div>
          @if (standupDay(); as day) {
            <wa-button variant="brand" (click)="copy()">
              <wa-icon slot="start" [name]="copied() ? 'check' : 'clipboard'"></wa-icon>
              {{ copied() ? 'Copied!' : 'Copy prompt' }}
            </wa-button>
          }
        </div>

        @if (standupDay(); as day) {
          <div class="row" style="margin-top:12px">
            <wa-tag size="small" appearance="outlined">
              {{ day.label }} · {{ day.ratings.length }} item{{ day.ratings.length === 1 ? '' : 's' }}
            </wa-tag>
          </div>
          <div
            class="muted"
            style="margin-top:8px; white-space:pre-wrap; font-family:var(--wa-font-family-code, monospace); font-size:13px"
          >{{ prompt() }}</div>
        } @else {
          <div class="muted" style="margin-top:12px">
            Nothing reported yet — claim points on a ticket and the prompt will show up here.
          </div>
        }
      </div>
    }
  `,
})
export class ToolsComponent implements OnInit {
  private api = inject(ApiService);

  loading = signal(true);
  ratings = signal<MyRating[]>([]);
  copied = signal(false);

  // The most recent local calendar day with reported work, bucketed like
  // History: the day the work transitioned, falling back to ratedAt.
  standupDay = computed<StandupDay | null>(() => {
    const byDay = new Map<string, StandupDay>();
    let latestKey: string | null = null;
    for (const r of this.ratings()) {
      const d = parseISO(r.transitionedAt ?? r.ratedAt);
      const key = format(d, 'yyyy-MM-dd');
      let g = byDay.get(key);
      if (!g) {
        g = { label: isToday(d) ? 'today' : format(d, 'EEEE, MMM d'), ratings: [] };
        byDay.set(key, g);
      }
      g.ratings.push(r);
      if (!latestKey || key > latestKey) latestKey = key;
    }
    return latestKey ? byDay.get(latestKey)! : null;
  });

  prompt = computed(() => {
    const day = this.standupDay();
    return day ? buildStandupPrompt(day) : '';
  });

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.prompt());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  ngOnInit(): void {
    this.api.myRatings().subscribe({
      next: (r) => {
        this.ratings.set(r.ratings);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
