import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ApiError, OrgMember } from '@shared/contracts';
import type {
  PutRiskConfigRequest,
  RiskBoardCandidate,
  RiskBoardRef,
  RiskColumnsResponse,
  RiskCompositeConfig,
  RiskCutoffs,
  RiskFieldCandidatesResponse,
  RiskFieldOption,
  RiskWorkSchedule,
} from '@shared/risk';
import { scheduleDaysSummary, workHoursPerWeek } from '@shared/risk-cutoffs';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';
import { RiskCompositeEditorComponent } from './composite-editor.component';
import { RiskCutoffsEditorComponent } from './cutoffs-editor.component';
import { targetChecked, targetValue } from './dom-events';
import { RiskImpactPreviewComponent } from './impact-preview.component';

type FieldKey = 'flagged' | 'rejections' | 'implementor' | 'codeReviewer';

const FIELD_LABELS: Record<FieldKey, string> = {
  flagged: 'Flagged (blocked)',
  rejections: 'Code-review rejections',
  implementor: 'Developer',
  codeReviewer: 'Reviewer',
};

// Per-site risk-board configuration. Nothing here is secret (board ids, cutoff
// tables, an account id), so unlike the notification-channel panel the stored
// values are read back and shown.
//
// This component owns boards / refresher / fields / save; the cutoff table itself
// is <sp-risk-cutoffs> (cutoffs-editor.component.ts), which replaced the raw-JSON
// textarea. Composite weights and the work schedule are still JSON here — the
// composite weights are <sp-risk-composite>. The work schedule is still JSON — a
// visual 7-day + timezone editor is deferred (see DEFERRED.md).
@Component({
  selector: 'sp-risk-admin',
  standalone: true,
  imports: [
    RouterLink,
    RiskCompositeEditorComponent,
    RiskCutoffsEditorComponent,
    RiskImpactPreviewComponent,
  ],
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

      @if (defaultCutoffs(); as defs) {
        <sp-risk-cutoffs
          [cutoffs]="serverCutoffs()"
          [defaults]="defs"
          [schedule]="effectiveSchedule()"
          [scheduleIsCustom]="scheduleIsCustom()"
          [columns]="columnsInfo()"
          [columnsError]="columnsError()"
          [boardsAwaitingSave]="boardsAwaitingSave()"
          (cutoffsChange)="cutoffs.set($event)"
        ></sp-risk-cutoffs>
      }

      @if (defaultComposite(); as dc) {
        <sp-risk-composite
          [composite]="serverComposite()"
          [defaults]="dc"
          [schedule]="effectiveSchedule()"
          (compositeChange)="composite.set($event)"
        ></sp-risk-composite>
      }

      <div class="panel">
        <h3>Work schedule</h3>
        <p class="muted" style="font-size:12px">
          Blank = the built-in schedule (and clearing the box resets to it). The
          server validates the shape and the timezone before saving. Currently:
          <strong>{{ scheduleSummary() }}</strong>.
        </p>
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

      <!-- Last thing before Save, deliberately: it answers "what will this do?"
           for the two editors AND the schedule box above it. -->
      <sp-risk-impact
        [cutoffs]="cutoffs()"
        [composite]="composite()"
        [schedule]="effectiveSchedule()"
        [reloadKey]="savedAt()"
      ></sp-risk-impact>

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
  /** Bumped on a successful save so the impact preview re-runs against the config
   *  the server now holds (its "before" is the stored snapshot, not the form). */
  savedAt = signal(0);
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
  scheduleJson = signal('');
  // The cutoff table is a structured model now, not text: null = follow the shipped
  // defaults (stored NULL), which is what <sp-risk-cutoffs> emits when its switch
  // is on. `defaultCutoffs` is the read-only reference the editor renders then.
  //
  // THE SPLIT IS LOAD-BEARING — do not collapse these back into one signal.
  // `serverCutoffs` is what `[cutoffs]` binds to and is written ONLY here on load
  // and on a successful save. `cutoffs` is the DRAFT, written ONLY by
  // `(cutoffsChange)`, and read by save() and the impact preview. With one signal
  // the editor's own emit flowed straight back into its own input, whose effect
  // re-ran `load()` — which re-collapses the model — so every keystroke clobbered
  // the edit, deleted a just-added row, and re-announced "repaired N rules". After
  // the split the editor is UNCONTROLLED after mount: its input effect fires on a
  // real reload only. Same split on composite for symmetry; benign there today
  // (normalize() is idempotent), but the asymmetry is the trap.
  serverCutoffs = signal<RiskCutoffs | null>(null);
  cutoffs = signal<RiskCutoffs | null>(null);
  defaultCutoffs = signal<RiskCutoffs | null>(null);
  serverComposite = signal<RiskCompositeConfig | null>(null);
  composite = signal<RiskCompositeConfig | null>(null);
  defaultComposite = signal<RiskCompositeConfig | null>(null);
  defaultSchedule = signal<RiskWorkSchedule | null>(null);
  columnsInfo = signal<RiskColumnsResponse | null>(null);
  columnsError = signal<string | null>(null);
  // Read-only reference copy of the shipped default (never written back).
  defaultScheduleJson = signal('');
  defaultInProgress = signal('In Progress');

  /** The schedule the metrics are actually measured on, so the editor's units
   *  caption is derived from real data. Reads the (live) JSON box first, so
   *  editing the schedule immediately changes what "24 hours" means. */
  effectiveSchedule = computed<RiskWorkSchedule>(() => {
    const typed = safeParse<RiskWorkSchedule>(this.scheduleJson());
    return typed ?? this.defaultSchedule() ?? FALLBACK_SCHEDULE;
  });
  scheduleIsCustom = computed(() => safeParse<RiskWorkSchedule>(this.scheduleJson()) !== null);
  /** Boards ticked in the picker that the columns endpoint doesn't know about yet.
   *  Ticking a board genuinely CANNOT populate the Scope picker before a save —
   *  `listRiskColumns` iterates the SAVED `cfg.boards` — so say so rather than
   *  silently doing nothing. */
  boardsAwaitingSave = computed<string[]>(() => {
    const known = this.columnsInfo()?.boards;
    if (!known) return [];
    const ids = new Set(known.map((b) => b.boardId));
    return this.picked()
      .filter((b) => !ids.has(b.boardId))
      .map((b) => b.name);
  });
  /** "40 work hours/week (Mon–Thu 9–18, Fri 9–13, America/New_York)" — the derived
   *  summary the plan asks for wherever hours are entered. */
  scheduleSummary = computed(() => {
    const s = this.effectiveSchedule();
    return `${workHoursPerWeek(s)} work hours/week (${scheduleDaysSummary(s)}, ${s.timeZone})`;
  });

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
        this.serverCutoffs.set(r.config.cutoffs);
        this.cutoffs.set(r.config.cutoffs);
        this.defaultCutoffs.set(r.defaults.cutoffs);
        this.serverComposite.set(r.config.composite);
        this.composite.set(r.config.composite);
        this.defaultComposite.set(r.defaults.composite);
        this.defaultSchedule.set(r.defaults.schedule);
        this.scheduleJson.set(r.config.schedule ? pretty(r.config.schedule) : '');
        this.defaultScheduleJson.set(pretty(r.defaults.schedule));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.loadCandidates();
    this.api.orgMembers().subscribe({ next: (r) => this.members.set(r.members) });
    this.loadColumns();
    this.api.adminRiskFields().subscribe({ next: (r) => this.fieldCandidates.set(r) });
  }

  /** Board columns for the cutoff editor's Scope picker. Served from the stored
   *  snapshots, so this normally costs no Jira calls. Extracted from ngOnInit
   *  because it must ALSO run after a successful save — `listRiskColumns` iterates
   *  the SAVED `cfg.boards`, so that is the only moment new columns can appear. */
  private loadColumns(): void {
    this.api.adminRiskColumns().subscribe({
      next: (r) => {
        this.columnsInfo.set(r);
        this.columnsError.set(null);
      },
      // A silent failure used to leave `columnsInfo` null, which both empties the
      // Scope picker AND makes `pointsMissing()` false — so the "no Story Points
      // field" warning could never fire and nobody learned why size rules were dead.
      error: (e: { error?: ApiError }) =>
        this.columnsError.set(e.error?.error ?? 'Could not load board columns.'),
    });
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

  /** Reads go through `dom-events.ts` so the `<wa-select>` `string | null | string[]`
   *  normalization lives in exactly one place. */
  value(e: Event): string {
    return targetValue(e);
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
    const on = targetChecked(e);
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
        cutoffs: this.cutoffs(),
        composite: this.composite(),
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
        this.savedAt.update((n) => n + 1);
        // The server now holds exactly what we sent, so re-baseline the editors'
        // inputs from the body (not from a refetch). This is the ONLY other write
        // to serverCutoffs/serverComposite besides ngOnInit.
        this.serverCutoffs.set(body.cutoffs ?? null);
        this.serverComposite.set(body.composite ?? null);
        // The only moment new columns can appear: `listRiskColumns` iterates the
        // SAVED cfg.boards, so a board ticked before this save had no columns to
        // offer until now.
        this.loadColumns();
        this.message.set({ ok: true, text: 'Saved. The next refresh picks this up.' });
      },
      error: (e: { error?: ApiError }) => {
        this.saving.set(false);
        // The cutoff validator returns per-rule issues; show them rather than the
        // generic "invalid cutoffs".
        const issues = e.error?.issues ?? [];
        this.message.set({
          ok: false,
          text: issues.length
            ? issues.map((i) => i.message).join(' · ')
            : (e.error?.error ?? 'Could not save.'),
        });
      },
    });
  }
}

/** Last-resort schedule if neither the org nor the server's defaults have loaded
 *  yet — only ever used for the units caption while the page is still fetching. */
const FALLBACK_SCHEDULE: RiskWorkSchedule = {
  timeZone: 'UTC',
  days: { Mon: [9, 17], Tue: [9, 17], Wed: [9, 17], Thu: [9, 17], Fri: [9, 17], Sat: null, Sun: null },
};

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** Non-throwing variant of parseOrNull, for the derived (display-only) reads. */
function safeParse<T>(raw: string): T | null {
  try {
    return parseOrNull<T>(raw);
  } catch {
    return null;
  }
}

/** Blank textarea = "use the code defaults" (stored as NULL). Throws on bad JSON,
 *  which save() turns into an inline message. */
function parseOrNull<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as T;
}
