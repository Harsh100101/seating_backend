import { afterEach, describe, expect, it } from 'vitest';
import { assertDisposableTestDatabaseUrl, hardenTestEnvironment } from '../src/utils/test-database-guard.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnvironment)) process.env[key] = value;
});

describe('disposable database safety guard', () => {
  it('accepts only an explicitly authorized local replica-set database', () => {
    process.env.NODE_ENV = 'test';
    process.env.TEST_ENVIRONMENT = 'disposable';
    process.env.ALLOW_DISPOSABLE_TEST_DB_WRITES = '1';

    expect(assertDisposableTestDatabaseUrl('mongodb://127.0.0.1:27017/seating_test_guard?replicaSet=rs0'))
      .toMatchObject({ databaseName: 'seating_test_guard', replicaSet: 'rs0' });
  });

  it('rejects Atlas/shared hosts and the shared seating_db name', () => {
    process.env.NODE_ENV = 'test';
    process.env.TEST_ENVIRONMENT = 'disposable';
    process.env.ALLOW_DISPOSABLE_TEST_DB_WRITES = '1';

    expect(() => assertDisposableTestDatabaseUrl('mongodb://remote.example/seating_test_guard?replicaSet=rs0'))
      .toThrow(/localhost|127\.0\.0\.1/);
    expect(() => assertDisposableTestDatabaseUrl('mongodb://127.0.0.1:27017/seating_db?replicaSet=rs0'))
      .toThrow(/dedicated|seating_browser|seating_test/);
  });

  it('removes inherited application DATABASE_URL when no explicit test URL exists', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.TEST_DATABASE_URL;
    process.env.DATABASE_URL = 'mongodb://remote.example/seating_db';

    hardenTestEnvironment();

    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
