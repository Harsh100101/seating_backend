import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ADMIN, seedAdminUser, seedEnterpriseDemoAccounts } from '../prisma/seed.js';
import { seed } from '../prisma/seed.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

describe('legacy administrator bootstrap protection', () => {
  it('does not ship the unrestricted bulk administrator password reset utility', () => {
    expect(existsSync(path.resolve(testDirectory, '../reset-passwords.ts'))).toBe(false);
  });

  it('refuses to construct a Prisma client without an explicitly guarded disposable database', async () => {
    await expect(seed()).rejects.toThrow(/TEST_DATABASE_URL|ALLOW_DISPOSABLE_TEST_DB_WRITES/);
  });

  it('refuses demo account provisioning outside test mode without a disposable database', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEST_ENVIRONMENT', '');
    vi.stubEnv('ALLOW_DISPOSABLE_TEST_DB_WRITES', '');
    vi.stubEnv('TEST_DATABASE_URL', '');
    await expect(seedEnterpriseDemoAccounts({} as any, [], [])).rejects.toThrow(/guarded seed CLI/);
    vi.unstubAllEnvs();
  });

  it('refuses injected Prisma seeding outside test mode before any database operation', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const upsert = vi.fn();
    const prisma = { adminUser: { upsert } };
    await expect(seed(prisma as any)).rejects.toThrow(/guarded seed CLI/);
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('does not reactivate an existing inactive legacy bootstrap account', async () => {
    const existing = {
      id: 'legacy-admin-id',
      email: DEFAULT_ADMIN.email,
      name: 'System Admin',
      role: 'SUPER_ADMIN',
      isActive: false,
      passwordHash: 'unchanged-hash',
    };
    const upsert = vi.fn();
    const prisma = {
      adminUser: {
        findUnique: vi.fn().mockResolvedValue(existing),
        count: vi.fn(),
        upsert,
      },
    };

    const result = await seedAdminUser(prisma as any);

    expect(result).toBe(existing);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not recreate the legacy bootstrap account when other admins exist', async () => {
    const upsert = vi.fn();
    const prisma = {
      adminUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(7),
        upsert,
      },
    };

    const result = await seedAdminUser(prisma as any);

    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps first-install bootstrap safety when no admin exists', async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: 'first-admin-id',
      email: DEFAULT_ADMIN.email,
      name: DEFAULT_ADMIN.name,
      role: 'SUPER_ADMIN',
      isActive: true,
    });
    const prisma = {
      adminUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        upsert,
      },
    };

    const result = await seedAdminUser(prisma as any);

    expect(result?.email).toBe(DEFAULT_ADMIN.email);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.role).toBe('SUPER_ADMIN');
  });
});
