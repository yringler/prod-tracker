import { Injectable, computed, inject, signal } from '@angular/core';
import type { MeResponse } from '@shared/contracts';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(ApiService);
  readonly me = signal<MeResponse | null>(null);
  readonly loaded = signal(false);
  readonly isAdmin = computed(() => this.me()?.role === 'admin');

  load(): void {
    this.api.me().subscribe({
      next: (m) => {
        this.me.set(m);
        this.loaded.set(true);
      },
      error: () => {
        this.me.set(null);
        this.loaded.set(true);
      },
    });
  }

  login(): void {
    this.api.authStart().subscribe((r) => (window.location.href = r.authorizeUrl));
  }

  /** Start hosted Checkout — POST for the URL, then redirect (mirrors login()). */
  subscribe(): void {
    this.api.createCheckout().subscribe((r) => (window.location.href = r.url));
  }

  /** Open the Stripe Billing Portal (card/cancel/invoices) in the same tab. */
  openBillingPortal(): void {
    this.api.createPortal().subscribe((r) => (window.location.href = r.url));
  }

  logout(): void {
    this.api.logout().subscribe(() => {
      this.me.set(null);
      window.location.href = '/';
    });
  }

  /** Patch the local snapshot after a settings save — no /api/me refetch needed. */
  setDailyGoal(dailyGoal: number | null): void {
    this.me.update((m) => (m ? { ...m, dailyGoal } : m));
  }

  /** Switch the active Jira site. Reloads so every cloud-scoped view refetches. */
  switchSite(cloudId: string): void {
    if (cloudId === this.me()?.cloudId) return;
    this.api.switchSite(cloudId).subscribe(() => window.location.reload());
  }
}
