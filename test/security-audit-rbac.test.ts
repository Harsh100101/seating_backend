import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Senior Security Audit - RBAC & IDOR Verification Suite', () => {
  let server: FastifyInstance;
  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;
  let unit1Id: string;
  let unit2Id: string;
  let unit1DeptId: string;
  let unit2DeptId: string;
  let unit2SeatId: string;
  let unit2EmployeeId: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    const u1 = await mockPrisma.unit.findFirst({ where: { code: 'UNIT-1' } });
    const u2 = await mockPrisma.unit.findFirst({ where: { code: 'UNIT-2' } });
    unit1Id = u1!.id;
    unit2Id = u2!.id;

    // Unit 1 department
    const d1 = await mockPrisma.department.create({
      data: {
        name: 'Unit 1 Quality Assurance',
        code: 'QA-U1',
        colorHex: '#10B981',
        unitId: unit1Id,
      }
    });
    unit1DeptId = d1.id;

    // Unit 2 department
    const d2 = await mockPrisma.department.create({
      data: {
        name: 'Unit 2 Assembly Department',
        code: 'ASM-U2',
        colorHex: '#3B82F6',
        unitId: unit2Id,
      }
    });
    unit2DeptId = d2.id;

    // Unit 2 hierarchy: Plant, Building, Floor, Seat
    const p2 = await mockPrisma.plant.create({
      data: {
        name: 'Unit 2 Main Plant',
        code: 'PLT-U2-01',
        unitId: unit2Id,
      }
    });

    const b2 = await mockPrisma.building.create({
      data: {
        name: 'Unit 2 Admin Block',
        code: 'BLD-U2-01',
        plantId: p2.id,
      }
    });

    const f2 = await mockPrisma.floor.create({
      data: {
        name: 'Unit 2 Floor 1',
        floorNumber: 1,
        buildingId: b2.id,
        canvasWidth: 1000,
        canvasHeight: 800,
      }
    });

    const emp2 = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-U2-999',
        fullName: 'Unit 2 Operator',
        departmentId: d2.id,
      }
    });
    unit2EmployeeId = emp2.id;

    const s2 = await mockPrisma.seat.create({
      data: {
        floorId: f2.id,
        label: 'WS-U2-101',
        x: 100,
        y: 100,
        status: 'AVAILABLE',
        employeeId: emp2.id,
        departmentId: d2.id,
      }
    });
    unit2SeatId = s2.id;

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    const login = async (email: string) => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: DEMO_PASSWORD }
      });
      return res.headers['set-cookie'] as string;
    };

    superAdminCookie = await login('superadmin@shaktiman.com');
    unit1AdminCookie = await login('unit1.admin@shaktiman.com');
    unit2AdminCookie = await login('unit2.admin@shaktiman.com');
  }, 30000);

  afterEach(async () => {
    if (server) await server.close();
  });

  // 1. Department IDOR & Unit Isolation
  describe('Department Access Control & Multi-Tenancy Enforcement', () => {
    it('SEC-DEPT-01: Unit 1 Admin CANNOT create department in Unit 2 (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: unit1AdminCookie },
        payload: {
          name: 'Hacked Department',
          code: 'HCK',
          colorHex: '#FF0000',
          unitId: unit2Id,
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-DEPT-02: Unit 1 Admin CANNOT update or rename Unit 2 department (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/departments/${unit2DeptId}`,
        headers: { cookie: unit1AdminCookie },
        payload: {
          name: 'Tampered Unit 2 Dept'
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-DEPT-03: Unit 1 Admin CANNOT delete Unit 2 department (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/departments/${unit2DeptId}`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-DEPT-04: Super Admin CAN create, update, and manage departments across units', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: {
          name: 'Global HQ Dept',
          code: 'GHQ-01',
          colorHex: '#4F46E5',
          unitId: unit2Id,
        }
      });
      expect(res.statusCode).toBe(201);
    });
  });

  // 2. Seat Scoping & Admin Role Checks
  describe('Seat Assignment & Unassignment Role Scoping', () => {
    it('SEC-SEAT-01: Unit 1 Admin CANNOT assign seat in Unit 2 (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/assign`,
        headers: { cookie: unit1AdminCookie },
        payload: { employeeId: unit2EmployeeId }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-SEAT-02: Unit 1 Admin CANNOT unassign seat in Unit 2 (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // 3. Employee Multi-Tenancy Scoping
  describe('Employee Management Multi-Tenancy Scoping', () => {
    it('SEC-EMP-01: Unit 1 Admin CANNOT create employee assigned to Unit 2 Department (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: unit1AdminCookie },
        payload: {
          employeeCode: 'EMP-ROGUE-01',
          fullName: 'Rogue Employee',
          departmentId: unit2DeptId,
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-EMP-02: Unit 1 Admin CANNOT edit Unit 2 employee (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/employees/${unit2EmployeeId}`,
        headers: { cookie: unit1AdminCookie },
        payload: {
          fullName: 'Tampered Name',
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-EMP-02B: Unit 1 Admin CANNOT read Unit 2 employee details by ID (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/employees/${unit2EmployeeId}`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });

    it('SEC-EMP-03: Unit 1 Admin CANNOT delete Unit 2 employee (Blocked 403)', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/employees/${unit2EmployeeId}`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
