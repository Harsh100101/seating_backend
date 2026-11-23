import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { employeeRoutes } from '../src/routes/employees.js';
import { createMockPrisma } from './mock-prisma.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

const enabled = process.env.RUN_REAL_PRISMA_EMPLOYEE_MATRIX === '1' && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('Auditor Forensic Verification: Milestone 2 Enterprise Matrix Logic', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let testDeptId: string;
  let testFloorId: string;
  let testUnitId: string;
  let seatDirectId: string;
  let seatFallbackId: string;
  const createdSeatIds: string[] = [];
  const createdEmployeeIds: string[] = [];
  let directEmpId: string;
  let seatedEmpId: string;
  let conflictEmpId: string;

  const runId = Date.now().toString().slice(-6);

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
        id: `forensic-admin-${runId}`,
        email: 'superadmin@shaktiman.com',
        role: 'SUPER_ADMIN'
      };
    });
    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.ready();

    // Setup Unit, Plant, Building, Floor for clean isolation
    const unit = await prisma.unit.create({
      data: { name: `Forensic Unit ${runId}`, code: `FU-${runId}` }
    });
    testUnitId = unit.id;

    const plant = await prisma.plant.create({
      data: { name: `Forensic Plant ${runId}`, code: `FP-${runId}`, unitId: unit.id }
    });

    const bld = await prisma.building.create({
      data: { name: `Forensic Bldg ${runId}`, code: `FB-${runId}`, plantId: plant.id }
    });

    const floor = await prisma.floor.create({
      data: { name: `Forensic Floor ${runId}`, floorNumber: 42, buildingId: bld.id }
    });
    testFloorId = floor.id;

    const dept = await prisma.department.create({
      data: {
        name: `Forensic Dept ${runId}`,
        code: `FD${runId.slice(-3)}`,
        unit: { connect: { id: unit.id } },
        colorHex: '#6366F1'
      }
    });
    testDeptId = dept.id;

    // Create Seat 1 with Office Area
    const seat1 = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-AUDIT-1-${runId}`,
        officeArea: `Seated Area Alpha ${runId}`,
        status: 'AVAILABLE',
        x: 10,
        y: 10
      }
    });
    seatFallbackId = seat1.id;
    createdSeatIds.push(seat1.id);

    // Create Seat 2 with different Office Area
    const seat2 = await prisma.seat.create({
      data: {
        floorId: testFloorId,
        label: `WS-AUDIT-2-${runId}`,
        officeArea: `Seated Area Conflict ${runId}`,
        status: 'AVAILABLE',
        x: 20,
        y: 20
      }
    });
    seatDirectId = seat2.id;
    createdSeatIds.push(seat2.id);

    // 1. Employee with Direct Office Area (unseated)
    const emp1 = await prisma.employee.create({
      data: {
        employeeCode: `EMP-DIR-${runId}`,
        fullName: `Auditor Emp Direct ${runId}`,
        email: `direct.${runId}@forensic.org`,
        departmentId: testDeptId,
        ext: `410${runId.slice(-2)}`,
        section: `Forensic Section 101 ${runId}`,
        functionName: `Quality Assurance ${runId}`,
        grade: 'M3',
        reportingManager: `Auditor Manager A ${runId}`,
        reportingTo: `Auditor Manager A ${runId}`,
        hod: `Chief Director ${runId}`,
        officeArea: `Direct Area Prime ${runId}`
      }
    });
    directEmpId = emp1.id;
    createdEmployeeIds.push(emp1.id);

    // 2. Employee seated with inherited Office Area
    const emp2 = await prisma.employee.create({
      data: {
        employeeCode: `EMP-SEAT-${runId}`,
        fullName: `Auditor Emp Seated ${runId}`,
        email: `seated.${runId}@forensic.org`,
        departmentId: testDeptId,
        ext: `420${runId.slice(-2)}`,
        section: `Forensic Section 202 ${runId}`,
        functionName: `Engineering Analysis ${runId}`,
        grade: 'L1',
        reportingManager: `Auditor Manager B ${runId}`,
        reportingTo: `Auditor Manager B ${runId}`,
        hod: `Chief Director ${runId}`,
        officeArea: null
      }
    });
    seatedEmpId = emp2.id;
    createdEmployeeIds.push(emp2.id);
    await prisma.seat.update({
      where: { id: seatFallbackId },
      data: { employeeId: emp2.id }
    });

    // 3. Employee with direct officeArea AND seated in a seat with different officeArea (Precedence test)
    const emp3 = await prisma.employee.create({
      data: {
        employeeCode: `EMP-CONF-${runId}`,
        fullName: `Auditor Emp Precedence ${runId}`,
        email: `conflict.${runId}@forensic.org`,
        departmentId: testDeptId,
        ext: `430${runId.slice(-2)}`,
        section: `Forensic Section 101 ${runId}`,
        functionName: `Quality Assurance ${runId}`,
        grade: 'E4',
        reportingManager: `Auditor Manager A ${runId}`,
        reportingTo: `Auditor Manager A ${runId}`,
        hod: `Chief Director ${runId}`,
        officeArea: `Direct Area Overrule ${runId}`
      }
    });
    conflictEmpId = emp3.id;
    createdEmployeeIds.push(emp3.id);
    await prisma.seat.update({
      where: { id: seatDirectId },
      data: { employeeId: emp3.id }
    });
  });

  afterAll(async () => {
    // Teardown
    for (const sid of createdSeatIds) {
      try {
        await prisma.seat.delete({ where: { id: sid } });
      } catch {
        // Best-effort cleanup for synthetic forensic fixtures.
      }
    }
    if (createdEmployeeIds.length > 0) {
      await prisma.employee.deleteMany({
        where: { id: { in: createdEmployeeIds } }
      });
    }
    try {
      await prisma.department.delete({ where: { id: testDeptId } });
      await prisma.floor.delete({ where: { id: testFloorId } });
      const bld = await prisma.building.findFirst({ where: { name: `Forensic Bldg ${runId}` } });
      if (bld) await prisma.building.delete({ where: { id: bld.id } });
      const plt = await prisma.plant.findFirst({ where: { name: `Forensic Plant ${runId}` } });
      if (plt) await prisma.plant.delete({ where: { id: plt.id } });
      await prisma.unit.delete({ where: { id: testUnitId } });
    } catch {
      // Best-effort cleanup for synthetic forensic fixtures.
    }

    await app.close();
    await prisma.$disconnect();
  });

  describe('Forensic Check 1: Empirical Evaluation of officeArea Filtering', () => {
    it('accurately queries by direct officeArea', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(`Direct Area Prime ${runId}`)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);
      expect(data.employees[0].employeeCode).toBe(`EMP-DIR-${runId}`);
      expect(data.employees[0].officeArea).toBe(`Direct Area Prime ${runId}`);
    });

    it('accurately queries by seat fallback officeArea', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(`Seated Area Alpha ${runId}`)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);
      expect(data.employees[0].employeeCode).toBe(`EMP-SEAT-${runId}`);
      expect(data.employees[0].officeArea).toBe(`Seated Area Alpha ${runId}`);
      expect(data.employees[0].seat?.officeArea).toBe(`Seated Area Alpha ${runId}`);
    });

    it('prefers direct employee.officeArea over seat.officeArea in payload', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?empCode=EMP-CONF-${runId}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);
      const emp = data.employees[0];
      // Direct officeArea overrides seat.officeArea
      expect(emp.officeArea).toBe(`Direct Area Overrule ${runId}`);
      expect(emp.seat?.officeArea).toBe(`Seated Area Conflict ${runId}`);
    });

    it('handles case-insensitivity and whitespace in officeArea parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?officeArea=${encodeURIComponent(`   seated area alpha ${runId}   `)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.some((e: any) => e.employeeCode === `EMP-SEAT-${runId}`)).toBe(true);
    });

    it('bypasses filter when officeArea=ALL', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}&officeArea=ALL`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(3);
    });
  });

  describe('Forensic Check 2: Empirical Evaluation of section Filtering', () => {
    it('accurately queries by section and supports multiple matching employees', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?section=${encodeURIComponent(`Forensic Section 101 ${runId}`)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(2);
      const codes = data.employees.map((e: any) => e.employeeCode);
      expect(codes).toContain(`EMP-DIR-${runId}`);
      expect(codes).toContain(`EMP-CONF-${runId}`);
    });

    it('handles case-insensitivity and whitespace in section parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?section=${encodeURIComponent(`  forensic section 202 ${runId}  `)}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);
      expect(data.employees[0].employeeCode).toBe(`EMP-SEAT-${runId}`);
    });

    it('bypasses filter when section=ALL', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?departmentId=${testDeptId}&section=ALL`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(3);
    });
  });

  describe('Forensic Check 3: Response Payload Matrix Fields Integrity', () => {
    it('returns all required enterprise matrix fields with authentic dynamic content', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees?empCode=EMP-DIR-${runId}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.employees.length).toBe(1);
      const emp = data.employees[0];

      // Verifying all R2 contract fields
      expect(emp.ext).toBe(`410${runId.slice(-2)}`);
      expect(emp.section).toBe(`Forensic Section 101 ${runId}`);
      expect(emp.functionName).toBe(`Quality Assurance ${runId}`);
      expect(emp.grade).toBe('M3');
      expect(emp.reportingManager).toBe(`Auditor Manager A ${runId}`);
      expect(emp.reportingTo).toBe(`Auditor Manager A ${runId}`);
      expect(emp.hod).toBe(`Chief Director ${runId}`);
      expect(emp.officeArea).toBe(`Direct Area Prime ${runId}`);
      expect(emp.department).toBeDefined();
      expect(emp.department.name).toBe(`Forensic Dept ${runId}`);
    });
  });

  describe('Forensic Check 4: Interoperability of reportingManager and reportingTo', () => {
    it('queries interchangeably via reportingManager and legacy reportingTo', async () => {
      const targetMgr = `Auditor Manager A ${runId}`;

      const resManager = await app.inject({
        method: 'GET',
        url: `/api/employees?reportingManager=${encodeURIComponent(targetMgr)}`
      });
      expect(resManager.statusCode).toBe(200);
      const dataManager = JSON.parse(resManager.body);
      expect(dataManager.employees.length).toBe(2);

      const resTo = await app.inject({
        method: 'GET',
        url: `/api/employees?reportingTo=${encodeURIComponent(targetMgr)}`
      });
      expect(resTo.statusCode).toBe(200);
      const dataTo = JSON.parse(resTo.body);
      expect(dataTo.employees.length).toBe(2);
      expect(dataManager.employees.map((e: any) => e.id).sort()).toEqual(dataTo.employees.map((e: any) => e.id).sort());
    });
  });

  describe('Forensic Check 5: /filter-options Aggregation Integrity', () => {
    it('aggregates officeAreas from both direct and seated sources without duplicates', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/employees/filter-options?unitId=${testUnitId}`
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      // Verify sections
      expect(data.sections).toContain(`Forensic Section 101 ${runId}`);
      expect(data.sections).toContain(`Forensic Section 202 ${runId}`);

      // Verify officeAreas contains both direct and seated areas
      expect(data.officeAreas).toContain(`Direct Area Prime ${runId}`);
      expect(data.officeAreas).toContain(`Seated Area Alpha ${runId}`);
      expect(data.officeAreas).toContain(`Direct Area Overrule ${runId}`);
      expect(data.officeAreas).toContain(`Seated Area Conflict ${runId}`);

      // Verify no duplicates exist in officeAreas
      const uniqueOfficeAreas = new Set(data.officeAreas);
      expect(uniqueOfficeAreas.size).toBe(data.officeAreas.length);
    });
  });
});
