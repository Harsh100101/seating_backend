import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { employeeRoutes } from '../src/routes/employees.js';
import { createMockPrisma } from './mock-prisma.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

const enabled = process.env.RUN_REAL_PRISMA_EMPLOYEE_MATRIX === '1' && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('Challenger M2 Matrix: Empirical Adversarial Stress Suite', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let testDeptId: string;
  let testFloorId: string;
  let seatAId: string;
  let seatBId: string;
  let seatCId: string;
  const createdEmployeeIds: string[] = [];
  const createdSeatIds: string[] = [];

  const uniqueSuffix = `ch${Date.now().toString().slice(-6)}`;
  const areaDirect = `Area Direct ${uniqueSuffix}`;
  const areaSeat = `Area Seated ${uniqueSuffix}`;
  const areaBoth = `Area Both ${uniqueSuffix}`;
  const sectionComplex = `Complex & Specialized Operations ${uniqueSuffix}`;
  const managerName = `Dr. Jane Doe ${uniqueSuffix}`;
  const extNumber = `889${uniqueSuffix.slice(-2)}`;

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
        id: `admin-${uniqueSuffix}`,
        email: `admin-${uniqueSuffix}@test.com`,
        role: 'SUPER_ADMIN'
      };
    });
    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.ready();

    // 1. Department
    const dept = await prisma.department.create({
      data: {
        name: `Dept Challenger ${uniqueSuffix}`,
        code: `DCH${uniqueSuffix.slice(-3)}`
      }
    });
    testDeptId = dept.id;

    // 2. Unit / Plant / Building / Floor
    const unit = await prisma.unit.create({
      data: { name: `Unit Challenger ${uniqueSuffix}`, code: `UCH${uniqueSuffix.slice(-3)}` }
    });
    const plant = await prisma.plant.create({
      data: { name: `Plant Challenger ${uniqueSuffix}`, code: `PCH${uniqueSuffix.slice(-3)}`, unitId: unit.id }
    });
    const building = await prisma.building.create({
      data: { name: `Bldg Challenger ${uniqueSuffix}`, code: `BCH${uniqueSuffix.slice(-3)}`, plantId: plant.id }
    });
    const floor = await prisma.floor.create({
      data: { name: `Floor Challenger ${uniqueSuffix}`, floorNumber: 88, buildingId: building.id }
    });
    testFloorId = floor.id;

    // 3. Seats
    // Seat A: areaSeat
    const seatA = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-CHA-${uniqueSuffix}`,
        officeArea: areaSeat,
        status: 'AVAILABLE',
        x: 10,
        y: 10
      }
    });
    seatAId = seatA.id;
    createdSeatIds.push(seatA.id);

    // Seat B: areaBoth
    const seatB = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-CHB-${uniqueSuffix}`,
        officeArea: areaBoth,
        status: 'AVAILABLE',
        x: 20,
        y: 20
      }
    });
    seatBId = seatB.id;
    createdSeatIds.push(seatB.id);

    // Seat C: different area for conflict test
    const seatC = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-CHC-${uniqueSuffix}`,
        officeArea: `Area Conflict Seat ${uniqueSuffix}`,
        status: 'AVAILABLE',
        x: 30,
        y: 30
      }
    });
    seatCId = seatC.id;
    createdSeatIds.push(seatC.id);

    // 4. Employees
    // Emp 1: Pure direct officeArea, unseated
    const emp1 = await prisma.employee.create({
      data: {
        employeeCode: `EMP1-${uniqueSuffix}`,
        fullName: `Emp One ${uniqueSuffix}`,
        email: `emp1.${uniqueSuffix}@test.com`,
        departmentId: testDeptId,
        ext: extNumber,
        section: sectionComplex,
        functionName: `Function ${uniqueSuffix}`,
        grade: 'G1',
        reportingManager: managerName,
        reportingTo: managerName,
        hod: `HOD Chief ${uniqueSuffix}`,
        officeArea: areaDirect
      }
    });
    createdEmployeeIds.push(emp1.id);

    // Emp 2: Pure seated officeArea, employee.officeArea is null
    const emp2 = await prisma.employee.create({
      data: {
        employeeCode: `EMP2-${uniqueSuffix}`,
        fullName: `Emp Two ${uniqueSuffix}`,
        email: `emp2.${uniqueSuffix}@test.com`,
        departmentId: testDeptId,
        ext: null,
        section: sectionComplex,
        functionName: null,
        grade: null,
        reportingManager: null,
        reportingTo: null,
        hod: null,
        officeArea: null
      }
    });
    createdEmployeeIds.push(emp2.id);
    await prisma.seat.update({
      where: { id: seatAId },
      data: { employeeId: emp2.id }
    });

    // Emp 3: Both employee.officeArea and seat.officeArea are areaBoth
    const emp3 = await prisma.employee.create({
      data: {
        employeeCode: `EMP3-${uniqueSuffix}`,
        fullName: `Emp Three ${uniqueSuffix}`,
        email: `emp3.${uniqueSuffix}@test.com`,
        departmentId: testDeptId,
        ext: `999${uniqueSuffix.slice(-2)}`,
        section: `Another Section ${uniqueSuffix}`,
        functionName: `Engineering`,
        grade: 'E3',
        reportingManager: `Manager Legacy ${uniqueSuffix}`,
        reportingTo: `Manager Legacy ${uniqueSuffix}`,
        hod: `HOD Engineering`,
        officeArea: areaBoth
      }
    });
    createdEmployeeIds.push(emp3.id);
    await prisma.seat.update({
      where: { id: seatBId },
      data: { employeeId: emp3.id }
    });

    // Emp 4: Conflicting: direct officeArea is Area Conflicting Direct, seat is Area Conflict Seat
    const emp4 = await prisma.employee.create({
      data: {
        employeeCode: `EMP4-${uniqueSuffix}`,
        fullName: `Emp Four ${uniqueSuffix}`,
        email: `emp4.${uniqueSuffix}@test.com`,
        departmentId: testDeptId,
        officeArea: `Area Conflict Direct ${uniqueSuffix}`
      }
    });
    createdEmployeeIds.push(emp4.id);
    await prisma.seat.update({
      where: { id: seatCId },
      data: { employeeId: emp4.id }
    });

    // Emp 5: Legacy employee with ONLY reportingTo set (reportingManager is null)
    const emp5 = await prisma.employee.create({
      data: {
        employeeCode: `EMP5-${uniqueSuffix}`,
        fullName: `Emp Five ${uniqueSuffix}`,
        email: `emp5.${uniqueSuffix}@test.com`,
        departmentId: testDeptId,
        reportingTo: `Legacy Boss ${uniqueSuffix}`
      }
    });
    createdEmployeeIds.push(emp5.id);
  });

  afterAll(async () => {
    for (const sId of createdSeatIds) {
      try {
        await prisma.seat.delete({ where: { id: sId } });
      } catch {
        // Best-effort cleanup for synthetic matrix fixtures.
      }
    }
    if (createdEmployeeIds.length > 0) {
      try {
        await prisma.employee.deleteMany({
          where: { id: { in: createdEmployeeIds } }
        });
      } catch {
        // Best-effort cleanup for synthetic matrix fixtures.
      }
    }
    if (testFloorId) {
      try {
        await prisma.floor.delete({ where: { id: testFloorId } });
      } catch {
        // Best-effort cleanup for synthetic matrix fixtures.
      }
    }
    if (testDeptId) {
      try {
        await prisma.department.delete({ where: { id: testDeptId } });
      } catch {
        // Best-effort cleanup for synthetic matrix fixtures.
      }
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('Adversarial Test 1: OfficeArea Filtering Robustness', () => {
    it('matches employee directly when unseated (pure direct officeArea)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(areaDirect)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      const codes = data.employees.map((e: any) => e.employeeCode);
      expect(codes).toContain(`EMP1-${uniqueSuffix}`);
      const emp = data.employees.find((e: any) => e.employeeCode === `EMP1-${uniqueSuffix}`);
      expect(emp.officeArea).toBe(areaDirect);
      expect(emp.seat).toBeNull();
    });

    it('matches employee via assigned seat when employee.officeArea is null', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(areaSeat)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      const codes = data.employees.map((e: any) => e.employeeCode);
      expect(codes).toContain(`EMP2-${uniqueSuffix}`);
      const emp = data.employees.find((e: any) => e.employeeCode === `EMP2-${uniqueSuffix}`);
      expect(emp.officeArea).toBe(areaSeat);
      expect(emp.seat).not.toBeNull();
      expect(emp.seat.officeArea).toBe(areaSeat);
    });

    it('handles mixed case and uppercase in officeArea query parameter', async () => {
      // Lowercase
      const resLower = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(areaSeat.toLowerCase())}`
      });
      expect(resLower.statusCode).toBe(200);
      const dataLower = JSON.parse(resLower.body);
      expect(dataLower.employees.map((e: any) => e.employeeCode)).toContain(`EMP2-${uniqueSuffix}`);

      // Uppercase
      const resUpper = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(areaSeat.toUpperCase())}`
      });
      expect(resUpper.statusCode).toBe(200);
      const dataUpper = JSON.parse(resUpper.body);
      expect(dataUpper.employees.map((e: any) => e.employeeCode)).toContain(`EMP2-${uniqueSuffix}`);
    });

    it('returns empty result cleanly for non-existent officeArea', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=NonExistentArea_999999`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('handles leading and trailing whitespace in officeArea parameter via trimming', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent('   ' + areaDirect + '   ')}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.map((e: any) => e.employeeCode)).toContain(`EMP1-${uniqueSuffix}`);
    });

    it('handles conflicting direct vs seated officeArea in employee record', async () => {
      // Query by direct area
      const resDirect = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(`Area Conflict Direct ${uniqueSuffix}`)}`
      });
      expect(resDirect.statusCode).toBe(200);
      const dataDirect = JSON.parse(resDirect.body);
      expect(dataDirect.employees.map((e: any) => e.employeeCode)).toContain(`EMP4-${uniqueSuffix}`);

      // Query by seat area
      const resSeat = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(`Area Conflict Seat ${uniqueSuffix}`)}`
      });
      expect(resSeat.statusCode).toBe(200);
      const dataSeat = JSON.parse(resSeat.body);
      expect(dataSeat.employees.map((e: any) => e.employeeCode)).toContain(`EMP4-${uniqueSuffix}`);
    });
  });

  describe('Adversarial Test 2: Section Filtering & Case Insensitivity', () => {
    it('filters by complex section name with special characters and spaces', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?section=${encodeURIComponent(sectionComplex)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      const codes = data.employees.map((e: any) => e.employeeCode);
      expect(codes).toContain(`EMP1-${uniqueSuffix}`);
      expect(codes).toContain(`EMP2-${uniqueSuffix}`);
      expect(codes).not.toContain(`EMP3-${uniqueSuffix}`);
    });

    it('handles lowercase, uppercase, and mixed-case section parameter', async () => {
      const resLower = await app.inject({
        method: 'GET',
        url: `/api/employees?section=${encodeURIComponent(sectionComplex.toLowerCase())}`
      });
      expect(resLower.statusCode).toBe(200);
      const dataLower = JSON.parse(resLower.body);
      expect(dataLower.employees.map((e: any) => e.employeeCode)).toContain(`EMP1-${uniqueSuffix}`);

      const resUpper = await app.inject({
        method: 'GET',
        url: `/api/employees?section=${encodeURIComponent(sectionComplex.toUpperCase())}`
      });
      expect(resUpper.statusCode).toBe(200);
      const dataUpper = JSON.parse(resUpper.body);
      expect(dataUpper.employees.map((e: any) => e.employeeCode)).toContain(`EMP1-${uniqueSuffix}`);
    });

    it('returns empty list for non-existent section without errors', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?section=CompletelyFakeSection_XYZ123`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('treats section=ALL as no-op and does not filter out records', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}&section=ALL`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      const codes = data.employees.map((e: any) => e.employeeCode);
      expect(codes).toContain(`EMP1-${uniqueSuffix}`);
      expect(codes).toContain(`EMP2-${uniqueSuffix}`);
      expect(codes).toContain(`EMP3-${uniqueSuffix}`);
    });
  });

  describe('Adversarial Test 3: Payload Completeness & Interoperability', () => {
    it('guarantees all matrix fields exist on every employee even when fields are null in DB', async () => {
      // Query EMP2 who has null for ext, functionName, grade, reportingManager, reportingTo, hod, officeArea
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?empCode=EMP2-${uniqueSuffix}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);

      const emp = data.employees[0];
      // Check presence of keys
      expect(emp).toHaveProperty('ext');
      expect(emp).toHaveProperty('section');
      expect(emp).toHaveProperty('functionName');
      expect(emp).toHaveProperty('grade');
      expect(emp).toHaveProperty('reportingManager');
      expect(emp).toHaveProperty('reportingTo');
      expect(emp).toHaveProperty('hod');
      expect(emp).toHaveProperty('officeArea');

      // Null fallbacks
      expect(emp.ext).toBeNull();
      expect(emp.section).toBe(sectionComplex);
      expect(emp.functionName).toBeNull();
      expect(emp.grade).toBeNull();
      expect(emp.reportingManager).toBeNull();
      expect(emp.reportingTo).toBeNull();
      expect(emp.hod).toBeNull();
      // OfficeArea resolves to seated area
      expect(emp.officeArea).toBe(areaSeat);
    });

    it('interoperability: employee with only reportingTo resolves reportingManager properly', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?empCode=EMP5-${uniqueSuffix}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);
      const emp = data.employees[0];
      expect(emp.reportingTo).toBe(`Legacy Boss ${uniqueSuffix}`);
      expect(emp.reportingManager).toBe(`Legacy Boss ${uniqueSuffix}`);
    });

    it('search filter matches across reportingManager, ext, and section', async () => {
      // Search by ext
      const resExt = await app.inject({
        method: 'GET',
        url: `/api/employees?search=${extNumber}`
      });
      expect(resExt.statusCode).toBe(200);
      const dataExt = JSON.parse(resExt.body);
      expect(dataExt.employees.map((e: any) => e.employeeCode)).toContain(`EMP1-${uniqueSuffix}`);

      // Search by section substring
      const resSec = await app.inject({
        method: 'GET',
        url: `/api/employees?search=Specialized%20Operations`
      });
      expect(resSec.statusCode).toBe(200);
      const dataSec = JSON.parse(resSec.body);
      expect(dataSec.employees.map((e: any) => e.employeeCode)).toContain(`EMP1-${uniqueSuffix}`);

      // Search by manager name
      const resMgr = await app.inject({
        method: 'GET',
        url: `/api/employees?search=Jane%20Doe`
      });
      expect(resMgr.statusCode).toBe(200);
      const dataMgr = JSON.parse(resMgr.body);
      expect(dataMgr.employees.map((e: any) => e.employeeCode)).toContain(`EMP1-${uniqueSuffix}`);
    });
  });

  describe('Adversarial Test 4: Mock Prisma Fastify Integration & Area Matching', () => {
    it('verifies Fastify GET /api/employees?officeArea= works when running against mockPrisma', async () => {
      const mockPrisma = await createMockPrisma();
      const mockApp = Fastify();
      mockApp.decorate('prisma', mockPrisma);
      mockApp.addHook('onRequest', async (req: any) => {
        req.admin = { id: 'admin', role: 'SUPER_ADMIN' };
      });
      await mockApp.register(employeeRoutes, { prefix: '/api/employees' });
      await mockApp.ready();

      const dept = await mockPrisma.department.create({
        data: { name: 'Mock Department', code: 'MD1' }
      });

      const seat = await mockPrisma.seat.create({
        data: {
          label: 'MOCK-SEAT-1',
          officeArea: 'Mock Area Fastify',
          floorId: 'fl-1'
        }
      });

      const emp = await mockPrisma.employee.create({
        data: {
          employeeCode: 'MOCK-E1',
          fullName: 'Mock Seated Person',
          departmentId: dept.id,
          officeArea: null
        }
      });

      await mockPrisma.seat.update({
        where: { id: seat.id },
        data: { employeeId: emp.id }
      });

      // Now query via Fastify inject
      const res = await mockApp.inject({
        method: 'GET',
        url: '/api/employees?officeArea=Mock%20Area%20Fastify'
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBeGreaterThanOrEqual(1);
      expect(data.employees.map((e: any) => e.employeeCode)).toContain('MOCK-E1');
      await mockApp.close();
    });
  });
});
