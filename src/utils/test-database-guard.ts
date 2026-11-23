import { MongoClient } from 'mongodb';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const TEST_DB_NAME = /^seating_(?:browser|test)_[a-z0-9][a-z0-9_-]{2,}$/i;

export interface DisposableDatabaseCheck {
  url: string;
  databaseName: string;
  replicaSet: string;
}
function databaseNameFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

export function getExplicitTestDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL?.trim() || undefined;
}

/**
 * Synchronous policy check. This deliberately rejects Atlas/SRV URLs and
 * ordinary application database names before Prisma can be constructed.
 */
export function assertDisposableTestDatabaseUrl(rawUrl: string | undefined): DisposableDatabaseCheck {
  if (process.env.NODE_ENV !== 'test' && process.env.TEST_ENVIRONMENT !== 'disposable') {
    throw new Error('Database writes require NODE_ENV=test or TEST_ENVIRONMENT=disposable.');
  }
  if (process.env.ALLOW_DISPOSABLE_TEST_DB_WRITES !== '1') {
    throw new Error('Database writes require ALLOW_DISPOSABLE_TEST_DB_WRITES=1.');
  }
  if (!rawUrl) {
    throw new Error('Database writes require an explicit TEST_DATABASE_URL.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid MongoDB URL.');
  }

  if (url.protocol !== 'mongodb:') {
    throw new Error('TEST_DATABASE_URL must use mongodb:// and a local disposable endpoint.');
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('TEST_DATABASE_URL must target localhost/127.0.0.1/::1; remote databases are forbidden.');
  }
  if (url.username || url.password) {
    throw new Error('TEST_DATABASE_URL must not contain credentials.');
  }

  const replicaSet = url.searchParams.get('replicaSet')?.trim();
  if (!replicaSet) {
    throw new Error('TEST_DATABASE_URL must target a MongoDB replica set.');
  }

  const databaseName = databaseNameFromUrl(rawUrl);
  if (!TEST_DB_NAME.test(databaseName) || databaseName === 'seating_db') {
    throw new Error('TEST_DATABASE_URL must use a dedicated seating_browser_* or seating_test_* database name.');
  }

  return { url: rawUrl, databaseName, replicaSet };
}

/**
 * Positive endpoint verification. The URL/name policy above is not treated as
 * proof by itself; the server must answer hello as the expected local replica.
 */
export async function verifyDisposableTestDatabase(rawUrl: string | undefined): Promise<DisposableDatabaseCheck> {
  const check = assertDisposableTestDatabaseUrl(rawUrl);
  const client = new MongoClient(check.url, {
    appName: 'seating-disposable-test-guard',
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
  });

  try {
    await client.connect();
    const hello = await client.db(check.databaseName).admin().command({ hello: 1 });
    if (hello.setName !== check.replicaSet || hello.isWritablePrimary !== true && hello.ismaster !== true) {
      throw new Error('TEST_DATABASE_URL did not verify as the writable local replica-set primary.');
    }
    return check;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Vitest setup hardening: remove any checked-in/application DATABASE_URL from
 * the test process. Only an explicit, positively opted-in test URL may be put
 * back into DATABASE_URL for Prisma consumers that rely on schema env lookup.
 */
export function hardenTestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') return;

  const explicit = getExplicitTestDatabaseUrl();
  delete process.env.DATABASE_URL;

  if (explicit) {
    assertDisposableTestDatabaseUrl(explicit);
    process.env.DATABASE_URL = explicit;
  }
}
