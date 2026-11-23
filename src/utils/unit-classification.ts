import type { Prisma } from '@prisma/client';

export type UnitLifecycleStatus = 'ACTIVE' | 'INACTIVE' | 'QUARANTINED';
export type UnitClassification = 'CONFIRMED_BUSINESS_UNIT' | 'CONFIRMED_SYNTHETIC_TEST_UNIT' | 'INACTIVE_UNIT' | 'UNKNOWN_REVIEW_REQUIRED';

/**
 * Legacy production Units predate lifecycleStatus. Their codes are the
 * migration allow-list, not a five-Unit capacity limit. Any Unit created by
 * the application is persisted with lifecycleStatus=ACTIVE and is therefore
 * eligible without changing this list.
 */
const DEFAULT_LEGACY_BUSINESS_CODES = new Set(['UNIT-1', 'UNIT-2', 'UNIT-3', 'UNIT-4', 'UNIT-5']);

export function legacyBusinessUnitCodes(): Set<string> {
  const configured = process.env.AUTHORIZED_LEGACY_UNIT_CODES
    ?.split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_LEGACY_BUSINESS_CODES);
}
export function classifyUnit(unit: { code: string; lifecycleStatus?: UnitLifecycleStatus | null }): UnitClassification {
  if (unit.lifecycleStatus === 'ACTIVE') return 'CONFIRMED_BUSINESS_UNIT';
  if (unit.lifecycleStatus === 'INACTIVE') return 'INACTIVE_UNIT';
  if (unit.lifecycleStatus === 'QUARANTINED') return 'CONFIRMED_SYNTHETIC_TEST_UNIT';
  return legacyBusinessUnitCodes().has(unit.code.toUpperCase())
    ? 'CONFIRMED_BUSINESS_UNIT'
    : 'UNKNOWN_REVIEW_REQUIRED';
}

export function isBusinessUnit(unit: { code: string; lifecycleStatus?: UnitLifecycleStatus | null }): boolean {
  return classifyUnit(unit) === 'CONFIRMED_BUSINESS_UNIT';
}

export function unitSelectorWhere(includeQuarantined = false): Prisma.UnitWhereInput {
  if (includeQuarantined) return {};
  const legacyCodes = [...legacyBusinessUnitCodes()];
  return {
    OR: [
      { lifecycleStatus: 'ACTIVE' },
      // Legacy Atlas Units omit lifecycle_status entirely. Prisma reads the
      // missing field as null, but MongoDB requires isSet:false to match it.
      // Keep the explicit code allow-list so unknown null-status Units remain
      // excluded until they are classified by an authorized operator.
      { lifecycleStatus: { isSet: false }, code: { in: legacyCodes } },
    ],
  } as Prisma.UnitWhereInput;
}
