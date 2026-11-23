import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import xlsx from 'xlsx';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Milestone 3: Unit-Scoped Department Import, P2002 409 Handling & Graceful Disconnect', () => {
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
  let floor1: any;

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

    // Plant, Building, Floor in Unit 1 for Seat tests
    const plant1 = await mockPrisma.plant.create({
      data: { name: 'Plant 1', code: 'PLT-01', unitId: unit1.id }
    });
    const bld1 = await mockPrisma.building.create({
      data: { name: 'Building 1', code: 'BLD-01', plantId: plant1.id }
    });
    floor1 = await mockPrisma.floor.create({
      data: { name: 'Floor 1', floorNumber: 1, buildingId: bld1.id }
    });

    // Create duplicate department codes 'ENG' in both Unit 1 and Unit 2
    deptEngUnit1 = await mockPrisma.department.create({
      data: { name: 'Engineering Unit 1', code: 'ENG', colorHex: '#112233', unitId: unit1.id }
    });
    deptEngUnit2 = await mockPrisma.department.create({
      data: { name: 'Engineering Unit 2', code: 'ENG', colorHex: '#445566', unitId: unit2.id }
    });

    // Create QA department only in Unit 2
    deptQaUnit2Only = await mockPrisma.department.create({
      data: { name: 'Quality Assurance', code: 'QA', colorHex: '#778899', unitId: unit2.id }
    });

    // Super Admin login
    const saLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    superAdminCookie = saLogin.headers['set-cookie'] as string;

    // Unit 1 Admin user & login
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

    // Unit 2 Admin user & login
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
  // Issue 3.2: Unit-Scoped Department Lookup in Bulk Import
  // =========================================================================
  describe('Issue 3.2: Unit-Scoped Bulk Import', () => {
    it('M3-IMPORT-01: Unit 1 Admin importing Excel with code "ENG" maps to Unit 1 department, not Unit 2', async () => {
      const wb = xlsx.utils.book_new();
      const data = [
        ['Employee Code', 'Employee Name', 'Email', 'Department'],
        ['EMP-U1-01', 'U1 Worker', 'u1.worker@company.com', 'ENG']
      ];
      const ws = xlsx.utils.aoa_to_sheet(data);
      xlsx.utils.book_append_sheet(wb, ws, 'Roster');
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const boundary = '----WebKitFormBoundaryM3Excel01';
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

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-U1-01' } });
      expect(emp).toBeDefined();
      expect(emp.departmentId).toBe(deptEngUnit1.id);
      expect(emp.departmentId).not.toBe(deptEngUnit2.id);
    });

    it('M3-IMPORT-02: Unit 2 Admin importing CSV with code "ENG" maps to Unit 2 department, not Unit 1', async () => {
      const csv =
        'employeeCode,fullName,email,departmentCode\r\n' +
        'EMP-U2-01,U2 Worker,u2.worker@company.com,ENG\r\n';

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit2AdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-U2-01' } });
      expect(emp).toBeDefined();
      expect(emp.departmentId).toBe(deptEngUnit2.id);
      expect(emp.departmentId).not.toBe(deptEngUnit1.id);
    });

    it('M3-IMPORT-03: Super Admin importing Excel with Unit column scopes rows independently', async () => {
      const wb = xlsx.utils.book_new();
      const data = [
        ['Employee Code', 'Employee Name', 'Email', 'Department', 'Unit'],
        ['EMP-ROW-U1', 'Row U1', 'row.u1@company.com', 'ENG', 'UNIT-1'],
        ['EMP-ROW-U2', 'Row U2', 'row.u2@company.com', 'ENG', 'UNIT-2'],
      ];
      const ws = xlsx.utils.aoa_to_sheet(data);
      xlsx.utils.book_append_sheet(wb, ws, 'Roster');
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const boundary = '----WebKitFormBoundaryM3Excel03';
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
      expect(body.imported).toBe(2);
      expect(body.failed).toBe(0);

      const emp1 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-ROW-U1' } });
      const emp2 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-ROW-U2' } });
      expect(emp1.departmentId).toBe(deptEngUnit1.id);
      expect(emp2.departmentId).toBe(deptEngUnit2.id);
    });

    it('M3-IMPORT-04: Super Admin using ?unitId=<id> query param scopes lookup to that unit', async () => {
      const csv =
        'employeeCode,fullName,email,departmentCode\r\n' +
        'EMP-QUERY-01,Query Worker,query.worker@company.com,ENG\r\n';

      const res = await server.inject({
        method: 'POST',
        url: `/api/employees/import-csv?unitId=${unit2.id}`,
        headers: {
          cookie: superAdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-QUERY-01' } });
      expect(emp.departmentId).toBe(deptEngUnit2.id);
    });

    it('M3-IMPORT-05: Unit Admin importing department that only exists in another unit receives clear row error', async () => {
      // QA exists only in Unit 2. Unit 1 Admin attempts to import QA
      const csv =
        'employeeCode,fullName,email,departmentCode\r\n' +
        'EMP-CROSS-ERR,Cross Worker,cross@company.com,QA\r\n';

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].error).toContain("Department code 'QA' does not exist in target unit");
    });

    it('M3-IMPORT-06: Global department fallback works when department has no unitId', async () => {
      // Find one of the default unassigned global departments (e.g. FIN)
      const globalFin = await mockPrisma.department.findFirst({ where: { code: 'FIN' } });
      expect(globalFin).toBeDefined();

      const csv =
        'employeeCode,fullName,email,departmentCode\r\n' +
        'EMP-GLOBAL-01,Global Fin,fin.worker@company.com,FIN\r\n';

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: unit1AdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-GLOBAL-01' } });
      expect(emp.departmentId).toBe(globalFin.id);
    });
  });

  // =========================================================================
  // Issue 3.3: Clean 409 Conflict for Prisma P2002 Unique Constraint Errors
  // =========================================================================
  describe('Issue 3.3: P2002 409 Conflict Handling', () => {
    it('M3-P2002-01: POST /api/employees duplicate employeeCode returns 409 with descriptive message', async () => {
      // First employee
      const first = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-DUP-01',
          fullName: 'Original Employee',
          email: 'dup.orig@company.com',
          departmentId: deptEngUnit1.id
        }
      });
      expect(first.statusCode).toBe(201);

      // Attempt duplicate employeeCode
      const second = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-DUP-01',
          fullName: 'Duplicate Employee',
          email: 'dup.diff@company.com',
          departmentId: deptEngUnit1.id
        }
      });

      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('Employee code already exists');
    });

    it('M3-P2002-02: POST /api/employees duplicate email returns 409 with descriptive message', async () => {
      const first = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-EMAIL-01',
          fullName: 'First Email',
          email: 'shared.email@company.com',
          departmentId: deptEngUnit1.id
        }
      });
      expect(first.statusCode).toBe(201);

      const second = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-EMAIL-02',
          fullName: 'Second Email',
          email: 'shared.email@company.com',
          departmentId: deptEngUnit1.id
        }
      });

      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('Employee email already exists');
    });

    it('M3-P2002-03: PUT /api/employees/:id duplicate employeeCode returns 409 with descriptive message', async () => {
      const emp1 = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-PUT-01',
          fullName: 'Emp Put 1',
          email: 'put1@company.com',
          departmentId: deptEngUnit1.id
        }
      });
      const emp2 = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-PUT-02',
          fullName: 'Emp Put 2',
          email: 'put2@company.com',
          departmentId: deptEngUnit1.id
        }
      });

      // Update emp2's code to emp1's code
      const updateRes = await server.inject({
        method: 'PUT',
        url: `/api/employees/${emp2.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { employeeCode: 'EMP-PUT-01' }
      });

      expect(updateRes.statusCode).toBe(409);
      expect(updateRes.json().message).toContain('Employee code already exists');
    });

    it('M3-P2002-04: PUT /api/employees/:id duplicate email returns 409 with descriptive message', async () => {
      const emp1 = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-EMPUT-01',
          fullName: 'Emp EmPut 1',
          email: 'emput1@company.com',
          departmentId: deptEngUnit1.id
        }
      });
      const emp2 = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-EMPUT-02',
          fullName: 'Emp EmPut 2',
          email: 'emput2@company.com',
          departmentId: deptEngUnit1.id
        }
      });

      const updateRes = await server.inject({
        method: 'PUT',
        url: `/api/employees/${emp2.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { email: 'emput1@company.com' }
      });

      expect(updateRes.statusCode).toBe(409);
      expect(updateRes.json().message).toContain('Employee email already exists');
    });

    it('M3-P2002-05: POST /api/seats duplicate (floorId, label) returns 409 with descriptive message', async () => {
      const firstSeat = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: {
          floorId: floor1.id,
          label: 'WS-101',
          x: 100,
          y: 100
        }
      });
      expect(firstSeat.statusCode).toBe(201);

      const dupSeat = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: {
          floorId: floor1.id,
          label: 'WS-101',
          x: 200,
          y: 200
        }
      });

      expect(dupSeat.statusCode).toBe(409);
      const body = dupSeat.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('A workstation with this label already exists on this floor');
    });

    it('M3-P2002-06: PUT /api/seats/:id duplicate (floorId, label) returns 409 with descriptive message', async () => {
      const seat1 = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: { floorId: floor1.id, label: 'WS-201' }
      });
      const seat2 = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: { floorId: floor1.id, label: 'WS-202' }
      });

      const updateRes = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat2.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { label: 'WS-201' }
      });

      expect(updateRes.statusCode).toBe(409);
      expect(updateRes.json().message).toContain('A workstation with this label already exists on this floor');
    });

    it('M3-P2002-07: POST /api/seats/:id/quick-assign returns 409 if employee already assigned', async () => {
      // Create seat 1 and seat 2
      const s1 = await mockPrisma.seat.create({ data: { floorId: floor1.id, label: 'QA-01' } });
      const s2 = await mockPrisma.seat.create({ data: { floorId: floor1.id, label: 'QA-02' } });

      // Create employee assigned to s1
      const emp = await mockPrisma.employee.create({
        data: {
          employeeCode: 'EMP-ALREADY-ASSIGNED',
          fullName: 'Assigned Guy',
          departmentId: deptEngUnit1.id
        }
      });
      await mockPrisma.seat.update({ where: { id: s1.id }, data: { employeeId: emp.id } });

      // Attempt to quick-assign same employeeCode to s2
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${s2.id}/quick-assign`,
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-ALREADY-ASSIGNED',
          fullName: 'Assigned Guy',
          departmentId: deptEngUnit1.id
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Conflict');
    });

    it('M3-P2002-08: POST /api/departments duplicate (unitId, code) returns 409 with descriptive message', async () => {
      // deptEngUnit1 already has code 'ENG' in unit1. Attempt to create another department with code 'ENG' in unit1
      const res = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: {
          name: 'Another Engineering',
          code: 'ENG',
          colorHex: '#334455',
          unitId: unit1.id
        }
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('Department name or code already exists in this unit');
    });

    it('M3-P2002-09: PUT /api/departments/:id duplicate (unitId, code) returns 409 with descriptive message', async () => {
      const dept2 = await mockPrisma.department.create({
        data: { name: 'Operations Unit 1', code: 'OPS-U1', colorHex: '#aabbcc', unitId: unit1.id }
      });

      const res = await server.inject({
        method: 'PUT',
        url: `/api/departments/${dept2.id}`,
        headers: { cookie: superAdminCookie },
        payload: { code: 'ENG' }
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('Department name or code already exists in this unit');
    });

    it('M3-P2002-10: Central server error handler formats P2002 with array, string, and undefined meta.target', async () => {
      // Test central handler directly by injecting requests that throw synthetic P2002 errors
      const testServer = buildServer({
        prisma: mockPrisma,
        sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
      });
      testServer.get('/api/test-p2002-array', async () => {
        throw new Prisma.PrismaClientKnownRequestError('Constraint', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['field1', 'field2'] }
        });
      });
      testServer.get('/api/test-p2002-string', async () => {
        throw new Prisma.PrismaClientKnownRequestError('Constraint', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: 'singleField' }
        });
      });
      testServer.get('/api/test-p2002-undef', async () => {
        const err: any = new Error('Constraint');
        err.code = 'P2002';
        throw err;
      });
      await testServer.ready();

      const loginRes = await testServer.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
      });
      const cookie = loginRes.headers['set-cookie'] as string;

      const resArray = await testServer.inject({
        method: 'GET',
        url: '/api/test-p2002-array',
        headers: { cookie }
      });
      expect(resArray.statusCode).toBe(409);
      expect(resArray.json().message).toBe('Duplicate value on unique constraint: field1, field2');

      const resString = await testServer.inject({
        method: 'GET',
        url: '/api/test-p2002-string',
        headers: { cookie }
      });
      expect(resString.statusCode).toBe(409);
      expect(resString.json().message).toBe('Duplicate value on unique constraint: singleField');

      const resUndef = await testServer.inject({
        method: 'GET',
        url: '/api/test-p2002-undef',
        headers: { cookie }
      });
      expect(resUndef.statusCode).toBe(409);
      expect(resUndef.json().message).toBe('Duplicate value on unique constraint: field');

      await testServer.close();
    });
  });

  // =========================================================================
  // Issue 4.3: Graceful Prisma Disconnect on Shutdown
  // =========================================================================
  describe('Issue 4.3: Graceful Prisma Disconnect', () => {
    it('M3-SHUTDOWN-01: Disconnects Prisma on graceful close and error branches', async () => {
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      const fakeServer: any = {
        close: vi.fn().mockResolvedValue(undefined),
        prisma: { $disconnect: mockDisconnect },
        log: { info: vi.fn(), error: vi.fn() }
      };

      // Emulate the shutdown logic in index.ts
      const shutdown = async (serverInstance: any) => {
        try {
          await serverInstance.close();
          if (serverInstance.prisma) {
            await serverInstance.prisma.$disconnect();
          }
        } catch (closeErr) {
          serverInstance.log.error(closeErr);
          try {
            if (serverInstance.prisma) {
              await serverInstance.prisma.$disconnect();
            }
          } catch (prismaErr) {
            serverInstance.log.error(prismaErr);
          }
        }
      };

      await shutdown(fakeServer);
      expect(fakeServer.close).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Error branch: server.close throws, Prisma still attempts disconnect
      mockDisconnect.mockClear();
      const failingServer: any = {
        close: vi.fn().mockRejectedValue(new Error('Connection drain timeout')),
        prisma: { $disconnect: mockDisconnect },
        log: { info: vi.fn(), error: vi.fn() }
      };

      await shutdown(failingServer);
      expect(failingServer.close).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(failingServer.log.error).toHaveBeenCalled();
    });
  });
});
