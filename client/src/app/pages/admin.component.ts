import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { form, required } from '@angular/forms/signals';
import type { ConfigResponse, FieldOption, OrgMember, Team, TeamMembership } from '@shared/contracts';
import type { AdminChannelConfigItem } from '@shared/notifications';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';

// Admin screens: teams, effective-dated memberships, admin appointment (with the
// last-admin guard surfaced from the API), and the done-status set. Built with
// Signal Forms — one model, per-field `required` rules, each action button gated
// on its own field's validity (the fields drive independent actions, so a single
// form-level submit would wrongly cross-block them).
@Component({
  selector: 'sp-admin',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Admin</h2>

    <div class="panel">
      <h3>Teams</h3>
      <div class="row">
        <wa-input
          placeholder="New team name"
          [value]="adminModel().newTeamName"
          (input)="setField('newTeamName', $event)"
        ></wa-input>
        <wa-button variant="brand" [disabled]="adminForm.newTeamName().invalid()" (click)="createTeam()">
          Create team
        </wa-button>
      </div>
      <table style="margin-top:10px">
        <tbody>
          @for (t of teams(); track t.teamId) {
            <tr>
              <td><strong>{{ t.name }}</strong> <span class="muted">({{ t.teamId.slice(0, 8) }})</span></td>
              <td><wa-button size="small" appearance="outlined" (click)="loadMembers(t)">Members</wa-button></td>
            </tr>
            @if (openTeam() === t.teamId) {
              <tr><td colspan="2">
                @for (m of members(); track m.accountId) {
                  <div class="muted">{{ m.displayName }} · since {{ m.effectiveFrom }}</div>
                }
              </td></tr>
            }
          }
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h3>Assign member to team</h3>
      <div class="row">
        <wa-select
          with-clear
          placeholder="member…"
          [value]="adminModel().assignAccountId"
          (change)="setField('assignAccountId', $event)"
        >
          @for (mem of orgMembers(); track mem.accountId) {
            <wa-option [value]="mem.accountId">{{ mem.displayName }}</wa-option>
          }
        </wa-select>
        <wa-select
          placeholder="team…"
          [value]="adminModel().assignTeamId"
          (change)="setField('assignTeamId', $event)"
        >
          @for (t of teams(); track t.teamId) {
            <wa-option [value]="t.teamId">{{ t.name }}</wa-option>
          }
        </wa-select>
        <wa-button
          variant="brand"
          [disabled]="adminForm.assignAccountId().invalid() || adminForm.assignTeamId().invalid()"
          (click)="assign()"
        >
          Assign
        </wa-button>
      </div>
      <p class="muted" style="font-size:12px">Writes an effective-dated membership; the prior open membership is closed at "now".</p>
    </div>

    <div class="panel">
      <h3>Admins</h3>
      <div class="row">
        <wa-select
          with-clear
          placeholder="member to appoint…"
          [value]="adminModel().appointAccountId"
          (change)="setField('appointAccountId', $event)"
        >
          @for (mem of orgMembers(); track mem.accountId) {
            <wa-option [value]="mem.accountId">{{ mem.displayName }}</wa-option>
          }
        </wa-select>
        <wa-button variant="brand" [disabled]="adminForm.appointAccountId().invalid()" (click)="appoint()">
          Appoint admin
        </wa-button>
      </div>
      <div class="row" style="margin-top:8px">
        <wa-select
          with-clear
          placeholder="member to revoke…"
          [value]="adminModel().revokeAccountId"
          (change)="setField('revokeAccountId', $event)"
        >
          @for (mem of orgMembers(); track mem.accountId) {
            <wa-option [value]="mem.accountId">{{ mem.displayName }}</wa-option>
          }
        </wa-select>
        <wa-button appearance="outlined" variant="danger" [disabled]="adminForm.revokeAccountId().invalid()" (click)="revoke()">Revoke admin</wa-button>
      </div>
      @if (adminMsg()) { <wa-callout variant="neutral" style="margin-top:8px">{{ adminMsg() }}</wa-callout> }
    </div>

    <div class="panel">
      <h3>Done statuses</h3>
      <p class="muted" style="font-size:12px">Comma-separated status names counted as "done". Empty = use Jira's Done category.</p>
      <div class="row">
        <wa-input
          placeholder="Done, Shipped, Released"
          style="flex:1"
          [value]="adminModel().doneNames"
          (input)="setField('doneNames', $event)"
        ></wa-input>
        <wa-button variant="brand" (click)="saveDone()">Save</wa-button>
      </div>
    </div>

    <div class="panel">
      <h3>Custom fields</h3>
      <p class="muted" style="font-size:12px">
        Jira's Story Points / Sprint field ids vary per instance. Auto-detection picks them
        when unambiguous; when more than one matches, choose here. Story points and sprints
        stay empty until both are set.
      </p>
      <div class="row">
        <label style="min-width:90px">Story Points</label>
        <wa-select
          placeholder="Story Points field…"
          [value]="adminModel().spFieldId"
          (change)="setField('spFieldId', $event)"
        >
          @for (f of spOptions(); track f.id) {
            <wa-option [value]="f.id">{{ f.name }} ({{ f.id }})</wa-option>
          }
        </wa-select>
      </div>
      <div class="row" style="margin-top:8px">
        <label style="min-width:90px">Sprint</label>
        <wa-select
          placeholder="Sprint field…"
          [value]="adminModel().sprintFieldId"
          (change)="setField('sprintFieldId', $event)"
        >
          @for (f of sprintOptions(); track f.id) {
            <wa-option [value]="f.id">{{ f.name }} ({{ f.id }})</wa-option>
          }
        </wa-select>
        <wa-button
          variant="brand"
          [disabled]="!adminModel().spFieldId || !adminModel().sprintFieldId"
          (click)="saveFields()"
        >
          Save
        </wa-button>
      </div>
      @if (fieldsMsg()) { <wa-callout variant="neutral" style="margin-top:8px">{{ fieldsMsg() }}</wa-callout> }
    </div>

    <div class="panel">
      <h3>Notification channels</h3>
      <p class="muted" style="font-size:12px">
        These credentials are shared by everyone on this site — users only choose
        whether to receive notifications, never how to send them. Stored encrypted
        server-side and write-only: saving verifies them live with the vendor; to
        change anything, re-enter all fields.
      </p>
      @for (c of adminChannels(); track c.descriptor.channel) {
        <div style="margin-top:10px">
          <div class="row">
            <strong>{{ c.descriptor.displayName }}</strong>
            <wa-tag size="small" [attr.variant]="c.configured ? 'success' : 'neutral'">
              {{ configuredLabel(c) }}
            </wa-tag>
          </div>
          <!-- Non-secret echo only: the server sends "summary" as an adapter-declared
               allow-list (site / fromAddress), never anything from the sealed box. -->
          @for (line of summaryLines(c); track line) {
            <div class="muted" style="font-size:12px">{{ line }}</div>
          }
          @if (configuredHint(c); as hint) {
            <div class="muted" style="font-size:12px">{{ hint }}</div>
          }
          <!-- Vendor-agnostic: the server's requestedFields drive the inputs. -->
          @for (f of c.descriptor.requestedFields ?? []; track f) {
            <div class="row" style="margin-top:8px">
              <label style="min-width:110px">{{ f }}</label>
              <wa-input
                style="flex:1"
                [attr.type]="isSecretField(f) ? 'password' : 'text'"
                autocomplete="off"
                [attr.placeholder]="f"
                [value]="channelFieldValue(c.descriptor.channel, f)"
                (input)="setChannelField(c.descriptor.channel, f, $event)"
              ></wa-input>
            </div>
          }
          <div class="row" style="margin-top:8px">
            <wa-button
              variant="brand"
              [disabled]="!channelComplete(c) || busyChannel() === c.descriptor.channel"
              (click)="saveChannel(c)"
            >
              Save
            </wa-button>
            @if (c.configuredAt) {
              <wa-button
                appearance="outlined"
                variant="danger"
                [disabled]="busyChannel() === c.descriptor.channel"
                (click)="removeChannelConfig(c)"
              >
                Remove configuration
              </wa-button>
            }
          </div>
          @if (channelMsg()[c.descriptor.channel]; as msg) {
            <wa-callout [attr.variant]="msg.ok ? 'success' : 'danger'" style="margin-top:8px">
              {{ msg.text }}
            </wa-callout>
          }
        </div>
      } @empty {
        <p class="muted">No channels take per-site configuration.</p>
      }
    </div>
  `,
})
export class AdminComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  teams = signal<Team[]>([]);
  orgMembers = signal<OrgMember[]>([]);
  members = signal<TeamMembership[]>([]);
  openTeam = signal<string | null>(null);
  adminMsg = signal('');
  spOptions = signal<FieldOption[]>([]);
  sprintOptions = signal<FieldOption[]>([]);
  fieldsMsg = signal('');

  // Per-org notification-channel config. Dynamic field set (the descriptor's
  // requestedFields), so plain signals rather than the static Signal Forms model.
  adminChannels = signal<AdminChannelConfigItem[]>([]);
  private channelFields = signal<Record<string, Record<string, string>>>({});
  channelMsg = signal<Record<string, { ok: boolean; text: string }>>({});
  busyChannel = signal<string | null>(null);

  // Signal Forms model — all string fields, no null/undefined initial values.
  protected readonly adminModel = signal({
    newTeamName: '',
    assignAccountId: '',
    assignTeamId: '',
    appointAccountId: '',
    revokeAccountId: '',
    doneNames: '',
    spFieldId: '',
    sprintFieldId: '',
  });

  protected readonly adminForm = form(this.adminModel, (s) => {
    required(s.newTeamName, { message: 'Team name is required' });
    required(s.assignAccountId, { message: 'accountId is required' });
    required(s.assignTeamId, { message: 'Pick a team' });
    required(s.appointAccountId, { message: 'accountId is required' });
    required(s.revokeAccountId, { message: 'accountId is required' });
    // doneNames is intentionally optional (empty = use Jira's Done category).
  });

  ngOnInit(): void {
    this.refreshTeams();
    this.refreshChannelConfigs();
    this.api.orgMembers().subscribe((r) => this.orgMembers.set(r.members));
    this.api.adminConfig().subscribe((c: ConfigResponse) =>
      this.adminModel.update((m) => ({ ...m, doneNames: c.doneStatusNames.join(', ') })),
    );
    this.api.adminFields().subscribe({
      next: (r) => {
        this.spOptions.set(r.storyPoints);
        this.sprintOptions.set(r.sprint);
        // Pre-select the configured id, else the sole candidate (nothing when
        // ambiguous, so the admin is forced to choose).
        const pick = (cur: string | null, opts: FieldOption[]) =>
          cur ?? (opts.length === 1 ? opts[0]!.id : '');
        this.adminModel.update((m) => ({
          ...m,
          spFieldId: pick(r.current.storyPointsFieldId, r.storyPoints),
          sprintFieldId: pick(r.current.sprintFieldId, r.sprint),
        }));
      },
      error: (e) => this.fieldsMsg.set(e?.error?.error ?? 'Could not load Jira fields'),
    });
  }

  private refreshTeams(): void {
    this.api.teams().subscribe((r) => this.teams.set(r.teams));
  }

  private refreshChannelConfigs(): void {
    this.api.adminChannelConfigs().subscribe((r) => this.adminChannels.set(r.channels));
  }

  channelFieldValue(channel: string, field: string): string {
    return this.channelFields()[channel]?.[field] ?? '';
  }

  /** Mask credential-like fields (apiKey, webhookToken) as passwords; leave
   *  non-secret config (site, botEmail) legible. Names come from the descriptor. */
  protected isSecretField(field: string): boolean {
    return /key|token|secret|password/i.test(field);
  }

  /** The adapter-declared non-secret echo, as "key: value" lines. */
  protected summaryLines(c: AdminChannelConfigItem): string[] {
    const summary = c.summary ?? {};
    return Object.keys(summary).map((k) => `${k}: ${summary[k]}`);
  }

  /** Three states, not two: an org row (removable), the deployment-wide legacy
   *  env fallback (deliverable but NOT ours to remove — there is no row), and
   *  nothing. */
  protected configuredLabel(c: AdminChannelConfigItem): string {
    if (!c.configured) return 'Not configured';
    return c.configuredAt ? 'Configured' : 'Provisioned by the operator';
  }

  /** "Configured <date>" — formatted here rather than with a DatePipe, which this
   *  component doesn't import. */
  protected configuredHint(c: AdminChannelConfigItem): string | null {
    if (!c.configuredAt) {
      return c.configured
        ? 'Delivering with the deployment-wide legacy env config. Save fields here to provision this site; there is nothing site-specific to remove.'
        : null;
    }
    const d = new Date(c.configuredAt);
    if (Number.isNaN(d.getTime())) return null;
    const by = c.configuredBy ? ` by ${c.configuredBy}` : '';
    return `Configured ${d.toLocaleDateString()}${by}`;
  }

  removeChannelConfig(c: AdminChannelConfigItem): void {
    const channel = c.descriptor.channel;
    this.busyChannel.set(channel);
    this.api.unconfigureChannel(channel).subscribe({
      next: () => {
        this.busyChannel.set(null);
        this.channelMsg.update((m) => ({
          ...m,
          [channel]: { ok: true, text: 'Configuration removed — this channel is now off for the site.' },
        }));
        // Write-only secrets: clear the inputs rather than leaving them on screen.
        this.channelFields.update((m) => ({ ...m, [channel]: {} }));
        this.refreshChannelConfigs();
      },
      error: (e) => {
        this.busyChannel.set(null);
        this.channelMsg.update((m) => ({
          ...m,
          [channel]: { ok: false, text: e?.error?.error ?? 'Remove failed' },
        }));
      },
    });
  }

  setChannelField(channel: string, field: string, ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.channelFields.update((m) => ({ ...m, [channel]: { ...m[channel], [field]: value } }));
  }

  channelComplete(c: AdminChannelConfigItem): boolean {
    // No per-field validation (admin tool) — just require every requested field.
    return (c.descriptor.requestedFields ?? []).every(
      (f) => this.channelFieldValue(c.descriptor.channel, f).trim().length > 0,
    );
  }

  saveChannel(c: AdminChannelConfigItem): void {
    const channel = c.descriptor.channel;
    this.busyChannel.set(channel);
    this.api.configureChannel(channel, this.channelFields()[channel] ?? {}).subscribe({
      next: () => {
        this.busyChannel.set(null);
        this.channelMsg.update((m) => ({
          ...m,
          [channel]: { ok: true, text: 'Saved — credentials verified.' },
        }));
        // Write-only secrets: clear the inputs rather than leaving them on screen.
        this.channelFields.update((m) => ({ ...m, [channel]: {} }));
        this.refreshChannelConfigs();
      },
      error: (e) => {
        this.busyChannel.set(null);
        // The adapter's human-readable message (400 body) surfaces verbatim.
        this.channelMsg.update((m) => ({
          ...m,
          [channel]: { ok: false, text: e?.error?.error ?? 'Save failed' },
        }));
      },
    });
  }

  /** Bridge a webawesome <wa-input>/<wa-select> value into the Signal Forms model.
   *  The directive-based `[formField]` doesn't bind to custom elements, so we sync
   *  the model by hand; the `required` validators derive from the model, so
   *  button-gating still works. */
  setField(key: keyof ReturnType<typeof this.adminModel>, ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.adminModel.update((m) => ({ ...m, [key]: value }));
  }

  createTeam(): void {
    const name = this.adminModel().newTeamName.trim();
    const cloudId = this.auth.me()?.cloudId;
    if (!name || !cloudId) return;
    this.api.createTeam({ cloudId, name }).subscribe(() => {
      this.adminModel.update((m) => ({ ...m, newTeamName: '' }));
      this.refreshTeams();
    });
  }

  loadMembers(t: Team): void {
    if (this.openTeam() === t.teamId) {
      this.openTeam.set(null);
      return;
    }
    this.openTeam.set(t.teamId);
    this.api.memberships(t.teamId).subscribe((r) => this.members.set(r.members));
  }

  assign(): void {
    const { assignAccountId, assignTeamId } = this.adminModel();
    if (!assignAccountId || !assignTeamId) return;
    this.api
      .assignMembership({ accountId: assignAccountId.trim(), teamId: assignTeamId })
      .subscribe(() => this.adminModel.update((m) => ({ ...m, assignAccountId: '' })));
  }

  appoint(): void {
    const accountId = this.adminModel().appointAccountId.trim();
    if (!accountId) return;
    this.api.appointAdmin({ accountId }).subscribe(() => {
      this.adminMsg.set('Appointed.');
      this.adminModel.update((m) => ({ ...m, appointAccountId: '' }));
    });
  }

  revoke(): void {
    const accountId = this.adminModel().revokeAccountId.trim();
    if (!accountId) return;
    this.api.revokeAdmin(accountId).subscribe({
      next: () => {
        this.adminMsg.set('Revoked.');
        this.adminModel.update((m) => ({ ...m, revokeAccountId: '' }));
      },
      error: (e) => this.adminMsg.set(e?.error?.error ?? 'Revoke failed (last-admin guard?)'),
    });
  }

  saveDone(): void {
    const cloudId = this.auth.me()?.cloudId;
    if (!cloudId) return;
    const names = this.adminModel()
      .doneNames.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.api
      .setDoneStatuses({ cloudId, doneStatusNames: names })
      .subscribe(() => this.adminMsg.set('Done statuses saved.'));
  }

  saveFields(): void {
    const cloudId = this.auth.me()?.cloudId;
    const { spFieldId, sprintFieldId } = this.adminModel();
    if (!cloudId || !spFieldId || !sprintFieldId) return;
    this.api
      .setFields({ cloudId, storyPointsFieldId: spFieldId, sprintFieldId })
      .subscribe({
        next: () => this.fieldsMsg.set('Custom fields saved. They apply on the next poll.'),
        error: (e) => this.fieldsMsg.set(e?.error?.error ?? 'Save failed'),
      });
  }
}
