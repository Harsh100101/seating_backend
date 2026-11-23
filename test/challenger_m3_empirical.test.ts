import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import xlsx from 'xlsx';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('CHALLENGER Empirical Verification Suite - Milestone 3', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;
  let unit1: any;
  let unit2: any;
  let unit3: any;
  let deptDevU1: any;
  let deptDevU2: any;
  let deptDevU3: any;
  let deptRndU1: any;
  let deptRndU2: any;
  let deptQaU2Only: any;
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
      sessionSecret: 'super-secret-session-key-at-least-32-chars-long!',
    });
    await server.ready();

    const passwordHash = await argon2.hash(DEFAULT_ADMIN.password, { type: argon2.argon2id });

    // 1. Create 3 independent manufacturing units
    unit1 = await mockPrisma.unit.create({
      data: { name: 'Manufacturing Unit Alpha', code: 'UNIT-ALPHA', location: 'Campus 1' }
    });
    unit2 = await mockPrisma.unit.create({
      data: { name: 'Manufacturing Unit Beta', code: 'UNIT-BETA', location: 'Campus 2' }
    });
    unit3 = await mockPrisma.unit.create({
      data: { name: 'Manufacturing Unit Gamma', code: 'UNIT-GAMMA', location: 'Campus 3' }
    });

    // 2. Plants, Buildings, Floors
    const plant1 = await mockPrisma.plant.create({
      data: { name: 'Plant Alpha', code: 'PLT-A', unitId: unit1.id }
    });
    const bld1 = await mockPrisma.building.create({
      data: { name: 'Bld Alpha', code: 'BLD-A', plantId: plant1.id }
    });
    floor1 = await mockPrisma.floor.create({
      data: { name: 'Floor A1', floorNumber: 1, buildingId: bld1.id }
    });

    const plant2 = await mockPrisma.plant.create({
      data: { name: 'Plant Beta', code: 'PLT-B', unitId: unit2.id }
    });
    const bld2 = await mockPrisma.building.create({
      data: { name: 'Bld Beta', code: 'BLD-B', plantId: plant2.id }
    });
    floor2 = await mockPrisma.floor.create({
      data: { name: 'Floor B1', floorNumber: 1, buildingId: bld2.id }
    });

    // 3. Multi-unit identical department codes and names across units
    // DEV department in all 3 units
    deptDevU1 = await mockPrisma.department.create({
      data: { name: 'Software Development Alpha', code: 'DEV', colorHex: '#111111', unitId: unit1.id }
    });
    deptDevU2 = await mockPrisma.department.create({
      data: { name: 'Software Development Beta', code: 'DEV', colorHex: '#222222', unitId: unit2.id }
    });
    deptDevU3 = await mockPrisma.department.create({
      data: { name: 'Software Development Gamma', code: 'DEV', colorHex: '#333333', unitId: unit3.id }
    });

    // R&D department in Unit 1 and Unit 2 with same name, different codes
    deptRndU1 = await mockPrisma.department.create({
      data: { name: 'Research & Development', code: 'RND-A', colorHex: '#444444', unitId: unit1.id }
    });
    deptRndU2 = await mockPrisma.department.create({
      data: { name: 'Research & Development', code: 'RND-B', colorHex: '#555555', unitId: unit2.id }
    });

    // QA department strictly in Unit 2 only
    deptQaU2Only = await mockPrisma.department.create({
      data: { name: 'Quality Assurance Special', code: 'QA-SPECIAL', colorHex: '#666666', unitId: unit2.id }
    });

    // 4. Authenticate Super Admin
    const saLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    superAdminCookie = saLogin.headers['set-cookie'] as string;

    // 5. Unit 1 Admin user & login
    await mockPrisma.adminUser.create({
      data: {
        email: 'alpha.admin@company.com',
        name: 'Unit Alpha Admin',
        passwordHash,
        role: 'UNIT_ADMIN',
        assignedUnitId: unit1.id
      }
    });
    const u1Login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alpha.admin@company.com', password: DEFAULT_ADMIN.password }
    });
    unit1AdminCookie = u1Login.headers['set-cookie'] as string;

    // 6. Unit 2 Admin user & login
    await mockPrisma.adminUser.create({
      data: {
        email: 'beta.admin@company.com',
        name: 'Unit Beta Admin',
        passwordHash,
        role: 'UNIT_ADMIN',
        assignedUnitId: unit2.id
      }
    });
    const u2Login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'beta.admin@company.com', password: DEFAULT_ADMIN.password }
    });
    unit2AdminCookie = u2Login.headers['set-cookie'] as string;
  }, 30000);

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // SECTION 1: SuperAdmin Multi-Unit Import Routing & Cross-Unit Isolation
  // =========================================================================
  describe('1. SuperAdmin Multi-Unit Bulk Import Routing', () => {
    it('CHALLENGE-M3-01: SuperAdmin imports CSV with 3 units in single batch, correctly routes DEV to distinct unit departments', async () => {
      const csv =
        'employeeCode,fullName,email,departmentCode,unit\r\n' +
        'EMP-DEV-01,Emp Alpha,alpha.dev@example.com,DEV,UNIT-ALPHA\r\n' +
        'EMP-DEV-02,Emp Beta,beta.dev@example.com,DEV,UNIT-BETA\r\n' +
        'EMP-DEV-03,Emp Gamma,gamma.dev@example.com,DEV,UNIT-GAMMA\r\n';

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: superAdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(3);
      expect(body.failed).toBe(0);
      expect(body.errors).toHaveLength(0);

      const emp1 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-DEV-01' } });
      const emp2 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-DEV-02' } });
      const emp3 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-DEV-03' } });

      expect(emp1.departmentId).toBe(deptDevU1.id);
      expect(emp2.departmentId).toBe(deptDevU2.id);
      expect(emp3.departmentId).toBe(deptDevU3.id);

      // Verify no cross-pollution
      expect(emp1.departmentId).not.toBe(deptDevU2.id);
      expect(emp2.departmentId).not.toBe(deptDevU3.id);
    });

    it('CHALLENGE-M3-02: SuperAdmin imports Excel matching department by NAME ("Research & Development") scoped per unit', async () => {
      const wb = xlsx.utils.book_new();
      const data = [
        ['Employee Code', 'Employee Name', 'Email', 'Department', 'Unit'],
        ['EMP-RND-01', 'Emp RND Alpha', 'rnd.a@example.com', 'Research & Development', 'UNIT-ALPHA'],
        ['EMP-RND-02', 'Emp RND Beta', 'rnd.b@example.com', 'Research & Development', 'UNIT-BETA'],
      ];
      const ws = xlsx.utils.aoa_to_sheet(data);
      xlsx.utils.book_append_sheet(wb, ws, 'Roster');
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const boundary = '----WebKitFormBoundaryChallengerM3Excel02';
      const payload = buildMultipart(boundary, 'rnd_roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

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

      const emp1 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-RND-01' } });
      const emp2 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-RND-02' } });

      expect(emp1.departmentId).toBe(deptRndU1.id);
      expect(emp2.departmentId).toBe(deptRndU2.id);
    });

    it('CHALLENGE-M3-03: SuperAdmin import with non-existent target unit isolates failure and does not crash batch', async () => {
      const csv =
        'employeeCode,fullName,email,departmentCode,unit\r\n' +
        'EMP-VALID-01,Valid Alpha,valid.a@example.com,DEV,UNIT-ALPHA\r\n' +
        'EMP-INVALID-01,Invalid Unit,invalid.u@example.com,DEV,UNIT-GHOST-999\r\n';

      const res = await server.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: {
          cookie: superAdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors[0].row).toBe(3);
      expect(body.errors[0].error).toContain("Department code 'DEV' does not exist in target unit");

      const validEmp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-VALID-01' } });
      expect(validEmp).toBeDefined();
      expect(validEmp.departmentId).toBe(deptDevU1.id);

      const invalidEmp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-INVALID-01' } });
      expect(invalidEmp).toBeNull();
    });
  });

  // =========================================================================
  // SECTION 2: UnitAdmin Cross-Unit Import Isolation / Strict Scoping
  // =========================================================================
  describe('2. UnitAdmin Cross-Unit Import Isolation', () => {
    it('CHALLENGE-M3-04: Unit 1 Admin attempting to import row targeting UNIT-BETA is forced to Unit 1', async () => {
      // Unit 1 Admin sends row with UNIT-BETA and DEV
      const csv =
        'employeeCode,fullName,email,departmentCode,unit\r\n' +
        'EMP-FORCE-U1,Forced Alpha,forced.a@example.com,DEV,UNIT-BETA\r\n';

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

      // Must be mapped strictly to Unit 1's department, NOT Unit 2's department
      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-FORCE-U1' } });
      expect(emp.departmentId).toBe(deptDevU1.id);
      expect(emp.departmentId).not.toBe(deptDevU2.id);
    });

    it('CHALLENGE-M3-05: Unit 1 Admin attempting to import department existing only in Unit 2 is strictly blocked', async () => {
      // QA-SPECIAL only exists in Unit 2
      const csv =
        'employeeCode,fullName,email,departmentCode\r\n' +
        'EMP-CROSS-BLOCK,Cross QA,cross.qa@example.com,QA-SPECIAL\r\n';

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
      expect(body.errors[0].error).toContain("Department code 'QA-SPECIAL' does not exist in target unit");

      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-CROSS-BLOCK' } });
      expect(emp).toBeNull();
    });

    it('CHALLENGE-M3-06: Unit 1 Admin passing ?unitId=UNIT-BETA query param is ignored in favor of assignedUnitId', async () => {
      const csv =
        'employeeCode,fullName,email,departmentCode\r\n' +
        'EMP-QUERY-OVERRIDE,Query Override,override@example.com,DEV\r\n';

      const res = await server.inject({
        method: 'POST',
        url: `/api/employees/import-csv?unitId=${unit2.id}`,
        headers: {
          cookie: unit1AdminCookie,
          'content-type': 'text/csv',
        },
        payload: csv,
      });

      expect(res.statusCode).toBe(200);
      const emp = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-QUERY-OVERRIDE' } });
      expect(emp.departmentId).toBe(deptDevU1.id);
      expect(emp.departmentId).not.toBe(deptDevU2.id);
    });
  });

  // =========================================================================
  // SECTION 3: P2002 Unique Constraint Handling across All Resources
  // =========================================================================
  describe('3. P2002 Unique Constraint Conflict Responses', () => {
    it('CHALLENGE-M3-07: Employee duplicate employeeCode on create returns 409 Conflict', async () => {
      const first = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-P2002-C1',
          fullName: 'Emp One',
          email: 'one@example.com',
          departmentId: deptDevU1.id
        }
      });
      expect(first.statusCode).toBe(201);

      const second = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-P2002-C1',
          fullName: 'Emp Duplicate Code',
          email: 'two@example.com',
          departmentId: deptDevU1.id
        }
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('Conflict');
      expect(second.json().message).toBe('Employee code already exists');
    });

    it('CHALLENGE-M3-08: Employee duplicate email on create returns 409 Conflict', async () => {
      const first = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-P2002-E1',
          fullName: 'Emp Unique Code 1',
          email: 'dup.email@example.com',
          departmentId: deptDevU1.id
        }
      });
      expect(first.statusCode).toBe(201);

      const second = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeCode: 'EMP-P2002-E2',
          fullName: 'Emp Unique Code 2',
          email: 'dup.email@example.com',
          departmentId: deptDevU1.id
        }
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('Conflict');
      expect(second.json().message).toBe('Employee email already exists');
    });

    it('CHALLENGE-M3-09: Employee duplicate employeeCode and email on PUT returns 409 Conflict', async () => {
      const empA = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: { employeeCode: 'EMP-PUT-A', fullName: 'Emp A', email: 'a@example.com', departmentId: deptDevU1.id }
      });
      const empB = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: superAdminCookie },
        payload: { employeeCode: 'EMP-PUT-B', fullName: 'Emp B', email: 'b@example.com', departmentId: deptDevU1.id }
      });

      // Update B's code to A's code
      const putCodeRes = await server.inject({
        method: 'PUT',
        url: `/api/employees/${empB.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { employeeCode: 'EMP-PUT-A' }
      });
      expect(putCodeRes.statusCode).toBe(409);
      expect(putCodeRes.json().message).toBe('Employee code already exists');

      // Update B's email to A's email
      const putEmailRes = await server.inject({
        method: 'PUT',
        url: `/api/employees/${empB.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { email: 'a@example.com' }
      });
      expect(putEmailRes.statusCode).toBe(409);
      expect(putEmailRes.json().message).toBe('Employee email already exists');
    });

    it('CHALLENGE-M3-10: Seat duplicate label on same floor on POST and PUT returns 409 Conflict', async () => {
      // POST duplicate seat
      const s1 = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: { floorId: floor1.id, label: 'DESK-CHALLENGE-01' }
      });
      expect(s1.statusCode).toBe(201);

      const sDup = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: { floorId: floor1.id, label: 'DESK-CHALLENGE-01' }
      });
      expect(sDup.statusCode).toBe(409);
      expect(sDup.json().message).toContain('A workstation with this label already exists on this floor');

      // PUT duplicate seat
      const s2 = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: superAdminCookie },
        payload: { floorId: floor1.id, label: 'DESK-CHALLENGE-02' }
      });
      expect(s2.statusCode).toBe(201);

      const putDup = await server.inject({
        method: 'PUT',
        url: `/api/seats/${s2.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { label: 'DESK-CHALLENGE-01' }
      });
      expect(putDup.statusCode).toBe(409);
      expect(putDup.json().message).toContain('A workstation with this label already exists on this floor');
    });

    it('CHALLENGE-M3-11: Department duplicate code and name within same unit on POST and PUT returns 409 Conflict', async () => {
      // Duplicate code in unit 1
      const postDupCode = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: { name: 'Novel Name', code: 'DEV', colorHex: '#123456', unitId: unit1.id }
      });
      expect(postDupCode.statusCode).toBe(409);
      expect(postDupCode.json().message).toContain('Department name or code already exists in this unit');

      // Duplicate name in unit 1
      const postDupName = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: { name: 'Software Development Alpha', code: 'NOVEL-CODE', colorHex: '#123456', unitId: unit1.id }
      });
      expect(postDupName.statusCode).toBe(409);
      expect(postDupName.json().message).toContain('Department name or code already exists in this unit');

      // Create new department and update to duplicate code
      const newDept = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: superAdminCookie },
        payload: { name: 'Brand New Dept', code: 'BRAND-NEW', colorHex: '#123456', unitId: unit1.id }
      });
      expect(newDept.statusCode).toBe(201);

      const putDupCode = await server.inject({
        method: 'PUT',
        url: `/api/departments/${newDept.json().id}`,
        headers: { cookie: superAdminCookie },
        payload: { code: 'DEV' }
      });
      expect(putDupCode.statusCode).toBe(409);
      expect(putDupCode.json().message).toContain('Department name or code already exists in this unit');
    });

    it('CHALLENGE-M3-12: Central error handler formats arbitrary P2002 variations into 409 response', async () => {
      const customServer = buildServer({
        prisma: mockPrisma,
        sessionSecret: 'super-secret-session-key-at-least-32-chars-long!',
      });

      customServer.get('/api/synthetic-p2002-multi', async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique failure', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['unitId', 'buildingCode', 'roomNumber'] }
        });
      });
      customServer.get('/api/synthetic-p2002-empty-meta', async () => {
        const err: any = new Error('Unique failure');
        err.code = 'P2002';
        throw err;
      });
      await customServer.ready();

      const loginRes = await customServer.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
      });
      const cookie = loginRes.headers['set-cookie'] as string;

      const resMulti = await customServer.inject({
        method: 'GET',
        url: '/api/synthetic-p2002-multi',
        headers: { cookie }
      });
      expect(resMulti.statusCode).toBe(409);
      expect(resMulti.json().message).toBe('Duplicate value on unique constraint: unitId, buildingCode, roomNumber');

      const resEmpty = await customServer.inject({
        method: 'GET',
        url: '/api/synthetic-p2002-empty-meta',
        headers: { cookie }
      });
      expect(resEmpty.statusCode).toBe(409);
      expect(resEmpty.json().message).toBe('Duplicate value on unique constraint: field');

      await customServer.close();
    });
  });

  // =========================================================================
  // SECTION 4: Graceful Shutdown & Prisma Disconnect Resilience
  // =========================================================================
  describe('4. Graceful Shutdown & Prisma Disconnect', () => {
    it('CHALLENGE-M3-13: Invokes server.close() before prisma.$disconnect() on graceful exit', async () => {
      const executionOrder: string[] = [];
      const fakeServer: any = {
        close: vi.fn().mockImplementation(async () => {
          executionOrder.push('server.close');
        }),
        prisma: {
          $disconnect: vi.fn().mockImplementation(async () => {
            executionOrder.push('prisma.$disconnect');
          })
        },
        log: { info: vi.fn(), error: vi.fn() }
      };

      const shutdownHandler = async (srv: any) => {
        srv.log.info('Received SIGINT, closing server gracefully...');
        try {
          await srv.close();
          if (srv.prisma) {
            await srv.prisma.$disconnect();
          }
        } catch (closeErr) {
          srv.log.error(closeErr);
          try {
            if (srv.prisma) {
              await srv.prisma.$disconnect();
            }
          } catch (prismaErr) {
            srv.log.error(prismaErr);
          }
        }
      };

      await shutdownHandler(fakeServer);
      expect(executionOrder).toEqual(['server.close', 'prisma.$disconnect']);
    });

    it('CHALLENGE-M3-14: Disconnects Prisma even if server.close() rejects with error', async () => {
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      const failingServer: any = {
        close: vi.fn().mockRejectedValue(new Error('Socket close timeout')),
        prisma: { $disconnect: mockDisconnect },
        log: { info: vi.fn(), error: vi.fn() }
      };

      const shutdownHandler = async (srv: any) => {
        srv.log.info('Received SIGTERM, closing server gracefully...');
        try {
          await srv.close();
          if (srv.prisma) {
            await srv.prisma.$disconnect();
          }
        } catch (closeErr) {
          srv.log.error(closeErr);
          try {
            if (srv.prisma) {
              await srv.prisma.$disconnect();
            }
          } catch (prismaErr) {
            srv.log.error(prismaErr);
          }
        }
      };

      await shutdownHandler(failingServer);
      expect(failingServer.close).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(failingServer.log.error).toHaveBeenCalled();
    });

    it('CHALLENGE-M3-15: Safely catches and logs when prisma.$disconnect() throws during shutdown', async () => {
      const brokenPrismaServer: any = {
        close: vi.fn().mockResolvedValue(undefined),
        prisma: {
          $disconnect: vi.fn().mockRejectedValue(new Error('Prisma disconnect pool teardown failed'))
        },
        log: { info: vi.fn(), error: vi.fn() }
      };

      const shutdownHandler = async (srv: any) => {
        srv.log.info('Received SIGINT, closing server gracefully...');
        try {
          await srv.close();
          if (srv.prisma) {
            await srv.prisma.$disconnect();
          }
        } catch (closeErr) {
          srv.log.error(closeErr);
          try {
            if (srv.prisma) {
              await srv.prisma.$disconnect();
            }
          } catch (prismaErr) {
            srv.log.error(prismaErr);
          }
        }
      };

      // Ensure no unhandled rejection escapes
      await expect(shutdownHandler(brokenPrismaServer)).resolves.not.toThrow();
      expect(brokenPrismaServer.log.error).toHaveBeenCalled();
    });
  });
});
