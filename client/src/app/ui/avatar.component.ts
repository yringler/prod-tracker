import { Component, Input, signal } from '@angular/core';

// Round profile picture with an initials fallback. The Atlassian avatar URL can
// be absent (or fail to load — some avatar CDNs want auth we don't have), so the
// initials circle is the reliable rendering and the image is the upgrade.
@Component({
  selector: 'sp-avatar',
  standalone: true,
  template: `
    @if (url && !failed()) {
      <img
        [src]="url"
        [style.width.px]="size"
        [style.height.px]="size"
        alt=""
        referrerpolicy="no-referrer"
        (error)="failed.set(true)"
      />
    } @else {
      <span
        class="fallback"
        [style.width.px]="size"
        [style.height.px]="size"
        [style.font-size.px]="size * 0.42"
        >{{ initials() }}</span
      >
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      img,
      .fallback {
        border-radius: 50%;
      }
      .fallback {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in oklab, var(--accent) 25%, var(--panel));
        color: var(--ink);
        font-weight: 600;
      }
    `,
  ],
})
export class AvatarComponent {
  @Input({ required: true }) name!: string;
  @Input() url: string | null = null;
  @Input() size = 24;

  readonly failed = signal(false);

  // Plain getter (not computed): `name` is a non-signal @Input, so a computed
  // would cache the first value forever.
  initials(): string {
    const words = (this.name ?? '').trim().split(/\s+/).filter(Boolean);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
  }
}
