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
      When you don't act on a browser reminder, we can nudge you again through one of
      these channels. Connect the ones you want.
    </p>

    @if (loading()) {
      <wa-spinner></wa-spinner>
    } @else {
      @for (item of channels(); track item.descriptor.channel) {
        <div class="row" style="gap:8px; align-items:center; margin-bottom:8px">
          <strong>{{ item.descriptor.displayName }}</strong>
          @if (item.status.linked) {
            <wa-tag size="small" variant="success" appearance="outlined">
              Connected as {{ item.status.label }}
            </wa-tag>
            <wa-button
              size="small"
              appearance="outlined"
              (click)="disconnect(item.descriptor.channel)"
              >Disconnect</wa-button
            >
          } @else {
            <wa-tag size="small" variant="neutral" appearance="outlined">Not connected</wa-tag>
            <wa-button
              size="small"
              variant="brand"
              [disabled]="setup()?.channel === item.descriptor.channel"
              (click)="connect(item.descriptor.channel)"
              >Connect</wa-button
            >
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
                    <wa-input
                      [attr.type]="step.inputType"
                      [attr.name]="step.name"
                      [attr.label]="step.label"
                    ></wa-input>
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
        <p class="muted">No notification channels are available.</p>
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
  setup = signal<OpenSetup | null>(null);

  private poll: Subscription | null = null;

  constructor() {
    this.refresh();
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  private refresh(): void {
    this.api.notificationChannels().subscribe({
      next: (res) => {
        this.channels.set(res.channels);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  connect(channel: string): void {
    this.api.beginChannelSetup(channel).subscribe({
      next: (instructions) => {
        this.setup.set({ channel, instructions });
        this.startPolling(channel);
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
