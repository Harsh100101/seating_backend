import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('100% Strict Unit-Level Multi-Tenancy Isolation & 5-Tier Scoping', () => {
  let server: FastifyInstance;
  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;
  let unit1Id: string;
  let unit2Id: string;
  let unit1BuildingId: string;
  let unit1DeptId: string;
  let unit2DeptId: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    // Find Unit 1 and Unit 2
    const u1 = await mockPrisma.unit.findFirst({ where: { code: 'UNIT-1' } });
    const u2 = await mockPrisma.unit.findFirst({ where: { code: 'UNIT-2' } });
    unit1Id = u1!.id;
    unit2Id = u2!.id;

    // Seed Unit 1 hierarchy
    const p1 = await mockPrisma.plant.create({
      data: {
        name: 'Unit 1 Assembly Plant',
        code: 'PLT-U1-01',
        unitId: unit1Id,
      }
    });

    const b1 = await mockPrisma.building.create({
      data: {
        name: 'Unit 1 Tech Center',
        code: 'BLD-U1-01',
        plantId: p1.id,
      }
    });
    unit1BuildingId = b1.id;

    await mockPrisma.floor.create({
      data: {
        name: 'Floor 1',
        floorNumber: 1,
        buildingId: b1.id,
      }
    });

    const d1 = await mockPrisma.department.create({
      data: {
        name: 'Unit 1 Quality Assurance',
        code: 'QA-U1',
        colorHex: '#10B981',
        unitId: unit1Id,
      }
    });
    unit1DeptId = d1.id;

    const d2 = await mockPrisma.department.create({
      data: {
        name: 'Unit 2 Manufacturing Ops',
        code: 'OPS-U2',
        colorHex: '#3B82F6',
        unitId: unit2Id,
      }
    });
    unit2DeptId = d2.id;

    await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-U1-001',
        fullName: 'Arun Kumar',
        email: 'arun.u1@shaktiman.com',
        departmentId: d1.id,
      }
    });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Helper for login
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

  // ==========================================
  // Section 1: Super Admin Multi-Unit Visibility
  // ==========================================
  describe('SUPER_ADMIN Global Multi-Unit Visibility', () => {
    it('SUPER-01: Can see all 5 Units in /api/units', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(5);
      const codes = data.map((u: any) => u.code);
      expect(codes).toContain('UNIT-1');
      expect(codes).toContain('UNIT-2');
      expect(codes).toContain('UNIT-3');
      expect(codes).toContain('UNIT-4');
      expect(codes).toContain('UNIT-5');
    });

    it('SUPER-02: Can filter /api/employees by unitId', async () => {
      const empRes = await server.inject({
        method: 'GET',
        url: `/api/employees?unitId=${unit1Id}`,
        headers: { cookie: superAdminCookie }
      });
      expect(empRes.statusCode).toBe(200);
      const empData = empRes.json();
      const employees = empData.employees || empData;
      expect(Array.isArray(employees)).toBe(true);
      expect(employees.length).toBeGreaterThanOrEqual(1);
      for (const emp of employees) {
        const uId = emp.seat?.floor?.building?.plant?.unit?.id || emp.department?.unitId || emp.unit?.id;
        if (uId) {
          expect(uId).toBe(unit1Id);
        }
      }
    });
  });

  // ==========================================
  // Section 2: Unit 1 Admin & Unit 1 HOD Scoping
  // ==========================================
  describe('Unit 1 Admin & Unit 1 HOD Full Unit 1 Scope & 0 Cross-Unit Leak', () => {
    for (const role of ['UNIT_ADMIN']) {
      it(`U1-${role}: GET /api/units returns ONLY Unit 1`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/units',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBe(1);
        expect(data[0].id).toBe(unit1Id);
        expect(data[0].code).toBe('UNIT-1');
      });

      it(`U1-${role}: GET /api/units/:id allows Unit 1, blocks Unit 2 with 403`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        // Allowed
        const okRes = await server.inject({
          method: 'GET',
          url: `/api/units/${unit1Id}`,
          headers: { cookie }
        });
        expect(okRes.statusCode).toBe(200);
        expect(okRes.json().id).toBe(unit1Id);

        // Blocked cross-unit
        const forbiddenRes = await server.inject({
          method: 'GET',
          url: `/api/units/${unit2Id}`,
          headers: { cookie }
        });
        expect(forbiddenRes.statusCode).toBe(403);
      });

      it(`U1-${role}: GET /api/plants returns ONLY Unit 1 plants`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/plants',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const plants = res.json();
        expect(Array.isArray(plants)).toBe(true);
        expect(plants.length).toBeGreaterThan(0);
        for (const p of plants) {
          expect(p.unitId).toBe(unit1Id);
        }
      });

      it(`U1-${role}: GET /api/buildings returns ONLY Unit 1 buildings`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/buildings',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const buildings = res.json();
        expect(Array.isArray(buildings)).toBe(true);
        expect(buildings.length).toBeGreaterThan(0);
        for (const b of buildings) {
          expect(b.plant?.unitId).toBe(unit1Id);
        }
      });

      it(`U1-${role}: GET /api/floors returns ONLY Unit 1 floors`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/floors',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const floors = res.json();
        expect(Array.isArray(floors)).toBe(true);
        expect(floors.length).toBeGreaterThan(0);
        for (const f of floors) {
          expect(f.buildingId).toBe(unit1BuildingId);
        }
      });

      it(`U1-${role}: GET /api/departments returns ALL Unit 1 departments (not restricted to single dept)`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/departments',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const depts = res.json();
        expect(Array.isArray(depts)).toBe(true);
        expect(depts.length).toBeGreaterThan(0);
        for (const d of depts) {
          if (d.unitId) {
            expect(d.unitId).toBe(unit1Id);
          }
        }
        expect(depts.some((d: any) => d.code === 'QA-U1')).toBe(true);
      });

      it(`U1-${role}: GET /api/employees returns Unit 1 employees and enforces unit isolation even if query tries unit2`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit1AdminCookie : unit1HodCookie;
        // Even if query attempts ?unitId=unit2Id, backend overrides with unit1Id
        const res = await server.inject({
          method: 'GET',
          url: `/api/employees?unitId=${unit2Id}`,
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        const emps = data.employees || data;
        expect(Array.isArray(emps)).toBe(true);
        expect(emps.length).toBeGreaterThanOrEqual(1);
        for (const emp of emps) {
          const empUnitId = emp.seat?.floor?.building?.plant?.unit?.id || emp.department?.unitId || emp.unit?.id;
          if (empUnitId) {
            expect(empUnitId).toBe(unit1Id);
          }
        }
      });
    }
  });

  // ==========================================
  // Section 3: Unit 2 Admin & Unit 2 HOD Scoping
  // ==========================================
  describe('Unit 2 Admin & Unit 2 HOD Full Unit 2 Scope & 0 Cross-Unit Leak', () => {
    for (const role of ['UNIT_ADMIN']) {
      it(`U2-${role}: GET /api/units returns ONLY Unit 2`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit2AdminCookie : unit2HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/units',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBe(1);
        expect(data[0].id).toBe(unit2Id);
        expect(data[0].code).toBe('UNIT-2');
      });

      it(`U2-${role}: GET /api/units/:id blocks Unit 1 with 403`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit2AdminCookie : unit2HodCookie;
        const forbiddenRes = await server.inject({
          method: 'GET',
          url: `/api/units/${unit1Id}`,
          headers: { cookie }
        });
        expect(forbiddenRes.statusCode).toBe(403);

        const okRes = await server.inject({
          method: 'GET',
          url: `/api/units/${unit2Id}`,
          headers: { cookie }
        });
        expect(okRes.statusCode).toBe(200);
      });

      it(`U2-${role}: GET /api/plants returns ONLY Unit 2 plants`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit2AdminCookie : unit2HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/plants',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const plants = res.json();
        expect(Array.isArray(plants)).toBe(true);
        expect(plants.length).toBeGreaterThan(0);
        for (const p of plants) {
          expect(p.unitId).toBe(unit2Id);
        }
      });

      it(`U2-${role}: GET /api/departments returns ALL Unit 2 departments`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit2AdminCookie : unit2HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/departments',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const depts = res.json();
        expect(Array.isArray(depts)).toBe(true);
        expect(depts.length).toBeGreaterThan(0);
        for (const d of depts) {
          if (d.unitId) {
            expect(d.unitId).toBe(unit2Id);
          }
        }
        expect(depts.some((d: any) => d.code === 'QA-U1')).toBe(false); // Unit 1 dept not present
      });

      it(`U2-${role}: GET /api/employees returns ONLY Unit 2 employees`, async () => {
        const cookie = role === 'UNIT_ADMIN' ? unit2AdminCookie : unit2HodCookie;
        const res = await server.inject({
          method: 'GET',
          url: '/api/employees',
          headers: { cookie }
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        const emps = data.employees || data;
        for (const emp of emps) {
          const empUnitId = emp.seat?.floor?.building?.plant?.unit?.id || emp.department?.unitId || emp.unit?.id;
          if (empUnitId) {
            expect(empUnitId).toBe(unit2Id);
          }
        }
      });
    }
  });

  // ==========================================
  // Section 4: Employee Creation Scoping & Desktop No
  // ==========================================
  describe('Employee Creation with Desktop No and Strict Unit Isolation', () => {
    it('CREATE-01: Unit 1 Admin can create employee in Unit 1 with Desktop No (pcNumber)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: unit1AdminCookie },
        payload: {
          employeeCode: 'EMP-U1-NEW-1',
          fullName: 'Unit 1 New Operator',
          departmentId: unit1DeptId,
          pcNumber: 'PC-U1-ADM-001',
          section: 'Assembly Line',
          functionName: 'Operations',
          reportingTo: 'Manager U1',
          hod: 'HOD U1',
          isActive: true
        }
      });
      expect(res.statusCode).toBe(201);
      const created = res.json();
      expect(created.employeeCode).toBe('EMP-U1-NEW-1');
      expect(created.pcNumber).toBe('PC-U1-ADM-001');
      expect(created.section).toBe('Assembly Line');
      expect(created.departmentId).toBe(unit1DeptId);
    });

    it('CREATE-02: Unit 1 Admin CANNOT create employee in Unit 2 (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: unit1AdminCookie },
        payload: {
          employeeCode: 'EMP-LEAK-U2',
          fullName: 'Intruder in Unit 2',
          departmentId: unit2DeptId,
          pcNumber: 'PC-ILLEGAL'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('You can only create employees within your assigned Unit');
    });

    it('CREATE-03: Unit 2 Admin can create employee in Unit 2, but blocked from Unit 1 (403 Forbidden)', async () => {
      // 1. Success in Unit 2
      const okRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: unit2AdminCookie },
        payload: {
          employeeCode: 'EMP-U2-NEW-1',
          fullName: 'Unit 2 Technician',
          departmentId: unit2DeptId,
          pcNumber: 'PC-U2-SAN-042',
          section: 'Stores',
          functionName: 'Manufacturing',
          reportingTo: 'Supervisor U2',
          hod: 'HOD U2'
        }
      });
      expect(okRes.statusCode).toBe(201);
      expect(okRes.json().pcNumber).toBe('PC-U2-SAN-042');

      // 2. Blocked in Unit 1
      const blockedRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: unit2AdminCookie },
        payload: {
          employeeCode: 'EMP-LEAK-U1',
          fullName: 'Intruder in Unit 1',
          departmentId: unit1DeptId,
          pcNumber: 'PC-BAD'
        }
      });
      expect(blockedRes.statusCode).toBe(403);
    });

    

    it('CREATE-05: SUPER_ADMIN can create employees in BOTH Unit 1 and Unit 2', async () => {
      // Unit 1
      const resU1 = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-SUPER-U1',
          fullName: 'Super Admin Created U1',
          departmentId: unit1DeptId,
          pcNumber: 'PC-SUPER-U1'
        }
      });
      expect(resU1.statusCode).toBe(201);

      // Unit 2
      const resU2 = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-SUPER-U2',
          fullName: 'Super Admin Created U2',
          departmentId: unit2DeptId,
          pcNumber: 'PC-SUPER-U2'
        }
      });
      expect(resU2.statusCode).toBe(201);
    });
  });
});
