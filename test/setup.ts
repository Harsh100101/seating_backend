import { hardenTestEnvironment } from '../src/utils/test-database-guard.js';
import '../src/utils/xlsx.js';

hardenTestEnvironment();
// Legacy import coverage is explicitly enabled only for disposable Vitest runs.
process.env.ENABLE_LEGACY_EMPLOYEE_BULK_IMPORT = 'true';
