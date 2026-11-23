import { describe, expect, it, afterEach } from 'vitest';
import { classifyUnit, isBusinessUnit, unitSelectorWhere } from '../src/utils/unit-classification.js';

describe('Unit lifecycle classification', () => {
  afterEach(() => {
    delete process.env.AUTHORIZED_LEGACY_UNIT_CODES;
  });

  it('recognizes the five legacy baseline Units by explicit codes', () => {
    expect(isBusinessUnit({ code: 'UNIT-1' })).toBe(true);
    expect(isBusinessUnit({ code: 'UNIT-5' })).toBe(true);
    expect(classifyUnit({ code: 'MU-159404' })).toBe('UNKNOWN_REVIEW_REQUIRED');
  });

  it('treats persisted lifecycle status as authoritative for future Units', () => {
    expect(classifyUnit({ code: 'FUTURE-9', lifecycleStatus: 'ACTIVE' })).toBe('CONFIRMED_BUSINESS_UNIT');
    expect(classifyUnit({ code: 'FUTURE-9', lifecycleStatus: 'QUARANTINED' })).toBe('CONFIRMED_SYNTHETIC_TEST_UNIT');
    expect(classifyUnit({ code: 'FUTURE-9', lifecycleStatus: 'INACTIVE' })).toBe('INACTIVE_UNIT');
  });

  it('supports an explicit legacy-code migration override without a name prefix heuristic', () => {
    process.env.AUTHORIZED_LEGACY_UNIT_CODES = 'UNIT-1,AUTHORIZED-6';
    expect(isBusinessUnit({ code: 'AUTHORIZED-6' })).toBe(true);
    expect(isBusinessUnit({ code: 'Matrix Unit 6' })).toBe(false);
    expect(unitSelectorWhere()).toEqual({ OR: [{ lifecycleStatus: 'ACTIVE' }, { lifecycleStatus: { isSet: false }, code: { in: ['UNIT-1', 'AUTHORIZED-6'] } }] });
  });
});
