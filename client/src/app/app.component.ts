import {
    CUSTOM_ELEMENTS_SCHEMA,
    Component,
    OnInit,
    inject,
    signal,
} from "@angular/core";
import {
    NavigationEnd,
    Router,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
} from "@angular/router";
import { filter } from "rxjs";
import { AuthService } from "./auth.service";
import { ThemeService } from "./theme.service";

// Routes that render without authentication (e.g. the privacy policy must be
// publicly reachable for Atlassian's OAuth review).
const PUBLIC_ROUTES = ["/privacy"];

@Component({
    selector: "sp-root",
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
                    <a routerLink="/tracker" routerLinkActive="active"
                        >Tracker</a
                    >
                    <a routerLink="/history" routerLinkActive="active"
                        >History</a
                    >
                    <a routerLink="/aggregates" routerLinkActive="active"
                        >Aggregates</a
                    >
                    @if (auth.isAdmin()) {
                        <a routerLink="/admin" routerLinkActive="active"
                            >Admin</a
                        >
                    }
                    <span class="spacer"></span>
                    <wa-switch
                        size="small"
                        title="Toggle dark mode"
                        [checked]="theme.theme() === 'dark'"
                        (change)="theme.toggle()"
                    >
                        <wa-icon name="moon"></wa-icon>
                    </wa-switch>
                    @if (me.sites.length > 1) {
                        <wa-select
                            size="small"
                            [value]="me.cloudId"
                            (change)="onSwitchSite($event)"
                            title="Jira site"
                        >
                            @for (s of me.sites; track s.cloudId) {
                                <wa-option [value]="s.cloudId">{{
                                    s.name
                                }}</wa-option>
                            }
                        </wa-select>
                    } @else if (me.sites.length === 1) {
                        <wa-tag size="small" appearance="outlined">{{
                            me.sites[0].name
                        }}</wa-tag>
                    }
                    <span class="muted">{{ me.displayName }}</span>
                    <wa-button
                        size="small"
                        appearance="plain"
                        (click)="auth.logout()"
                    >
                        <wa-icon
                            slot="start"
                            name="arrow-right-from-bracket"
                        ></wa-icon>
                        Sign out
                    </wa-button>
                </nav>
                @if (me.needsReauth) {
                    <main>
                        <wa-callout variant="warning">
                            <wa-icon
                                slot="icon"
                                name="triangle-exclamation"
                            ></wa-icon>
                            Your Jira consent expired.
                            <a
                                href="#"
                                (click)="auth.login(); $event.preventDefault()"
                                >Re-connect Jira</a
                            >.
                        </wa-callout>
                    </main>
                }
                <main><router-outlet /></main>
            } @else {
                <nav>
                    <span class="spacer"></span>
                    <wa-switch
                        size="small"
                        title="Toggle dark mode"
                        [checked]="theme.theme() === 'dark'"
                        (change)="theme.toggle()"
                    >
                        <wa-icon name="moon"></wa-icon>
                    </wa-switch>
                </nav>
                <main>
                    <div style="margin-top:64px; text-align:center">
                        <h1 style="font-size:32px; margin-bottom:8px">
                            Story-point effort tracker
                        </h1>
                        <p
                            class="muted"
                            style="font-size:16px; max-width:580px; margin:0 auto 24px"
                        >
                            A personal record of the work you actually get done.
                            As your Jira tickets move, take a few seconds to
                            note the effort you put in — then look back and see
                            how much you did today, this week, this month,
                            whether you're picking up pace, and how you're
                            tracking against your team. Knowledge and
                            well-earned pride in your work.
                        </p>
                        <wa-button
                            variant="brand"
                            size="large"
                            (click)="auth.login()"
                        >
                            <wa-icon
                                slot="start"
                                name="jira"
                                family="brands"
                            ></wa-icon>
                            Login with Jira
                        </wa-button>
                        <p
                            class="muted"
                            style="font-size:13px; margin-top:10px"
                        >
                            Read-only Jira access. Nothing is ever written back
                            to your Jira tickets.
                        </p>
                    </div>

                    <h2 style="text-align:center; margin-top:56px">
                        How it works
                    </h2>
                    <div
                        class="grid"
                        style="grid-template-columns:repeat(3, 1fr); margin-top:16px"
                    >
                        <div class="panel">
                            <wa-icon
                                name="bell"
                                style="font-size:22px; color:var(--accent)"
                            ></wa-icon>
                            <h3 style="margin:8px 0 4px">Log it as you go</h3>
                            <p class="muted" style="margin:0">
                                As your tickets move in Jira, you're prompted —
                                optionally by push notification — to note the
                                effort you put in. It takes seconds, and it's
                                saved here only, never pushed back to Jira.
                            </p>
                        </div>
                        <div class="panel">
                            <wa-icon
                                name="pen-to-square"
                                style="font-size:22px; color:var(--accent)"
                            ></wa-icon>
                            <h3 style="margin:8px 0 4px">Note what you did</h3>
                            <p class="muted" style="margin:0">
                                Jot a line on what you actually got done and
                                what you're proud of. Over time it becomes a
                                diary of your work, in your own words.
                            </p>
                        </div>
                        <div class="panel">
                            <wa-icon
                                name="chart-line"
                                style="font-size:22px; color:var(--accent)"
                            ></wa-icon>
                            <h3 style="margin:8px 0 4px">Look back</h3>
                            <p class="muted" style="margin:0">
                                See how much you got done today, this week, and
                                this month — whether you're speeding up, and how
                                you stack up next to your team. End each week
                                and month knowing exactly what you accomplished.
                            </p>
                        </div>
                    </div>

                    <div
                        class="panel row"
                        style="gap:12px; margin-top:24px; align-items:flex-start"
                    >
                        <wa-icon
                            name="shield-halved"
                            style="font-size:22px; color:var(--done)"
                        ></wa-icon>
                        <div>
                            <h3 style="margin:0 0 4px">
                                Your numbers are yours
                            </h3>
                            <p class="muted" style="margin:0">
                                No one — not even an admin — can see how you
                                rated an individual ticket. Only anonymized team
                                totals are ever shared, so this stays your own
                                private record to reflect on.
                            </p>
                        </div>
                    </div>
                </main>
            }
        }
    `,
})
export class AppComponent implements OnInit {
    auth = inject(AuthService);
    theme = inject(ThemeService);
    private router = inject(Router);
    isPublicRoute = signal(this.checkPublic(this.router.url));

    ngOnInit(): void {
        this.router.events
            .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
            .subscribe((e) =>
                this.isPublicRoute.set(this.checkPublic(e.urlAfterRedirects)),
            );
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
