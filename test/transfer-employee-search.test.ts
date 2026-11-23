import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEMO_PASSWORD, seed } from '../prisma/seed.js';

describe('Unit Admin transfer employee search', () => {
  let server: FastifyInstance;
  let unit1AdminCookie: string;

  beforeEach(async () => {
    const prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });
    const unit1 = await prisma.unit.findFirst({ where: { code: 'UNIT-1' } });
    const unit2 = await prisma.unit.findFirst({ where: { code: 'UNIT-2' } });
    const unit1Department = await prisma.department.create({
      data: { name: 'Search Unit One', code: `SEARCH-U1-${Date.now()}`, unitId: unit1.id }
    });
    const unit2Department = await prisma.department.create({
      data: { name: 'Search Unit Two', code: `SEARCH-U2-${Date.now()}`, unitId: unit2.id }
    });

    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-SEARCH-001',
        fullName: 'Amit Tiwari',
        email: `search-u1-${Date.now()}@example.com`,
        departmentId: unit1Department.id
      }
    });
    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-SEARCH-002',
        fullName: 'Rahul Patil',
        email: `search-u2-${Date.now()}@example.com`,
        departmentId: unit2Department.id
      }
    });

    server = buildServer({
      prisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unit1.admin@shaktiman.com', password: DEMO_PASSWORD }
    });
    unit1AdminCookie = login.headers['set-cookie'] as string;
  });

  afterEach(async () => server.close());

  it('supports trimmed partial ID and case-insensitive multi-word name search', async () => {
    const byId = await server.inject({
      method: 'GET',
      url: '/api/employees?search=%20emp-search-00%20&limit=20',
      headers: { cookie: unit1AdminCookie }
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().employees.map((employee: any) => employee.employeeCode)).toContain('EMP-SEARCH-001');

    const byName = await server.inject({
      method: 'GET',
      url: '/api/employees?search=AMIT%20TIW&limit=20',
      headers: { cookie: unit1AdminCookie }
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().employees.map((employee: any) => employee.fullName)).toContain('Amit Tiwari');
  });

  it('never returns a matching employee from another Unit', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/employees?search=EMP-SEARCH-002&limit=20',
      headers: { cookie: unit1AdminCookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().employees).toHaveLength(0);
  });
});
