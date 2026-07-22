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
import { OptionSelectComponent } from './option-select.component';
import {
  MORE_FIELDS_VALUE,
  allFieldOptions,
  filterFieldOptions,
  type SelectOption,
} from './select-options';

/**
 * `<sp-field-picker>` — a text-filterable select over ALL of the site's Jira
 * fields: a `<wa-input>` search box that narrows the `<sp-option-select>` below
 * it. Deliberately NOT a hand-rolled combobox — `sp-option-select` is the
 * hard-won single owner of the wa-select contract, and this component only
 * decides which options to feed it.
 *
 * The option list is capped (FIELD_PICKER_CAP) with a counted "keep typing"
 * sentinel; picking the sentinel is swallowed here rather than emitted.
 */
@Component({
  selector: 'sp-field-picker',
  standalone: true,
  imports: [OptionSelectComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="col">
      <wa-input
        size="small"
        clearable
        placeholder="filter fields…"
        [attr.aria-label]="(ariaLabel() ?? 'field') + ' filter'"
        [value]="query()"
        (input)="query.set(inputValue($event))"
      ></wa-input>
      <sp-option-select
        [value]="value()"
        [options]="options()"
        [ariaLabel]="ariaLabel()"
        (valueChange)="onPick($event)"
      ></sp-option-select>
    </div>
  `,
  styles: [
    `
      .col {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    `,
  ],
})
export class FieldPickerComponent {
  /** All of the site's fields (may be empty while loading — the stored value stays
   *  selectable regardless, via ensureValuePresent). */
  readonly fields = input.required<readonly RiskFieldMeta[]>();
  /** The picked field id; `''` = none picked yet. */
  readonly value = input.required<string>();
  readonly ariaLabel = input<string | null>(null);

  readonly valueChange = output<string>();

  query = signal('');

  readonly options = computed<SelectOption[]>(() =>
    allFieldOptions(filterFieldOptions(this.fields(), this.query()), this.value()),
  );

  inputValue(e: Event): string {
    return targetValue(e);
  }

  onPick(v: string): void {
    if (v === MORE_FIELDS_VALUE) return; // the overflow counter is not a choice
    this.valueChange.emit(v);
  }
}
