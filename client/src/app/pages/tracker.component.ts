import { DatePipe } from "@angular/common";
import {
    CUSTOM_ELEMENTS_SCHEMA,
    Component,
    OnInit,
    inject,
    signal,
} from "@angular/core";
import type { MyRatingsResponse, PendingRating } from "@shared/contracts";
import { claimCeiling } from "@shared/domain";
import { isToday, parseISO } from "date-fns";
import { ApiService } from "../api.service";
import { PushService } from "../push.service";

type MyRating = MyRatingsResponse["ratings"][number];

// Notification → rating UI. Each pending shows key, title, link, story points and
// the four effort buttons, plus an optional diary note. Submitting writes to OUR
// db only — never back to Jira. Below the prompts, a "Done today" strip reflects
// what you already claimed today so the page rewards progress, not just demands it.
@Component({
    selector: "sp-tracker",
    standalone: true,
    imports: [DatePipe],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
    template: `
        <div class="row" style="justify-content:space-between">
            <h2>Rate your effort</h2>
            <div class="row" style="gap:8px">
                @if (isDev) {
                    <wa-button
                        size="small"
                        appearance="outlined"
                        [loading]="seeding()"
                        (click)="seedDev()"
                    >
                        <wa-icon slot="start" name="flask"></wa-icon>
                        Add fake item
                    </wa-button>
                }
                @if (pending().length > 0) {
                    <wa-button
                        size="small"
                        appearance="outlined"
                        [loading]="clearing()"
                        (click)="clearAll()"
                    >
                        <wa-icon slot="start" name="trash"></wa-icon>
                        Clear all
                    </wa-button>
                }
                @if (pushOn()) {
                    <wa-tag
                        size="small"
                        variant="success"
                        appearance="outlined"
                    >
                        <wa-icon slot="start" name="bell"></wa-icon>
                        {{ pushMsg() || "Notifications on" }}
                    </wa-tag>
                } @else {
                    <wa-button size="small" (click)="enablePush()">{{
                        pushMsg() || "Enable notifications"
                    }}</wa-button>
                }
            </div>
        </div>

        @if (loading()) {
            <div class="row" style="gap:8px">
                <wa-spinner></wa-spinner> <span class="muted">Loading…</span>
            </div>
        } @else if (pending().length === 0) {
            <div class="panel muted">
                Nothing to rate right now. You'll be prompted as your tickets
                change status.
            </div>
        } @else {
            @for (p of pending(); track p.pendingId) {
                <div class="panel">
                    <div class="row" style="justify-content:space-between">
                        <div>
                            <a [href]="p.url" target="_blank" rel="noopener">
                                <strong>{{ p.issueKey }}</strong>
                                <wa-icon
                                    name="arrow-up-right-from-square"
                                ></wa-icon>
                            </a>
                            — {{ p.title }}
                        </div>
                        <wa-tag size="small" appearance="outlined"
                            >{{ p.storyPoints ?? "—" }} pts ·
                            {{ transitionList(p) }}</wa-tag
                        >
                    </div>
                    <div class="muted" style="font-size:12px">
                        moved {{ p.transitionedAt | date: "short" }}
                    </div>
                    <wa-textarea
                        #notes
                        label="Notes"
                        placeholder="What did you do? What are you proud of?"
                        rows="2"
                        resize="vertical"
                        style="margin-top:10px"
                        [disabled]="busy() === p.pendingId"
                    ></wa-textarea>
                    <div class="row" style="margin-top:10px; gap:8px">
                        <wa-button-group label="Effort">
                            @for (pt of presetPoints; track pt) {
                                <wa-button
                                    appearance="outlined"
                                    [loading]="busy() === p.pendingId"
                                    [disabled]="
                                        busy() === p.pendingId ||
                                        pt > maxClaim(p)
                                    "
                                    (click)="rate(p, pt, notes.value)"
                                    >{{ pt }}</wa-button
                                >
                            }
                        </wa-button-group>
                        <wa-input
                            #custom
                            type="number"
                            min="0"
                            [attr.max]="maxClaim(p)"
                            step="1"
                            placeholder="pts"
                            style="width:80px"
                            [disabled]="busy() === p.pendingId"
                        ></wa-input>
                        <wa-button
                            appearance="outlined"
                            [disabled]="busy() === p.pendingId || !custom.value"
                            (click)="rateCustom(p, custom, notes.value)"
                            >Rate</wa-button
                        >
                    </div>
                </div>
            }
        }

        @if (today().length > 0) {
            <h3 style="margin-top:32px">Done today</h3>
            <p class="muted" style="margin-top:-8px">
                Nice work — here's what you claimed points on today.
            </p>
            @for (r of today(); track r.id) {
                <div class="panel">
                    <div class="row" style="justify-content:space-between">
                        <div>
                            @if (r.url) {
                                <a
                                    [href]="r.url"
                                    target="_blank"
                                    rel="noopener"
                                >
                                    <strong>{{ r.issueKey }}</strong>
                                    <wa-icon
                                        name="arrow-up-right-from-square"
                                    ></wa-icon>
                                </a>
                            } @else {
                                <strong>{{ r.issueKey }}</strong>
                            }
                            @if (r.title) {
                                — {{ r.title }}
                            }
                        </div>
                        <wa-tag
                            size="small"
                            variant="success"
                            appearance="outlined"
                            >{{ r.claimedPoints }} pts claimed</wa-tag
                        >
                    </div>
                    @if (r.notes) {
                        <div
                            class="muted"
                            style="margin-top:6px; white-space:pre-wrap"
                        >
                            {{ r.notes }}
                        </div>
                    }
                </div>
            }
        }

        <wa-dialog
            label="Clear all pending?"
            [open]="confirmOpen()"
            (wa-after-hide)="confirmOpen.set(false)"
        >
            Clear all pending events? This cannot be undone.
            <wa-button
                slot="footer"
                appearance="outlined"
                (click)="confirmOpen.set(false)"
                >Cancel</wa-button
            >
            <wa-button
                slot="footer"
                variant="danger"
                [loading]="clearing()"
                (click)="doClearAll()"
                >Clear all</wa-button
            >
        </wa-dialog>
    `,
})
export class TrackerComponent implements OnInit {
    private api = inject(ApiService);
    private push = inject(PushService);

