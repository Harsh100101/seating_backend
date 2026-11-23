import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { employeeRoutes } from '../src/routes/employees.js';
import { createMockPrisma } from './mock-prisma.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

const enabled = process.env.RUN_REAL_PRISMA_EMPLOYEE_MATRIX === '1' && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('Milestone 2 (R2): Enterprise Matrix Employee Filtering & Response Payload', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let testDeptId: string;
  let testUnitId: string;
  let testFloorId: string;
  let seat1Id: string;
  let seat2Id: string;
  const createdEmployeeIds: string[] = [];
  const createdSeatIds: string[] = [];
  let empAId: string;
  let empBId: string;
  let empCId: string;

  const testSuffix = Date.now().toString().slice(-6);

  beforeAll(async () => {
    await verifyDisposableTestDatabase(process.env.TEST_DATABASE_URL);
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    await prisma.$connect();

    app = Fastify();
    await app.register(cookie);
    await app.register(cors);
    app.decorate('prisma', prisma);
    app.addHook('onRequest', async (req: any) => {
      req.admin = {
        id: 'matrix-m2-admin',
        email: 'superadmin@shaktiman.com',
        role: 'SUPER_ADMIN'
      };
    });
    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.ready();

    // 1. Create an explicit Unit-scoped test department for hierarchy validation.
    const unit = await prisma.unit.create({
      data: { name: `Matrix Unit ${testSuffix}`, code: `MU-${testSuffix}` }
    });
    testUnitId = unit.id;
    const dept = await prisma.department.create({
      data: {
        name: `Matrix QA Dept ${testSuffix}`,
        code: `MQD${testSuffix.slice(-3)}`,
        unitId: testUnitId,
        colorHex: '#3B82F6'
      }
    });
    testDeptId = dept.id;

    // 2. Ensure test floor
    const existingFloor = await prisma.floor.findFirst();
    if (existingFloor) {
      testFloorId = existingFloor.id;
    } else {
      let bld = await prisma.building.findFirst();
      if (!bld) {
        let plt = await prisma.plant.findFirst();
        if (!plt) {
          const unit = await prisma.unit.create({
            data: { name: `Matrix Unit ${testSuffix}`, code: `MU-${testSuffix}` }
          });
          plt = await prisma.plant.create({
            data: { name: `Matrix Plant ${testSuffix}`, code: `MP-${testSuffix}`, unitId: unit.id }
          });
        }
        bld = await prisma.building.create({
          data: { name: `Matrix Bldg ${testSuffix}`, code: `MB-${testSuffix}`, plantId: plt.id }
        });
      }
      const fl = await prisma.floor.create({
        data: { name: `Matrix Floor ${testSuffix}`, floorNumber: 99, buildingId: bld.id }
      });
      testFloorId = fl.id;
    }

    // 3. Create test seats with distinct officeArea
    const seat1 = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-M2-A-${testSuffix}`,
        officeArea: `Matrix Area Alpha ${testSuffix}`,
        status: 'AVAILABLE',
        x: 100,
        y: 100
      }
    });
    seat1Id = seat1.id;
    createdSeatIds.push(seat1.id);

    const seat2 = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-M2-B-${testSuffix}`,
        officeArea: `Matrix Area Beta ${testSuffix}`,
        status: 'AVAILABLE',
        x: 200,
        y: 200
      }
    });
    seat2Id = seat2.id;
    createdSeatIds.push(seat2.id);

    // 4. Create Employee A (Direct officeArea, unseated)
    const empA = await prisma.employee.create({
      data: {
        employeeCode: `EMPA-${testSuffix}`,
        fullName: `Employee Alpha ${testSuffix}`,
        email: `empa.${testSuffix}@example.com`,
        departmentId: testDeptId,
        ext: `501${testSuffix.slice(-2)}`,
        section: `Precision Fabrication ${testSuffix}`,
        functionName: `Operations ${testSuffix}`,
        grade: 'M1',
        reportingManager: `Manager Alpha ${testSuffix}`,
        reportingTo: `Manager Alpha ${testSuffix}`,
        hod: `HOD Director ${testSuffix}`,
        officeArea: `Matrix Area Alpha ${testSuffix}`
      }
    });
    empAId = empA.id;
    createdEmployeeIds.push(empA.id);

    // 5. Create Employee B (Seated in seat2 with seat.officeArea = 'Matrix Area Beta ...', no direct employee.officeArea)
    const empB = await prisma.employee.create({
      data: {
        employeeCode: `EMPB-${testSuffix}`,
        fullName: `Employee Beta ${testSuffix}`,
        email: `empb.${testSuffix}@example.com`,
        departmentId: testDeptId,
        ext: `502${testSuffix.slice(-2)}`,
        section: `Logistics Supply ${testSuffix}`,
        functionName: `Supply Chain ${testSuffix}`,
        grade: 'L2',
        reportingManager: `Manager Beta ${testSuffix}`,
        reportingTo: `Manager Beta ${testSuffix}`,
        hod: `HOD Director ${testSuffix}`,
        officeArea: null
      }
    });
    empBId = empB.id;
    createdEmployeeIds.push(empB.id);

    // Assign Employee B to seat2
    await prisma.seat.update({
      where: { id: seat2Id },
      data: { employeeId: empB.id }
    });

    // 6. Create Employee C (Seated in seat1 with seat.officeArea = 'Matrix Area Alpha ...')
    const empC = await prisma.employee.create({
      data: {
        employeeCode: `EMPC-${testSuffix}`,
        fullName: `Employee Gamma ${testSuffix}`,
        email: `empc.${testSuffix}@example.com`,
        departmentId: testDeptId,
        ext: `503${testSuffix.slice(-2)}`,
        section: `Precision Fabrication ${testSuffix}`,
        functionName: `Operations ${testSuffix}`,
        grade: 'M2',
        reportingManager: `Manager Alpha ${testSuffix}`,
        reportingTo: `Manager Alpha ${testSuffix}`,
        hod: `HOD Director ${testSuffix}`,
        officeArea: null
      }
    });
    empCId = empC.id;
    createdEmployeeIds.push(empC.id);

    // Assign Employee C to seat1
    await prisma.seat.update({
      where: { id: seat1Id },
      data: { employeeId: empC.id }
    });
  });

  afterAll(async () => {
    // Cleanup employees and seats
    for (const sId of createdSeatIds) {
      try {
        await prisma.seat.delete({ where: { id: sId } });
      } catch {
        // Best-effort cleanup for synthetic employee fixtures.
      }
    }
    if (createdEmployeeIds.length > 0) {
      await prisma.employee.deleteMany({
        where: { id: { in: createdEmployeeIds } }
      });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('1. GET /api/employees Query Filtering', () => {
    it('filters employees by officeArea matching direct employee.officeArea and seat.officeArea', async () => {
      const area = `Matrix Area Alpha ${testSuffix}`;
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(area)}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employees.length).toBeGreaterThanOrEqual(2);

      const codes = body.employees.map((e: any) => e.employeeCode);
      // Both Emp A (direct employee.officeArea) and Emp C (via seat.officeArea) must match
      expect(codes).toContain(`EMPA-${testSuffix}`);
      expect(codes).toContain(`EMPC-${testSuffix}`);

      // Every returned employee has resolved officeArea
      for (const emp of body.employees) {
        expect(emp.officeArea).toBe(area);
      }
    });

    it('filters employees by officeArea when matched purely through seat.officeArea', async () => {
      const area = `Matrix Area Beta ${testSuffix}`;
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(area)}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employees.length).toBeGreaterThanOrEqual(1);

      const found = body.employees.find((e: any) => e.employeeCode === `EMPB-${testSuffix}`);
      expect(found).toBeDefined();
      expect(found.officeArea).toBe(area);
      expect(found.seat?.officeArea).toBe(area);
    });

    it('filters employees by section parameter', async () => {
      const targetSection = `Logistics Supply ${testSuffix}`;
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?section=${encodeURIComponent(targetSection)}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employees.length).toBeGreaterThanOrEqual(1);

      const found = body.employees.find((e: any) => e.employeeCode === `EMPB-${testSuffix}`);
      expect(found).toBeDefined();
      expect(found.section).toBe(targetSection);

      for (const emp of body.employees) {
        expect(emp.section).toBe(targetSection);
      }
    });

    it('handles section=ALL and officeArea=ALL without filtering out records', async () => {
      const resAll = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}&section=ALL&officeArea=ALL`
      });

      expect(resAll.statusCode).toBe(200);
      const body = JSON.parse(resAll.body);
      const codes = body.employees.map((e: any) => e.employeeCode);
      expect(codes).toContain(`EMPA-${testSuffix}`);
      expect(codes).toContain(`EMPB-${testSuffix}`);
      expect(codes).toContain(`EMPC-${testSuffix}`);
    });

    it('filters by reportingManager and reportingTo interchangeably', async () => {
      const manager = `Manager Alpha ${testSuffix}`;

      // Query via reportingManager
      const res1 = await app.inject({
        method: 'GET',
        url: `/api/employees?reportingManager=${encodeURIComponent(manager)}`
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      const codes1 = body1.employees.map((e: any) => e.employeeCode);
      expect(codes1).toContain(`EMPA-${testSuffix}`);
      expect(codes1).toContain(`EMPC-${testSuffix}`);

      // Query via legacy reportingTo
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/employees?reportingTo=${encodeURIComponent(manager)}`
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      const codes2 = body2.employees.map((e: any) => e.employeeCode);
      expect(codes2).toContain(`EMPA-${testSuffix}`);
      expect(codes2).toContain(`EMPC-${testSuffix}`);
    });

    it('filters by intercom extension ext', async () => {
      const targetExt = `501${testSuffix.slice(-2)}`;
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?ext=${encodeURIComponent(targetExt)}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employees.length).toBeGreaterThanOrEqual(1);
      const found = body.employees.find((e: any) => e.employeeCode === `EMPA-${testSuffix}`);
      expect(found).toBeDefined();
      expect(found.ext).toBe(targetExt);
    });
  });

  describe('2. Response Payload Structure & Enterprise Matrix Fields', () => {
    it('returns ext, section, functionName, grade, reportingManager, reportingTo, hod, and officeArea in employee objects', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?empCode=EMPA-${testSuffix}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employees.length).toBe(1);

      const emp = body.employees[0];
      expect(emp.employeeCode).toBe(`EMPA-${testSuffix}`);
      expect(emp.ext).toBe(`501${testSuffix.slice(-2)}`);
      expect(emp.section).toBe(`Precision Fabrication ${testSuffix}`);
      expect(emp.functionName).toBe(`Operations ${testSuffix}`);
      expect(emp.grade).toBe('M1');
      expect(emp.reportingManager).toBe(`Manager Alpha ${testSuffix}`);
      expect(emp.reportingTo).toBe(`Manager Alpha ${testSuffix}`);
      expect(emp.hod).toBe(`HOD Director ${testSuffix}`);
      expect(emp.officeArea).toBe(`Matrix Area Alpha ${testSuffix}`);
    });

    it('includes seat.officeArea in seat payload for seated employees', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?empCode=EMPB-${testSuffix}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employees.length).toBe(1);

      const emp = body.employees[0];
      expect(emp.seat).not.toBeNull();
      expect(emp.seat.officeArea).toBe(`Matrix Area Beta ${testSuffix}`);
      // Fallback officeArea is populated from seat.officeArea
      expect(emp.officeArea).toBe(`Matrix Area Beta ${testSuffix}`);
    });
  });

  describe('3. Employee Create & Update Mutation Endpoints', () => {
    it('creates employee with ext, reportingManager, and officeArea via POST /api/employees', async () => {
      const newCode = `EMP-NEW-${Date.now().toString().slice(-6)}`;
      const payload = {
        employeeCode: newCode,
        fullName: 'New Enterprise Matrix Employee',
        email: `${newCode.toLowerCase()}@example.com`,
        departmentId: testDeptId,
        ext: '6010',
        section: 'Core Assembly',
        functionName: 'Manufacturing Operations',
        grade: 'M3',
        reportingManager: 'Deepak Verma',
        hod: 'General Manager',
        officeArea: 'Plant 1 Central Wing'
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/employees',
        payload
      });

      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);
      createdEmployeeIds.push(created.id);

      expect(created.employeeCode).toBe(newCode);
      expect(created.ext).toBe('6010');
      expect(created.reportingManager).toBe('Deepak Verma');
      expect(created.reportingTo).toBe('Deepak Verma');
      expect(created.officeArea).toBe('Plant 1 Central Wing');

      // Verify persistence via GET /:id
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/employees/${created.id}`
      });
      expect(getRes.statusCode).toBe(200);
      const fetched = JSON.parse(getRes.body);
      expect(fetched.ext).toBe('6010');
      expect(fetched.reportingManager).toBe('Deepak Verma');
      expect(fetched.officeArea).toBe('Plant 1 Central Wing');
    });

    it('updates employee ext, reportingManager, and officeArea via PUT /api/employees/:id', async () => {
      const updatePayload = {
        ext: '7020',
        reportingManager: 'Senior VP Matrix',
        officeArea: 'Executive Suite Area'
      };

      const res = await app.inject({
        method: 'PUT',
        url: `/api/employees/${empAId}`,
        payload: { ...updatePayload, unitId: testUnitId }
      });

      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);
      expect(updated.ext).toBe('7020');
      expect(updated.reportingManager).toBe('Senior VP Matrix');
      expect(updated.reportingTo).toBe('Senior VP Matrix');
      expect(updated.officeArea).toBe('Executive Suite Area');
    });
  });

  describe('4. Mock Prisma In-Memory Verification', () => {
    it('verifies mockPrisma supports officeArea and section filtering in findMany and count', async () => {
      const mockPrisma = await createMockPrisma();

      // Create department in mock
      const dept = await mockPrisma.department.create({
        data: { name: 'Mock Matrix Dept', code: 'MMD' }
      });

      // Create seat with officeArea
      const seat = await mockPrisma.seat.create({
        data: {
          label: 'MOCK-WS-01',
          officeArea: 'Mock Seat Area',
          floorId: 'mock-floor-1'
        }
      });

      // Employee 1: direct officeArea, section Alpha
      const emp1 = await mockPrisma.employee.create({
        data: {
          employeeCode: 'MOCK-EMP-1',
          fullName: 'Mock Emp One',
          departmentId: dept.id,
          ext: '101',
          section: 'Section Alpha',
          officeArea: 'Mock Emp Area',
          reportingManager: 'Mock Boss'
        }
      });

      // Employee 2: assigned to seat with officeArea 'Mock Seat Area', section Beta
      const emp2 = await mockPrisma.employee.create({
        data: {
          employeeCode: 'MOCK-EMP-2',
          fullName: 'Mock Emp Two',
          departmentId: dept.id,
          ext: '102',
          section: 'Section Beta',
          reportingManager: 'Mock Boss'
        }
      });

      await mockPrisma.seat.update({
        where: { id: seat.id },
        data: { employeeId: emp2.id }
      });

      // Test section filter
      const sectionResults = await mockPrisma.employee.findMany({
        where: { section: { equals: 'Section Alpha', mode: 'insensitive' } }
      });
      expect(sectionResults.length).toBe(1);
      expect(sectionResults[0].employeeCode).toBe('MOCK-EMP-1');

      const sectionCount = await mockPrisma.employee.count({
        where: { section: { equals: 'Section Alpha', mode: 'insensitive' } }
      });
      expect(sectionCount).toBe(1);

      // Test direct employee officeArea match
      const empAreaResults = await mockPrisma.employee.findMany({
        where: {
          OR: [
            { officeArea: { equals: 'Mock Emp Area', mode: 'insensitive' } },
            { seat: { officeArea: { equals: 'Mock Emp Area', mode: 'insensitive' } } }
          ]
        }
      });
      expect(empAreaResults.length).toBe(1);
      expect(empAreaResults[0].employeeCode).toBe('MOCK-EMP-1');

      // Test seat.officeArea match
      const seatAreaResults = await mockPrisma.employee.findMany({
        where: {
          OR: [
            { officeArea: { equals: 'Mock Seat Area', mode: 'insensitive' } },
            { seat: { officeArea: { equals: 'Mock Seat Area', mode: 'insensitive' } } }
          ]
        }
      });
      expect(seatAreaResults.length).toBe(1);
      expect(seatAreaResults[0].employeeCode).toBe('MOCK-EMP-2');
      expect(seatAreaResults[0].seat).not.toBeNull();
      expect(seatAreaResults[0].seat?.officeArea).toBe('Mock Seat Area');

      // Test reportingManager match
      const managerResults = await mockPrisma.employee.findMany({
        where: {
          OR: [
            { reportingTo: { equals: 'Mock Boss', mode: 'insensitive' } },
            { reportingManager: { equals: 'Mock Boss', mode: 'insensitive' } }
          ]
        }
      });
      expect(managerResults.length).toBe(2);
    });
  });
});
