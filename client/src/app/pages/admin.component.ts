import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ConfigResponse, Team, TeamMembership } from '@shared/contracts';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';

// Admin screens: teams, effective-dated memberships, admin appointment (with the
// last-admin guard surfaced from the API), and the done-status set.
@Component({
  selector: 'sp-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <h2>Admin</h2>

    <div class="panel">
      <h3>Teams</h3>
      <div class="row">
        <input [(ngModel)]="newTeamName" placeholder="New team name" />
        <button class="primary" (click)="createTeam()">Create team</button>
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
        <input [(ngModel)]="assignAccountId" placeholder="accountId" />
        <select [(ngModel)]="assignTeamId">
          <option value="" disabled selected>team…</option>
          @for (t of teams(); track t.teamId) { <option [value]="t.teamId">{{ t.name }}</option> }
        </select>
        <button class="primary" (click)="assign()">Assign</button>
      </div>
      <p class="muted" style="font-size:12px">Writes an effective-dated membership; the prior open membership is closed at "now".</p>
    </div>

    <div class="panel">
      <h3>Admins</h3>
      <div class="row">
        <input [(ngModel)]="appointAccountId" placeholder="accountId to appoint" />
        <button class="primary" (click)="appoint()">Appoint admin</button>
      </div>
      <div class="row" style="margin-top:8px">
        <input [(ngModel)]="revokeAccountId" placeholder="accountId to revoke" />
        <button (click)="revoke()">Revoke admin</button>
      </div>
      @if (adminMsg()) { <p class="muted">{{ adminMsg() }}</p> }
    </div>

    <div class="panel">
      <h3>Done statuses</h3>
      <p class="muted" style="font-size:12px">Comma-separated status names counted as "done". Empty = use Jira's Done category.</p>
      <div class="row">
        <input [(ngModel)]="doneNames" placeholder="Done, Shipped, Released" style="flex:1" />
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

  newTeamName = '';
  assignAccountId = '';
  assignTeamId = '';
  appointAccountId = '';
  revokeAccountId = '';
  doneNames = '';

  ngOnInit(): void {
    this.refreshTeams();
    this.api.adminConfig().subscribe((c: ConfigResponse) => (this.doneNames = c.doneStatusNames.join(', ')));
  }

  private refreshTeams(): void {
    this.api.teams().subscribe((r) => this.teams.set(r.teams));
  }

  createTeam(): void {
    const name = this.newTeamName.trim();
    const cloudId = this.auth.me()?.cloudId;
    if (!name || !cloudId) return;
    this.api.createTeam({ cloudId, name }).subscribe(() => {
      this.newTeamName = '';
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
    if (!this.assignAccountId || !this.assignTeamId) return;
    this.api
      .assignMembership({ accountId: this.assignAccountId.trim(), teamId: this.assignTeamId })
      .subscribe(() => (this.assignAccountId = ''));
  }

  appoint(): void {
    if (!this.appointAccountId) return;
    this.api.appointAdmin({ accountId: this.appointAccountId.trim() }).subscribe(() => {
      this.adminMsg.set('Appointed.');
      this.appointAccountId = '';
    });
  }

  revoke(): void {
    if (!this.revokeAccountId) return;
    this.api.revokeAdmin(this.revokeAccountId.trim()).subscribe({
      next: () => {
        this.adminMsg.set('Revoked.');
        this.revokeAccountId = '';
      },
      error: (e) => this.adminMsg.set(e?.error?.error ?? 'Revoke failed (last-admin guard?)'),
    });
  }

  saveDone(): void {
    const cloudId = this.auth.me()?.cloudId;
    if (!cloudId) return;
    const names = this.doneNames.split(',').map((s) => s.trim()).filter(Boolean);
    this.api.setDoneStatuses({ cloudId, doneStatusNames: names }).subscribe(() => this.adminMsg.set('Done statuses saved.'));
  }
}
