export const isReconciliationEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.ENABLE_EMPLOYEE_RECONCILIATION === 'true';

export const isLegacyEmployeeBulkImportEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === 'test' && env.ENABLE_LEGACY_EMPLOYEE_BULK_IMPORT === 'true';

export const isInitialImportApplyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.ALLOW_AUTHORITATIVE_INITIAL_IMPORT_APPLY === 'true';

export const authoritativeExcelPath = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.AUTHORITATIVE_EXCEL_PATH?.trim() || undefined;
