import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { employeeRoutes } from '../src/routes/employees.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

// This suite is intentionally opt-in and must never use the repository's
// DATABASE_URL. It creates deterministic synthetic Office/Area records in a
// disposable MongoDB replica-set database.
const testUrl = process.env.OFFICE_AREA_TEST_DATABASE_URL;
const enabled = process.env.RUN_REAL_PRISMA_OFFICE_AREA === '1'
  && process.env.ALLOW_DISPOSABLE_TEST_DB_WRITES === '1'
  && process.env.TEST_ENVIRONMENT === 'disposable'
  && Boolean(testUrl);

describe.skipIf(!enabled)('Office / Area Filtering and Excel Parity Test Suite', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const createdUnitIds: string[] = [];
  const createdEmployeeCodes = ['OA-EMP-U1', 'OA-EMP-U2-POWDER', 'OA-EMP-U2-QUALITY', 'OA-EMP-U2-STORES'];

  beforeAll(async () => {
    await verifyDisposableTestDatabase(testUrl);

    prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await prisma.$connect();

    const unit1 = await prisma.unit.create({ data: { name: 'Office Area Fixture Unit 1', code: 'OA-U1' } });
    const unit2 = await prisma.unit.create({ data: { name: 'Office Area Fixture Unit 2', code: 'OA-U2' } });
    createdUnitIds.push(unit1.id, unit2.id);

    const plant1 = await prisma.plant.create({ data: { name: 'Office Area Plant 1', code: 'OA-P1', unitId: unit1.id } });
    const plant2 = await prisma.plant.create({ data: { name: 'Office Area Plant 2', code: 'OA-P2', unitId: unit2.id } });
    const building1 = await prisma.building.create({ data: { name: 'Office Area Building 1', code: 'OA-B1', plantId: plant1.id } });
    const building2 = await prisma.building.create({ data: { name: 'Office Area Building 2', code: 'OA-B2', plantId: plant2.id } });
    const floor1 = await prisma.floor.create({ data: { name: 'Office Area Floor 1', floorNumber: 1, buildingId: building1.id } });
    const floor2 = await prisma.floor.create({ data: { name: 'Office Area Floor 2', floorNumber: 1, buildingId: building2.id } });
    const dept1 = await prisma.department.create({ data: { name: 'Office Area Department 1', code: 'OA-D1', unitId: unit1.id } });
    const dept2 = await prisma.department.create({ data: { name: 'Office Area Department 2', code: 'OA-D2', unitId: unit2.id } });

    const employees = await Promise.all([
      prisma.employee.create({ data: { employeeCode: createdEmployeeCodes[0], fullName: 'Office Area Unit 1', departmentId: dept1.id, officeArea: 'Admin IT office' } }),
      prisma.employee.create({ data: { employeeCode: createdEmployeeCodes[1], fullName: 'Office Area Powder', departmentId: dept2.id, officeArea: 'Powder Coating & Vertical Assembly' } }),
      prisma.employee.create({ data: { employeeCode: createdEmployeeCodes[2], fullName: 'Office Area Quality', departmentId: dept2.id, officeArea: 'Manufacturing Quality - Unit-II' } }),
      prisma.employee.create({ data: { employeeCode: createdEmployeeCodes[3], fullName: 'Office Area Stores', departmentId: dept2.id, officeArea: 'Central Stores Unit-II' } })
    ]);

    await prisma.seat.createMany({
      data: [
        { floorId: floor1.id, label: 'OA-U1-01', x: 10, y: 10, employeeId: employees[0].id, departmentId: dept1.id, officeArea: 'Admin IT office' },
        { floorId: floor2.id, label: 'OA-U2-01', x: 10, y: 10, employeeId: employees[1].id, departmentId: dept2.id, officeArea: 'Powder Coating & Vertical Assembly' },
        { floorId: floor2.id, label: 'OA-U2-02', x: 90, y: 10, employeeId: employees[2].id, departmentId: dept2.id, officeArea: 'Manufacturing Quality - Unit-II' },
        { floorId: floor2.id, label: 'OA-U2-03', x: 170, y: 10, employeeId: employees[3].id, departmentId: dept2.id, officeArea: 'Central Stores Unit-II' }
      ]
    });

    app = Fastify();
    await app.register(cookie);
    await app.register(cors);
    app.decorate('prisma', prisma);
    app.addHook('onRequest', async (req: any) => {
      req.admin = { id: 'fixture-super-admin', email: 'fixture@example.com', role: 'SUPER_ADMIN' };
    });
    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      const fixtureEmployees = await prisma.employee.findMany({
        where: { employeeCode: { in: createdEmployeeCodes } },
        select: { id: true }
      });
      await prisma.seat.updateMany({
        where: { employeeId: { in: fixtureEmployees.map((employee) => employee.id) } },
        data: { employeeId: { unset: true } }
      });
      await prisma.employee.deleteMany({ where: { employeeCode: { in: createdEmployeeCodes } } });
      for (const unitId of createdUnitIds) {
        await prisma.unit.delete({ where: { id: unitId } }).catch(() => undefined);
      }
      await prisma.$disconnect();
    }
  });

  it('filters employees by Powder Coating & Vertical Assembly in Unit 2', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?officeArea=Powder%20Coating%20%26%20Vertical%20Assembly' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employees.length).toBe(1);
    expect(body.employees[0].officeArea).toBe('Powder Coating & Vertical Assembly');
  });

  it('filters employees by Manufacturing Quality - Unit-II in Unit 2', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?officeArea=Manufacturing%20Quality%20-%20Unit-II' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employees.length).toBe(1);
    expect(body.employees[0].officeArea).toBe('Manufacturing Quality - Unit-II');
  });

  it('filters employees by Central Stores Unit-II in Unit 2', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?officeArea=Central%20Stores%20Unit-II' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employees.length).toBe(1);
    expect(body.employees[0].officeArea).toBe('Central Stores Unit-II');
  });

  it('filters employees by Admin IT office in Unit 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?officeArea=Admin%20IT%20office' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employees.length).toBe(1);
    expect(body.employees[0].officeArea).toBe('Admin IT office');
  });

  it('provides distinct officeAreas in /api/employees/filter-options', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees/filter-options' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.officeAreas)).toBe(true);
    expect(body.officeAreas).toEqual(expect.arrayContaining([
      'Powder Coating & Vertical Assembly',
      'Manufacturing Quality - Unit-II',
      'Central Stores Unit-II'
    ]));
  });
});
