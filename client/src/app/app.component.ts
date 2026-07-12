import {
    CUSTOM_ELEMENTS_SCHEMA,
    Component,
    ElementRef,
    OnInit,
    inject,
    signal,
    viewChild,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import {
    NavigationEnd,
    Router,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
} from "@angular/router";
import { filter } from "rxjs";
import type WaPage from "@awesome.me/webawesome/dist/components/page/page.js";
import { AuthService } from "./auth.service";
import { ThemeService } from "./theme.service";
import { AvatarComponent } from "./ui/avatar.component";

// Routes that render without authentication (e.g. the privacy policy must be
// publicly reachable for Atlassian's OAuth review).
const PUBLIC_ROUTES = ["/privacy"];

@Component({
    selector: "sp-root",
    standalone: true,
    imports: [
        RouterOutlet,
        RouterLink,
        RouterLinkActive,
        NgTemplateOutlet,
        AvatarComponent,
    ],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
    template: `
        <wa-page #page mobile-breakpoint="920">
            @if (!isPublicRoute() && auth.loaded()) {
                @if (auth.me(); as me) {
                    <!-- Written once, stamped into the desktop header and the
                         mobile drawer (wa-page's navigation slot). -->
                    <ng-template #navLinks>
                        <a routerLink="/tracker" routerLinkActive="active"
                            >Tracker</a
                        >
                        <a routerLink="/history" routerLinkActive="active"
                            >History</a
                        >
                        <a routerLink="/aggregates" routerLinkActive="active"
                            >Aggregates</a
                        >
                        <a routerLink="/tools" routerLinkActive="active"
                            >Tools</a
                        >
                        @if (auth.isAdmin()) {
                            <a routerLink="/admin" routerLinkActive="active"
                                >Admin</a
                            >
                        }
                    </ng-template>
                    <nav slot="header">
                        <strong>SP&nbsp;Tracker</strong>
                        <span class="nav-links">
                            <ng-container [ngTemplateOutlet]="navLinks" />
                        </span>
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
                        <a
                            class="user-chip"
                            routerLink="/settings"
                            routerLinkActive="active"
                            title="Settings"
                        >
                            <sp-avatar
                                [name]="me.displayName"
                                [url]="me.avatarUrl"
                                [size]="24"
                            />
                            <span>{{ me.displayName }}</span>
                        </a>
                        <wa-button
                            size="small"
                            appearance="plain"
                            (click)="auth.logout()"
                        >
                            <wa-icon
                                slot="start"
                                name="arrow-right-from-bracket"
                            ></wa-icon>
                            <span class="signout-label">Sign out</span>
                        </wa-button>
                    </nav>
                    <nav slot="navigation" class="drawer-nav">
                        <ng-container [ngTemplateOutlet]="navLinks" />
                    </nav>
                } @else {
                    <nav slot="header">
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
                }
            }

            @if (isPublicRoute()) {
                <main><router-outlet /></main>
            } @else if (auth.loaded()) {
                @if (auth.me(); as me) {
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
                                    (click)="
                                        auth.login(); $event.preventDefault()
                                    "
                                    >Re-connect Jira</a
                                >.
                            </wa-callout>
                        </main>
                    }
                    <main><router-outlet /></main>
                } @else {
                    <main>
                        <div style="margin-top:64px; text-align:center">
                            <h1 style="font-size:32px; margin-bottom:8px">
                                How much have you done? How much can you do?
                            </h1>
                            <p
                                class="muted"
                                style="font-size:16px; max-width:580px; margin:0 auto 24px"
                            >
                                A personal coach for the work you actually get
                                done. As your Jira tickets move, take a few
                                seconds to note the effort you put in — then look
                                back and see how much you did today, this week,
                                and this month, whether you're picking up pace,
                                and, from your own history, how much you're
                                capable of. Knowledge and well-earned pride in
                                your work.
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
                                Read-only Jira access. Nothing is ever written
                                back to your Jira tickets.
                            </p>
                        </div>

                        <h2 style="text-align:center; margin-top:56px">
                            How it works
                        </h2>
                        <div
                            class="grid how-it-works"
                            style="margin-top:16px"
                        >
                            <div class="panel">
                                <wa-icon
                                    name="bell"
                                    style="font-size:22px; color:var(--accent)"
                                ></wa-icon>
                                <h3 style="margin:8px 0 4px">
                                    Log it as you go
                                </h3>
                                <p class="muted" style="margin:0">
                                    As your tickets move in Jira, you're
                                    prompted — optionally by push notification —
                                    to note the effort you put in. It takes
                                    seconds, and it's saved here only, never
                                    pushed back to Jira.
                                </p>
                            </div>
                            <div class="panel">
                                <wa-icon
                                    name="pen-to-square"
                                    style="font-size:22px; color:var(--accent)"
                                ></wa-icon>
                                <h3 style="margin:8px 0 4px">
                                    Note what you did
                                </h3>
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
                                <h3 style="margin:8px 0 4px">
                                    See what you can do
                                </h3>
                                <p class="muted" style="margin:0">
                                    See how much you got done today, this week,
                                    and this month, and whether you're speeding
                                    up. Over time your own history becomes the
                                    measure of what you're capable of — and how
                                    you're tracking with your team. End each week
                                    knowing exactly what you did.
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
                                    rated an individual ticket. Only anonymized
                                    team totals are ever shared, so this stays
                                    your own private record to reflect on.
                                </p>
                            </div>
                        </div>
                    </main>
                }
            }
        </wa-page>
    `,
})
export class AppComponent implements OnInit {
    auth = inject(AuthService);
    theme = inject(ThemeService);
    private router = inject(Router);
    private page = viewChild.required<ElementRef<WaPage>>("page");
    isPublicRoute = signal(this.checkPublic(this.router.url));

    ngOnInit(): void {
        this.router.events
            .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
            .subscribe((e) => {
                this.isPublicRoute.set(this.checkPublic(e.urlAfterRedirects));
                // wa-page doesn't watch SPA navigation, so close its mobile
                // nav drawer ourselves after every route change.
                this.page().nativeElement.hideNavigation();
            });
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
