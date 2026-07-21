// Reading a value back off a DOM/custom element, in one place.
//
// Pure functions, no class, no DI, no Angular import — deliberately not a base
// directive: there is no template, no lifecycle and no state to share, so a
// directive would only add an inheritance edge. Replaces the copy-pasted
// `value(e)` / `checked(e)` that lived in cutoffs-editor, composite-editor,
// risk-admin and risk-board.

/** A plain form control's value. Safe for `<wa-input>`/`<wa-number-input>`/
 *  `<wa-textarea>`, whose `value` is a string (possibly null on the element type). */
export function targetValue(e: Event): string {
  const v = (e.target as { value?: unknown } | null)?.value;
  return typeof v === 'string' ? v : '';
}

export function targetChecked(e: Event): boolean {
  return (e.target as { checked?: unknown } | null)?.checked === true;
}

/**
 * A `<wa-select>`'s value, normalized ONCE.
 *
 * Web Awesome's select is `string | null | string[]` — null when the bound value
 * isn't in the (non-disabled) option set, and an array in multiple mode. The old
 * code typed this `string` and then did `Number(raw)`, so a null read became
 * `Number(null) === 0`, which is not a story-point bucket and which the validator
 * later rejected. `''` is the normalized "nothing selected / any" sentinel.
 */
export function selectValue(e: Event): string {
  const v = (e.target as { value?: unknown } | null)?.value;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
  return '';
}
