import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { employeeRoutes } from '../src/routes/employees.js';
import { createMockPrisma } from './mock-prisma.js';
import { normalizeEmpCode } from '../src/utils/employee-code.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

const enabled = process.env.RUN_REAL_PRISMA_EMPLOYEE_MATRIX === '1' && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('Empirical Challenger M2 Matrix 2: Interface Conformance, Mutations & Mock Fidelity', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let testDeptId: string;
  let testUnitId: string;
  let testFloorId: string;
  let seatSeatedId: string;
  let seatDirectId: string;
  const createdEmpIds: string[] = [];
  const createdSeatIds: string[] = [];

  const uid = `c2_${Date.now().toString().slice(-6)}`;
  const areaOfficeAlpha = `Challenger Alpha Zone ${uid}`;
  const areaOfficeBeta = `Challenger Beta Zone ${uid}`;
  const sectionQA = `Matrix Core Quality ${uid}`;
  const managerName = `Pankaj Upadhyay ${uid}`;
  const extCode = `458${uid.slice(-2)}`;

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
        id: `c2-admin-${uid}`,
        email: `c2admin-${uid}@shaktiman.com`,
        role: 'SUPER_ADMIN'
      };
    });
    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.ready();

    // 1. Department
    const dept = await prisma.department.create({
      data: {
        name: `Dept C2 Matrix ${uid}`,
        code: `DC2${uid.slice(-3)}`
      }
    });
    testDeptId = dept.id;

    // 2. Unit -> Plant -> Building -> Floor
    const unit = await prisma.unit.create({
      data: { name: `Unit C2 ${uid}`, code: `U2-${uid.slice(-3)}` }
    });
    testUnitId = unit.id;
    await prisma.department.update({
      where: { id: testDeptId },
      data: { unitId: unit.id }
    });
    const plant = await prisma.plant.create({
      data: { name: `Plant C2 ${uid}`, code: `P2-${uid.slice(-3)}`, unitId: unit.id }
    });
    const bld = await prisma.building.create({
      data: { name: `Bldg C2 ${uid}`, code: `B2-${uid.slice(-3)}`, plantId: plant.id }
    });
    const floor = await prisma.floor.create({
      data: { name: `Floor C2 ${uid}`, floorNumber: 77, buildingId: bld.id }
    });
    testFloorId = floor.id;

    // 3. Seats
    const seat1 = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-C2-S1-${uid}`,
        officeArea: areaOfficeAlpha,
        status: 'AVAILABLE',
        x: 10,
        y: 10
      }
    });
    seatSeatedId = seat1.id;
    createdSeatIds.push(seat1.id);

    const seat2 = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-C2-S2-${uid}`,
        officeArea: areaOfficeBeta,
        status: 'AVAILABLE',
        x: 20,
        y: 20
      }
    });
    seatDirectId = seat2.id;
    createdSeatIds.push(seat2.id);
  });

  afterAll(async () => {
    // Cleanup created records
    try {
      if (createdEmpIds.length > 0) {
        await prisma.employee.deleteMany({
          where: { id: { in: createdEmpIds } }
        });
      }
      if (createdSeatIds.length > 0) {
        await prisma.seat.deleteMany({
          where: { id: { in: createdSeatIds } }
        });
      }
      if (testFloorId) {
        const floor = await prisma.floor.findUnique({ where: { id: testFloorId }, select: { buildingId: true } });
        if (floor) {
          const bld = await prisma.building.findUnique({ where: { id: floor.buildingId }, select: { plantId: true } });
          await prisma.floor.delete({ where: { id: testFloorId } });
          if (bld) {
            const plt = await prisma.plant.findUnique({ where: { id: bld.plantId }, select: { unitId: true } });
            await prisma.building.delete({ where: { id: floor.buildingId } });
            if (plt) {
              await prisma.plant.delete({ where: { id: bld.plantId } });
              await prisma.unit.delete({ where: { id: plt.unitId } });
            }
          }
        }
      }
      if (testDeptId) {
        await prisma.department.delete({ where: { id: testDeptId } });
      }
    } catch {
      // Best-effort cleanup
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('1. Interface Conformance: POST /api/employees Mutations', () => {
    it('creates employee with ext, reportingManager, officeArea, section, functionName, grade, hod', async () => {
      const payload = {
        employeeCode: `EMP-C2-01-${uid}`,
        fullName: `Employee Alpha ${uid}`,
        email: `emp.alpha.${uid}@shaktiman.com`,
        unitId: testUnitId,
        departmentId: testDeptId,
        ext: extCode,
        section: sectionQA,
        functionName: 'Quality Assurance & Testing',
        grade: 'M2',
        reportingManager: managerName,
        hod: `HOD Director ${uid}`,
        officeArea: areaOfficeBeta
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/employees',
        payload
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdEmpIds.push(body.id);

      expect(body.employeeCode).toBe(normalizeEmpCode(`EMP-C2-01-${uid}`));
      expect(body.ext).toBe(extCode);
      expect(body.section).toBe(sectionQA);
      expect(body.functionName).toBe('Quality Assurance & Testing');
      expect(body.grade).toBe('M2');
      expect(body.reportingManager).toBe(managerName);
      expect(body.reportingTo).toBe(managerName); // backward-compatible mirror
      expect(body.hod).toBe(`HOD Director ${uid}`);
      expect(body.officeArea).toBe(areaOfficeBeta);
    });

    it('creates employee with reportingTo only, verifying reportingManager mirrors cleanly', async () => {
      const payload = {
        employeeCode: `EMP-C2-02-${uid}`,
        fullName: `Employee Beta ${uid}`,
        email: `emp.beta.${uid}@shaktiman.com`,
        unitId: testUnitId,
        departmentId: testDeptId,
        reportingTo: `Legacy Leader ${uid}`
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/employees',
        payload
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdEmpIds.push(body.id);

      expect(body.reportingTo).toBe(`Legacy Leader ${uid}`);
      expect(body.reportingManager).toBe(`Legacy Leader ${uid}`);
    });
  });

  describe('2. Interface Conformance: PUT /api/employees/:id Mutations', () => {
    it('updates ext, reportingManager, and officeArea on an existing employee', async () => {
      const targetEmpId = createdEmpIds[0];
      const updatePayload = {
        ext: '9999',
        reportingManager: `Updated Manager ${uid}`,
        officeArea: `Updated Area ${uid}`,
        section: `Updated Section ${uid}`
      };

      const res = await app.inject({
        method: 'PUT',
        url: `/api/employees/${targetEmpId}`,
        payload: updatePayload
      });

      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);

      expect(updated.ext).toBe('9999');
      expect(updated.reportingManager).toBe(`Updated Manager ${uid}`);
      expect(updated.reportingTo).toBe(`Updated Manager ${uid}`);
      expect(updated.officeArea).toBe(`Updated Area ${uid}`);
      expect(updated.section).toBe(`Updated Section ${uid}`);
    });

    it('updates employee with reportingTo, verifying reportingManager mirrors cleanly in PUT', async () => {
      const targetEmpId = createdEmpIds[1];
      const updatePayload = {
        reportingTo: `New Alternate Leader ${uid}`
      };

      const res = await app.inject({
        method: 'PUT',
        url: `/api/employees/${targetEmpId}`,
        payload: updatePayload
      });

      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);

      expect(updated.reportingTo).toBe(`New Alternate Leader ${uid}`);
      expect(updated.reportingManager).toBe(`New Alternate Leader ${uid}`);
    });

    it('allows clearing ext and officeArea by setting to null', async () => {
      const targetEmpId = createdEmpIds[0];
      const updatePayload = {
        ext: null,
        officeArea: null
      };

      const res = await app.inject({
        method: 'PUT',
        url: `/api/employees/${targetEmpId}`,
        payload: updatePayload
      });

      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);

      expect(updated.ext).toBeNull();
      expect(updated.officeArea).toBeNull();
    });
  });

  describe('3. GET /api/employees & Fallback Resolution', () => {
    it('returns officeArea from seat in GET /api/employees when employee.officeArea is null', async () => {
      // Assign emp 2 to seat1 (which has areaOfficeAlpha)
      const emp2Id = createdEmpIds[1];
      await prisma.seat.update({
        where: { id: seatSeatedId },
        data: { employeeId: emp2Id }
      });

      // Verify GET /api/employees returns resolved officeArea via resolvedEmployees
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}`
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      const empInList = listBody.employees.find((e: any) => e.id === emp2Id);

      expect(empInList).toBeDefined();
      expect(empInList.officeArea).toBe(areaOfficeAlpha); // resolved fallback from seat!
      expect(empInList.seat).not.toBeNull();
      expect(empInList.seat.officeArea).toBe(areaOfficeAlpha);

      // Verify GET /:id returns seat.officeArea on seat relation
      const singleRes = await app.inject({
        method: 'GET',
        url: `/api/employees/${emp2Id}`
      });

      expect(singleRes.statusCode).toBe(200);
      const singleEmp = JSON.parse(singleRes.body);
      expect(singleEmp.seat).not.toBeNull();
      expect(singleEmp.seat.officeArea).toBe(areaOfficeAlpha);
    });

    it('preserves direct employee.officeArea when seat has a different officeArea', async () => {
      // Assign emp 1 to seat2 (which has areaOfficeBeta), but set employee.officeArea to custom direct
      const emp1Id = createdEmpIds[0];
      await prisma.employee.update({
        where: { id: emp1Id },
        data: { officeArea: `Direct Priority ${uid}` }
      });
      await prisma.seat.update({
        where: { id: seatDirectId },
        data: { employeeId: emp1Id }
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find((e: any) => e.id === emp1Id);

      expect(emp.id).toBe(emp1Id);
      expect(emp.officeArea).toBe(`Direct Priority ${uid}`); // Direct takes precedence!
      expect(emp.seat.officeArea).toBe(areaOfficeBeta);
    });
  });

  describe('4. Backward Compatibility & Query Filtering', () => {
    it('filters GET /api/employees by officeArea matching seat officeArea', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(areaOfficeAlpha)}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const codes = body.employees.map((e: any) => e.employeeCode);

      expect(codes).toContain(normalizeEmpCode(`EMP-C2-02-${uid}`));
    });

    it('filters GET /api/employees by officeArea matching direct employee officeArea', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(`Direct Priority ${uid}`)}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const codes = body.employees.map((e: any) => e.employeeCode);

      expect(codes).toContain(normalizeEmpCode(`EMP-C2-01-${uid}`));
    });

    it('returns all employees when query filters use ALL placeholder', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}&officeArea=ALL&section=ALL&reportingManager=ALL&ext=ALL`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const codes = body.employees.map((e: any) => e.employeeCode);

      expect(codes).toContain(normalizeEmpCode(`EMP-C2-01-${uid}`));
      expect(codes).toContain(normalizeEmpCode(`EMP-C2-02-${uid}`));
    });
  });

  describe('5. In-Memory mockPrisma Emulation Fidelity', () => {
    it('verifies mockPrisma handles employee mutations and filter matching identical to live Prisma', async () => {
      const mockPrisma = await createMockPrisma();

      const dept = await mockPrisma.department.create({
        data: { name: 'Mock Dept C2', code: 'MDC2' }
      });

      const seat = await mockPrisma.seat.create({
        data: {
          label: 'MOCK-C2-S1',
          officeArea: 'Mock Area 99',
          floorId: 'fl-mock'
        }
      });

      // Create employee with new matrix fields
      const emp = await mockPrisma.employee.create({
        data: {
          employeeCode: 'MOCK-C2-E1',
          fullName: 'Mock Person C2',
          departmentId: dept.id,
          ext: '7777',
          section: 'Mock Quality',
          functionName: 'Mock QA',
          reportingManager: 'Mock Boss Person',
          reportingTo: 'Mock Boss Person',
          officeArea: null
        }
      });

      expect(emp.ext).toBe('7777');
      expect(emp.reportingManager).toBe('Mock Boss Person');
      expect(emp.section).toBe('Mock Quality');

      // Update employee in mock
      const updated = await mockPrisma.employee.update({
        where: { id: emp.id },
        data: {
          ext: '8888',
          officeArea: 'Mock Updated Area'
        }
      });

      expect(updated.ext).toBe('8888');
      expect(updated.officeArea).toBe('Mock Updated Area');

      // Test filter by ext
      const byExt = await mockPrisma.employee.findMany({
        where: { ext: { equals: '8888', mode: 'insensitive' } }
      });
      expect(byExt.length).toBe(1);
      expect(byExt[0].employeeCode).toBe('MOCK-C2-E1');

      // Test filter by reportingManager
      const byManager = await mockPrisma.employee.findMany({
        where: { reportingManager: { equals: 'Mock Boss Person', mode: 'insensitive' } }
      });
      expect(byManager.length).toBe(1);
      expect(byManager[0].employeeCode).toBe('MOCK-C2-E1');

      // Test count parity
      const countExt = await mockPrisma.employee.count({
        where: { ext: { equals: '8888', mode: 'insensitive' } }
      });
      expect(countExt).toBe(1);
    });
  });
});
