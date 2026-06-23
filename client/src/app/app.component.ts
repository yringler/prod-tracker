import { CUSTOM_ELEMENTS_SCHEMA, Component, OnInit, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from './auth.service';

// Routes that render without authentication (e.g. the privacy policy must be
// publicly reachable for Atlassian's OAuth review).
const PUBLIC_ROUTES = ['/privacy'];

@Component({
  selector: 'sp-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    @if (isPublicRoute()) {
      <main><router-outlet /></main>
    } @else if (auth.loaded()) {
      @if (auth.me(); as me) {
        <nav>
          <strong>SP&nbsp;Tracker</strong>
          <a routerLink="/tracker" routerLinkActive="active">Tracker</a>
          <a routerLink="/aggregates" routerLinkActive="active">Aggregates</a>
          @if (auth.isAdmin()) {
            <a routerLink="/admin" routerLinkActive="active">Admin</a>
          }
          <span class="spacer"></span>
          @if (me.sites.length > 1) {
            <wa-select size="small" [value]="me.cloudId" (change)="onSwitchSite($event)" title="Jira site">
              @for (s of me.sites; track s.cloudId) {
                <wa-option [value]="s.cloudId">{{ s.name }}</wa-option>
              }
            </wa-select>
          } @else if (me.sites.length === 1) {
            <wa-tag size="small" appearance="outlined">{{ me.sites[0].name }}</wa-tag>
          }
          <span class="muted">{{ me.displayName }}</span>
          <wa-button size="small" appearance="plain" (click)="auth.logout()">
            <wa-icon slot="start" name="arrow-right-from-bracket"></wa-icon>
            Sign out
          </wa-button>
        </nav>
        @if (me.needsReauth) {
          <main>
            <wa-callout variant="warning">
              <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
              Your Jira consent expired. <a href="#" (click)="auth.login(); $event.preventDefault()">Re-connect Jira</a>.
            </wa-callout>
          </main>
        }
        <main><router-outlet /></main>
      } @else {
        <main>
          <div class="panel" style="margin-top:64px; text-align:center">
            <h1>Story-point effort tracker</h1>
            <p class="muted">Rate the effort you personally put into each ticket. Your ratings stay private; only team aggregates are shared.</p>
            <wa-button variant="brand" (click)="auth.login()">Connect Jira</wa-button>
          </div>
        </main>
      }
    }
  `,
})
export class AppComponent implements OnInit {
  auth = inject(AuthService);
  private router = inject(Router);
  isPublicRoute = signal(this.checkPublic(this.router.url));

  ngOnInit(): void {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.isPublicRoute.set(this.checkPublic(e.urlAfterRedirects)));
    this.auth.load();
  }

  private checkPublic(url: string): boolean {
    const path = url.split(/[?#]/)[0] ?? url;
    return PUBLIC_ROUTES.includes(path);
  }
  onSwitchSite(e: Event): void {
    this.auth.switchSite((e.target as HTMLSelectElement).value);
  }
}
