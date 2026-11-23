import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, seed } from '../prisma/seed.js';

describe('CHALLENGER Empirical Verification Suite - Milestone 2', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma);
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Authenticate admin session
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;
    expect(sessionCookie).toBeDefined();
  });

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // 1. Unit CRUD Endpoints and Uniqueness
  // =========================================================================
  describe('1. Unit CRUD endpoints and uniqueness', () => {
    it('EMP-UNIT-01: Verifies all 5 seeded units exist with expected names and codes', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      expect(res.statusCode).toBe(200);
      const units = res.json();
      expect(Array.isArray(units)).toBe(true);
      expect(units.length).toBeGreaterThanOrEqual(5);

      const codes = units.map((u: any) => u.code);
      expect(codes).toContain('UNIT-1');
      expect(codes).toContain('UNIT-2');
      expect(codes).toContain('UNIT-3');
      expect(codes).toContain('UNIT-4');
      expect(codes).toContain('UNIT-5');
    });

    it('EMP-UNIT-02: Rejects duplicate unit name with 409 (exact and case-insensitive)', async () => {
      // Exact duplicate
      const exactRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Unit 1',
          code: 'UNIT-NEW-01'
        }
      });
      expect(exactRes.statusCode).toBe(409);
      expect(exactRes.json().message).toMatch(/unit name already exists/i);

      // Case-insensitive duplicate ("unit 1" vs "Unit 1")
      const lowerRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'unit 1',
          code: 'UNIT-NEW-02'
        }
      });
      expect(lowerRes.statusCode).toBe(409);
      expect(lowerRes.json().message).toMatch(/unit name already exists/i);

      // Uppercase duplicate ("UNIT 3" vs "Unit 3")
      const upperRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'UNIT 3',
          code: 'UNIT-NEW-03'
        }
      });
      expect(upperRes.statusCode).toBe(409);
      expect(upperRes.json().message).toMatch(/unit name already exists/i);
    });

    it('EMP-UNIT-03: Rejects duplicate unit code with 409 (exact and case-normalized)', async () => {
      // Duplicate code UNIT-2
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Unit Novel Alpha',
          code: 'UNIT-2'
        }
      });
      expect(res1.statusCode).toBe(409);
      expect(res1.json().message).toMatch(/unit code already exists/i);

      // Lowercase code that normalizes to existing UNIT-3
      const res2 = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Unit Novel Beta',
          code: 'unit-3'
        }
      });
      expect(res2.statusCode).toBe(409);
      expect(res2.json().message).toMatch(/unit code already exists/i);
    });

    it('EMP-UNIT-04: PUT /api/units/:id permits self-updates without 409 false-positive', async () => {
      // Fetch Unit 1
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit1 = listRes.json().find((u: any) => u.code === 'UNIT-1');

      // Update location while keeping same name and code
      const updateRes = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit1.id}`,
        headers: { cookie: sessionCookie },
        payload: {
          name: unit1.name,
          code: unit1.code,
          location: 'Industrial Zone North'
        }
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().location).toBe('Industrial Zone North');
      expect(updateRes.json().name).toBe('Unit 1');
      expect(updateRes.json().code).toBe('UNIT-1');
    });

    it('EMP-UNIT-05: PUT /api/units/:id rejects conflict with another unit name/code with 409', async () => {
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit1 = listRes.json().find((u: any) => u.code === 'UNIT-1');

      // Conflict with Unit 2 name
      const nameConflictRes = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit1.id}`,
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit 2' }
      });
      expect(nameConflictRes.statusCode).toBe(409);

      // Conflict with Unit 2 code
      const codeConflictRes = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit1.id}`,
        headers: { cookie: sessionCookie },
        payload: { code: 'UNIT-2' }
      });
      expect(codeConflictRes.statusCode).toBe(409);
    });
  });

  // =========================================================================
  // 2. Plant CRUD Endpoints and Scoping
  // =========================================================================
  describe('2. Plant CRUD endpoints and scoping', () => {
    it('EMP-PLANT-01: Rejects duplicate plant code under the SAME unit with 409', async () => {
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');

      // PLT-U2-01 was seeded under Unit 2
      const res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit2.id,
          name: 'Another Plant Under Unit 2',
          code: 'PLT-U2-01'
        }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/already exists in this unit/i);
    });

    it('EMP-PLANT-02: Allows the SAME plant code under DIFFERENT units', async () => {
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit1 = unitsRes.json().find((u: any) => u.code === 'UNIT-1');
      const unit3 = unitsRes.json().find((u: any) => u.code === 'UNIT-3');
      const unit4 = unitsRes.json().find((u: any) => u.code === 'UNIT-4');

      const sharedCode = 'PLT-COMMON-01';

      // 1. Create plant under Unit 1
      const resU1 = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit1.id,
          name: 'Unit 1 Standard Plant',
          code: sharedCode
        }
      });
      expect(resU1.statusCode).toBe(201);
      const plantU1 = resU1.json();
      expect(plantU1.code).toBe(sharedCode);
      expect(plantU1.unitId).toBe(unit1.id);

      // 2. Create plant with the SAME code under Unit 3 -> MUST SUCCEED (201)
      const resU3 = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit3.id,
          name: 'Unit 3 Standard Plant',
          code: sharedCode
        }
      });
      expect(resU3.statusCode).toBe(201);
      const plantU3 = resU3.json();
      expect(plantU3.code).toBe(sharedCode);
      expect(plantU3.unitId).toBe(unit3.id);
      expect(plantU3.id).not.toBe(plantU1.id);

      // 3. Create plant with the SAME code under Unit 4 -> MUST SUCCEED (201)
      const resU4 = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit4.id,
          name: 'Unit 4 Standard Plant',
          code: sharedCode
        }
      });
      expect(resU4.statusCode).toBe(201);
      const plantU4 = resU4.json();
      expect(plantU4.code).toBe(sharedCode);
      expect(plantU4.unitId).toBe(unit4.id);

      // 4. Attempting to create under Unit 1 AGAIN with same code -> MUST FAIL (409)
      const resU1Dup = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit1.id,
          name: 'Unit 1 Duplicate',
          code: sharedCode
        }
      });
      expect(resU1Dup.statusCode).toBe(409);
    });

    it('EMP-PLANT-03: Filtering plants by unitId returns only plants for that unit', async () => {
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');

      const res = await server.inject({
        method: 'GET',
        url: `/api/plants?unitId=${unit2.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(res.statusCode).toBe(200);
      const plants = res.json();
      expect(plants.length).toBeGreaterThanOrEqual(1);
      for (const p of plants) {
        expect(p.unitId).toBe(unit2.id);
      }
    });

    it('EMP-PLANT-04: Rejects plant creation with non-existent unitId with 404', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: 'non-existent-unit-999',
          name: 'Orphan Plant',
          code: 'PLT-ORPHAN'
        }
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toMatch(/unit not found/i);
    });
  });

  // =========================================================================
  // 3. Unit 2 Static Assignment Integrity Invariant
  // =========================================================================
  describe('3. Unit 2 static assignment integrity invariant', () => {
    let u2SeatId: string;
    let employeeId: string;

    beforeEach(async () => {
      // Look up seeded Unit 2 -> Plant 1 -> Building -> Floor 1
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');
      expect(unit2).toBeDefined();

      const plantsRes = await server.inject({
        method: 'GET',
        url: `/api/plants?unitId=${unit2.id}`,
        headers: { cookie: sessionCookie }
      });
      const plant1 = plantsRes.json()[0];
      expect(plant1).toBeDefined();

      const bldRes = await server.inject({
        method: 'GET',
        url: `/api/buildings?plantId=${plant1.id}`,
        headers: { cookie: sessionCookie }
      });
      const building = bldRes.json()[0];
      expect(building).toBeDefined();

      const flrRes = await server.inject({
        method: 'GET',
        url: `/api/floors?buildingId=${building.id}`,
        headers: { cookie: sessionCookie }
      });
      const floor1 = flrRes.json().find((f: any) => f.floorNumber === 1);
      expect(floor1).toBeDefined();

      // Create department and employee
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Manufacturing Operations', code: 'MOP', colorHex: '#EF4444' }
      });
      const deptId = deptRes.json().id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          departmentId: deptId,
          employeeCode: 'EMP-M2-001',
          fullName: 'Test Operator',
          email: 'operator@factory.com'
        }
      });
      employeeId = empRes.json().id;

      // Add seat to floor 1
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${floor1.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ x: 50, y: 50, label: 'U2-F1-CHALLENGE', type: 'STANDARD_DESK' }]
        }
      });
      const seat = layoutRes.json().seats[0];
      u2SeatId = seat.id;

      // Assign seat
      const assignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId }
      });
      expect(assignRes.statusCode).toBe(200);
    });

    it('EMP-U2-INV-01: POST /api/seats/:id/unassign with x-auto-release: true returns 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
      expect(res.json().message).toMatch(/Unit 2.*static.*cannot be released by automated/i);
    });

    it('EMP-U2-INV-02: PATCH /api/seats/:id/unassign with x-auto-release: true returns 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
      expect(res.json().message).toMatch(/Unit 2.*static.*cannot be released by automated/i);
    });

    it('EMP-U2-INV-03: POST /api/seats/:id/unassign with isAutoRelease: true in body returns 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: { cookie: sessionCookie },
        payload: { isAutoRelease: true }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
      expect(res.json().message).toMatch(/Unit 2.*static.*cannot be released by automated/i);
    });

    it('EMP-U2-INV-04: POST /api/seats/:id/unassign with automated: true or x-cron: true returns 403 Forbidden', async () => {
      // Test x-cron header
      const cronRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-cron': 'true'
        }
      });
      expect(cronRes.statusCode).toBe(403);

      // Test automated: true body
      const autoRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: { cookie: sessionCookie },
        payload: { automated: true }
      });
      expect(autoRes.statusCode).toBe(403);
    });

    it('EMP-U2-INV-05: Unauthenticated unassignment attempt returns 401 Unauthorized', async () => {
      // POST without cookie
      const postRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`
      });
      expect(postRes.statusCode).toBe(401);
      expect(postRes.json().error).toBe('Unauthorized');

      // PATCH without cookie
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${u2SeatId}/unassign`
      });
      expect(patchRes.statusCode).toBe(401);
      expect(patchRes.json().error).toBe('Unauthorized');

      // Even with auto-release header without auth -> 401
      const unauthAutoRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: { 'x-auto-release': 'true' }
      });
      expect(unauthAutoRes.statusCode).toBe(401);
    });

    it('EMP-U2-INV-06: Unauthenticated assignment attempt on Unit 2 returns 401 Unauthorized', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/assign`,
        payload: { employeeId }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('EMP-U2-INV-07: Legitimate authenticated Admin unassign succeeds (200) without automated flags', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${u2SeatId}/unassign`,
        headers: { cookie: sessionCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBeNull();
    });

    it('EMP-U2-INV-08: Non-Unit 2 seat permits automated unassignment (scoping invariant check)', async () => {
      // Create hierarchy under Unit 1: Plant -> Building -> Floor -> Seat
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit1 = unitsRes.json().find((u: any) => u.code === 'UNIT-1');

      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unit1.id, name: 'Unit 1 Plant A', code: 'PLT-U1-AUTOTEST' }
      });
      const plantId = plantRes.json().id;

      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId, name: 'Unit 1 Office Building', code: 'BLD-U1-AUTOTEST' }
      });
      const bldId = bldRes.json().id;

      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, floorNumber: 1, name: 'U1 Floor 1' }
      });
      const floorId = flrRes.json().id;

      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${floorId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ x: 10, y: 10, label: 'U1-SEAT-AUTO', type: 'HOT_DESK' }]
        }
      });
      const u1Seat = layoutRes.json().seats[0];

      // Assign employee to U1 seat
      await server.inject({
        method: 'POST',
        url: `/api/seats/${u1Seat.id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId }
      });

      // Automated unassign on Unit 1 seat MUST NOT be blocked by Unit 2 invariant!
      const unassignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${u1Seat.id}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(unassignRes.statusCode).toBe(200);
      expect(unassignRes.json().employeeId).toBeNull();
    });
  });

  // =========================================================================
  // 4. CSV Export Headers
  // =========================================================================
  describe('4. CSV export headers and data integrity', () => {
    it('EMP-CSV-01: GET /api/reports/export-csv returns 200 with all 12 exact headers', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/reports/export-csv',
        headers: { cookie: sessionCookie }
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename="seating-allocations-.*\.csv"/);

      const csvContent = res.body;
      const lines = csvContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const headerLine = lines[0];
      const expectedHeaderLine =
        'Unit Name,Plant Name,Building Name,Floor Name,Seat Label,Seat Type,Seat Status,Employee Code,Employee Name,Employee Email,Department Code,Department Name';
      expect(headerLine).toBe(expectedHeaderLine);

      const headers = headerLine.split(',');
      expect(headers).toHaveLength(12);
      expect(headers).toEqual([
        'Unit Name',
        'Plant Name',
        'Building Name',
        'Floor Name',
        'Seat Label',
        'Seat Type',
        'Seat Status',
        'Employee Code',
        'Employee Name',
        'Employee Email',
        'Department Code',
        'Department Name'
      ]);
    });

    it('EMP-CSV-02: Exported rows correctly resolve Unit, Plant, Building, Floor hierarchy for seats', async () => {
      // 1. Fetch seeded Unit 2 hierarchy
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');

      const plantsRes = await server.inject({
        method: 'GET',
        url: `/api/plants?unitId=${unit2.id}`,
        headers: { cookie: sessionCookie }
      });
      const plant1 = plantsRes.json()[0];

      const bldRes = await server.inject({
        method: 'GET',
        url: `/api/buildings?plantId=${plant1.id}`,
        headers: { cookie: sessionCookie }
      });
      const building = bldRes.json()[0];

      const flrRes = await server.inject({
        method: 'GET',
        url: `/api/floors?buildingId=${building.id}`,
        headers: { cookie: sessionCookie }
      });
      const floor2 = flrRes.json().find((f: any) => f.floorNumber === 2);

      // Create employee
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Quality Control', code: 'QC', colorHex: '#3B82F6' }
      });
      const dept = deptRes.json();

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          departmentId: dept.id,
          employeeCode: 'QC-777',
          fullName: 'Alice Inspector',
          email: 'alice.inspector@company.com'
        }
      });
      const emp = empRes.json();

      // Put a seat on Floor 2 and assign Alice
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${floor2.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ x: 30, y: 30, label: 'U2-FL2-QC01', type: 'EXECUTIVE_DESK' }]
        }
      });
      const seat = layoutRes.json().seats[0];

      await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: emp.id }
      });

      // Export CSV
      const csvRes = await server.inject({
        method: 'GET',
        url: '/api/reports/export-csv',
        headers: { cookie: sessionCookie }
      });
      expect(csvRes.statusCode).toBe(200);

      const rows = csvRes.body.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const aliceRow = rows.find((r) => r.includes('U2-FL2-QC01'));
      expect(aliceRow).toBeDefined();

      // Check fields in CSV row
      expect(aliceRow).toContain('"Unit 2"');
      expect(aliceRow).toContain('"Unit 2 - Plant 1"');
      expect(aliceRow.includes('"Santosh Bhavan"') || aliceRow.includes('"Unit 2 - Main Building"')).toBe(true);
      expect(aliceRow).toContain('"Floor 2"');
      expect(aliceRow).toContain('"U2-FL2-QC01"');
      expect(aliceRow).toContain('"EXECUTIVE_DESK"');
      expect(aliceRow).toContain('"QC-777"');
      expect(aliceRow).toContain('"Alice Inspector"');
      expect(aliceRow).toContain('"alice.inspector@company.com"');
      expect(aliceRow).toContain('"QC"');
      expect(aliceRow).toContain('"Quality Control"');
    });
  });
});
