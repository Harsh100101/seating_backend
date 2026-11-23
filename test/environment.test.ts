import { describe, expect, it } from 'vitest';
import { getRepositoryEnvPath, requireDatabaseUrl } from '../src/config/environment.js';

describe('backend environment resolution', () => {
  it('resolves the repository .env independently of the backend working directory', () => {
    const path = getRepositoryEnvPath();
    expect(path.replace(/\\/g, '/')).toMatch(/(seating_backend|phase2-backend|seating-home-stabilization|seating-arrange)\/\.env$/);
  });

  it('fails safely before startup when no database URL is configured', () => {
    expect(() => requireDatabaseUrl('')).toThrow(/DATABASE_URL is required/);
  });
});
