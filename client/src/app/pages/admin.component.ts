import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormField, form, required } from '@angular/forms/signals';
import type { ConfigResponse, Team, TeamMembership } from '@shared/contracts';
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
  imports: [FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Admin</h2>

    <div class="panel">
      <h3>Teams</h3>
      <div class="row">
        <input [formField]="adminForm.newTeamName" placeholder="New team name" />
        <button class="primary" [disabled]="adminForm.newTeamName().invalid()" (click)="createTeam()">
          Create team
        </button>
      </div>
      <table style="margin-top:10px">
        <tbody>
          @for (t of teams(); track t.teamId) {
            <tr>
              <td><strong>{{ t.name }}</strong> <span class="muted">({{ t.teamId.slice(0, 8) }})</span></td>
              <td><button (click)="loadMembers(t)">Members</button></td>
            </tr>
            @if (openTeam() === t.teamId) {
              <tr><td colspan="2">
                @for (m of members(); track m.accountId + m.effectiveFrom) {
                  <div class="muted">{{ m.displayName }} · from {{ m.effectiveFrom }}{{ m.effectiveTo ? ' to ' + m.effectiveTo : ' (current)' }}</div>
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
        <input [formField]="adminForm.assignAccountId" placeholder="accountId" />
        <select [formField]="adminForm.assignTeamId">
          <option value="" disabled>team…</option>
          @for (t of teams(); track t.teamId) { <option [value]="t.teamId">{{ t.name }}</option> }
        </select>
        <button
          class="primary"
          [disabled]="adminForm.assignAccountId().invalid() || adminForm.assignTeamId().invalid()"
          (click)="assign()"
        >
          Assign
        </button>
      </div>
      <p class="muted" style="font-size:12px">Writes an effective-dated membership; the prior open membership is closed at "now".</p>
    </div>

    <div class="panel">
      <h3>Admins</h3>
      <div class="row">
        <input [formField]="adminForm.appointAccountId" placeholder="accountId to appoint" />
        <button class="primary" [disabled]="adminForm.appointAccountId().invalid()" (click)="appoint()">
          Appoint admin
        </button>
      </div>
      <div class="row" style="margin-top:8px">
        <input [formField]="adminForm.revokeAccountId" placeholder="accountId to revoke" />
        <button [disabled]="adminForm.revokeAccountId().invalid()" (click)="revoke()">Revoke admin</button>
      </div>
      @if (adminMsg()) { <p class="muted">{{ adminMsg() }}</p> }
    </div>

    <div class="panel">
      <h3>Done statuses</h3>
      <p class="muted" style="font-size:12px">Comma-separated status names counted as "done". Empty = use Jira's Done category.</p>
      <div class="row">
        <input [formField]="adminForm.doneNames" placeholder="Done, Shipped, Released" style="flex:1" />
        <button class="primary" (click)="saveDone()">Save</button>
      </div>
    </div>
  `,
})
export class AdminComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  teams = signal<Team[]>([]);
  members = signal<TeamMembership[]>([]);
  openTeam = signal<string | null>(null);
  adminMsg = signal('');

  // Signal Forms model — all string fields, no null/undefined initial values.
  protected readonly adminModel = signal({
    newTeamName: '',
    assignAccountId: '',
    assignTeamId: '',
    appointAccountId: '',
    revokeAccountId: '',
    doneNames: '',
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
    this.api.adminConfig().subscribe((c: ConfigResponse) =>
      this.adminModel.update((m) => ({ ...m, doneNames: c.doneStatusNames.join(', ') })),
    );
  }

  private refreshTeams(): void {
    this.api.teams().subscribe((r) => this.teams.set(r.teams));
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
}
