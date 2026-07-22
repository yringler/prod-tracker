// Sprint Risk Board — validation for the admin's generic field-mapping entries
// (`RiskFieldConfigEntry[]`), following the `validateCutoffs` pattern in
// risk-cutoffs.ts: pure, tolerant of `unknown` (the worker hands it raw JSON off
// the wire), returning save-blocking errors and advisory warnings as
// `RiskConfigIssue`s addressed by entry index. Imported by both the worker route
// (PUT/preview validation) and the client's Fields editor, so the two can't drift.
//
// Deletable with the feature: `rm shared/src/risk-fields.ts` + its barrel line.

import type { RiskConfigIssue, RiskFieldConfigEntry, RiskFieldKind } from './risk';

/** Hard cap on configured field entries — bounds the refresh's Jira field list and
 *  the composite's term count. */
export const MAX_FIELD_ENTRIES = 20;

/** The kind a field of this Jira `schema.type` is scored as: numbers get banded
 *  count semantics, everything else is a binary truthy flag. The single source for
 *  the schema.type → kind rule (worker discovery copies its output onto entries). */
export function kindForSchemaType(schemaType: string | null | undefined): RiskFieldKind {
  return schemaType === 'number' ? 'count' : 'flag';
}

export interface FieldEntriesValidation {
  errors: RiskConfigIssue[];
  warnings: RiskConfigIssue[];
}

const ENTRY_KEYS = ['label', 'fieldId', 'kind', 'warn', 'risk', 'weight'];
const KINDS: readonly RiskFieldKind[] = ['count', 'flag'];

/**
 * Every footgun in a field-entry array, split into save-blocking errors and
 * advisory warnings. Rules: entries is an array of ≤ MAX_FIELD_ENTRIES objects;
 * each has a non-empty unique trimmed label, a non-empty unique fieldId, a known
 * kind; count entries carry finite 0 < warn < risk; flag entries omit warn/risk;
 * weight is absent or finite ≥ 0 (0 = excluded from the composite — warned, since
 * the entry then only ever shows as a pill, never moves the score).
 */
export function validateFieldEntries(entries: unknown): FieldEntriesValidation {
  const errors: RiskConfigIssue[] = [];
  const warnings: RiskConfigIssue[] = [];

  if (!Array.isArray(entries)) {
    errors.push({ code: 'NOT_AN_ARRAY', message: 'fields must be an array of entries' });
    return { errors, warnings };
  }
  if (entries.length > MAX_FIELD_ENTRIES) {
    errors.push({
      code: 'TOO_MANY_FIELDS',
      message: `at most ${MAX_FIELD_ENTRIES} field entries are allowed (got ${entries.length})`,
    });
  }

  const seenLabels = new Set<string>();
  const seenFieldIds = new Set<string>();

  entries.forEach((raw, index) => {
    const at = { index } as const;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ ...at, code: 'INVALID_ENTRY', message: `entry ${index} must be an object` });
      return;
    }
    const e = raw as RiskFieldConfigEntry & Record<string, unknown>;

    for (const key of Object.keys(e)) {
      if (!ENTRY_KEYS.includes(key)) {
        warnings.push({
          ...at,
          code: 'UNKNOWN_KEY',
          message: `entry ${index} has an unknown key "${key}" — it is ignored, and the editor strips it on save`,
        });
      }
    }

    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (label === '') {
      errors.push({ ...at, field: 'label', code: 'EMPTY_LABEL', message: `entry ${index}: label must be a non-empty string` });
    } else if (seenLabels.has(label.toLowerCase())) {
      errors.push({ ...at, field: 'label', code: 'DUPLICATE_LABEL', message: `entry ${index}: label "${label}" is already used by another entry` });
    } else {
      seenLabels.add(label.toLowerCase());
    }

    const fieldId = typeof e.fieldId === 'string' ? e.fieldId.trim() : '';
    if (fieldId === '') {
      errors.push({ ...at, field: 'fieldId', code: 'EMPTY_FIELD_ID', message: `entry ${index}: pick a Jira field` });
    } else if (seenFieldIds.has(fieldId)) {
      errors.push({ ...at, field: 'fieldId', code: 'DUPLICATE_FIELD_ID', message: `entry ${index}: field ${fieldId} is already mapped by another entry` });
    } else {
      seenFieldIds.add(fieldId);
    }

    if (!KINDS.includes(e.kind as RiskFieldKind)) {
      errors.push({ ...at, field: 'kind', code: 'INVALID_KIND', message: `entry ${index}: kind must be "count" or "flag"` });
    } else if (e.kind === 'count') {
      const warnOk = typeof e.warn === 'number' && Number.isFinite(e.warn) && e.warn > 0;
      const riskOk = typeof e.risk === 'number' && Number.isFinite(e.risk) && e.risk > 0;
      if (!warnOk) {
        errors.push({ ...at, field: 'warn', code: 'INVALID_THRESHOLD', message: `entry ${index}: a count field needs a finite warn threshold > 0` });
      }
      if (!riskOk) {
        errors.push({ ...at, field: 'risk', code: 'INVALID_THRESHOLD', message: `entry ${index}: a count field needs a finite risk threshold > 0` });
      }
      if (warnOk && riskOk && (e.warn as number) >= (e.risk as number)) {
        errors.push({ ...at, field: 'warn', code: 'INVERTED_THRESHOLD', message: `entry ${index}: warn (${e.warn}) must be below risk (${e.risk})` });
      }
    } else {
      if (e.warn !== undefined || e.risk !== undefined) {
        errors.push({ ...at, field: 'warn', code: 'FLAG_WITH_THRESHOLDS', message: `entry ${index}: a flag field takes no warn/risk thresholds` });
      }
    }

    if (e.weight !== undefined) {
      if (typeof e.weight !== 'number' || !Number.isFinite(e.weight) || e.weight < 0) {
        errors.push({ ...at, field: 'weight', code: 'INVALID_WEIGHT', message: `entry ${index}: weight must be a finite number ≥ 0` });
      } else if (e.weight === 0) {
        warnings.push({ ...at, field: 'weight', code: 'ZERO_WEIGHT', message: `entry ${index}: weight 0 excludes "${label || e.fieldId}" from the composite score` });
      }
    }
  });

  return { errors, warnings };
}