    readonly presetPoints = [0, 1, 3, 5, 8] as const;
    // Local dev only: the cron poller that creates pending prompts never runs in
    // `wrangler dev`, so this button injects a made-up one to exercise the flow.
    readonly isDev =
        location.hostname === "localhost" || location.hostname === "127.0.0.1";
    pending = signal<PendingRating[]>([]);
    today = signal<MyRating[]>([]);
    loading = signal(true);
    busy = signal<string | null>(null);
    clearing = signal(false);
    seeding = signal(false);
    pushMsg = signal<string>("");
    pushOn = signal(false);
    confirmOpen = signal(false);

    ngOnInit(): void {
        this.refresh();
        this.loadToday();
        this.push.status().then((s) => this.pushOn.set(s === "granted"));
    }

    refresh(): void {
        this.api.pending().subscribe({
            next: (r) => {
                this.pending.set(r.items);
                this.loading.set(false);
            },
            error: () => this.loading.set(false),
        });
    }

    // Reflection strip: work that transitioned today, newest first. "Today" is the
    // user's local day (isToday) — a reflective grouping, unlike the UTC trend
    // buckets. Grouped by transition time, not when the points were claimed, so a
    // ticket finished today still shows here even if claimed tomorrow (older rows
    // without a stored transition fall back to ratedAt).
    loadToday(): void {
        this.api.myRatings().subscribe({
            next: (r) =>
                this.today.set(
                    r.ratings.filter((x) => isToday(parseISO(x.transitionedAt ?? x.ratedAt))),
                ),
        });
    }

    // The chosen Fibonacci/custom value IS the claimed points — submit it directly.
    // The backend only ever sees points (plus the optional note).
    rate(p: PendingRating, claimedPoints: number, notes: string): void {
        // Coerce BEFORE touching busy: if the notes element ever fails to provide a
        // string, this must not throw after the spinner is already on (which would
        // strand it forever with no request sent).
        const trimmed = (notes ?? "").trim();
        this.busy.set(p.pendingId);
        this.api
            .submitRating({
                pendingId: p.pendingId,
                issueKey: p.issueKey,
                claimedPoints,
                notes: trimmed,
            })
            .subscribe({
                next: (res) => {
                    this.pending.update((list) =>
                        list.filter((x) => x.pendingId !== p.pendingId),
                    );
                    // Move it straight into "Done today" so the work doesn't just vanish.
                    this.today.update((list) => [
                        {
                            id: res.id,
                            issueKey: p.issueKey,
                            claimedPoints,
                            storyPointsAtRating: res.storyPointsAtRating,
                            sprintId: res.sprintId,
                            ratedAt: new Date().toISOString(),
                            transitionedAt: p.transitionedAt,
                            title: p.title,
                            url: p.url,
                            notes: trimmed.length > 0 ? trimmed : null,
                        },
                        ...list,
                    ]);
                    this.busy.set(null);
                },
                error: () => this.busy.set(null),
            });
    }

    // All of an issue's unrated transitions, oldest-first, as "→ A, B, C". A single
    // move reads "→ In Progress" exactly as before; a flurry lists every status the
    // ticket passed through, so one composite claim covers the whole sequence.
    transitionList(p: PendingRating): string {
        return "→ " + p.transitions.map((t) => t.toStatus).join(", ");
    }

    // Mirror the server's claim ceiling so the UI never offers a value the server
    // would reject: presets above it are disabled and the custom input gets a `max`.
    maxClaim(p: PendingRating): number {
        return claimCeiling(p.storyPoints);
    }

    // Custom effort: a typed point value. Let the input enforce its own `max` and
    // surface WebAwesome's native validation message (instead of a silent server
    // 400) when the value is too high; otherwise rate() submits it directly.
    rateCustom(
        p: PendingRating,
        input: { value: string; reportValidity(): boolean },
        notes: string,
    ): void {
        const points = Number(input.value);
        if (!Number.isFinite(points) || points < 0) return; // ignore blank/garbage
        if (!input.reportValidity()) return; // shows "Value must be ≤ N" on the input
        this.rate(p, points, notes);
    }

    // Dev only: inject a fake pending prompt, then re-fetch so it shows up.
    seedDev(): void {
        this.seeding.set(true);
        this.api.seedDevPending().subscribe({
            next: () => {
                this.refresh();
                this.seeding.set(false);
            },
            error: () => this.seeding.set(false),
        });
    }

    clearAll(): void {
        this.confirmOpen.set(true);
    }

    doClearAll(): void {
        this.clearing.set(true);
        this.api.clearPending().subscribe({
            next: () => {
                this.pending.set([]);
                this.clearing.set(false);
                this.confirmOpen.set(false);
            },
            error: () => this.clearing.set(false),
        });
    }

    async enablePush(): Promise<void> {
        this.pushMsg.set("…");
        const r = await this.push.enable();
        this.pushOn.set(r === "granted");
        this.pushMsg.set(
            r === "granted"
                ? "Notifications on"
                : r === "denied"
                  ? "Blocked"
                  : "Unsupported",
        );
    }
}
