import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, DEMO_PASSWORD, TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD, seed } from '../prisma/seed.js';

describe('TECH_ADMIN-only administrator account management', () => {
  let server: FastifyInstance;
  let prisma: any;

  beforeEach(async () => {
    prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });
    server = buildServer({
      prisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  async function login(email: string, password: string) {
    const response = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie'];
  }

  it('allows TECH_ADMIN to create a UNIT_ADMIN without returning a password', async () => {
    const cookie = await login(TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD);
    const unit = await prisma.unit.findUnique({ where: { code: 'UNIT-1' } });
    const response = await server.inject({
      method: 'POST',
      url: '/api/admin-users',
      headers: { cookie },
      payload: { email: 'new.unit.admin@example.com', name: 'New Unit Admin', password: 'A-secure-password-123', role: 'UNIT_ADMIN', assignedUnitId: unit.id }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().passwordHash).toBeUndefined();
  });

  it('allows TECH_ADMIN to remove active and inactive admins while preserving audit-linked records', async () => {
    const techCookie = await login(TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD);
    const unit = await prisma.unit.findUnique({ where: { code: 'UNIT-1' } });
    const created = await server.inject({
      method: 'POST',
      url: '/api/admin-users',
      headers: { cookie: techCookie },
      payload: { email: 'inactive.to.delete@example.com', name: 'Inactive To Delete', password: 'A-secure-password-123', role: 'UNIT_ADMIN', assignedUnitId: unit.id }
    });
    expect(created.statusCode).toBe(201);
    const inactiveId = created.json().id;

    const deactivate = await server.inject({
      method: 'PATCH',
      url: `/api/admin-users/${inactiveId}`,
      headers: { cookie: techCookie },
      payload: { isActive: false }
    });
    expect(deactivate.statusCode).toBe(200);

    const inactiveDelete = await server.inject({ method: 'DELETE', url: `/api/admin-users/${inactiveId}`, headers: { cookie: techCookie } });
    expect(inactiveDelete.statusCode).toBe(200);
    expect((await prisma.adminUser.findUnique({ where: { id: inactiveId } })).deletedAt).toBeTruthy();

    const activeUnitAdmin = await prisma.adminUser.findUnique({ where: { email: 'unit1.admin@shaktiman.com' } });
    const activeDelete = await server.inject({ method: 'DELETE', url: `/api/admin-users/${activeUnitAdmin.id}`, headers: { cookie: techCookie } });
    expect(activeDelete.statusCode).toBe(200);
    expect((await prisma.adminUser.findUnique({ where: { id: activeUnitAdmin.id } })).isActive).toBe(false);

    const list = await server.inject({ method: 'GET', url: '/api/admin-users', headers: { cookie: techCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().admins.some((admin: any) => admin.id === inactiveId || admin.id === activeUnitAdmin.id)).toBe(false);
  });

  it('allows TECH_ADMIN to reset a UNIT_ADMIN password and deactivate the account', async () => {
    const techCookie = await login(TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD);
    const unitAdmin = await prisma.adminUser.findUnique({ where: { email: 'unit1.admin@shaktiman.com' } });

    const resetResponse = await server.inject({
      method: 'POST',
      url: `/api/admin-users/${unitAdmin.id}/reset-password`,
      headers: { cookie: techCookie },
      payload: { password: 'New-unit-admin-password-123' }
    });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json().success).toBe(true);

    const oldPasswordLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unit1.admin@shaktiman.com', password: DEMO_PASSWORD }
    });
    expect(oldPasswordLogin.statusCode).toBe(401);

    const newPasswordLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unit1.admin@shaktiman.com', password: 'New-unit-admin-password-123' }
    });
    expect(newPasswordLogin.statusCode).toBe(200);

    const deactivateResponse = await server.inject({
      method: 'PATCH',
      url: `/api/admin-users/${unitAdmin.id}`,
      headers: { cookie: techCookie },
      payload: { isActive: false }
    });
    expect(deactivateResponse.statusCode).toBe(200);
    expect(deactivateResponse.json().isActive).toBe(false);
  });

  it('rejects SUPER_ADMIN administrator-account management at the backend', async () => {
    const cookie = await login(DEFAULT_ADMIN.email, DEFAULT_ADMIN.password);
    const response = await server.inject({ method: 'GET', url: '/api/admin-users', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it('rejects UNIT_ADMIN administrator-account management at the backend', async () => {
    const cookie = await login('unit1.admin@shaktiman.com', DEMO_PASSWORD);
    const response = await server.inject({ method: 'GET', url: '/api/admin-users', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it('rejects SUPER_ADMIN and UNIT_ADMIN write access to administrator accounts', async () => {
    const target = await prisma.adminUser.findUnique({ where: { email: 'unit1.admin@shaktiman.com' } });
    const principals = [
      { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password },
      { email: 'unit1.admin@shaktiman.com', password: DEMO_PASSWORD }
    ];

    for (const principal of principals) {
      const cookie = await login(principal.email, principal.password);
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/admin-users',
        headers: { cookie },
        payload: { email: 'blocked.admin@example.com', name: 'Blocked Admin', password: 'A-secure-password-123', role: 'UNIT_ADMIN', assignedUnitId: target.assignedUnitId }
      });
      const updateResponse = await server.inject({
        method: 'PATCH',
        url: `/api/admin-users/${target.id}`,
        headers: { cookie },
        payload: { isActive: false }
      });
      const resetResponse = await server.inject({
        method: 'POST',
        url: `/api/admin-users/${target.id}/reset-password`,
        headers: { cookie },
        payload: { password: 'Another-secure-password-123' }
      });
      const deleteResponse = await server.inject({
        method: 'DELETE',
        url: `/api/admin-users/${target.id}`,
        headers: { cookie },
      });

      expect(createResponse.statusCode).toBe(403);
      expect(updateResponse.statusCode).toBe(403);
      expect(resetResponse.statusCode).toBe(403);
      expect(deleteResponse.statusCode).toBe(403);
    }
  });

  it('protects the last active TECH_ADMIN from deactivation', async () => {
    const cookie = await login(TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD);
    const techAdmin = await prisma.adminUser.findUnique({ where: { email: TECH_ADMIN_EMAIL } });
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin-users/${techAdmin.id}`,
      headers: { cookie },
      payload: { isActive: false }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('last active TECH_ADMIN');

    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/api/admin-users/${techAdmin.id}`,
      headers: { cookie },
    });
    expect(deleteResponse.statusCode).toBe(409);
    expect(deleteResponse.json().message).toContain('last active TECH_ADMIN');
  });

  it('allows TECH_ADMIN to reuse email of soft-deleted admin via controlled reactivation', async () => {
    const techCookie = await login(TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD);
    const unit1 = await prisma.unit.findUnique({ where: { code: 'UNIT-1' } });
    const unit2 = await prisma.unit.findUnique({ where: { code: 'UNIT-2' } });

    // 1. Create an admin
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/admin-users',
      headers: { cookie: techCookie },
      payload: {
        email: 'reusable.admin@example.com',
        name: 'Original Admin',
        password: 'Original-password-123',
        role: 'UNIT_ADMIN',
        assignedUnitId: unit1.id
      }
    });
    expect(createRes.statusCode).toBe(201);
    const originalId = createRes.json().id;

    // 2. Attempting to create again with same email while active returns 409
    const duplicateRes = await server.inject({
      method: 'POST',
      url: '/api/admin-users',
      headers: { cookie: techCookie },
      payload: {
        email: 'reusable.admin@example.com',
        name: 'Duplicate Admin',
        password: 'Another-password-123',
        role: 'UNIT_ADMIN',
        assignedUnitId: unit1.id
      }
    });
    expect(duplicateRes.statusCode).toBe(409);
    expect(duplicateRes.json().message).toBe('An administrator with this email already exists.');

    // 3. Soft-delete the admin
    const deleteRes = await server.inject({
      method: 'DELETE',
      url: `/api/admin-users/${originalId}`,
      headers: { cookie: techCookie }
    });
    expect(deleteRes.statusCode).toBe(200);

    const softDeleted = await prisma.adminUser.findUnique({ where: { id: originalId } });
    expect(softDeleted.deletedAt).toBeTruthy();
    expect(softDeleted.isActive).toBe(false);

    // 4. Non-TECH_ADMIN attempting to create with this email is rejected (403)
    const unitCookie = await login('unit1.admin@shaktiman.com', DEMO_PASSWORD);
    const forbiddenRes = await server.inject({
      method: 'POST',
      url: '/api/admin-users',
      headers: { cookie: unitCookie },
      payload: {
        email: 'reusable.admin@example.com',
        name: 'Reactivated Admin',
        password: 'Reactivated-password-123',
        role: 'UNIT_ADMIN',
        assignedUnitId: unit2.id
      }
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // 5. TECH_ADMIN creates admin with previously soft-deleted email -> controlled reactivation
    const reactivateRes = await server.inject({
      method: 'POST',
      url: '/api/admin-users',
      headers: { cookie: techCookie },
      payload: {
        email: 'reusable.admin@example.com',
        name: 'Reactivated Admin',
        password: 'Reactivated-password-123',
        role: 'UNIT_ADMIN',
        assignedUnitId: unit2.id
      }
    });
    expect(reactivateRes.statusCode).toBe(201);
    const reactivatedBody = reactivateRes.json();
    expect(reactivatedBody.id).toBe(originalId);
    expect(reactivatedBody.name).toBe('Reactivated Admin');
    expect(reactivatedBody.assignedUnitId).toBe(unit2.id);
    expect(reactivatedBody.isActive).toBe(true);

    // Verify DB state
    const restored = await prisma.adminUser.findUnique({ where: { id: originalId } });
    expect(restored.deletedAt).toBeNull();
    expect(restored.isActive).toBe(true);
    expect(restored.name).toBe('Reactivated Admin');

    // 6. Verify newly reactivated admin can login with new password
    const newLoginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'reusable.admin@example.com',
        password: 'Reactivated-password-123'
      }
    });
    expect(newLoginRes.statusCode).toBe(200);

    // Old password should fail
    const oldLoginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'reusable.admin@example.com',
        password: 'Original-password-123'
      }
    });
    expect(oldLoginRes.statusCode).toBe(401);

    // 7. Verify audit log entry
    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: 'AdminUser', entityId: originalId }
    });
    const reactivatedLog = auditLogs.find((l: any) => l.action === 'ADMIN_ACCOUNT_REACTIVATED');
    expect(reactivatedLog).toBeTruthy();
    expect(reactivatedLog.metadata.email).toBe('reusable.admin@example.com');
  });
});
