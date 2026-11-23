import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The application is normally launched from the repository root, where the
 * deployment environment file lives.  `pnpm --filter` and direct backend
 * launches may instead use apps/backend as their working directory.  Resolve
 * the repository file from this module rather than relying on process.cwd().
 */
export function getRepositoryEnvPath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '../../.env');
}

export function loadApplicationEnvironment(): void {
  // Host-provided values take precedence over the single repository .env.
  dotenv.config({ path: getRepositoryEnvPath(), override: false, quiet: true });
}

/**
 * Fail before Fastify starts if a runtime database URL was not configured.
 * The message intentionally names the setting but never includes its value.
 */
export function requireDatabaseUrl(value = process.env.DATABASE_URL): string {
  if (!value?.trim()) {
    throw new Error(
      'FATAL: DATABASE_URL is required. Set it in the process environment or the repository .env file before starting the backend.',
    );
  }
  return value;
}
