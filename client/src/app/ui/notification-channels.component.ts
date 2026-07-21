import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { Subscription, timer } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';
import type { ChannelListItem, SetupInstructions } from '@shared/notifications';
import { ApiService } from '../api.service';

// Self-describing notification-channel settings. The client renders whatever the
// adapter's beginSetup() returns — it has NO per-vendor branches. The setup-step
// vocabulary is exhausted by the @switch below (Angular narrows `step` per @case
// under strictTemplates); adding a SetupStep kind without a matching @case makes
// `step` no longer `never` in @default, so assertNever(step) fails to compile — the
// intended failure mode.
//
// Security: the `embed` branch is sandboxed WITHOUT allow-top-navigation and has NO
// postMessage listener; its `src` is an adapter-minted signed short-lived token URL,
// never a raw account id (the app never trusts an embedded frame to talk back).
interface OpenSetup {
  channel: string;
  instructions: SetupInstructions;
}

@Component({
  selector: 'sp-notification-channels',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <h3 style="margin-top:0">Notifications</h3>
    <p class="muted">
      Your site admin has set these up. Turn on the ones you want reminders through.
    </p>

    @if (loading()) {
      <wa-spinner></wa-spinner>
    } @else if (error()) {
      <p class="muted" style="margin:.5rem 0; display:flex; gap:8px; align-items:center">
        Couldn't load notification channels.
        <wa-button size="small" appearance="outlined" (click)="refresh()">Retry</wa-button>
      </p>
    } @else {
      @for (item of channels(); track item.descriptor.channel) {
        <div class="row" style="gap:8px; align-items:center; margin-bottom:8px">
          <strong>{{ item.descriptor.displayName }}</strong>
          <wa-switch
            #sw
            size="small"
            [checked]="item.enabled"
            (change)="toggle(item, sw)"
            [attr.title]="'Receive reminders through ' + item.descriptor.displayName"
          ></wa-switch>
          @if (item.enabled) {
            @if (item.status.linked) {
              <wa-tag size="small" variant="success" appearance="outlined">
                Connected as {{ item.status.label }}
              </wa-tag>
            } @else if (needsIdentity(item)) {
              <wa-tag size="small" variant="neutral" appearance="outlined">
                Needs {{ item.descriptor.identityPrompt ?? 'setup' }}
              </wa-tag>
            } @else {
              <wa-tag size="small" variant="success" appearance="outlined">On</wa-tag>
            }
          } @else {
            <wa-tag size="small" variant="neutral" appearance="outlined">Off</wa-tag>
            @if (item.status.linked) {
              <wa-button
                size="small"
                appearance="plain"
                (click)="disconnect(item.descriptor.channel)"
                >Forget my {{ item.descriptor.displayName }} details</wa-button
              >
            }
          }
        </div>

        @if (setup(); as s) {
          @if (s.channel === item.descriptor.channel) {
            <div class="panel" style="margin:4px 0 12px">
              @for (step of s.instructions.steps; track $index) {
                @switch (step.kind) {
                  @case ('text') {
                    <p style="margin:.25rem 0">{{ step.body }}</p>
                  }
                  @case ('copyable') {
                    <div class="row" style="gap:8px; align-items:center">
                      <span style="font-weight:600">{{ step.label }}:</span>
                      <code>{{ step.value }}</code>
                      <wa-copy-button [value]="step.value"></wa-copy-button>
                      @if (expiryHint(step.expiresAt); as hint) {
                        <span class="muted" style="font-size:12px">{{ hint }}</span>
                      }
                    </div>
                  }
                  @case ('link') {
                    <a [href]="step.href" target="_blank" rel="noopener">{{ step.label }}</a>
                  }
                  @case ('input') {
                    <div class="row" style="gap:8px; align-items:end">
                      <wa-input
                        #inp
                        [attr.type]="step.inputType"
                        [attr.name]="step.name"
                        [attr.label]="step.label"
                      ></wa-input>
                      <wa-button
                        size="small"
                        variant="brand"
                        (click)="submitInput(s.channel, step.name, inp)"
                        >Submit</wa-button
                      >
                    </div>
                  }
                  @case ('embed') {
                    <iframe
                      [src]="trustEmbed(step.src)"
                      [height]="step.height"
                      width="100%"
                      style="border:0"
                      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                    ></iframe>
                  }
                  @default {
                    {{ assertNever(step) }}
                  }
                }
              }
              <div style="margin-top:8px">
                <wa-button size="small" appearance="plain" (click)="cancelSetup()"
                  >Cancel</wa-button
                >
                <span class="muted" style="font-size:12px; margin-left:8px"
                  >Waiting for you to finish…</span
                >
              </div>
            </div>
          }
        }
      } @empty {
        <p class="muted">
          No notification channels have been set up for your site yet. Ask an admin.
        </p>
      }

      @if (actionError(); as e) {
        <wa-callout variant="danger" size="small" style="margin-top:8px">{{ e }}</wa-callout>
      }
    }
  `,
})
export class NotificationChannelsComponent {
  private api = inject(ApiService);
  private sanitizer = inject(DomSanitizer);
  private destroyRef = inject(DestroyRef);

  channels = signal<ChannelListItem[]>([]);
  loading = signal(true);
  error = signal(false);
  setup = signal<OpenSetup | null>(null);
  /** Non-fatal, per-action error (a failed toggle / failed setup open). The
   *  `error` signal above is for the LIST load and replaces the whole panel. */
  actionError = signal('');

  private poll: Subscription | null = null;

  constructor() {
    this.refresh();
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  // Public so the Retry button can re-run it. Distinguishes a failed request (show
  // an error + Retry) from a genuinely empty list ("no channels available"), instead
  // of collapsing both into the misleading empty message.
  refresh(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.notificationChannels().subscribe({
      next: (res) => {
        this.channels.set(res.channels);
        this.actionError.set('');
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  /** The whole user-side surface: opt in / out. Provisioning is the admin's, so
   *  turning a channel ON may still need ONE thing from the user (an address, a
   *  handle) — the reply says so, and we open the existing setup panel right away
   *  instead of making them find a second button. `el` is the <wa-switch> template
   *  ref (the repo's `#inp` idiom): reading `.checked` off it avoids a
   *  `$event.target` cast in the template, which strictTemplates would require. */
  toggle(item: ChannelListItem, el: { checked: boolean }): void {
    const channel = item.descriptor.channel;
    const enabled = el.checked;
    this.api.setChannelEnabled(channel, enabled).subscribe({
      next: (res) => {
        this.actionError.set('');
        this.channels.update((list) =>
          list.map((c) =>
            c.descriptor.channel === channel
              ? { ...c, enabled: res.enabled, status: res.status }
              : c,
          ),
        );
        if (res.enabled && this.needsIdentity({ ...item, status: res.status }))
          this.connect(channel);
        else this.cancelSetup();
      },
      // `<wa-switch>` is uncontrolled: the DOM property is already flipped, and the
      // bound expression (item.enabled) has NOT changed, so re-rendering will not
      // write it back. Reset the element directly, then re-read the server.
      error: () => {
        el.checked = item.enabled;
        this.actionError.set(`Couldn't change ${item.descriptor.displayName} — try again.`);
        this.refresh();
      },
    });
  }

  connect(channel: string): void {
    this.api.beginChannelSetup(channel).subscribe({
      next: (instructions) => {
        this.setup.set({ channel, instructions });
        this.startPolling(channel);
      },
      error: () => {
        const name =
          this.channels().find((c) => c.descriptor.channel === channel)?.descriptor
            .displayName ?? channel;
        this.actionError.set(`Couldn't start setup for ${name} — try again.`);
      },
    });
  }

  cancelSetup(): void {
    this.stopPolling();
    this.setup.set(null);
  }

  disconnect(channel: string): void {
    this.api.unlinkChannel(channel).subscribe({ next: () => this.refresh() });
  }

  // In-app setup completion (an `input` flow, e.g. email). On success, close the
  // panel and refresh so the row flips to "Connected".
  submitInput(channel: string, name: string, el: { value: string | null }): void {
    this.api.completeChannelSetup(channel, { [name]: el.value ?? '' }).subscribe({
      next: (status) => {
        if (status.linked) {
          this.setup.set(null);
          this.stopPolling();
          this.refresh();
        }
      },
    });
  }

  // Poll status while a setup panel is open; stop as soon as the link lands, then
  // flip the row to "Connected". Mirrors push.service's poll-then-stop shape.
  private startPolling(channel: string): void {
    this.stopPolling();
    this.poll = timer(3000, 3000)
      .pipe(
        switchMap(() => this.api.channelStatus(channel)),
        takeWhile((status) => !status.linked, true),
      )
      .subscribe({
        next: (status) => {
          if (status.linked) {
            this.setup.set(null);
            this.stopPolling();
            this.refresh();
          }
        },
      });
  }

  private stopPolling(): void {
    this.poll?.unsubscribe();
    this.poll = null;
  }

  /** Does this channel still need ONE thing from the user (an address, a handle)
   *  before it can deliver? Absent → yes (the conservative default, and what both
   *  shipped adapters declare); an explicit `false` means enabling is sufficient. */
  needsIdentity(item: ChannelListItem): boolean {
    return item.descriptor.requiresUserIdentity !== false && !item.status.linked;
  }

  expiryHint(expiresAt: number | undefined): string | null {
    if (expiresAt === undefined) return null;
    const mins = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    return mins <= 0 ? 'Code expired — regenerate' : `Code expires in ~${mins} min`;
  }

  trustEmbed(src: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(src);
  }

  // Exhaustiveness guard: `step` is narrowed to `never` here only when every
  // SetupStep kind above has a @case. A new kind without one breaks the build.
  assertNever(x: never): string {
    return String(x);
  }
}
