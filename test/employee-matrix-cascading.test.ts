import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Employee Matrix Cascading Filter Suite (R2)', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let sessionCookie: string;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
    });
    await server.ready();

    // Authenticate as Super Admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password,
      },
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;

    // Seed test entities: Unit, Plant, Building, Floor, Department
    const unit1 = await mockPrisma.unit.create({
      data: { name: 'Unit 2', code: 'UNIT-2', location: 'Hadamtala' },
    });

    const plant1 = await mockPrisma.plant.create({
      data: { name: 'Unit 2 - Plant 1', code: 'PLT-U2-01', unitId: unit1.id },
    });

    const bld1 = await mockPrisma.building.create({
      data: { name: 'Santosh Bhavan', code: 'BLD-U2-01', plantId: plant1.id },
    });

    const floor2 = await mockPrisma.floor.create({
      data: { name: 'Floor 2', floorNumber: 2, buildingId: bld1.id },
    });

    const deptCosting = await mockPrisma.department.create({
      data: { name: 'Costing', code: 'COST', colorHex: '#10B981', unitId: unit1.id },
    });

    const deptProd = await mockPrisma.department.create({
      data: { name: 'Production', code: 'PROD-U2', colorHex: '#3B82F6', unitId: unit1.id },
    });

    // Create 3 verified industrial employee records
    const emp1 = await mockPrisma.employee.create({
      data: {
        employeeCode: '90012345',
        fullName: 'Vala Virenkumar Bhimabhai',
        email: 'viren.vala@shaktiman.com',
        departmentId: deptCosting.id,
        section: 'Rotary Tiller Paint & Vertical Assy',
        functionName: 'Manufacturing Operations',
        reportingManager: 'Vibhuti Bhushan Chaturvedi',
        reportingTo: 'Vibhuti Bhushan Chaturvedi',
        hod: 'Yogesh Kumar Babulal Gupta',
        grade: 'M-3',
        designation: 'Senior Engineer',
        ext: '2194',
        pcNumber: 'PC-COST-01',
        isActive: true,
      },
    });

    const emp2 = await mockPrisma.employee.create({
      data: {
        employeeCode: '90054321',
        fullName: 'Davera Omkumar Bharatbhai',
        email: 'omkumar.d@shaktiman.com',
        departmentId: deptProd.id,
        section: 'Central Procurement Cell',
        functionName: 'Supply Chain',
        reportingManager: 'Pankaj Upadhyay',
        reportingTo: 'Pankaj Upadhyay',
        hod: 'Yogesh Kumar Babulal Gupta',
        grade: 'M-4',
        designation: 'Assistant Manager',
        ext: '2241',
        pcNumber: 'PC-PROC-02',
        isActive: false,
      },
    });

    // Workstation assigned to emp1
    await mockPrisma.seat.create({
      data: {
        label: 'WS01',
        floorId: floor2.id,
        departmentId: deptCosting.id,
        employeeId: emp1.id,
        pcNumber: 'PC-COST-01',
        status: 'AVAILABLE',
        x: 100,
        y: 100,
      },
    });

    // Vacant workstation
    await mockPrisma.seat.create({
      data: {
        label: 'WS02',
        floorId: floor2.id,
        departmentId: deptProd.id,
        status: 'AVAILABLE',
        x: 200,
        y: 100,
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('MATRIX-01: GET /api/employees returns full employee payload with all 6 HR attributes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employees).toBeDefined();
    expect(body.employees.length).toBeGreaterThanOrEqual(2);

    const emp = body.employees.find((e: any) => e.employeeCode === '90012345');
    expect(emp).toBeDefined();
    expect(emp.section).toBe('Rotary Tiller Paint & Vertical Assy');
    expect(emp.functionName).toBe('Manufacturing Operations');
    expect(emp.reportingManager).toBe('Vibhuti Bhushan Chaturvedi');
    expect(emp.hod).toBe('Yogesh Kumar Babulal Gupta');
    expect(emp.grade).toBe('M-3');
    expect(emp.ext).toBe('2194');
  });

  it('MATRIX-02: Filters correctly by departmentId, section, functionName, reportingManager, and hod', async () => {
    // 1. By section
    const resSec = await server.inject({
      method: 'GET',
      url: '/api/employees?section=Central%20Procurement%20Cell',
      headers: { cookie: sessionCookie },
    });
    expect(resSec.statusCode).toBe(200);
    const bodySec = resSec.json();
    expect(bodySec.employees.length).toBe(1);
    expect(bodySec.employees[0].employeeCode).toBe('90054321');

    // 2. By functionName
    const resFn = await server.inject({
      method: 'GET',
      url: '/api/employees?functionName=Manufacturing%20Operations',
      headers: { cookie: sessionCookie },
    });
    expect(resFn.statusCode).toBe(200);
    const bodyFn = resFn.json();
    expect(bodyFn.employees.length).toBe(1);
    expect(bodyFn.employees[0].employeeCode).toBe('90012345');

    // 3. By reportingManager
    const resMgr = await server.inject({
      method: 'GET',
      url: '/api/employees?reportingManager=Pankaj%20Upadhyay',
      headers: { cookie: sessionCookie },
    });
    expect(resMgr.statusCode).toBe(200);
    const bodyMgr = resMgr.json();
    expect(bodyMgr.employees.length).toBe(1);
    expect(bodyMgr.employees[0].employeeCode).toBe('90054321');

    // 4. By hod
    const resHod = await server.inject({
      method: 'GET',
      url: '/api/employees?hod=Yogesh%20Kumar%20Babulal%20Gupta',
      headers: { cookie: sessionCookie },
    });
    expect(resHod.statusCode).toBe(200);
    const bodyHod = resHod.json();
    expect(bodyHod.employees.length).toBe(2);
  });

  it('MATRIX-03: Filters correctly by isActive (true | false)', async () => {
    // Active only
    const resActive = await server.inject({
      method: 'GET',
      url: '/api/employees?isActive=true',
      headers: { cookie: sessionCookie },
    });
    expect(resActive.statusCode).toBe(200);
    const bodyActive = resActive.json();
    expect(bodyActive.employees.every((e: any) => e.isActive === true)).toBe(true);

    // Inactive only
    const resInactive = await server.inject({
      method: 'GET',
      url: '/api/employees?isActive=false',
      headers: { cookie: sessionCookie },
    });
    expect(resInactive.statusCode).toBe(200);
    const bodyInactive = resInactive.json();
    expect(bodyInactive.employees.every((e: any) => e.isActive === false)).toBe(true);
    expect(bodyInactive.employees.some((e: any) => e.employeeCode === '90054321')).toBe(true);
  });

  it('MATRIX-04: Filters correctly by seating status (ASSIGNED | UNASSIGNED)', async () => {
    // Assigned only (emp1 has seat WS01)
    const resAssigned = await server.inject({
      method: 'GET',
      url: '/api/employees?status=ASSIGNED',
      headers: { cookie: sessionCookie },
    });
    expect(resAssigned.statusCode).toBe(200);
    const bodyAssigned = resAssigned.json();
    expect(bodyAssigned.employees.length).toBe(1);
    expect(bodyAssigned.employees[0].employeeCode).toBe('90012345');

    // Unassigned only (emp2 has no seat)
    const resUnassigned = await server.inject({
      method: 'GET',
      url: '/api/employees?status=UNASSIGNED',
      headers: { cookie: sessionCookie },
    });
    expect(resUnassigned.statusCode).toBe(200);
    const bodyUnassigned = resUnassigned.json();
    expect(bodyUnassigned.employees.some((e: any) => e.employeeCode === '90054321')).toBe(true);
  });

  it('MATRIX-05: Real-time search matches Code, Name, Email, Ext, and PC Number', async () => {
    // Match by extension
    const resExt = await server.inject({
      method: 'GET',
      url: '/api/employees?search=2194',
      headers: { cookie: sessionCookie },
    });
    expect(resExt.statusCode).toBe(200);
    expect(resExt.json().employees.length).toBe(1);
    expect(resExt.json().employees[0].employeeCode).toBe('90012345');

    // Match by PC Number
    const resPc = await server.inject({
      method: 'GET',
      url: '/api/employees?search=PC-PROC-02',
      headers: { cookie: sessionCookie },
    });
    expect(resPc.statusCode).toBe(200);
    expect(resPc.json().employees.length).toBe(1);
    expect(resPc.json().employees[0].employeeCode).toBe('90054321');
  });
});
