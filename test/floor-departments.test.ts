import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Floor-Wise Department Architecture & Color Hex Validation', () => {
  let server: FastifyInstance;
  let adminCookie: string;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma);
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Login as admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    expect(loginRes.statusCode).toBe(200);
    adminCookie = loginRes.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  it('DEPT-01: Creates floor-scoped department with valid hex color', async () => {
    const floor = await mockPrisma.floor.findFirst();
    expect(floor).toBeDefined();

    const res = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Floor 1 Robotics Pod',
        code: 'ROBO-F1',
        colorHex: '#6366F1',
        floorId: floor!.id
      }
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Floor 1 Robotics Pod');
    expect(body.code).toBe('ROBO-F1');
    expect(body.colorHex).toBe('#6366F1');
    expect(body.floorId).toBe(floor!.id);
  });

  it('DEPT-02: Rejects invalid hex color codes', async () => {
    const floor = await mockPrisma.floor.findFirst();
    expect(floor).toBeDefined();

    const invalidColors = ['#FFF', '123456', '#GGGGGG', '#12345678', 'red'];

    for (const color of invalidColors) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: adminCookie },
        payload: {
          name: `Invalid Color Dept ${color}`,
          code: `INV-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          colorHex: color,
          floorId: floor!.id
        }
      });

      expect(res.statusCode).toBe(400);
    }
  });

  it('DEPT-03: Enforces compound uniqueness per unit and allows cross-unit reuse', async () => {
    const allFloors = await mockPrisma.floor.findMany();
    expect(allFloors.length).toBeGreaterThanOrEqual(1);
    const floorA = allFloors[0];

    // Create a plant, building, and floor in Unit 1 for cross-unit testing
    const u1 = (await mockPrisma.unit.findMany()).find((u: any) => u.name === 'Unit 1');
    const plantU1 = await mockPrisma.plant.create({ data: { name: 'Unit 1 Plant', code: 'PLT-U1', unitId: u1.id } });
    const bldU1 = await mockPrisma.building.create({ data: { name: 'Unit 1 Building', code: 'BLD-U1', plantId: plantU1.id } });
    const floorB = await mockPrisma.floor.create({ data: { name: 'Unit 1 Floor 1', floorNumber: 1, buildingId: bldU1.id } });

    // Create on Floor A
    const resA = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Assembly Operations',
        code: 'ASM-OPS',
        colorHex: '#10B981',
        floorId: floorA.id
      }
    });
    expect(resA.statusCode).toBe(201);

    // Duplicate code on SAME floor should fail with 409 Conflict
    const resDup = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Assembly Operations Duplicate',
        code: 'ASM-OPS',
        colorHex: '#0EA5E9',
        floorId: floorA.id
      }
    });
    expect(resDup.statusCode).toBe(409);

    // SAME code on DIFFERENT floor should succeed with 201 Created
    const resB = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Assembly Operations Floor B',
        code: 'ASM-OPS',
        colorHex: '#EC4899',
        floorId: floorB.id
      }
    });
    expect(resB.statusCode).toBe(201);
  });

  it('DEPT-04: Filters departments by floorId', async () => {
    const floor = await mockPrisma.floor.findFirst();
    expect(floor).toBeDefined();

    // Create floor-specific dept
    await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Precision Welding',
        code: 'WELD-01',
        colorHex: '#F59E0B',
        floorId: floor!.id
      }
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/departments?floorId=${floor!.id}`,
      headers: { cookie: adminCookie }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((d: any) => d.code === 'WELD-01');
    expect(found).toBeDefined();
    expect(found.floorId).toBe(floor!.id);
  });

  it('DEPT-05: Blocks deletion of department with active seat assignments', async () => {
    // Find department with assigned seats
    const seatWithDept = await mockPrisma.seat.findFirst({
      where: { departmentId: { not: null } }
    });
    expect(seatWithDept).toBeDefined();

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/departments/${seatWithDept!.departmentId}`,
      headers: { cookie: adminCookie }
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/cannot delete department/i);
  });

  it('DEPT-06: GET /api/floors/:id returns departments array', async () => {
    const floor = await mockPrisma.floor.findFirst();
    expect(floor).toBeDefined();

    const res = await server.inject({
      method: 'GET',
      url: `/api/floors/${floor!.id}`,
      headers: { cookie: adminCookie }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(floor!.id);
    expect(Array.isArray(body.departments)).toBe(true);
  });

  it('DEPT-07: Filters departments by unitId', async () => {
    const units = await mockPrisma.unit.findMany();
    const u1 = units.find((u: any) => u.name === 'Unit 1');
    const u2 = units.find((u: any) => u.name === 'Unit 2');
    expect(u1).toBeDefined();
    expect(u2).toBeDefined();

    // Create a dept in Unit 1 and a dept in Unit 2
    await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Unit 1 Dept', code: 'U1-DEPT', colorHex: '#3B82F6', unitId: u1!.id }
    });
    await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Unit 2 Dept', code: 'U2-DEPT', colorHex: '#10B981', unitId: u2!.id }
    });

    const resU1 = await server.inject({
      method: 'GET',
      url: `/api/departments?unitId=${u1!.id}`,
      headers: { cookie: adminCookie }
    });
    expect(resU1.statusCode).toBe(200);
    const listU1 = JSON.parse(resU1.body);
    expect(listU1.some((d: any) => d.code === 'U1-DEPT')).toBe(true);
    expect(listU1.some((d: any) => d.code === 'U2-DEPT')).toBe(false);

    const resU2 = await server.inject({
      method: 'GET',
      url: `/api/departments?unitId=${u2!.id}`,
      headers: { cookie: adminCookie }
    });
    expect(resU2.statusCode).toBe(200);
    const listU2 = JSON.parse(resU2.body);
    expect(listU2.some((d: any) => d.code === 'U2-DEPT')).toBe(true);
    expect(listU2.some((d: any) => d.code === 'U1-DEPT')).toBe(false);
  });

  it('DEPT-08: GET /api/employees?departmentName matches across units or scopes to unit', async () => {
    const units = await mockPrisma.unit.findMany();
    const u1 = units.find((u: any) => u.name === 'Unit 1');
    const u2 = units.find((u: any) => u.name === 'Unit 2');

    // Create Corporate HR in Unit 1 and Unit 2
    const resD1 = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Corporate Human Resources', code: 'CHR-U1', colorHex: '#EF4444', unitId: u1!.id }
    });
    const d1 = JSON.parse(resD1.body);

    const resD2 = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Corporate Human Resources', code: 'CHR-U2', colorHex: '#EF4444', unitId: u2!.id }
    });
    const d2 = JSON.parse(resD2.body);

    // Create employee in Unit 1 CHR and employee in Unit 2 CHR
    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: adminCookie },
      payload: { fullName: 'U1 HR Member', employeeCode: 'EMP-CHR-01', departmentId: d1.id }
    });
    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: adminCookie },
      payload: { fullName: 'U2 HR Member', employeeCode: 'EMP-CHR-02', departmentId: d2.id }
    });

    // Query without unitId (All Units) -> returns both
    const resAll = await server.inject({
      method: 'GET',
      url: '/api/employees?departmentName=Corporate Human Resources',
      headers: { cookie: adminCookie }
    });
    expect(resAll.statusCode).toBe(200);
    const bodyAll = JSON.parse(resAll.body);
    expect(bodyAll.employees.length).toBeGreaterThanOrEqual(2);
    expect(bodyAll.employees.some((e: any) => e.employeeCode === 'EMP-CHR-01')).toBe(true);
    expect(bodyAll.employees.some((e: any) => e.employeeCode === 'EMP-CHR-02')).toBe(true);

    // Query with unitId=u1.id -> returns only U1
    const resUnit1 = await server.inject({
      method: 'GET',
      url: `/api/employees?departmentName=Corporate Human Resources&unitId=${u1!.id}`,
      headers: { cookie: adminCookie }
    });
    expect(resUnit1.statusCode).toBe(200);
    const bodyUnit1 = JSON.parse(resUnit1.body);
    expect(bodyUnit1.employees.some((e: any) => e.employeeCode === 'EMP-CHR-01')).toBe(true);
    expect(bodyUnit1.employees.some((e: any) => e.employeeCode === 'EMP-CHR-02')).toBe(false);
  });

  it('DEPT-09: GET /api/employees?departmentId matches sister depts across units', async () => {
    const units = await mockPrisma.unit.findMany();
    const u1 = units.find((u: any) => u.name === 'Unit 1');
    const u2 = units.find((u: any) => u.name === 'Unit 2');

    // Create Quality Dept in both units
    const d1Res = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Quality Control', code: 'QC-U1', colorHex: '#10B981', unitId: u1!.id }
    });
    const d1 = JSON.parse(d1Res.body);

    const d2Res = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Quality Control', code: 'QC-U2', colorHex: '#10B981', unitId: u2!.id }
    });
    const d2 = JSON.parse(d2Res.body);

    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: adminCookie },
      payload: { fullName: 'QC Inspector 1', employeeCode: 'EMP-QC-01', departmentId: d1.id }
    });
    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: adminCookie },
      payload: { fullName: 'QC Inspector 2', employeeCode: 'EMP-QC-02', departmentId: d2.id }
    });

    // Query with departmentId=d1.id (All Units) -> returns employees in d1 AND d2
    const res = await server.inject({
      method: 'GET',
      url: `/api/employees?departmentId=${d1.id}`,
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employees.some((e: any) => e.employeeCode === 'EMP-QC-01')).toBe(true);
    expect(body.employees.some((e: any) => e.employeeCode === 'EMP-QC-02')).toBe(true);

    // Query with departmentId=d1.id AND unitId=u2.id -> resolves to sister dept d2 and returns EMP-QC-02
    const resScoped = await server.inject({
      method: 'GET',
      url: `/api/employees?departmentId=${d1.id}&unitId=${u2!.id}`,
      headers: { cookie: adminCookie }
    });
    expect(resScoped.statusCode).toBe(200);
    const bodyScoped = JSON.parse(resScoped.body);
    expect(bodyScoped.employees.some((e: any) => e.employeeCode === 'EMP-QC-02')).toBe(true);
    expect(bodyScoped.employees.some((e: any) => e.employeeCode === 'EMP-QC-01')).toBe(false);
  });

  it('DEPT-10: Enforces compound uniqueness on (unitId, name)', async () => {
    const units = await mockPrisma.unit.findMany();
    const u1 = units.find((u: any) => u.name === 'Unit 1');
    const u2 = units.find((u: any) => u.name === 'Unit 2');

    const res1 = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Logistics Division', code: 'LOG-01', colorHex: '#F59E0B', unitId: u1!.id }
    });
    expect(res1.statusCode).toBe(201);

    // Duplicate name in same unit -> 409 Conflict
    const resDup = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Logistics Division', code: 'LOG-02', colorHex: '#F59E0B', unitId: u1!.id }
    });
    expect(resDup.statusCode).toBe(409);

    // Same name in different unit -> 201 Created
    const resDiffUnit = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: adminCookie },
      payload: { name: 'Logistics Division', code: 'LOG-03', colorHex: '#F59E0B', unitId: u2!.id }
    });
    expect(resDiffUnit.statusCode).toBe(201);
  });
});
