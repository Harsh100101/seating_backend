import { describe, expect, it } from 'vitest';
import { isVacantEmpCode, normalizeEmpCode } from '../src/utils/employee-code.js';

describe('employee duplicate key policy', () => {
  it.each([
    ['E1001', 'E1001'],
    ['e1001', 'E1001'],
    [' E1001 ', 'E1001'],
    [null, ''],
    [undefined, '']
  ])('normalizes %j to %j', (value, expected) => {
    expect(normalizeEmpCode(value)).toBe(expected);
  });

  it('treats only employee-code vacancy sentinels as vacant', () => {
    expect(isVacantEmpCode('VACANT')).toBe(true);
    expect(isVacantEmpCode(null)).toBe(true);
    expect(isVacantEmpCode(undefined)).toBe(true);
    expect(isVacantEmpCode('')).toBe(true);
    expect(isVacantEmpCode('E1001')).toBe(false);
  });

  it('does not use names or organizational fields as duplicate keys', () => {
    const rows = [
      { empCode: 'E1001', name: 'Raj Patel', department: 'Accounts' },
      { empCode: 'E1002', name: 'Raj Patel', department: 'Accounts' }
    ];
    const codes = rows.map((row) => normalizeEmpCode(row.empCode));
    expect(new Set(codes).size).toBe(rows.length);
  });

  it('detects duplicate employee IDs regardless of case and whitespace', () => {
    const rows = ['E1001', ' e1001 '];
    const codes = rows.map(normalizeEmpCode);
    expect(new Set(codes).size).toBe(1);
  });
});
