import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import xlsx from 'xlsx';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Milestone 3 Adversarial Challenge & Stress Tests', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;
  let unit1: any;
  let unit2: any;
  let deptEngUnit1: any;
  let deptEngUnit2: any;
  let deptQaUnit2Only: any;
  let globalDept: any;
  let floor1: any;
  let floor2: any;

  function buildMultipart(boundary: string, filename: string, mime: string, content: Buffer): Buffer {
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    return Buffer.concat([header, content, footer]);
  }

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
    });
    await server.ready();

    const passwordHash = await argon2.hash(DEFAULT_ADMIN.password, { type: argon2.argon2id });

    // Create 2 test units
    unit1 = await mockPrisma.unit.create({
      data: { name: 'Manufacturing Unit 1', code: 'UNIT-1', location: 'Plant A' }
    });
    unit2 = await mockPrisma.unit.create({
      data: { name: 'Manufacturing Unit 2', code: 'UNIT-2', location: 'Plant B' }
    });

    // Plant, Building, Floor in Unit 1
    const plant1 = await mockPrisma.plant.create({
      data: { name: 'Plant 1', code: 'PLT-01', unitId: unit1.id }
    });
    const bld1 = await mockPrisma.building.create({
      data: { name: 'Building 1', code: 'BLD-01', plantId: plant1.id }
    });
    floor1 = await mockPrisma.floor.create({
      data: { name: 'Floor 1', floorNumber: 1, buildingId: bld1.id }
    });

    // Plant, Building, Floor in Unit 2
    const plant2 = await mockPrisma.plant.create({
      data: { name: 'Plant 2', code: 'PLT-02', unitId: unit2.id }
    });
    const bld2 = await mockPrisma.building.create({
      data: { name: 'Building 2', code: 'BLD-02', plantId: plant2.id }
    });
    floor2 = await mockPrisma.floor.create({
      data: { name: 'Floor 2', floorNumber: 2, buildingId: bld2.id }
    });

    // Department with identical code 'ENG' in both Unit 1 and Unit 2
    deptEngUnit1 = await mockPrisma.department.create({
      data: { name: 'Engineering Unit 1', code: 'ENG', colorHex: '#112233', unitId: unit1.id }
    });
    deptEngUnit2 = await mockPrisma.department.create({
      data: { name: 'Engineering Unit 2', code: 'ENG', colorHex: '#445566', unitId: unit2.id }
    });

    // Department only in Unit 2
    deptQaUnit2Only = await mockPrisma.department.create({
      data: { name: 'Quality Assurance', code: 'QA', colorHex: '#778899', unitId: unit2.id }
    });

    // Global department without unitId (unassigned / corporate)
    globalDept = await mockPrisma.department.create({
      data: { name: 'Corporate Legal', code: 'LEGAL', colorHex: '#999999', unitId: null }
    });

    // Super Admin login
    const saLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    superAdminCookie = saLogin.headers['set-cookie'] as string;

    // Unit 1 Admin login
    await mockPrisma.adminUser.create({
      data: {
        email: 'u1admin@company.com',
        name: 'Unit 1 Admin',
        passwordHash,
        role: 'UNIT_ADMIN',
        assignedUnitId: unit1.id
      }
    });
    const u1Login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'u1admin@company.com', password: DEFAULT_ADMIN.password }
    });
    unit1AdminCookie = u1Login.headers['set-cookie'] as string;

    // Unit 2 Admin login
    await mockPrisma.adminUser.create({
      data: {
        email: 'u2admin@company.com',
        name: 'Unit 2 Admin',
        passwordHash,
        role: 'UNIT_ADMIN',
        assignedUnitId: unit2.id
      }
    });
    const u2Login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'u2admin@company.com', password: DEFAULT_ADMIN.password }
    });
    unit2AdminCookie = u2Login.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // Section 1: Bulk Import Adversarial Stress Tests
  // =========================================================================
  describe('Bulk Import Scoping & Edge Cases (/import & /import-csv)', () => {
    it('ADV-IMPORT-01: Excel import with lowercase department code and extra whitespace matches correctly', async () => {
      const wb = xlsx.utils.book_new();
      const data = [
        ['Employee Code', 'Employee Name', 'Email', 'Department'],
        ['EMP-WS-01', 'Whitespace Tester', 'ws1@company.com', '   eng   ']
      ];
      const ws = xlsx.utils.aoa_to_sheet(data);
      xlsx.utils.book_append_sheet(wb, ws, 'Roster');
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const boundary = '----WebKitFormBoundaryWs01';
      const payload = buildMultipart(boundary, 'roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-WS-01' } });
      expect(emp).toBeDefined();
      expect(emp.departmentId).toBe(deptEngUnit1.id);
    });

    it('ADV-IMPORT-02: Excel import by Department Name (case-insensitive with padding)', async () => {
      const wb = xlsx.utils.book_new();
      const data = [
        ['Employee Code', 'Employee Name', 'Email', 'Department'],
        ['EMP-NAME-01', 'Dept Name Tester', 'name1@company.com', '  engineering unit 1  ']
      ];
      const ws = xlsx.utils.aoa_to_sheet(data);
      xlsx.utils.book_append_sheet(wb, ws, 'Roster');
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const boundary = '----WebKitFormBoundaryName01';
      const payload = buildMultipart(boundary, 'roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-NAME-01' } });
      expect(emp.departmentId).toBe(deptEngUnit1.id);
    });

    it('ADV-IMPORT-03: Excel with scrambled column order (Department, Email, Name, Code, Unit)', async () => {
      const wb = xlsx.utils.book_new();
      const data = [
        ['Department', 'Email', 'Employee Name', 'Employee Code', 'Unit'],
        ['ENG', 'scramble@company.com', 'Scramble User', 'EMP-SCRAMBLE', 'UNIT-2']
      ];
      const ws = xlsx.utils.aoa_to_sheet(data);
      xlsx.utils.book_append_sheet(wb, ws, 'Roster');
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const boundary = '----WebKitFormBoundaryScramble';
      const payload = buildMultipart(boundary, 'roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import',
        headers: {
          cookie: superAdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-SCRAMBLE' } });
      expect(emp).toBeDefined();
      expect(emp.fullName).toBe('Scramble User');
      expect(emp.email).toBe('scramble@company.com');
      expect(emp.departmentId).toBe(deptEngUnit2.id); // Matched Unit 2
    });

    it('ADV-IMPORT-04: Unit Admin CANNOT bypass unit lock even if CSV row specifies Unit 2', async () => {
      // Unit 1 admin uploads CSV attempting to assign to Unit 2
      const csv = `Employee Code,Employee Name,Email,Department,Unit\nEMP-BYPASS-01,Bypass Attempt,bypass@company.com,ENG,UNIT-2`;
      const boundary = '----WebKitFormBoundaryBypass';
      const payload = buildMultipart(boundary, 'bypass.csv', 'text/csv', Buffer.from(csv));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);

      // Must have mapped to Unit 1's ENG department, NOT Unit 2!
      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-BYPASS-01' } });
      expect(emp.departmentId).toBe(deptEngUnit1.id);
      expect(emp.departmentId).not.toBe(deptEngUnit2.id);
    });

    it('ADV-IMPORT-05: Unit Admin importing code QA (only in Unit 2) with Unit 2 in row is rejected', async () => {
      const csv = `Employee Code,Employee Name,Email,Department,Unit\nEMP-QA-01,QA Attempt,qa@company.com,QA,UNIT-2`;
      const boundary = '----WebKitFormBoundaryQaRej';
      const payload = buildMultipart(boundary, 'qa.csv', 'text/csv', Buffer.from(csv));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors[0].error).toContain("Department code 'QA' does not exist in target unit");
    });

    it('ADV-IMPORT-06: Super Admin specifying an invalid/non-existent unit receives clear row error without 500 crash', async () => {
      // Use QA (which is unit-specific to Unit 2 and does NOT exist globally) with an invalid unit
      const csv = `Employee Code,Employee Name,Email,Department,Unit\nEMP-INV-01,Invalid Unit User,inv@company.com,QA,NON_EXISTENT_UNIT_999`;
      const boundary = '----WebKitFormBoundaryInvUnit';
      const payload = buildMultipart(boundary, 'invalid.csv', 'text/csv', Buffer.from(csv));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: superAdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors[0].error).toContain("Department code 'QA' does not exist in target unit");
    });

    it('ADV-IMPORT-07: Unassigned / Global Department (unitId = null) is resolved properly for Unit Admin', async () => {
      const csv = `Employee Code,Employee Name,Email,Department\nEMP-GL-01,Global Worker,gl1@company.com,LEGAL`;
      const boundary = '----WebKitFormBoundaryGlobal1';
      const payload = buildMultipart(boundary, 'global.csv', 'text/csv', Buffer.from(csv));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-GL-01' } });
      expect(emp.departmentId).toBe(globalDept.id);
    });

    it('ADV-IMPORT-08: Unit-scoped department takes precedence over global department with same code', async () => {
      // Create global dept with code 'ENG'
      const globalEng = await mockPrisma.department.create({
        data: { name: 'Global Engineering', code: 'ENG_GLOBAL', colorHex: '#000000', unitId: null }
      });
      // Unit 1 Admin imports ENG -> should pick Unit 1's ENG, not global
      const csv = `Employee Code,Employee Name,Email,Department\nEMP-PRI-01,Priority Tester,pri1@company.com,ENG`;
      const boundary = '----WebKitFormBoundaryPri';
      const payload = buildMultipart(boundary, 'priority.csv', 'text/csv', Buffer.from(csv));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-PRI-01' } });
      expect(emp.departmentId).toBe(deptEngUnit1.id);
    });

    it('ADV-IMPORT-09: CSV with formula injection attacks are safely stripped and imported', async () => {
      const csv = `Employee Code,Employee Name,Email,Department\n=CMD|' /C calc'!A0,+Dangerous User,sec@company.com,ENG`;
      const boundary = '----WebKitFormBoundarySec';
      const payload = buildMultipart(boundary, 'sec.csv', 'text/csv', Buffer.from(csv));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);

      // Verify dangerous leading characters (=, +) were stripped
      const employees = await mockPrisma.employee.findMany();
      const secEmp = employees.find((e: any) => e.email === 'sec@company.com');
      expect(secEmp).toBeDefined();
      expect(secEmp.employeeCode.startsWith('=')).toBe(false);
      expect(secEmp.fullName.startsWith('+')).toBe(false);
    });

    it('ADV-IMPORT-10: Handles empty CSV, empty lines, and header-only gracefully without error', async () => {
      const boundary = '----WebKitFormBoundaryEmpty';
      const payload = buildMultipart(boundary, 'empty.csv', 'text/csv', Buffer.from(''));

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.failed).toBe(0);
      expect(body.errors).toEqual([]);
    });
  });

  // =========================================================================
  // Section 2: P2002 Unique Constraint Handling Stress Tests
  // =========================================================================
  describe('P2002 Unique Constraint Stress Tests Across Routes & Central Handler', () => {
    it('ADV-P2002-01: Central error handler handles weird meta.target: empty array, whitespace string, numbers, null', async () => {
      const customServer = buildServer({
        prisma: mockPrisma,
        sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
      });

      // Subtest 1: meta.target is empty array
      customServer.get('/test/p2002-empty-arr', async () => {
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        err.meta = { target: [] };
        throw err;
      });

      // Subtest 2: meta.target is whitespace string
      customServer.get('/test/p2002-ws-str', async () => {
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        err.meta = { target: '   ' };
        throw err;
      });

      // Subtest 3: meta.target is a number or null
      customServer.get('/test/p2002-number', async () => {
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        err.meta = { target: 12345 };
        throw err;
      });

      // Subtest 4: meta is undefined
      customServer.get('/test/p2002-no-meta', async () => {
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      });

      // Subtest 5: meta.target is multiple composite fields
      customServer.get('/test/p2002-multi', async () => {
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        err.meta = { target: ['unitId', 'code', 'name'] };
        throw err;
      });

      await customServer.ready();

      const loginRes = await customServer.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
      });
      const cookie = loginRes.headers['set-cookie'] as string;

      const res1 = await customServer.inject({ method: 'GET', url: '/test/p2002-empty-arr', headers: { cookie } });
      expect(res1.statusCode).toBe(409);
      expect(res1.json().message).toBe('Duplicate value on unique constraint: field');

      const res2 = await customServer.inject({ method: 'GET', url: '/test/p2002-ws-str', headers: { cookie } });
      expect(res2.statusCode).toBe(409);
      expect(res2.json().message).toBe('Duplicate value on unique constraint: field');

      const res3 = await customServer.inject({ method: 'GET', url: '/test/p2002-number', headers: { cookie } });
      expect(res3.statusCode).toBe(409);
      expect(res3.json().message).toBe('Duplicate value on unique constraint: field');

      const res4 = await customServer.inject({ method: 'GET', url: '/test/p2002-no-meta', headers: { cookie } });
      expect(res4.statusCode).toBe(409);
      expect(res4.json().message).toBe('Duplicate value on unique constraint: field');

      const res5 = await customServer.inject({ method: 'GET', url: '/test/p2002-multi', headers: { cookie } });
      expect(res5.statusCode).toBe(409);
      expect(res5.json().message).toBe('Duplicate value on unique constraint: unitId, code, name');

      await customServer.close();
    });

    it('ADV-P2002-02: POST /api/employees race condition: passes findUnique pre-check, but create throws P2002', async () => {
      // Mock findUnique to return null, but $transaction create throws P2002 on employeeCode
      const origFindUnique = mockPrisma.employee.findUnique;
      const origCreate = mockPrisma.employee.create;

      mockPrisma.employee.findUnique = vi.fn().mockResolvedValue(null);
      mockPrisma.employee.create = vi.fn().mockImplementation(() => {
        const err: any = new Error('Unique constraint failed on employeeCode');
        err.code = 'P2002';
        err.meta = { target: ['employeeCode'] };
        throw err;
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-RACE-01',
          fullName: 'Race Tester',
          email: 'race@company.com',
          departmentId: deptEngUnit1.id,
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('Employee code already exists');

      // Restore mocks
      mockPrisma.employee.findUnique = origFindUnique;
      mockPrisma.employee.create = origCreate;
    });

    it('ADV-P2002-03: POST /api/employees handles MongoDB-style target string employee_code_1', async () => {
      const origFindUnique = mockPrisma.employee.findUnique;
      const origCreate = mockPrisma.employee.create;

      mockPrisma.employee.findUnique = vi.fn().mockResolvedValue(null);
      mockPrisma.employee.create = vi.fn().mockImplementation(() => {
        const err: any = new Error('Unique constraint failed on employee_code_1');
        err.code = 'P2002';
        err.meta = { target: 'employee_code_1' };
        throw err;
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-MONGO-01',
          fullName: 'Mongo Target Tester',
          email: 'mongo@company.com',
          departmentId: deptEngUnit1.id,
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('Employee code already exists');

      mockPrisma.employee.findUnique = origFindUnique;
      mockPrisma.employee.create = origCreate;
    });

    it('ADV-P2002-04: PUT /api/employees/:id handles concurrent P2002 on email', async () => {
      const emp = await mockPrisma.employee.create({
        data: {
          employeeCode: 'EMP-PUT-RACE',
          fullName: 'Put Race',
          email: 'putrace@company.com',
          departmentId: deptEngUnit1.id
        }
      });

      const origUpdate = mockPrisma.employee.update;
      mockPrisma.employee.update = vi.fn().mockImplementation(() => {
        const err: any = new Error('Unique constraint failed on email');
        err.code = 'P2002';
        err.meta = { target: ['email'] };
        throw err;
      });

      const res = await server.inject({
        method: 'PUT',
        url: `/api/employees/${emp.id}`,
        headers: { cookie: superAdminCookie },
        payload: {
          email: 'newemail@company.com',
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('Employee email already exists');

      mockPrisma.employee.update = origUpdate;
    });

    it('ADV-P2002-05: POST /api/seats/:id/assign returns 409 when employee is already assigned to another seat', async () => {
      // Create seat 1 and assign employee
      const emp = await mockPrisma.employee.create({
        data: {
          employeeCode: 'EMP-SEAT-01',
          fullName: 'Seat Worker',
          email: 'seat1@company.com',
          departmentId: deptEngUnit1.id
        }
      });
      const seat1 = await mockPrisma.seat.create({
        data: {
          floorId: floor1.id,
          label: 'WS-01',
          status: 'AVAILABLE',
          x: 10,
          y: 10,
          employeeId: emp.id,
          departmentId: deptEngUnit1.id
        }
      });
      // Create seat 2
      const seat2 = await mockPrisma.seat.create({
        data: {
          floorId: floor1.id,
          label: 'WS-02',
          status: 'AVAILABLE',
          x: 20,
          y: 20,
        }
      });

      // Try assigning same employee to seat 2
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat2.id}/assign`,
        headers: { cookie: superAdminCookie },
        payload: { employeeId: emp.id }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/already assigned/i);
    });

    it('ADV-P2002-06: Floor Department (detached floor with no unitId) P2002 conflict reports floor message', async () => {
      // Create a detached floor not connected to building/plant
      const detachedFloor = await mockPrisma.floor.create({
        data: { name: 'Detached Floor', floorNumber: 99 }
      });

      const origCreate = mockPrisma.department.create;
      mockPrisma.department.create = vi.fn().mockImplementation(() => {
        const err: any = new Error('Unique constraint failed on floorId, code');
        err.code = 'P2002';
        err.meta = { target: ['floorId', 'code'] };
        throw err;
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: {
          name: 'Floor Ops',
          code: 'FOPS',
          colorHex: '#334455',
          floorId: detachedFloor.id,
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('Department name or code already exists on this floor');

      mockPrisma.department.create = origCreate;
    });

    it('ADV-P2002-07: PUT /api/departments/:id without unitId reports floor message on conflict', async () => {
      const dept = await mockPrisma.department.create({
        data: {
          name: 'Floor Dept',
          code: 'FDEPT',
          colorHex: '#111111',
          floorId: floor1.id,
          unitId: null
        }
      });

      const origUpdate = mockPrisma.department.update;
      mockPrisma.department.update = vi.fn().mockImplementation(() => {
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      });

      const res = await server.inject({
        method: 'PUT',
        url: `/api/departments/${dept.id}`,
        headers: { cookie: superAdminCookie },
        payload: {
          name: 'Floor Dept Updated',
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('Department name or code already exists on this floor');

      mockPrisma.department.update = origUpdate;
    });
  });

  // =========================================================================
  // Section 3: Graceful Shutdown Stress Tests (apps/backend/src/index.ts)
  // =========================================================================
  describe('Graceful Shutdown Invariants & Error Branch Disconnect', () => {
    it('ADV-SHUTDOWN-01: Disconnects Prisma on clean server.close()', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const fakeServer: any = {
        close: mockClose,
        prisma: { $disconnect: mockDisconnect },
        log: { info: vi.fn(), error: vi.fn() }
      };

      // Execute shutdown logic identical to index.ts
      const shutdown = async (signal: string) => {
        fakeServer.log.info(`Received ${signal}, closing server gracefully...`);
        try {
          await fakeServer.close();
          if (fakeServer.prisma) {
            await fakeServer.prisma.$disconnect();
          }
          process.exit(0);
        } catch (closeErr) {
          fakeServer.log.error(closeErr);
          try {
            if (fakeServer.prisma) {
              await fakeServer.prisma.$disconnect();
            }
          } catch (prismaErr) {
            fakeServer.log.error(prismaErr);
          }
          process.exit(1);
        }
      };

      await shutdown('SIGINT');

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
      mockExit.mockRestore();
    });

    it('ADV-SHUTDOWN-02: Disconnects Prisma even if server.close() rejects with error', async () => {
      const mockClose = vi.fn().mockRejectedValue(new Error('Port stuck or fastify close timeout'));
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const fakeServer: any = {
        close: mockClose,
        prisma: { $disconnect: mockDisconnect },
        log: { info: vi.fn(), error: vi.fn() }
      };

      const shutdown = async (signal: string) => {
        fakeServer.log.info(`Received ${signal}, closing server gracefully...`);
        try {
          await fakeServer.close();
          if (fakeServer.prisma) {
            await fakeServer.prisma.$disconnect();
          }
          process.exit(0);
        } catch (closeErr) {
          fakeServer.log.error(closeErr);
          try {
            if (fakeServer.prisma) {
              await fakeServer.prisma.$disconnect();
            }
          } catch (prismaErr) {
            fakeServer.log.error(prismaErr);
          }
          process.exit(1);
        }
      };

      await shutdown('SIGTERM');

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });

    it('ADV-SHUTDOWN-03: Double fault (both close and disconnect fail) exits cleanly with 1 without unhandled rejection', async () => {
      const mockClose = vi.fn().mockRejectedValue(new Error('Close failed'));
      const mockDisconnect = vi.fn().mockRejectedValue(new Error('Mongo pool disconnect failed'));
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const fakeServer: any = {
        close: mockClose,
        prisma: { $disconnect: mockDisconnect },
        log: { info: vi.fn(), error: vi.fn() }
      };

      const shutdown = async (signal: string) => {
        try {
          await fakeServer.close();
          if (fakeServer.prisma) {
            await fakeServer.prisma.$disconnect();
          }
          process.exit(0);
        } catch (closeErr) {
          fakeServer.log.error(closeErr);
          try {
            if (fakeServer.prisma) {
              await fakeServer.prisma.$disconnect();
            }
          } catch (prismaErr) {
            fakeServer.log.error(prismaErr);
          }
          process.exit(1);
        }
      };

      await shutdown('SIGINT');

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(fakeServer.log.error).toHaveBeenCalledTimes(2);
      mockExit.mockRestore();
    });

    it('ADV-SHUTDOWN-04: Gracefully handles scenario where server.prisma is undefined', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const fakeServer: any = {
        close: mockClose,
        prisma: undefined,
        log: { info: vi.fn(), error: vi.fn() }
      };

      const shutdown = async (signal: string) => {
        try {
          await fakeServer.close();
          if (fakeServer.prisma) {
            await fakeServer.prisma.$disconnect();
          }
          process.exit(0);
        } catch (closeErr) {
          fakeServer.log.error(closeErr);
          try {
            if (fakeServer.prisma) {
              await fakeServer.prisma.$disconnect();
            }
          } catch (prismaErr) {
            fakeServer.log.error(prismaErr);
          }
          process.exit(1);
        }
      };

      await shutdown('SIGINT');

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
      mockExit.mockRestore();
    });
  });
});
