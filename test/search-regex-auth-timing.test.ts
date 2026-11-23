import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { employeeRoutes } from '../src/routes/employees.js';
import { auditLogRoutes } from '../src/routes/audit-logs.js';
import { authRoutes } from '../src/routes/auth.js';
import { createMockPrisma } from './mock-prisma.js';
import { escapeRegexLiteral } from '../src/utils/regex.js';

describe('Backend Search Regex Escaping & Auth Timing Remediation', () => {
  let app: FastifyInstance;
  let prisma: any;
  let testDept: any;
  let adminUser: any;

  beforeAll(async () => {
    prisma = await createMockPrisma();
    app = Fastify();
    app.decorate('prisma', prisma);

    // Provide default super admin context for authenticated endpoints
    adminUser = {
      id: 'admin-super-01',
      role: 'SUPER_ADMIN',
      email: 'superadmin@shaktiman.com',
      name: 'Super Admin'
    };
    app.addHook('onRequest', async (request: any) => {
      request.admin = adminUser;
    });

    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.register(auditLogRoutes, { prefix: '/api/audit-logs' });
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();

    // Create a base unit & department
    const unit = await prisma.unit.create({
      data: { name: 'Engineering Unit', code: 'ENG-U1' }
    });
    testDept = await prisma.department.create({
      data: { name: 'IT Support & Infra', code: 'IT-01', unitId: unit.id }
    });

    // Seed test employees with regex-sensitive characters
    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-[01]*',
        fullName: 'IT (Support) Special+ist',
        email: 'support+tier1@company.com',
        designation: 'Senior Engineer (L2)',
        departmentId: testDept.id,
        pcNumber: 'PC?(01)',
        isActive: true
      }
    });

    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-C2-999',
        fullName: 'Legacy Synthetic Employee',
        email: 'synthetic@company.com',
        departmentId: testDept.id,
        isActive: true
      }
    });

    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-AB-01',
        fullName: 'Project A+B Lead',
        email: 'lead-ab@company.com',
        departmentId: testDept.id,
        isActive: true
      }
    });

    // Seed an audit log with regex-sensitive characters
    await prisma.auditLog.create({
      data: {
        action: 'SEAT_ASSIGNED',
        entityType: 'SEAT',
        entityId: 'WS-[TEST]+1',
        adminId: adminUser.id,
        details: { note: 'Assigned for IT (Support) onboarding' }
      }
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('escapeRegexLiteral helper', () => {
    it('properly escapes all regex metacharacters', () => {
      expect(escapeRegexLiteral('(')).toBe('\\(');
      expect(escapeRegexLiteral('[')).toBe('\\[');
      expect(escapeRegexLiteral('*')).toBe('\\*');
      expect(escapeRegexLiteral('+')).toBe('\\+');
      expect(escapeRegexLiteral('?')).toBe('\\?');
      expect(escapeRegexLiteral('.')).toBe('\\.');
      expect(escapeRegexLiteral('IT (Support)')).toBe('IT \\(Support\\)');
      expect(escapeRegexLiteral('A+B')).toBe('A\\+B');
      expect(escapeRegexLiteral('[test]')).toBe('\\[test\\]');
      expect(escapeRegexLiteral('a{1,2}^$|\\')).toBe('a\\{1,2\\}\\^\\$\\|\\\\');
    });
  });

  describe('MUST FIX 2: Employee Search Regex Escaping', () => {
    it('searches successfully for query with parentheses: "IT (Support)"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/employees?search=IT (Support)'
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.employees.length).toBeGreaterThanOrEqual(1);
      expect(data.employees.some((e: any) => e.fullName === 'IT (Support) Special+ist')).toBe(true);
    });

    it('searches successfully for query with plus sign: "A+B"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?search=${encodeURIComponent('A+B')}`
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.employees.some((e: any) => e.fullName === 'Project A+B Lead')).toBe(true);
    });

    it('searches successfully for query with brackets and wildcard: "EMP-[01]*"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/employees?search=EMP-[01]*'
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.employees.some((e: any) => e.employeeCode === 'EMP-[01]*')).toBe(true);
    });

    it('handles lone metacharacters without regex syntax errors (500)', async () => {
      for (const char of ['(', '[', '*', '+', '?', '.', ')', ']', '{', '}', '^', '$', '|']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/employees?search=${encodeURIComponent(char)}`
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('escapes user input in specific field query parameters: empCode, name, pcNumber', async () => {
      const resCode = await app.inject({
        method: 'GET',
        url: '/api/employees?empCode=[01]*'
      });
      expect(resCode.statusCode).toBe(200);
      expect(resCode.json().employees.some((e: any) => e.employeeCode === 'EMP-[01]*')).toBe(true);

      const resName = await app.inject({
        method: 'GET',
        url: '/api/employees?name=(Support)'
      });
      expect(resName.statusCode).toBe(200);
      expect(resName.json().employees.some((e: any) => e.fullName === 'IT (Support) Special+ist')).toBe(true);

      const resPc = await app.inject({
        method: 'GET',
        url: '/api/employees?pcNumber=?(01)'
      });
      expect(resPc.statusCode).toBe(200);
      expect(resPc.json().employees.some((e: any) => e.pcNumber === 'PC?(01)')).toBe(true);
    });
  });

  describe('SHOULD FIX 13: Synthetic employee prefix EMP-C2- visibility', () => {
    it('returns employee with EMP-C2- prefix in global employee search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/employees'
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      const c2Employee = data.employees.find((e: any) => e.employeeCode === 'EMP-C2-999');
      expect(c2Employee).toBeDefined();
      expect(c2Employee.fullName).toBe('Legacy Synthetic Employee');
    });

    it('allows searching specifically for EMP-C2- employee', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/employees?search=EMP-C2-999'
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.employees.length).toBe(1);
      expect(data.employees[0].employeeCode).toBe('EMP-C2-999');
    });
  });

  describe('MUST FIX 2: Audit Log Search Regex Escaping', () => {
    it('searches audit logs with regex metacharacters in query parameter "q"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/audit-logs?q=${encodeURIComponent('WS-[TEST]+1')}`
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.logs.some((l: any) => l.entityId === 'WS-[TEST]+1')).toBe(true);
    });

    it('handles metacharacters in "q" and "performedBy" safely without 500 error', async () => {
      for (const term of ['(', '[', '*', '+', '?', '.', '[test]', 'IT (Support)', 'A+B']) {
        const resQ = await app.inject({
          method: 'GET',
          url: `/api/audit-logs?q=${encodeURIComponent(term)}`
        });
        expect(resQ.statusCode).toBe(200);

        const resPerformedBy = await app.inject({
          method: 'GET',
          url: `/api/audit-logs?performedBy=${encodeURIComponent(term)}`
        });
        expect(resPerformedBy.statusCode).toBe(200);
      }
    });
  });

  describe('NICE TO HAVE 16: Login user enumeration timing mitigation', () => {
    it('executes dummy argon2.verify against static valid hash when email is not found', async () => {
      const verifySpy = vi.spyOn(argon2, 'verify');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'nonexistent-admin@example.com',
          password: 'Password123!'
        }
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.statusCode).toBe(401);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid email or password');

      // Verify dummy argon2 verification was invoked
      expect(verifySpy).toHaveBeenCalled();
      const lastCall = verifySpy.mock.calls[verifySpy.mock.calls.length - 1];
      expect(lastCall[0]).toContain('$argon2id$');
      expect(lastCall[1]).toBe('Password123!');

      verifySpy.mockRestore();
    });

    it('returns consistent generic 401 message for non-existent user and wrong password', async () => {
      // Non-existent email
      const resMissing = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'definitely-does-not-exist@example.com',
          password: 'AnyPassword123!'
        }
      });

      // Existing email, wrong password
      const resWrongPw = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: adminUser.email,
          password: 'IncorrectPassword999!'
        }
      });

      expect(resMissing.statusCode).toBe(401);
      expect(resWrongPw.statusCode).toBe(401);
      expect(resMissing.json().message).toBe('Invalid email or password');
      expect(resWrongPw.json().message).toBe('Invalid email or password');
    });
  });
});
