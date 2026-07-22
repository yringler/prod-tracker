import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { RiskFieldMeta } from '@shared/risk';
import { targetValue } from './dom-events';
import { fieldListItems, resolveFieldDisplay } from './select-options';

/**
 * `<sp-field-picker>` — pick one of the site's Jira fields. The collapsed control
 * is a one-line display of the current field plus a pencil; the pencil opens a
 * `<wa-dialog>` with a search box over a plain list of "name (id)" buttons.
 *
 * Deliberately NOT a `<wa-select>` combobox: the site's field list runs to
 * hundreds, and a modal search reads and behaves far better than a listbox that
 * flips over its own filter input. Because it's a list of native buttons rather
 * than a select, none of the wa-select value-presence contract applies — a picked
 * id the filter hides simply isn't in the list; the collapsed trigger still labels
 * it via `resolveFieldDisplay`.
 *
 * The list is capped (`FIELD_PICKER_CAP`); overflow is a plain, non-interactive
 * hint line — keep typing to narrow. The dialog is always in the DOM (`[open]`
 * toggled, mirroring the repo's `<wa-dialog>` idiom), but its list is guarded by
 * `@if (open())` so N closed row-pickers don't each render a list of buttons.
 */
@Component({
  selector: 'sp-field-picker',
  standalone: true,
  imports: [],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker">
      @if (value()) {
        <span class="field-display">{{ display().label }}</span>
        @if (display().note) {
          <small class="note">— {{ display().note }}</small>
        }
      } @else {
        <span class="field-display empty">Pick a field…</span>
      }
      <wa-button
        size="small"
        appearance="plain"
        [attr.aria-label]="(ariaLabel() ?? 'field') + ' — change'"
        (click)="openDialog()"
      >
        <wa-icon name="pen-to-square"></wa-icon>
      </wa-button>
    </div>

    <wa-dialog
      [attr.label]="(ariaLabel() ?? 'Jira field') + ' — pick'"
      [open]="open()"
      light-dismiss
      (wa-after-hide)="onHide()"
    >
      <wa-input
        autofocus
        size="small"
        with-clear
        placeholder="Search fields by name or id…"
        aria-label="search fields"
        [value]="query()"
        (input)="onFilter($event)"
      >
        <wa-icon slot="start" name="magnifying-glass"></wa-icon>
      </wa-input>
      @if (open()) {
        <div class="list" role="group" aria-label="fields">
          @for (item of list().items; track item.id) {
            <button
              type="button"
              class="option"
              [class.selected]="item.selected"
              [attr.aria-current]="item.selected ? 'true' : null"
              (click)="pick(item.id)"
            >
              <span>{{ item.label }}</span>
              @if (item.selected) {
                <wa-icon name="check"></wa-icon>
              }
            </button>
          } @empty {
            @if (fields().length) {
              <p class="muted">No fields match “{{ query() }}”.</p>
            } @else {
              <p class="muted">No fields loaded yet.</p>
            }
          }
        </div>
        @if (list().overflow) {
          <small class="hint">{{ list().overflow }} more — keep typing to narrow.</small>
        }
      }
      <wa-button slot="footer" appearance="outlined" (click)="open.set(false)">Cancel</wa-button>
    </wa-dialog>
  `,
  styles: [
    `
      .picker {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .field-display {
        color: var(--ink);
      }
      .field-display.empty {
        color: var(--muted);
      }
      .note {
        color: var(--muted);
        font-size: 12px;
      }
      .list {
        max-height: 320px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 8px;
      }
      .option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        text-align: left;
        padding: 6px 8px;
        border: 1px solid transparent;
        border-radius: var(--wa-border-radius-m, 6px);
        background: transparent;
        color: var(--ink);
        cursor: pointer;
      }
      .option:hover {
        background: var(--wa-color-surface-lowered, var(--panel));
      }
      .option.selected {
        border-color: var(--accent);
        background: var(--wa-color-brand-fill-quiet, var(--panel));
      }
      .hint {
        display: block;
        margin-top: 6px;
        font-size: 11px;
        color: var(--muted);
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
    `,
  ],
})
export class FieldPickerComponent {
  /** All of the site's fields (may be empty while loading). */
  readonly fields = input.required<readonly RiskFieldMeta[]>();
  /** The picked field id; `''` = none picked yet. */
  readonly value = input.required<string>();
  readonly ariaLabel = input<string | null>(null);

  readonly valueChange = output<string>();

  readonly open = signal(false);
  readonly query = signal('');

  readonly display = computed(() => resolveFieldDisplay(this.value(), this.fields()));
  readonly list = computed(() => fieldListItems(this.fields(), this.query(), this.value()));

  openDialog(): void {
    this.query.set('');
    this.open.set(true);
  }

  onFilter(e: Event): void {
    this.query.set(targetValue(e));
  }

  pick(id: string): void {
    this.valueChange.emit(id);
    this.open.set(false);
  }

  onHide(): void {
    this.open.set(false);
  }
}
