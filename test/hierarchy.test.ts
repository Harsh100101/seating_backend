import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Milestone 3 Integration: Organizational Hierarchy & Employees (Features 12 through 17)', () => {
  let server: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Authenticate admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  // Feature 12: Offices CRUD
  it('HIER-01: Offices CRUD handles creation, 255-character name, duplicate check, and cascade deletion', async () => {
    // 255-character name
    const longName = 'O'.repeat(240) + '_' + Date.now();
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: longName, city: 'London' }
    });
    expect(createRes.statusCode).toBe(201);
    const office = createRes.json();
    expect(office.name).toBe(longName);

    // Duplicate name rejected with 409
    const dupRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: longName, city: 'Paris' }
    });
    expect(dupRes.statusCode).toBe(409);

    // Update office
    const updRes = await server.inject({
      method: 'PUT',
      url: `/api/offices/${office.id}`,
      headers: { cookie: sessionCookie },
      payload: { city: 'Manchester' }
    });
    expect(updRes.statusCode).toBe(200);
    expect(updRes.json().city).toBe('Manchester');

    // Delete office
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/offices/${office.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().success).toBe(true);

    // Verify 404
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/offices/${office.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(getRes.statusCode).toBe(404);
  });

  // Feature 13: Buildings CRUD
  it('HIER-02: Buildings CRUD enforces composite unique [officeId, code] and supports office filter', async () => {
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'München HQ 🏢 ' + Date.now(), city: 'München' }
    });
    const officeId = offRes.json().id;

    // Create building
    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Tower 1', code: 'T1', officeId }
    });
    expect(bldRes.statusCode).toBe(201);
    const building = bldRes.json();
    expect(building.code).toBe('T1');

    // Duplicate code in same office -> 409
    const dupRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Tower 1 Duplicate', code: 't1', officeId }
    });
    expect(dupRes.statusCode).toBe(409);

    // Filter by officeId
    const listRes = await server.inject({
      method: 'GET',
      url: `/api/buildings?officeId=${officeId}`,
      headers: { cookie: sessionCookie }
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toHaveLength(1);
    expect(listRes.json()[0].office).toBeDefined();
  });

  // Feature 14: Floors CRUD
  it('HIER-03: Floors CRUD supports negative floor numbers (-2) and enforces unique [buildingId, floorNumber]', async () => {
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Seattle HQ ' + Date.now(), city: 'Seattle' }
    });
    const officeId = offRes.json().id;

    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Building North', code: 'BN', officeId }
    });
    const buildingId = bldRes.json().id;

    // Create negative floor number (-2 basement)
    const flrBasement = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Basement 2', floorNumber: -2, buildingId }
    });
    expect(flrBasement.statusCode).toBe(201);
    expect(flrBasement.json().floorNumber).toBe(-2);
    expect(flrBasement.json().canvasWidth).toBe(1600);
    expect(flrBasement.json().canvasHeight).toBe(1000);

    // Duplicate floor number in same building -> 409
    const dupRes = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Another Basement 2', floorNumber: -2, buildingId }
    });
    expect(dupRes.statusCode).toBe(409);
  });

  // Feature 15: Departments CRUD
  it('HIER-04: Departments CRUD enforces strict 6-char hex color and restricts deletion with active employees', async () => {
    // Valid 6-char hex
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Design Studio ' + Date.now(), code: 'DSN-' + Date.now().toString().slice(-4), colorHex: '#EC4899' }
    });
    expect(createRes.statusCode).toBe(201);
    const dept = createRes.json();

    // Invalid hex: 3-digit shorthand
    const badHex1 = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Bad Hex 1', code: 'BH1', colorHex: '#FFF' }
    });
    expect(badHex1.statusCode).toBe(400);

    // Invalid hex: missing #
    const badHex2 = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Bad Hex 2', code: 'BH2', colorHex: '2563EB' }
    });
    expect(badHex2.statusCode).toBe(400);

    // Invalid hex: 8-digit RGBA
    const badHex3 = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Bad Hex 3', code: 'BH3', colorHex: '#2563EBFF' }
    });
    expect(badHex3.statusCode).toBe(400);

    // Add employee to department
    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: {
        employeeCode: 'EMP-DSN-1',
        fullName: 'Designer Dana',
        departmentId: dept.id
      }
    });

    // Attempt to delete department with active employees -> 409 Conflict
    const delConflictRes = await server.inject({
      method: 'DELETE',
      url: `/api/departments/${dept.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(delConflictRes.statusCode).toBe(409);
    expect(delConflictRes.json().message).toContain('Cannot delete department with active employees');
  });

  // Feature 16 & 17: Employee Management & CSV Import
  it('HIER-05: Employee CRUD supports search, assigned filter, and bulk CSV import', async () => {
    // 1. Get sample department
    const deptListRes = await server.inject({
      method: 'GET',
      url: '/api/departments',
      headers: { cookie: sessionCookie }
    });
    const depts = deptListRes.json();
    const engDept = depts.find((d: any) => d.code === 'ENG') || depts[0];

    // 2. Create employee
    const empRes = await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: {
        employeeCode: 'EMP-SRCH-1',
        fullName: 'SpecialSearchName',
        email: 'special@company.com',
        departmentId: engDept.id
      }
    });
    expect(empRes.statusCode).toBe(201);

    // 3. Search employee
    const searchRes = await server.inject({
      method: 'GET',
      url: '/api/employees?search=SpecialSearchName',
      headers: { cookie: sessionCookie }
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().employees).toHaveLength(1);
    expect(searchRes.json().employees[0].fullName).toBe('SpecialSearchName');

    // 4. CSV Bulk Import with BOM, quotes, and errors
    const csvContent =
      '\uFEFFemployeeCode,fullName,email,departmentCode\r\n' +
      'CSV-001,"Smith, Alice",alice.smith@company.com,ENG\r\n' +
      'CSV-002,Bob Importer,bob.importer@company.com,ENG\r\n' +
      'CSV-003,Error Row,err@company.com,NONEXISTENT_DEPT\r\n';

    const importRes = await server.inject({
      method: 'POST',
      url: '/api/employees/import-csv',
      headers: {
        cookie: sessionCookie,
        'content-type': 'text/csv'
      },
      payload: csvContent
    });

    expect(importRes.statusCode).toBe(200);
    const result = importRes.json();
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(4);
    expect(result.errors[0].error).toContain('NONEXISTENT_DEPT');
  });
});
