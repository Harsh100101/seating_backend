import { afterEach, describe, expect, it } from 'vitest';
import {
  authoritativeExcelPath,
  isInitialImportApplyEnabled,
  isLegacyEmployeeBulkImportEnabled,
  isReconciliationEnabled
} from '../src/config/feature-flags.js';

describe('controlled production feature flags', () => {
  const clean = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

  afterEach(() => {
    delete process.env.ENABLE_EMPLOYEE_RECONCILIATION;
    delete process.env.VITE_ENABLE_EMPLOYEE_RECONCILIATION;
  });

  it('keeps reconciliation disabled unless the backend flag is explicitly true', () => {
    expect(isReconciliationEnabled(clean)).toBe(false);
    expect(isReconciliationEnabled({ ...clean, ENABLE_EMPLOYEE_RECONCILIATION: 'true' })).toBe(true);
    expect(isReconciliationEnabled({ ...clean, ENABLE_EMPLOYEE_RECONCILIATION_UI: 'true' })).toBe(false);
  });

  it('keeps legacy import and authoritative apply disabled by default', () => {
    expect(isLegacyEmployeeBulkImportEnabled(clean)).toBe(false);
    expect(isInitialImportApplyEnabled(clean)).toBe(false);
  });

  it('requires an explicit authoritative workbook path', () => {
    expect(authoritativeExcelPath(clean)).toBeUndefined();
    expect(authoritativeExcelPath({ ...clean, AUTHORITATIVE_EXCEL_PATH: '  C:\\approved\\source.xlsx  ' }))
      .toBe('C:\\approved\\source.xlsx');
  });
});
