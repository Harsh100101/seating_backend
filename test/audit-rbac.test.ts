import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';
import { FastifyInstance } from 'fastify';

describe('Audit Logs RBAC & Mutation Logging Suite', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let superAdminCookie: string;
  let unitAdminCookie: string;
  

  beforeAll(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Helper to log in and get cookie
    const getSessionCookie = async (email: string) => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: DEMO_PASSWORD }
      });
      const cookieHeader = res.headers['set-cookie'];
      if (!cookieHeader) throw new Error(`Login failed for ${email}`);
      return Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    };

    superAdminCookie = await getSessionCookie('superadmin@shaktiman.com');
    unitAdminCookie = await getSessionCookie('unit2.admin@shaktiman.com');
    
  }, 35000);

  afterAll(async () => {
    await server.close();
  });

  describe('RBAC Lock on GET /api/audit-logs', () => {
    it('SUPER_ADMIN can access audit logs (200 OK)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.logs).toBeDefined();
      expect(Array.isArray(body.logs)).toBe(true);
    });

    it('UNIT_ADMIN is rejected with 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs',
        headers: { cookie: unitAdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('Super Admin only');
    });

    it('keeps historical audit rows readable when their administrator was removed', async () => {
      await mockPrisma.auditLog.create({
        data: {
          adminId: '000000000000000000000000',
          action: 'HISTORICAL_ORPHAN_CHECK',
          entityType: 'AUTH',
          entityId: 'historical-orphan-check',
          metadata: {}
        }
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs?action=HISTORICAL_ORPHAN_CHECK',
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().logs[0].admin).toBeNull();
      expect(res.json().logs[0].adminId).toBe('000000000000000000000000');
    });

    

    

    
  });

  describe('Audit Query Filtering (action, entityType, performedBy, q)', () => {
    it('filters by action', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs?action=USER_LOGIN',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const logs = res.json().logs;
      for (const log of logs) {
        expect(log.action).toBe('USER_LOGIN');
      }
    });

    it('filters by entityType mapping (e.g. AUTH, SEAT, DEPARTMENT)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs?entityType=AUTH',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const logs = res.json().logs;
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by performedBy matching admin email/name', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs?performedBy=superadmin@shaktiman.com',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
    });

    it('supports debounced search query q', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/audit-logs?q=LOGIN',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().logs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Mutation Audit Trail Logging', () => {
    it('creates AuditLog on department creation with actorRole and ipAddress', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: {
          name: 'Audit Test Dept',
          code: 'ATD',
          colorHex: '#3B82F6'
        }
      });
      expect(res.statusCode).toBe(201);
      const dept = res.json();

      const auditRes = await server.inject({
        method: 'GET',
        url: `/api/audit-logs?action=DEPARTMENT_CREATED`,
        headers: { cookie: superAdminCookie }
      });
      expect(auditRes.statusCode).toBe(200);
      const log = auditRes.json().logs.find((l: any) => l.entityId === dept.id);
      expect(log).toBeDefined();
      expect(log.action).toBe('DEPARTMENT_CREATED');
      expect(log.metadata.actorRole).toBe('SUPER_ADMIN');
      expect(log.metadata.ipAddress).toBeDefined();
    });

    it('creates AuditLog on employee creation', async () => {
      const deptRes = await server.inject({
        method: 'GET',
        url: '/api/departments',
        headers: { cookie: superAdminCookie }
      });
      const deptId = deptRes.json()[0].id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-AUDIT-99',
          fullName: 'Audit Test Employee',
          email: 'audit.emp@company.com',
          departmentId: deptId
        }
      });
      expect(empRes.statusCode).toBe(201);
      const emp = empRes.json();

      const auditRes = await server.inject({
        method: 'GET',
        url: `/api/audit-logs?action=EMPLOYEE_CREATED`,
        headers: { cookie: superAdminCookie }
      });
      expect(auditRes.statusCode).toBe(200);
      const log = auditRes.json().logs.find((l: any) => l.entityId === emp.id);
      expect(log).toBeDefined();
      expect(log.action).toBe('EMPLOYEE_CREATED');
      expect(log.metadata.employeeCode).toBe('EMP-AUDIT-99');
    });
  });
});
