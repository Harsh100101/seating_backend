import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, seed } from '../prisma/seed.js';

describe('Milestone 2 Integration: Units & Plants CRUD and Unit 2 Static Invariant', () => {
  let server: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
    await seed(mockPrisma);
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

  // ==========================================
  // Section 1: Units CRUD (/api/units)
  // ==========================================
  describe('Units CRUD (/api/units)', () => {
    it('UNIT-01: GET /api/units returns list of seeded units and counts', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      expect(res.statusCode).toBe(200);
      const units = res.json();
      expect(Array.isArray(units)).toBe(true);
      expect(units.length).toBeGreaterThanOrEqual(5);

      const unit2 = units.find((u: any) => u.code === 'UNIT-2');
      expect(unit2).toBeDefined();
      expect(unit2.name).toBe('Unit 2');
      expect(unit2._count?.plants).toBeGreaterThanOrEqual(1);
    });

    it('UNIT-02: GET /api/units requires authentication', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/units'
      });
      expect(res.statusCode).toBe(401);
    });

    it('UNIT-03: POST /api/units creates unit and logs audit record', async () => {
      const payload = {
        name: 'Unit 99 Advanced Engineering',
        code: 'UNIT-99',
        location: 'Sector 7 Industrial Area',
        description: 'New manufacturing and R&D division'
      };

      const res = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload
      });
      expect(res.statusCode).toBe(201);
      const unit = res.json();
      expect(unit.name).toBe(payload.name);
      expect(unit.code).toBe(payload.code);
      expect(unit.location).toBe(payload.location);
      expect(unit.id).toBeDefined();

      // Verify fetch by ID
      const getRes = await server.inject({
        method: 'GET',
        url: `/api/units/${unit.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(unit.id);
    });

    it('UNIT-04: POST /api/units rejects duplicate code with 409', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Another Unit 1',
          code: 'UNIT-1',
          location: 'Building A'
        }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/code already exists/i);
    });

    it('UNIT-05: POST /api/units rejects duplicate name with 409', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Unit 1',
          code: 'UNIT-1-UNIQUE',
          location: 'Building B'
        }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/name already exists/i);
    });

    it('UNIT-06: PUT /api/units/:id updates unit and prevents conflicting code', async () => {
      // Create a unit first
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Delta', code: 'UNIT-DELTA', location: 'Campus East' }
      });
      const unit = createRes.json();

      // Update unit
      const updateRes = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit.id}`,
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Delta Renamed', location: 'Campus West' }
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().name).toBe('Unit Delta Renamed');
      expect(updateRes.json().location).toBe('Campus West');

      // Attempt conflicting code update
      const conflictRes = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit.id}`,
        headers: { cookie: sessionCookie },
        payload: { code: 'UNIT-2' }
      });
      expect(conflictRes.statusCode).toBe(409);
    });

    it('UNIT-07: DELETE /api/units/:id rejects removal when business dependencies exist', async () => {
      // 1. Create unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit To Delete Fully', code: 'UNIT-DEL-FULL' }
      });
      const unitId = unitRes.json().id;

      // 2. Create plant under unit
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Plant Under Unit Del', code: 'PLT-DEL-FULL' }
      });
      const plantId = plantRes.json().id;

      // 3. Create building under plant
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId, name: 'Building Under Plant Del', code: 'BLD-DEL-FULL' }
      });
      const bldId = bldRes.json().id;

      // 4. Create floor under building
      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, name: 'Floor Under Building Del', floorNumber: 1 }
      });
      const flrId = flrRes.json().id;

      // 5. Create seat on floor
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'U-DEL-S1', x: 20, y: 20, type: 'STANDARD_DESK' }]
        }
      });
      const seatId = layoutRes.json().seats[0].id;

      // 6. Create department and employee
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Cascade Dept', code: 'U-CASC-D', colorHex: '#8B5CF6' }
      });
      const deptId = deptRes.json().id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          departmentId: deptId,
          employeeCode: 'EMP-UDEL-1',
          fullName: 'Alice UnitCascader',
          email: 'alice.unitdel@company.com'
        }
      });
      const empId = empRes.json().id;

      // 7. Assign seat to employee
      const asgnRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empId }
      });
      expect(asgnRes.statusCode).toBe(200);

      // Verify employee is seated
      const checkEmpBefore = await server.inject({
        method: 'GET',
        url: `/api/employees/${empId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkEmpBefore.statusCode).toBe(200);
      expect(checkEmpBefore.json().seat).toBeDefined();
      expect(checkEmpBefore.json().seat.id).toBe(seatId);

      // 8. Delete unit
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().code).toBe('DEPENDENCIES_EXIST');
      return;

      // 9. Assert unit is gone
      const checkUnit = await server.inject({
        method: 'GET',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkUnit.statusCode).toBe(404);

      // 10. Assert plant is gone
      const checkPlant = await server.inject({
        method: 'GET',
        url: `/api/plants/${plantId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkPlant.statusCode).toBe(404);

      // 11. Assert building is gone
      const checkBld = await server.inject({
        method: 'GET',
        url: `/api/buildings/${bldId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkBld.statusCode).toBe(404);

      // 12. Assert floor is gone
      const checkFlr = await server.inject({
        method: 'GET',
        url: `/api/floors/${flrId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkFlr.statusCode).toBe(404);

      // 13. Assert seat is gone
      const checkSeat = await server.inject({
        method: 'GET',
        url: `/api/seats/${seatId}`,
        headers: { cookie: sessionCookie }
      });
      expect([404, 400]).toContain(checkSeat.statusCode);

      // 14. Assert employee is unseated (seat: null)
      const checkEmpAfter = await server.inject({
        method: 'GET',
        url: `/api/employees/${empId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkEmpAfter.statusCode).toBe(200);
      expect(checkEmpAfter.json().seat).toBeNull();
    });
  });

  // ==========================================
  // Section 2: Plants CRUD (/api/plants)
  // ==========================================
  describe('Plants CRUD (/api/plants)', () => {
    it('PLANT-01: GET /api/plants returns plants and filters by unitId', async () => {
      // Get all plants
      const allRes = await server.inject({
        method: 'GET',
        url: '/api/plants',
        headers: { cookie: sessionCookie }
      });
      expect(allRes.statusCode).toBe(200);
      const allPlants = allRes.json();
      expect(Array.isArray(allPlants)).toBe(true);
      expect(allPlants.length).toBeGreaterThanOrEqual(1);

      // Get Unit 2 ID
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');

      // Filter by unitId
      const filteredRes = await server.inject({
        method: 'GET',
        url: `/api/plants?unitId=${unit2.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(filteredRes.statusCode).toBe(200);
      const filteredPlants = filteredRes.json();
      expect(filteredPlants.length).toBeGreaterThanOrEqual(1);
      expect(filteredPlants.every((p: any) => p.unitId === unit2.id)).toBe(true);
    });

    it('PLANT-02: POST /api/plants creates plant under valid unit', async () => {
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit1 = unitsRes.json().find((u: any) => u.code === 'UNIT-1');

      const createRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit1.id,
          name: 'Unit 1 Assembly Plant',
          code: 'PLT-U1-01',
          type: 'Assembly',
          location: 'Bay 4'
        }
      });
      expect(createRes.statusCode).toBe(201);
      const plant = createRes.json();
      expect(plant.name).toBe('Unit 1 Assembly Plant');
      expect(plant.code).toBe('PLT-U1-01');
      expect(plant.unitId).toBe(unit1.id);
    });

    it('PLANT-03: POST /api/plants returns 404 for nonexistent unitId', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: 'non-existent-unit-id-123456',
          name: 'Ghost Plant',
          code: 'PLT-GHOST'
        }
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toMatch(/unit not found/i);
    });

    it('PLANT-04: POST /api/plants enforces compound unique [unitId, code] with 409', async () => {
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');

      // Attempt to create plant with same code as seeded plant (PLT-U2-01) under Unit 2
      const res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit2.id,
          name: 'Duplicate Plant Code',
          code: 'PLT-U2-01'
        }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/already exists in this unit/i);
    });

    it('PLANT-05: PUT /api/plants/:id updates plant and prevents duplicate code in same unit', async () => {
      const unitsRes = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      const unit2 = unitsRes.json().find((u: any) => u.code === 'UNIT-2');

      // Create a second plant under Unit 2
      const p2Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId: unit2.id,
          name: 'Plant Beta',
          code: 'PLT-U2-02'
        }
      });
      const p2 = p2Res.json();

      // Update name
      const updRes = await server.inject({
        method: 'PUT',
        url: `/api/plants/${p2.id}`,
        headers: { cookie: sessionCookie },
        payload: { name: 'Plant Beta Renovated' }
      });
      expect(updRes.statusCode).toBe(200);
      expect(updRes.json().name).toBe('Plant Beta Renovated');

      // Try updating code to PLT-U2-01 (conflict)
      const conflictRes = await server.inject({
        method: 'PUT',
        url: `/api/plants/${p2.id}`,
        headers: { cookie: sessionCookie },
        payload: { code: 'PLT-U2-01' }
      });
      expect(conflictRes.statusCode).toBe(409);
    });

    it('PLANT-08: DELETE /api/plants/:id cascades through buildings, floors, seats and unseats occupants without deleting parent Unit', async () => {
      // 1. Create unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Parent Unit for Plant Del', code: 'UNIT-PAR-PLTDEL' }
      });
      const unitId = unitRes.json().id;

      // 2. Create plant
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Plant Cascading Delete', code: 'PLT-CASC-DEL' }
      });
      const plantId = plantRes.json().id;

      // 3. Create building under plant
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId, name: 'Plant Del Building', code: 'BLD-P-DEL' }
      });
      const bldId = bldRes.json().id;

      // 4. Create floor under building
      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, name: 'Plant Del Floor', floorNumber: 1 }
      });
      const flrId = flrRes.json().id;

      // 5. Create seat on floor
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'P-DEL-S1', x: 30, y: 30, type: 'STANDARD_DESK' }]
        }
      });
      const seatId = layoutRes.json().seats[0].id;

      // 6. Create department and employee
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Plant Cascade Dept', code: 'P-CASC-D', colorHex: '#06B6D4' }
      });
      const deptId = deptRes.json().id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          departmentId: deptId,
          employeeCode: 'EMP-PDEL-1',
          fullName: 'Bob PlantCascader',
          email: 'bob.plantdel@company.com'
        }
      });
      const empId = empRes.json().id;

      // 7. Assign seat to employee
      const asgnRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empId }
      });
      expect(asgnRes.statusCode).toBe(200);

      // Verify employee is seated
      const checkEmpBefore = await server.inject({
        method: 'GET',
        url: `/api/employees/${empId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkEmpBefore.statusCode).toBe(200);
      expect(checkEmpBefore.json().seat).toBeDefined();
      expect(checkEmpBefore.json().seat.id).toBe(seatId);

      // 8. Delete plant
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${plantId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().success).toBe(true);

      // 9. Assert plant is gone
      const checkPlant = await server.inject({
        method: 'GET',
        url: `/api/plants/${plantId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkPlant.statusCode).toBe(404);

      // 10. Assert building is gone
      const checkBld = await server.inject({
        method: 'GET',
        url: `/api/buildings/${bldId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkBld.statusCode).toBe(404);

      // 11. Assert floor is gone
      const checkFlr = await server.inject({
        method: 'GET',
        url: `/api/floors/${flrId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkFlr.statusCode).toBe(404);

      // 12. Assert seat is gone
      const checkSeat = await server.inject({
        method: 'GET',
        url: `/api/seats/${seatId}`,
        headers: { cookie: sessionCookie }
      });
      expect([404, 400]).toContain(checkSeat.statusCode);

      // 13. Assert parent Unit is STILL 200 OK
      const checkUnit = await server.inject({
        method: 'GET',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkUnit.statusCode).toBe(200);
      expect(checkUnit.json().name).toBe('Parent Unit for Plant Del');

      // 14. Assert occupant is unseated (seat: null)
      const checkEmpAfter = await server.inject({
        method: 'GET',
        url: `/api/employees/${empId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkEmpAfter.statusCode).toBe(200);
      expect(checkEmpAfter.json().seat).toBeNull();
    });
  });

  // ==========================================
  // Section 3: Unit 2 Static Workstation Invariant Guard
  // ==========================================
  describe('Unit 2 Static Workstation Invariant Guard', () => {
    it('U2-GUARD-01: Auto-release attempt on Unit 2 seat returns 403 Forbidden', async () => {
      // Find Unit 2 -> Plant 1 -> Building -> Floor 1 -> Seat
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

      // Create building under Unit 2 Plant 1
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: {
          plantId: plant1.id,
          name: 'Manufacturing Wing 1',
          code: 'BLD-MW1'
        }
      });
      const bldId = bldRes.json().id;

      // Create floor
      const flRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: {
          buildingId: bldId,
          floorNumber: 1,
          name: 'Shop Floor 1'
        }
      });
      const flId = flRes.json().id;

      // Create department & employee
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Assembly Operations', code: 'ASY', colorHex: '#10B981' }
      });
      const deptId = deptRes.json().id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          departmentId: deptId,
          employeeCode: 'OP-001',
          fullName: 'Jane Operator',
          email: 'jane.operator@company.com'
        }
      });
      const empId = empRes.json().id;

      // Create seat and assign employee
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ x: 100, y: 100, label: 'U2-F1-01', type: 'STANDARD_DESK' }]
        }
      });
      const seat = layoutRes.json().seats[0];

      // Assign Jane Operator
      const asgnRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empId }
      });
      expect(asgnRes.statusCode).toBe(200);

      // Attempt automated unassign with x-auto-release header
      const autoReleaseRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(autoReleaseRes.statusCode).toBe(403);
      expect(autoReleaseRes.json().message).toMatch(/Unit 2.*static.*cannot be released by automated/i);

      // Attempt automated unassign with x-cron header
      const cronReleaseRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-cron': 'true'
        }
      });
      expect(cronReleaseRes.statusCode).toBe(403);

      // Attempt automated unassign with payload body { isAutoRelease: true }
      const bodyAutoRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/unassign`,
        headers: { cookie: sessionCookie },
        payload: { isAutoRelease: true }
      });
      expect(bodyAutoRes.statusCode).toBe(403);

      // Attempt unassign without authenticated admin session
      const unauthRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/unassign`
      });
      expect(unauthRes.statusCode).toBe(401);

      // Legitimate Admin unassign MUST succeed
      const adminUnassignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat.id}/unassign`,
        headers: { cookie: sessionCookie }
      });
      expect(adminUnassignRes.statusCode).toBe(200);
      expect(adminUnassignRes.json().employeeId).toBeNull();
    });
  });
});
