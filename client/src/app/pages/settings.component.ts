import { CUSTOM_ELEMENTS_SCHEMA, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MAX_DAILY_GOAL } from '@shared/domain';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';
import { AvatarComponent } from '../ui/avatar.component';

// Personal settings. Currently just the daily goal that drives the tracker's
// goal-progress panel; the profile row at the top is the destination the header
// avatar chip links to.
@Component({
  selector: 'sp-settings',
  standalone: true,
  imports: [AvatarComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <h2>Settings</h2>

    @if (auth.me(); as me) {
      <div class="panel row" style="gap:12px">
        <sp-avatar [name]="me.displayName" [url]="me.avatarUrl" [size]="40" />
        <div>
          <strong>{{ me.displayName }}</strong>
          @if (me.sites.length > 0) {
            <div class="muted" style="font-size:12px">
              {{ currentSiteName() }}
            </div>
          }
        </div>
      </div>

      <div class="panel">
        <h3 style="margin-top:0">Daily goal</h3>
        <p class="muted">
          How many claimed points make a full day for you? The tracker will show
          how your day is adding up against it, with a milestone at every
          quarter — so a goal of 16 celebrates 4, 8, 12 and 16.
        </p>
        <div class="row" style="gap:8px">
          <wa-input
            #goal
            type="number"
            min="1"
            [attr.max]="maxGoal"
            step="1"
            placeholder="e.g. 16"
            style="width:120px"
            [value]="me.dailyGoal ?? ''"
            [disabled]="saving()"
          ></wa-input>
          <wa-button
            variant="brand"
            [loading]="saving()"
            [disabled]="!goal.value"
            (click)="save(goal)"
            >Save</wa-button
          >
          @if (me.dailyGoal !== null) {
            <wa-button appearance="outlined" [loading]="saving()" (click)="clear()"
              >Clear goal</wa-button
            >
          }
          @if (savedMsg(); as msg) {
            <wa-tag size="small" variant="success" appearance="outlined">{{ msg }}</wa-tag>
          }
        </div>
        @if (me.dailyGoal; as g) {
          <p class="muted" style="margin-bottom:0">
            Milestones: {{ quarters(g) }}
          </p>
        }
      </div>

      <div class="panel">
        <h3 style="margin-top:0">Billing</h3>
        @if (billingParam() === 'success') {
          <wa-callout variant="success" style="margin-bottom:12px">
            <wa-icon slot="icon" name="circle-check"></wa-icon>
            You're subscribed — thanks! Your access is all set.
          </wa-callout>
        } @else if (billingParam() === 'canceled') {
          <wa-callout variant="neutral" style="margin-bottom:12px">
            <wa-icon slot="icon" name="circle-info"></wa-icon>
            Checkout canceled — no charge was made.
          </wa-callout>
        }
        <p class="muted" style="margin-top:0">{{ billingStatusLine() }}</p>
        @switch (me.billing.state) {
          @case ('exempt') {
            <!-- Complimentary access — nothing to manage. -->
          }
          @case ('active') {
            <wa-button
              appearance="outlined"
              [loading]="billingBusy()"
              (click)="manage()"
              >Manage billing</wa-button
            >
          }
          @default {
            <wa-button
              variant="brand"
              [loading]="billingBusy()"
              (click)="subscribe()"
              >Subscribe for $5/month</wa-button
            >
          }
        }
      </div>
    }
  `,
})
export class SettingsComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  readonly maxGoal = MAX_DAILY_GOAL;
  saving = signal(false);
  savedMsg = signal<string | null>(null);

  // The `?billing=success|canceled` marker Checkout/Portal redirect back with.
  readonly billingParam = signal(this.route.snapshot.queryParamMap.get('billing'));
  billingBusy = signal(false);

  currentSiteName = computed(() => {
    const me = this.auth.me();
    return me?.sites.find((s) => s.cloudId === me.cloudId)?.name ?? me?.sites[0]?.name ?? '';
  });

  billingStatusLine = computed(() => {
    const b = this.auth.me()?.billing;
    switch (b?.state) {
      case 'exempt':
        return 'You have complimentary access — no subscription needed.';
      case 'active':
        return "You're subscribed — $5/month. Manage your card, invoices, or cancel below.";
      case 'trialing':
        return `Free trial — ${b.daysLeft ?? 0} ${b.daysLeft === 1 ? 'day' : 'days'} left. Subscribe any time to keep your tracker.`;
      case 'expired':
        return 'Your free trial has ended. Subscribe to keep using the tracker.';
      default:
        return '';
    }
  });

  subscribe(): void {
    this.billingBusy.set(true);
    this.auth.subscribe();
  }

  manage(): void {
    this.billingBusy.set(true);
    this.auth.openBillingPortal();
  }

  save(input: { value: string; reportValidity(): boolean }): void {
    const goal = Number(input.value);
    if (!Number.isFinite(goal) || goal <= 0) return; // ignore blank/garbage
    if (!input.reportValidity()) return; // surfaces "must be ≤ max" on the input
    this.update(goal, 'Saved');
  }

  clear(): void {
    this.update(null, 'Goal cleared');
  }

  private update(dailyGoal: number | null, msg: string): void {
    this.saving.set(true);
    this.savedMsg.set(null);
    this.api.updateSettings({ dailyGoal }).subscribe({
      next: () => {
        this.auth.setDailyGoal(dailyGoal);
        this.saving.set(false);
        this.savedMsg.set(msg);
      },
      error: () => this.saving.set(false),
    });
  }

  quarters(goal: number): string {
    const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
    return [1, 2, 3, 4].map((i) => fmt((goal / 4) * i)).join(' · ');
  }
}
