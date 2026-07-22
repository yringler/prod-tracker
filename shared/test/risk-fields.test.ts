// validateFieldEntries — one case per rule (errors vs warnings), plus the
// schema.type → kind mapping the picker and worker discovery both rely on.
import { describe, expect, it } from 'vitest';
import type { RiskFieldConfigEntry } from '../src/risk';
import { MAX_FIELD_ENTRIES, kindForSchemaType, validateFieldEntries } from '../src/risk-fields';

const count = (over: Partial<RiskFieldConfigEntry> = {}): RiskFieldConfigEntry => ({
  label: 'Rejections',
  fieldId: 'customfield_1001',
  kind: 'count',
  warn: 2,
  risk: 4,
  ...over,
});

const flag = (over: Partial<RiskFieldConfigEntry> = {}): RiskFieldConfigEntry => ({
  label: 'Flagged',
  fieldId: 'customfield_1002',
  kind: 'flag',
  ...over,
});

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

describe('kindForSchemaType', () => {
  it('maps number to count, everything else to flag', () => {
    expect(kindForSchemaType('number')).toBe('count');
    expect(kindForSchemaType('array')).toBe('flag');
    expect(kindForSchemaType('option')).toBe('flag');
    expect(kindForSchemaType(null)).toBe('flag');
    expect(kindForSchemaType(undefined)).toBe('flag');
  });
});

describe('validateFieldEntries — errors (block the save)', () => {
  it('rejects a non-array', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      expect(codes(validateFieldEntries(bad).errors)).toContain('NOT_AN_ARRAY');
    }
  });

  it('rejects a non-object entry, anchored by index', () => {
    const r = validateFieldEntries([flag(), 'nope']);
    const issue = r.errors.find((i) => i.code === 'INVALID_ENTRY');
    expect(issue?.index).toBe(1);
  });

  it('rejects an empty or whitespace-only label', () => {
    expect(codes(validateFieldEntries([flag({ label: '' })]).errors)).toContain('EMPTY_LABEL');
    expect(codes(validateFieldEntries([flag({ label: '   ' })]).errors)).toContain('EMPTY_LABEL');
  });

  it('rejects duplicate labels (trimmed, case-insensitive)', () => {
    const r = validateFieldEntries([flag({ label: 'Flagged' }), count({ label: '  flagged ' })]);
    const issue = r.errors.find((i) => i.code === 'DUPLICATE_LABEL');
    expect(issue?.index).toBe(1);
    expect(issue?.field).toBe('label');
  });

  it('rejects a missing fieldId', () => {
    expect(codes(validateFieldEntries([flag({ fieldId: '' })]).errors)).toContain('EMPTY_FIELD_ID');
  });

  it('rejects duplicate fieldIds', () => {
    const r = validateFieldEntries([flag(), count({ fieldId: flag().fieldId })]);
    expect(codes(r.errors)).toContain('DUPLICATE_FIELD_ID');
  });

  it('rejects an unknown kind', () => {
    expect(codes(validateFieldEntries([{ ...flag(), kind: 'text' }]).errors)).toContain('INVALID_KIND');
  });

  it('requires warn and risk on a count entry', () => {
    const r = validateFieldEntries([count({ warn: undefined, risk: undefined })]);
    expect(r.errors.filter((i) => i.code === 'INVALID_THRESHOLD')).toHaveLength(2);
  });

  it('rejects non-finite and non-positive count thresholds', () => {
    expect(codes(validateFieldEntries([count({ warn: 0 })]).errors)).toContain('INVALID_THRESHOLD');
    expect(codes(validateFieldEntries([count({ risk: Infinity })]).errors)).toContain('INVALID_THRESHOLD');
    expect(codes(validateFieldEntries([count({ warn: NaN })]).errors)).toContain('INVALID_THRESHOLD');
  });

  it('rejects warn >= risk on a count entry', () => {
    expect(codes(validateFieldEntries([count({ warn: 4, risk: 4 })]).errors)).toContain('INVERTED_THRESHOLD');
    expect(codes(validateFieldEntries([count({ warn: 5, risk: 4 })]).errors)).toContain('INVERTED_THRESHOLD');
  });

  it('rejects warn/risk on a flag entry', () => {
    expect(codes(validateFieldEntries([flag({ warn: 1 })]).errors)).toContain('FLAG_WITH_THRESHOLDS');
    expect(codes(validateFieldEntries([flag({ risk: 2 })]).errors)).toContain('FLAG_WITH_THRESHOLDS');
  });

  it('rejects a negative or non-finite weight', () => {
    expect(codes(validateFieldEntries([flag({ weight: -1 })]).errors)).toContain('INVALID_WEIGHT');
    expect(codes(validateFieldEntries([flag({ weight: NaN })]).errors)).toContain('INVALID_WEIGHT');
  });

  it('caps the entry count', () => {
    const many = Array.from({ length: MAX_FIELD_ENTRIES + 1 }, (_, i) =>
      flag({ label: `F${i}`, fieldId: `customfield_${i}` }),
    );
    expect(codes(validateFieldEntries(many).errors)).toContain('TOO_MANY_FIELDS');
  });
});

describe('validateFieldEntries — warnings (advisory)', () => {
  it('warns on an unknown key', () => {
    const r = validateFieldEntries([{ ...flag(), bogus: 1 }]);
    expect(r.errors).toHaveLength(0);
    expect(codes(r.warnings)).toContain('UNKNOWN_KEY');
  });

  it('warns that weight 0 excludes the entry from the composite', () => {
    const r = validateFieldEntries([count({ weight: 0 })]);
    expect(r.errors).toHaveLength(0);
    expect(codes(r.warnings)).toContain('ZERO_WEIGHT');
  });
});

describe('validateFieldEntries — accepts', () => {
  it('accepts an empty list and a full valid mix', () => {
    expect(validateFieldEntries([]).errors).toHaveLength(0);
    const r = validateFieldEntries([count(), flag(), flag({ label: 'Priority', fieldId: 'priority', weight: 2 })]);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
});
