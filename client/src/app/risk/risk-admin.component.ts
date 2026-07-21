import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OrgMember } from '@shared/contracts';
import type {
  PutRiskConfigRequest,
  RiskBoardCandidate,
  RiskBoardRef,
  RiskFieldCandidatesResponse,
  RiskFieldOption,
} from '@shared/risk';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';

type FieldKey = 'flagged' | 'rejections' | 'implementor' | 'codeReviewer';

const FIELD_LABELS: Record<FieldKey, string> = {
  flagged: 'Flagged (blocked)',
  rejections: 'Code-review rejections',
  implementor: 'Developer',
  codeReviewer: 'Reviewer',
};

// Per-site risk-board configuration. Nothing here is secret (board ids, cutoff
// tables, an account id), so unlike the notification-channel panel the stored
// values are read back and shown. v1 edits the cutoff/composite/schedule tables as
// raw JSON with server-side validation; friendlier editors can come later without
// touching the API.
@Component({
  selector: 'sp-risk-admin',
  standalone: true,
  imports: [RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row" style="justify-content:space-between; align-items:center">
      <h2>Risk board setup</h2>
      <wa-button size="small" appearance="plain" routerLink="/risk">Back to board</wa-button>
    </div>

    @if (!auth.isAdmin()) {
      <div class="panel muted">Admins only.</div>
    } @else if (loading()) {
      <div class="row" style="gap:8px"><wa-spinner></wa-spinner> <span class="muted">Loading…</span></div>
    } @else {
      <div class="panel">
        <h3>Boards</h3>
        <p class="muted" style="font-size:12px">
          Pick the boards to watch. Selecting one runs a scope probe against Jira's
          board-configuration endpoint — if that fails, nothing else will work.
        </p>
        @for (b of candidates(); track b.boardId) {
          <div class="row" style="gap:8px; align-items:center">
            <wa-checkbox
              [attr.checked]="isPicked(b.boardId) ? '' : null"
              (change)="toggleBoard(b, $event)"
            ></wa-checkbox>
            <span>{{ b.name }}</span>
            <span class="muted" style="font-size:12px">#{{ b.boardId }} · {{ b.type ?? '?' }}</span>
          </div>
        } @empty {
          <div class="muted">No boards are visible to your Jira account.</div>
        }
        @if (probeError(); as err) {
          <wa-callout variant="danger" style="margin-top:8px">
            <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
            {{ err }}
          </wa-callout>
        }
      </div>

      <div class="panel">
        <h3>Refresher</h3>
        <p class="muted" style="font-size:12px">
          Snapshots are refreshed with this person's Jira grant. If they leave or their
          consent lapses, the board degrades until you pick someone else.
        </p>
        <wa-select
          placeholder="member…"
          [value]="refresherAccountId() ?? ''"
          (change)="refresherAccountId.set(value($event))"
        >
          @for (m of members(); track m.accountId) {
            <wa-option [value]="m.accountId">{{ m.displayName }}</wa-option>
          }
        </wa-select>
      </div>

      <div class="panel">
        <h3>Fields</h3>
        <p class="muted" style="font-size:12px">
          All optional, and all discovered from your Jira instance — ids are never
          hardcoded. Leave one blank and the board simply drops that signal.
        </p>
        @for (k of fieldKeys; track k) {
          <div class="row" style="margin-top:8px; align-items:center">
            <label style="min-width:180px">{{ label(k) }}</label>
            <wa-select
              with-clear
              style="flex:1"
              placeholder="none"
              [value]="fields()[k] ?? ''"
              (change)="setField(k, $event)"
            >
              @for (o of options(k); track o.id) {
                <wa-option [value]="o.id">{{ o.name }}</wa-option>
              }
            </wa-select>
          </div>
        }
        <div class="row" style="margin-top:8px; align-items:center">
          <label style="min-width:180px">In Progress status</label>
          <wa-input
            style="flex:1"
            [attr.placeholder]="defaultInProgress()"
            [value]="inProgressStatus()"
            (input)="inProgressStatus.set(value($event))"
          ></wa-input>
        </div>
      </div>

      <div class="panel">
        <h3>Thresholds &amp; clock</h3>
        <p class="muted" style="font-size:12px">
          Blank = use the built-in defaults (and clearing a box resets to them). Only
          what you type here is stored, so the shipped defaults keep improving under
          you. The server validates the shape (and the timezone) before saving.
        </p>
        <wa-details summary="Risk cutoffs (JSON)">
          <wa-textarea
            rows="8"
            placeholder="blank = built-in defaults"
            [value]="cutoffsJson()"
            (input)="cutoffsJson.set(value($event))"
          ></wa-textarea>
          <p class="muted" style="font-size:12px">Built-in defaults, for reference:</p>
          <pre class="ref">{{ defaultCutoffsJson() }}</pre>
        </wa-details>
        <wa-details summary="Composite weights (JSON)">
          <wa-textarea
            rows="5"
            placeholder="blank = built-in defaults"
            [value]="compositeJson()"
            (input)="compositeJson.set(value($event))"
          ></wa-textarea>
          <p class="muted" style="font-size:12px">Built-in defaults, for reference:</p>
          <pre class="ref">{{ defaultCompositeJson() }}</pre>
        </wa-details>
        <wa-details summary="Work schedule (JSON)">
          <wa-textarea
            rows="6"
            placeholder="blank = built-in defaults"
            [value]="scheduleJson()"
            (input)="scheduleJson.set(value($event))"
          ></wa-textarea>
          <p class="muted" style="font-size:12px">Built-in defaults, for reference:</p>
          <pre class="ref">{{ defaultScheduleJson() }}</pre>
        </wa-details>
      </div>

      <div class="row" style="gap:8px">
        <wa-button variant="brand" [loading]="saving()" (click)="save()">Save</wa-button>
        @if (message(); as msg) {
          <wa-callout [attr.variant]="msg.ok ? 'success' : 'danger'" style="flex:1">
            {{ msg.text }}
          </wa-callout>
        }
      </div>
    }
  `,
  styles: [
    `
      .ref {
        max-height: 180px;
        overflow: auto;
        font-size: 11px;
        color: var(--muted);
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 6px;
        margin: 0;
      }
    `,
  ],
})
export class RiskAdminComponent implements OnInit {
  private api = inject(ApiService);
  auth = inject(AuthService);

  readonly fieldKeys: FieldKey[] = ['flagged', 'rejections', 'implementor', 'codeReviewer'];

  loading = signal(true);
  saving = signal(false);
  message = signal<{ ok: boolean; text: string } | null>(null);
  probeError = signal<string | null>(null);

  candidates = signal<RiskBoardCandidate[]>([]);
  members = signal<OrgMember[]>([]);
  fieldCandidates = signal<RiskFieldCandidatesResponse | null>(null);

  picked = signal<RiskBoardRef[]>([]);
  refresherAccountId = signal<string | null>(null);
  fields = signal<Record<FieldKey, string | null>>({
    flagged: null,
    rejections: null,
    implementor: null,
    codeReviewer: null,
  });
  inProgressStatus = signal('');
  cutoffsJson = signal('');
  compositeJson = signal('');
  scheduleJson = signal('');
  // Read-only reference copies of the shipped defaults (never written back).
  defaultCutoffsJson = signal('');
  defaultCompositeJson = signal('');
  defaultScheduleJson = signal('');
  defaultInProgress = signal('In Progress');

  ngOnInit(): void {
    this.api.adminRiskConfig().subscribe({
      next: (r) => {
        this.picked.set(r.config.boards);
        this.refresherAccountId.set(r.config.refresherAccountId);
        this.fields.set({
          flagged: r.config.fields.flagged ?? null,
          rejections: r.config.fields.rejections ?? null,
          implementor: r.config.fields.implementor ?? null,
          codeReviewer: r.config.fields.codeReviewer ?? null,
        });
        this.inProgressStatus.set(r.config.inProgressStatus ?? '');
        this.defaultInProgress.set(r.defaults.inProgressStatus);
        // Only an org's OWN overrides go in the boxes. Prefilling the code defaults
        // would freeze a copy of them into the DB on the next Save, so the org would
        // never pick up later improvements to logic/defaults.ts — blank means
        // "NULL = use the built-in defaults", and clearing a box resets to them.
        this.cutoffsJson.set(r.config.cutoffs ? pretty(r.config.cutoffs) : '');
        this.compositeJson.set(r.config.composite ? pretty(r.config.composite) : '');
        this.scheduleJson.set(r.config.schedule ? pretty(r.config.schedule) : '');
        this.defaultCutoffsJson.set(pretty(r.defaults.cutoffs));
        this.defaultCompositeJson.set(pretty(r.defaults.composite));
        this.defaultScheduleJson.set(pretty(r.defaults.schedule));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.loadCandidates();
    this.api.orgMembers().subscribe({ next: (r) => this.members.set(r.members) });
    this.api.adminRiskFields().subscribe({ next: (r) => this.fieldCandidates.set(r) });
  }

  private loadCandidates(probe?: number): void {
    this.api.adminRiskBoards(probe).subscribe({
      next: (r) => {
        this.candidates.set(r.boards);
        this.probeError.set(r.probeError);
      },
      error: () => this.candidates.set([]),
    });
  }

  value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
  label(k: FieldKey): string {
    return FIELD_LABELS[k];
  }
  options(k: FieldKey): RiskFieldOption[] {
    return this.fieldCandidates()?.[k] ?? [];
  }
  isPicked(boardId: number): boolean {
    return this.picked().some((b) => b.boardId === boardId);
  }

  toggleBoard(b: RiskBoardCandidate, e: Event): void {
    const on = (e.target as HTMLInputElement).checked;
    this.picked.update((list) =>
      on
        ? [...list.filter((x) => x.boardId !== b.boardId), { boardId: b.boardId, name: b.name }]
        : list.filter((x) => x.boardId !== b.boardId),
    );
    if (on) this.loadCandidates(b.boardId); // probe #1 on the board just picked
  }

  setField(k: FieldKey, e: Event): void {
    const v = this.value(e);
    this.fields.update((f) => ({ ...f, [k]: v || null }));
  }

  save(): void {
    let body: PutRiskConfigRequest;
    try {
      body = {
        boards: this.picked(),
        cutoffs: parseOrNull(this.cutoffsJson()),
        composite: parseOrNull(this.compositeJson()),
        schedule: parseOrNull(this.scheduleJson()),
        fields: this.fields(),
        inProgressStatus: this.inProgressStatus().trim() || null,
        refresherAccountId: this.refresherAccountId(),
      };
    } catch {
      this.message.set({ ok: false, text: 'One of the JSON blocks is not valid JSON.' });
      return;
    }
    this.saving.set(true);
    this.api.putRiskConfig(body).subscribe({
      next: () => {
        this.saving.set(false);
        this.message.set({ ok: true, text: 'Saved. The next refresh picks this up.' });
      },
      error: (e: { error?: { error?: string } }) => {
        this.saving.set(false);
        this.message.set({ ok: false, text: e.error?.error ?? 'Could not save.' });
      },
    });
  }
}

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** Blank textarea = "use the code defaults" (stored as NULL). Throws on bad JSON,
 *  which save() turns into an inline message. */
function parseOrNull<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as T;
}
