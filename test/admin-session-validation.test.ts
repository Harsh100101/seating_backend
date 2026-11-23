import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, TECH_ADMIN_EMAIL } from '../prisma/seed.js';
import { signJwt } from '../src/utils/jwt.js';
import { normalizeUserRole } from '../src/utils/rbac.js';

describe('Admin Session Validation & Regression Tests', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'test-session-secret-at-least-32-chars-long-security!'
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('1. Valid active SUPER_ADMIN session loads protected routes (/api/reports/summary, /api/auth/me)', async () => {
    const admin = await mockPrisma.adminUser.findUnique({
      where: { email: DEFAULT_ADMIN.email.toLowerCase() }
    });
    expect(admin).toBeDefined();

    const token = signJwt({
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      role: 'SUPER_ADMIN',
      authTimeMs: Date.now()
    });

    const meRes = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().role).toBe('SUPER_ADMIN');

    const summaryRes = await server.inject({
      method: 'GET',
      url: '/api/reports/summary',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(summaryRes.statusCode).toBe(200);
  });

  it('2. Valid active TECH_ADMIN session loads protected routes and global audit logs', async () => {
    const techAdmin = await mockPrisma.adminUser.findUnique({
      where: { email: TECH_ADMIN_EMAIL.toLowerCase() }
    });
    expect(techAdmin).toBeDefined();

    const token = signJwt({
      adminId: techAdmin.id,
      email: techAdmin.email,
      name: techAdmin.name,
      role: 'TECH_ADMIN',
      authTimeMs: Date.now()
    });

    const auditRes = await server.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(auditRes.statusCode).toBe(200);
  });

  it('3. Valid active UNIT_ADMIN session loads protected routes for authorized unit', async () => {
    const unit = await mockPrisma.unit.create({
      data: {
        name: 'Unit 1 Validation',
        code: 'U1V'
      }
    });

    const unitAdminRecord = await mockPrisma.adminUser.create({
      data: {
        email: 'test.unitadmin@example.com',
        name: 'Unit Admin Test',
        passwordHash: 'dummy',
        role: 'UNIT_ADMIN',
        isActive: true,
        assignedUnitId: unit.id
      }
    });

    const token = signJwt({
      adminId: unitAdminRecord.id,
      email: unitAdminRecord.email,
      name: unitAdminRecord.name,
      role: 'UNIT_ADMIN',
      assignedUnitId: unit.id,
      authTimeMs: Date.now()
    });

    const meRes = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().role).toBe('UNIT_ADMIN');
  });

  it('4. Inactive legacy admin is strictly rejected with 403 on protected routes', async () => {
    const inactiveAdmin = await mockPrisma.adminUser.create({
      data: {
        email: 'legacy.inactive@example.com',
        name: 'Inactive Admin',
        passwordHash: 'dummy',
        role: 'SUPER_ADMIN',
        isActive: false
      }
    });

    const token = signJwt({
      adminId: inactiveAdmin.id,
      email: inactiveAdmin.email,
      name: inactiveAdmin.name,
      role: 'SUPER_ADMIN',
      authTimeMs: Date.now()
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/reports/summary',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/inactive/i);
  });

  it('5. Stale token with non-existent or malformed adminId returns 401 without crashing', async () => {
    const malformedToken = signJwt({
      adminId: 'non-existent-or-malformed-id',
      email: 'ghost@example.com',
      role: 'SUPER_ADMIN'
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/reports/summary',
      headers: { authorization: `Bearer ${malformedToken}` }
    });
    expect(res.statusCode).toBe(401);
  });

  it('6. Role normalization maps non-underscored variants (SUPERADMIN -> SUPER_ADMIN)', () => {
    expect(normalizeUserRole('SUPERADMIN')).toBe('SUPER_ADMIN');
    expect(normalizeUserRole('SUPER_ADMIN')).toBe('SUPER_ADMIN');
    expect(normalizeUserRole('TECHADMIN')).toBe('TECH_ADMIN');
    expect(normalizeUserRole('TECH_ADMIN')).toBe('TECH_ADMIN');
    expect(normalizeUserRole('UNITADMIN')).toBe('UNIT_ADMIN');
    expect(normalizeUserRole('UNIT_ADMIN')).toBe('UNIT_ADMIN');
  });

  it('7. Timestamp precision: legitimate token issued in the same second as updatedAt is NOT falsely invalidated', async () => {
    const admin = await mockPrisma.adminUser.findUnique({
      where: { email: DEFAULT_ADMIN.email.toLowerCase() }
    });
    const nowMs = Date.now();
    await mockPrisma.adminUser.update({
      where: { id: admin.id },
      data: { name: 'Super Admin Updated' }
    });

    const token = signJwt({
      adminId: admin.id,
      email: admin.email,
      role: 'SUPER_ADMIN',
      authTimeMs: nowMs + 500
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(200);
  });

  it('8. Timestamp invalidation: token issued BEFORE subsequent account security update is rejected', async () => {
    const admin = await mockPrisma.adminUser.findUnique({
      where: { email: DEFAULT_ADMIN.email.toLowerCase() }
    });
    const pastTimeMs = Date.now() - 5000;

    const token = signJwt({
      adminId: admin.id,
      email: admin.email,
      role: 'SUPER_ADMIN',
      authTimeMs: pastTimeMs
    });

    await mockPrisma.adminUser.update({
      where: { id: admin.id },
      data: { role: 'UNIT_ADMIN' }
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/session expired/i);
  });
});
