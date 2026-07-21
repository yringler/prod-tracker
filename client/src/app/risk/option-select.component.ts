import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { selectValue } from './dom-events';
import { ensureValuePresent, type SelectOption } from './select-options';

export type { SelectOption } from './select-options';

/**
 * `<sp-option-select>` — the SINGLE owner of the Web Awesome `<wa-select>`
 * contract. Nothing else in the risk slice touches a `wa-select`'s value or
 * options. Four rules, all learned from real defects:
 *
 * 1. **Never bind a value that isn't in the option list.** WA's value getter
 *    filters the bound value against its own option set and returns null
 *    otherwise, blanking the display AND the read-back. Enforced by
 *    `ensureValuePresent`, which synthesizes and annotates a missing value.
 * 2. **Never mark the selected option `disabled`.** Same filter (`!o.disabled`),
 *    so a disabled option can never be the value. Enforced structurally: options
 *    carry no `disabled` field at all.
 * 3. **`disabled` is not the encoding for "not offered".** Where the intent is
 *    "not available here", the option is OMITTED (see `columnOptions`). The
 *    `disabled` INPUT below is a different thing — it greys out the whole control
 *    (read-only while following the shipped defaults) — and is kept.
 * 4. **Normalize the read-back once, and reject rather than coerce.**
 *    `selectValue` collapses `string | null | string[]` to a string; `''` is the
 *    "any / nothing" sentinel. `valueChange` fires only on an ACTUAL change,
 *    because WA emits `change` liberally and every spurious emit is a round trip
 *    through the parent.
 */
@Component({
  selector: 'sp-option-select',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <wa-select
      [attr.size]="size()"
      [attr.disabled]="disabled() ? '' : null"
      [attr.placeholder]="placeholder()"
      [attr.aria-label]="ariaLabel()"
      [value]="value()"
      (change)="onChange($event)"
    >
      @for (o of view(); track o.value) {
        @if (o.heading) {
          <wa-divider></wa-divider>
          <small>{{ o.heading }}</small>
        }
        <wa-option [value]="o.value">{{ o.label }}</wa-option>
      }
    </wa-select>
  `,
})
export class OptionSelectComponent {
  readonly value = input.required<string>();
  readonly options = input.required<readonly SelectOption[]>();
  readonly placeholder = input<string | null>(null);
  readonly disabled = input(false);
  readonly size = input('small');
  readonly ariaLabel = input<string | null>(null);

  /** Always a string, never null, never an array. `''` = the "any" sentinel. */
  readonly valueChange = output<string>();

  /** Rule 1, applied to every caller rather than trusted to each of them. */
  readonly safeOptions = computed(() =>
    ensureValuePresent(this.options(), this.value(), 'not currently available'),
  );

  /** Flat render list: label already annotated, and `heading` set only on the FIRST
   *  option of each group so the divider+caption appear once. */
  readonly view = computed<{ value: string; label: string; heading: string | null }[]>(() => {
    let prev: string | undefined;
    return this.safeOptions().map((o) => {
      const heading = o.group && o.group !== prev ? o.group : null;
      prev = o.group;
      return {
        value: o.value,
        label: o.note ? `${o.label} — ${o.note}` : o.label,
        heading,
      };
    });
  });

  onChange(e: Event): void {
    const next = selectValue(e);
    if (next === this.value()) return; // rule 4: no spurious round trips
    this.valueChange.emit(next);
  }
}
