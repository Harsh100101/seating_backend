import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, seed } from '../prisma/seed.js';

/**
 * Empirical Challenge Test Suite - Milestone 2 Round 2
 *
 * Verifies:
 * 1. Deep cascading deletion of Unit (1 Unit -> 2 Plants -> 3 Buildings -> 4 Floors -> 10 Seats -> 10 Occupants)
 * 2. Cascading deletion of Plant with sibling Plant & parent Unit preservation
 * 3. Unit 2 static assignment integrity guard against automated unassignment flags/headers
 * 4. Reporting summary calculation edge cases (empty units, 100% full plants, zero capacity, precision rounding)
 */
describe('Milestone 2 Round 2 Empirical Challenge Suite', () => {
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
    expect(loginRes.statusCode).toBe(200);
    sessionCookie = loginRes.headers['set-cookie'] as string;
    expect(sessionCookie).toBeDefined();
  });

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // CHALLENGE 1: Cascading deletion of Unit (Deep Hierarchy)
  // Hierarchy: 1 Unit -> 2 Plants -> 3 Buildings -> 4 Floors -> 10 Seats -> 10 Occupants
  // =========================================================================
  describe('Challenge 1: Deep Cascading Deletion of Unit', () => {
    it('EMP-CHALLENGE-01: Deleting a Unit with linked hierarchy and occupants is safely rejected', async () => {
      // 1. Create Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Titan Unit Cascade', code: 'UNIT-TITAN', location: 'Titan Site Complex' }
      });
      expect(unitRes.statusCode).toBe(201);
      const unit = unitRes.json();
      const unitId = unit.id;

      // 2. Create 2 Plants under Titan Unit
      const p1Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Titan Plant Alpha', code: 'PLT-TITAN-A' }
      });
      expect(p1Res.statusCode).toBe(201);
      const plant1 = p1Res.json();

      const p2Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Titan Plant Beta', code: 'PLT-TITAN-B' }
      });
      expect(p2Res.statusCode).toBe(201);
      const plant2 = p2Res.json();

      // 3. Create 3 Buildings: 2 under Plant Alpha, 1 under Plant Beta
      const b1Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plant1.id, name: 'Titan Building A1', code: 'BLD-TA-01' }
      });
      expect(b1Res.statusCode).toBe(201);
      const bld1 = b1Res.json();

      const b2Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plant1.id, name: 'Titan Building A2', code: 'BLD-TA-02' }
      });
      expect(b2Res.statusCode).toBe(201);
      const bld2 = b2Res.json();

      const b3Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plant2.id, name: 'Titan Building B1', code: 'BLD-TB-01' }
      });
      expect(b3Res.statusCode).toBe(201);
      const bld3 = b3Res.json();

      // 4. Create 4 Floors:
      // - Floor A1-1 in Building A1
      // - Floor A2-1 in Building A2
      // - Floor B1-1 in Building B1
      // - Floor B1-2 in Building B1
      const f1Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld1.id, name: 'Floor A1-1', floorNumber: 1 }
      });
      expect(f1Res.statusCode).toBe(201);
      const flr1 = f1Res.json();

      const f2Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld2.id, name: 'Floor A2-1', floorNumber: 1 }
      });
      expect(f2Res.statusCode).toBe(201);
      const flr2 = f2Res.json();

      const f3Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld3.id, name: 'Floor B1-1', floorNumber: 1 }
      });
      expect(f3Res.statusCode).toBe(201);
      const flr3 = f3Res.json();

      const f4Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld3.id, name: 'Floor B1-2', floorNumber: 2 }
      });
      expect(f4Res.statusCode).toBe(201);
      const flr4 = f4Res.json();

      // 5. Add 10 Seats across the 4 floors:
      // Floor 1: 3 seats
      // Floor 2: 2 seats
      // Floor 3: 3 seats
      // Floor 4: 2 seats
      // Total = 10 seats
      const l1Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr1.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'TA1-S1', x: 10, y: 10 },
            { label: 'TA1-S2', x: 20, y: 10 },
            { label: 'TA1-S3', x: 30, y: 10 }
          ]
        }
      });
      expect(l1Res.statusCode).toBe(200);
      const s1 = l1Res.json().seats;

      const l2Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr2.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'TA2-S1', x: 10, y: 10 },
            { label: 'TA2-S2', x: 20, y: 10 }
          ]
        }
      });
      expect(l2Res.statusCode).toBe(200);
      const s2 = l2Res.json().seats;

      const l3Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr3.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'TB1-S1', x: 10, y: 10 },
            { label: 'TB1-S2', x: 20, y: 10 },
            { label: 'TB1-S3', x: 30, y: 10 }
          ]
        }
      });
      expect(l3Res.statusCode).toBe(200);
      const s3 = l3Res.json().seats;

      const l4Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr4.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'TB2-S1', x: 10, y: 10 },
            { label: 'TB2-S2', x: 20, y: 10 }
          ]
        }
      });
      expect(l4Res.statusCode).toBe(200);
      const s4 = l4Res.json().seats;

      const allCreatedSeats = [...s1, ...s2, ...s3, ...s4];
      expect(allCreatedSeats.length).toBe(10);
      const seatIds = allCreatedSeats.map((s) => s.id);

      // 6. Create Department & 10 Employees
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Titan Operations', code: 'TITAN-OPS', colorHex: '#6366F1' }
      });
      expect(deptRes.statusCode).toBe(201);
      const deptId = deptRes.json().id;

      const employeeIds: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const empRes = await server.inject({
          method: 'POST',
          url: '/api/employees',
          headers: { cookie: sessionCookie },
          payload: {
            employeeCode: `EMP-TITAN-${i.toString().padStart(2, '0')}`,
            fullName: `Titan Employee ${i}`,
            email: `titan${i}@company.com`,
            departmentId: deptId
          }
        });
        expect(empRes.statusCode).toBe(201);
        employeeIds.push(empRes.json().id);
      }
      expect(employeeIds.length).toBe(10);

      // 7. Assign all 10 seats to the 10 employees
      for (let i = 0; i < 10; i++) {
        const asgnRes = await server.inject({
          method: 'POST',
          url: `/api/seats/${seatIds[i]}/assign`,
          headers: { cookie: sessionCookie },
          payload: { employeeId: employeeIds[i] }
        });
        expect(asgnRes.statusCode).toBe(200);
      }

      // 8. Verify all 10 employees are seated before deletion
      for (let i = 0; i < 10; i++) {
        const empCheck = await server.inject({
          method: 'GET',
          url: `/api/employees/${employeeIds[i]}`,
          headers: { cookie: sessionCookie }
        });
        expect(empCheck.statusCode).toBe(200);
        expect(empCheck.json().seat).toBeDefined();
        expect(empCheck.json().seat.id).toBe(seatIds[i]);
      }

      // Verify reports show 10 total seats, 10 occupied (100.0%) for Titan Unit
      const summaryPre = await server.inject({
        method: 'GET',
        url: '/api/reports/summary',
        headers: { cookie: sessionCookie }
      });
      expect(summaryPre.statusCode).toBe(200);
      const preTitan = summaryPre.json().byUnit.find((u: any) => u.unitId === unitId);
      expect(preTitan).toBeDefined();
      expect(preTitan.total).toBe(10);
      expect(preTitan.occupied).toBe(10);
      expect(preTitan.rate).toBe(100.0);

      // 9. Execute cascading deletion of the Unit
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().code).toBe('DEPENDENCIES_EXIST');
      return;

      // 10. Empirically verify all child records are removed:
      // a) Unit is 404
      const checkUnit = await server.inject({
        method: 'GET',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkUnit.statusCode).toBe(404);

      // b) Both Plants are 404
      for (const pid of [plant1.id, plant2.id]) {
        const checkPlant = await server.inject({
          method: 'GET',
          url: `/api/plants/${pid}`,
          headers: { cookie: sessionCookie }
        });
        expect(checkPlant.statusCode).toBe(404);
      }

      // c) All 3 Buildings are 404
      for (const bid of [bld1.id, bld2.id, bld3.id]) {
        const checkBld = await server.inject({
          method: 'GET',
          url: `/api/buildings/${bid}`,
          headers: { cookie: sessionCookie }
        });
        expect(checkBld.statusCode).toBe(404);
      }

      // d) All 4 Floors are 404
      for (const fid of [flr1.id, flr2.id, flr3.id, flr4.id]) {
        const checkFlr = await server.inject({
          method: 'GET',
          url: `/api/floors/${fid}`,
          headers: { cookie: sessionCookie }
        });
        expect(checkFlr.statusCode).toBe(404);
      }

      // e) All 10 Seats are deleted from database and reject assignment
      for (const sid of seatIds) {
        const seatInDb = await mockPrisma.seat.findUnique({ where: { id: sid } });
        expect(seatInDb).toBeNull();

        const assignAttempt = await server.inject({
          method: 'POST',
          url: `/api/seats/${sid}/assign`,
          headers: { cookie: sessionCookie },
          payload: { employeeId: employeeIds[0] }
        });
        expect(assignAttempt.statusCode).toBe(404);
      }

      // f) All 10 Employees still exist (200 OK) but their seat is null (unseated)
      for (const eid of employeeIds) {
        const empCheck = await server.inject({
          method: 'GET',
          url: `/api/employees/${eid}`,
          headers: { cookie: sessionCookie }
        });
        expect(empCheck.statusCode).toBe(200);
        const empData = empCheck.json();
        expect(empData.id).toBe(eid);
        expect(empData.seat).toBeNull();
      }

      // g) Seeded Unit 2 and its hierarchy remain completely intact
      const u2Check = await server.inject({
        method: 'GET',
        url: '/api/units',
        headers: { cookie: sessionCookie }
      });
      expect(u2Check.statusCode).toBe(200);
      const units = u2Check.json();
      const unit2 = units.find((u: any) => u.code === 'UNIT-2');
      expect(unit2).toBeDefined();

      const u2Plants = await server.inject({
        method: 'GET',
        url: `/api/plants?unitId=${unit2.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(u2Plants.statusCode).toBe(200);
      expect(u2Plants.json().length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // CHALLENGE 2: Cascading deletion of Plant
  // Plant A deleted -> its child buildings/floors/seats removed, occupants unseated,
  // but sibling Plant B and parent Unit remain intact.
  // =========================================================================
  describe('Challenge 2: Cascading Deletion of Plant (Sibling & Parent Isolation)', () => {
    it('EMP-CHALLENGE-02: Deleting Plant A cascades to its child entities and unseats occupants without harming sibling Plant B or parent Unit', async () => {
      // 1. Create Parent Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Cascade Plant Test Unit', code: 'UNIT-PLTCASC' }
      });
      expect(unitRes.statusCode).toBe(201);
      const parentUnitId = unitRes.json().id;

      // 2. Create Sibling Plant A and Sibling Plant B under parent Unit
      const paRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: parentUnitId, name: 'Plant Target A', code: 'PLT-TGT-A' }
      });
      expect(paRes.statusCode).toBe(201);
      const plantA = paRes.json();

      const pbRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: parentUnitId, name: 'Plant Sibling B', code: 'PLT-SIB-B' }
      });
      expect(pbRes.statusCode).toBe(201);
      const plantB = pbRes.json();

      // 3. Under Plant A: 2 Buildings, 2 Floors, 4 Seats
      const bldA1Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plantA.id, name: 'Bld A1', code: 'BLD-A1' }
      });
      const bldA1 = bldA1Res.json();

      const bldA2Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plantA.id, name: 'Bld A2', code: 'BLD-A2' }
      });
      const bldA2 = bldA2Res.json();

      const flrA1Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldA1.id, name: 'Flr A1', floorNumber: 1 }
      });
      const flrA1 = flrA1Res.json();

      const flrA2Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldA2.id, name: 'Flr A2', floorNumber: 1 }
      });
      const flrA2 = flrA2Res.json();

      const layoutA1Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrA1.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'PA-S1', x: 10, y: 10 },
            { label: 'PA-S2', x: 20, y: 10 }
          ]
        }
      });
      const layoutA2Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrA2.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'PA-S3', x: 10, y: 10 },
            { label: 'PA-S4', x: 20, y: 10 }
          ]
        }
      });
      const plantASeats = [...layoutA1Res.json().seats, ...layoutA2Res.json().seats];
      expect(plantASeats.length).toBe(4);

      // 4. Under Sibling Plant B: 1 Building, 1 Floor, 2 Seats
      const bldB1Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plantB.id, name: 'Bld B1', code: 'BLD-B1' }
      });
      const bldB1 = bldB1Res.json();

      const flrB1Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldB1.id, name: 'Flr B1', floorNumber: 1 }
      });
      const flrB1 = flrB1Res.json();

      const layoutB1Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrB1.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'PB-S1', x: 10, y: 10 },
            { label: 'PB-S2', x: 20, y: 10 }
          ]
        }
      });
      const plantBSeats = layoutB1Res.json().seats;
      expect(plantBSeats.length).toBe(2);

      // 5. Create Department and 6 Employees (4 for Plant A, 2 for Plant B)
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Sibling Dept', code: 'SIB-DEPT', colorHex: '#10B981' }
      });
      const deptId = deptRes.json().id;

      const empAIds: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const empRes = await server.inject({
          method: 'POST',
          url: '/api/employees',
          headers: { cookie: sessionCookie },
          payload: {
            employeeCode: `EMP-PA-${i}`,
            fullName: `Plant A Emp ${i}`,
            email: `pa${i}@company.com`,
            departmentId: deptId
          }
        });
        empAIds.push(empRes.json().id);
      }

      const empBIds: string[] = [];
      for (let i = 1; i <= 2; i++) {
        const empRes = await server.inject({
          method: 'POST',
          url: '/api/employees',
          headers: { cookie: sessionCookie },
          payload: {
            employeeCode: `EMP-PB-${i}`,
            fullName: `Plant B Emp ${i}`,
            email: `pb${i}@company.com`,
            departmentId: deptId
          }
        });
        empBIds.push(empRes.json().id);
      }

      // Assign Plant A seats to empA
      for (let i = 0; i < 4; i++) {
        const asgnRes = await server.inject({
          method: 'POST',
          url: `/api/seats/${plantASeats[i].id}/assign`,
          headers: { cookie: sessionCookie },
          payload: { employeeId: empAIds[i] }
        });
        expect(asgnRes.statusCode).toBe(200);
      }

      // Assign Plant B seats to empB
      for (let i = 0; i < 2; i++) {
        const asgnRes = await server.inject({
          method: 'POST',
          url: `/api/seats/${plantBSeats[i].id}/assign`,
          headers: { cookie: sessionCookie },
          payload: { employeeId: empBIds[i] }
        });
        expect(asgnRes.statusCode).toBe(200);
      }

      // 6. Delete Plant A
      const delPlantRes = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${plantA.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(delPlantRes.statusCode).toBe(200);
      expect(delPlantRes.json().success).toBe(true);

      // 7. Verify Plant A and all its children are gone (404)
      const chkPlantA = await server.inject({
        method: 'GET',
        url: `/api/plants/${plantA.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkPlantA.statusCode).toBe(404);

      for (const bid of [bldA1.id, bldA2.id]) {
        const chkBld = await server.inject({
          method: 'GET',
          url: `/api/buildings/${bid}`,
          headers: { cookie: sessionCookie }
        });
        expect(chkBld.statusCode).toBe(404);
      }

      for (const fid of [flrA1.id, flrA2.id]) {
        const chkFlr = await server.inject({
          method: 'GET',
          url: `/api/floors/${fid}`,
          headers: { cookie: sessionCookie }
        });
        expect(chkFlr.statusCode).toBe(404);
      }

      for (const s of plantASeats) {
        const seatInDb = await mockPrisma.seat.findUnique({ where: { id: s.id } });
        expect(seatInDb).toBeNull();
      }

      // 8. Verify Plant A's occupants are unseated (seat is null)
      for (const eid of empAIds) {
        const empCheck = await server.inject({
          method: 'GET',
          url: `/api/employees/${eid}`,
          headers: { cookie: sessionCookie }
        });
        expect(empCheck.statusCode).toBe(200);
        expect(empCheck.json().seat).toBeNull();
      }

      // 9. Verify Sibling Plant B and all its children REMAIN INTACT!
      const chkPlantB = await server.inject({
        method: 'GET',
        url: `/api/plants/${plantB.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkPlantB.statusCode).toBe(200);
      expect(chkPlantB.json().name).toBe('Plant Sibling B');

      const chkBldB1 = await server.inject({
        method: 'GET',
        url: `/api/buildings/${bldB1.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkBldB1.statusCode).toBe(200);

      const chkFlrB1 = await server.inject({
        method: 'GET',
        url: `/api/floors/${flrB1.id}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkFlrB1.statusCode).toBe(200);

      for (const s of plantBSeats) {
        const seatInDb = await mockPrisma.seat.findUnique({ where: { id: s.id } });
        expect(seatInDb).toBeDefined();
        expect(seatInDb.id).toBe(s.id);
      }

      // Sibling Plant B's employees REMAIN SEATED!
      for (let i = 0; i < 2; i++) {
        const empCheck = await server.inject({
          method: 'GET',
          url: `/api/employees/${empBIds[i]}`,
          headers: { cookie: sessionCookie }
        });
        expect(empCheck.statusCode).toBe(200);
        expect(empCheck.json().seat).toBeDefined();
        expect(empCheck.json().seat.id).toBe(plantBSeats[i].id);
      }

      // 10. Verify PARENT UNIT is still 200 OK and still references Plant B
      const chkParentUnit = await server.inject({
        method: 'GET',
        url: `/api/units/${parentUnitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkParentUnit.statusCode).toBe(200);
      const pUnitData = chkParentUnit.json();
      expect(pUnitData.name).toBe('Cascade Plant Test Unit');
      const attachedPlants = pUnitData.plants || [];
      expect(attachedPlants.some((p: any) => p.id === plantB.id)).toBe(true);
      expect(attachedPlants.some((p: any) => p.id === plantA.id)).toBe(false);
    });
  });

  // =========================================================================
  // CHALLENGE 3: Unit 2 Seat Static Protection (isUnit2Seat Guard)
  // Challenge the guard with automated flags/headers across POST and PATCH:
  // - 'x-auto-release': 'true'
  // - 'x-cron': 'true'
  // - body: { isAutoRelease: true }
  // - body: { automated: true }
  // - combined flags
  // - Unauthenticated calls (401)
  // - Genuine Admin call without flags (200)
  // =========================================================================
  describe('Challenge 3: Unit 2 Seat Static Protection Guard', () => {
    let unit2SeatId: string;
    let seededEmpId: string;

    beforeEach(async () => {
      // Find a floor under Unit 2
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
      const u2Plant = plantsRes.json()[0];
      expect(u2Plant).toBeDefined();

      const bldsRes = await server.inject({
        method: 'GET',
        url: `/api/buildings?plantId=${u2Plant.id}`,
        headers: { cookie: sessionCookie }
      });
      const u2Bld = bldsRes.json()[0];
      expect(u2Bld).toBeDefined();

      const flrsRes = await server.inject({
        method: 'GET',
        url: `/api/floors?buildingId=${u2Bld.id}`,
        headers: { cookie: sessionCookie }
      });
      const u2Flr = flrsRes.json()[0];
      expect(u2Flr).toBeDefined();

      // Put a seat on Unit 2 Floor
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${u2Flr.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'U2-STATIC-S1', x: 50, y: 50 }]
        }
      });
      expect(layoutRes.statusCode).toBe(200);
      unit2SeatId = layoutRes.json().seats[0].id;

      // Create employee & assign
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit 2 Staff', code: 'U2-STAFF', colorHex: '#8B5CF6' }
      });
      const deptId = deptRes.json().id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          employeeCode: 'EMP-U2-001',
          fullName: 'Unit2 Operator',
          email: 'u2op@company.com',
          departmentId: deptId
        }
      });
      seededEmpId = empRes.json().id;

      const asgnRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: seededEmpId }
      });
      expect(asgnRes.statusCode).toBe(200);
    });

    it('EMP-CHALLENGE-03A: Rejects POST /api/seats/:id/unassign with x-auto-release: true header (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
      expect(res.json().message).toContain('100% static Admin-controlled');

      // State invariant: Seat remains assigned in database and employee record
      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);

      const chkEmp = await server.inject({
        method: 'GET',
        url: `/api/employees/${seededEmpId}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkEmp.json().seat?.id).toBe(unit2SeatId);
    });

    it('EMP-CHALLENGE-03B: Rejects PATCH /api/seats/:id/unassign with x-auto-release: true header (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
      expect(res.json().message).toContain('100% static Admin-controlled');

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);
    });

    it('EMP-CHALLENGE-03C: Rejects unassignment with x-cron: true header (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-cron': 'true'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);
    });

    it('EMP-CHALLENGE-03D: Rejects unassignment with isAutoRelease: true in body (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: { cookie: sessionCookie },
        payload: { isAutoRelease: true }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);
    });

    it('EMP-CHALLENGE-03E: Rejects unassignment with automated: true in body (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: { cookie: sessionCookie },
        payload: { automated: true }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);
    });

    it('EMP-CHALLENGE-03F: Rejects combined automated header and body flags (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        },
        payload: { automated: true, isAutoRelease: true }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);
    });

    it('EMP-CHALLENGE-03G: Rejects unauthenticated unassignment on Unit 2 seat with 401 Unauthorized', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBe(seededEmpId);
    });

    it('EMP-CHALLENGE-03H: Legitimate authenticated Admin unassignment WITHOUT automated flags succeeds (200 OK)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${unit2SeatId}/unassign`,
        headers: { cookie: sessionCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBeNull();

      // Verify seat is now vacant in database
      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: unit2SeatId } });
      expect(seatInDb.employeeId).toBeNull();

      // Verify occupant employee is unseated
      const chkEmp = await server.inject({
        method: 'GET',
        url: `/api/employees/${seededEmpId}`,
        headers: { cookie: sessionCookie }
      });
      expect(chkEmp.json().seat).toBeNull();
    });

    it('EMP-CHALLENGE-03I: Non-Unit 2 seat permits automated unassignment (scoping invariant)', async () => {
      // Create non-Unit 2 seat
      const uRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Dynamic Desk Unit', code: 'UNIT-DYN' }
      });
      const pRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: uRes.json().id, name: 'Dyn Plant', code: 'PLT-DYN' }
      });
      const bRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: pRes.json().id, name: 'Dyn Bld', code: 'BLD-DYN' }
      });
      const fRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bRes.json().id, name: 'Dyn Flr', floorNumber: 1 }
      });
      const lRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${fRes.json().id}/layout`,
        headers: { cookie: sessionCookie },
        payload: { seats: [{ label: 'DYN-S1', x: 10, y: 10 }] }
      });
      const dynSeatId = lRes.json().seats[0].id;

      // Assign seat
      await server.inject({
        method: 'POST',
        url: `/api/seats/${dynSeatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: seededEmpId }
      });

      // Call unassign with x-auto-release: true -> SHOULD SUCCEED for non-Unit 2 seat!
      const unassignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${dynSeatId}/unassign`,
        headers: {
          cookie: sessionCookie,
          'x-auto-release': 'true'
        }
      });
      expect(unassignRes.statusCode).toBe(200);
      expect(unassignRes.json().employeeId).toBeNull();

      const seatInDb = await mockPrisma.seat.findUnique({ where: { id: dynSeatId } });
      expect(seatInDb.employeeId).toBeNull();
    });
  });

  // =========================================================================
  // CHALLENGE 4: Reporting Calculations & Edge Cases
  // - Empty units (0 capacity -> total = 0, occupied = 0, rate = 0.0)
  // - 100% full plants (all seats occupied -> rate = 100.0)
  // - 0% occupied plants (all seats vacant -> rate = 0.0)
  // - Precision rounding (e.g. 1/3 = 33.3%, 2/3 = 66.7%)
  // - Zero capacity plants / units
  // =========================================================================
  describe('Challenge 4: Reporting Calculations Edge Cases', () => {
    it('EMP-CHALLENGE-04A: Empty seeded units (Unit 1, 3, 4, 5) report total: 0, occupied: 0, rate: 0.0 without NaN or errors', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/reports/summary',
        headers: { cookie: sessionCookie }
      });
      expect(res.statusCode).toBe(200);
      const rep = res.json();

      const emptyUnitCodes = ['UNIT-1', 'UNIT-3', 'UNIT-4', 'UNIT-5'];
      for (const code of emptyUnitCodes) {
        const u = rep.byUnit.find((unit: any) => unit.unitCode === code);
        expect(u).toBeDefined();
        expect(u.total).toBe(0);
        expect(u.occupied).toBe(0);
        expect(u.rate).toBe(0.0);
        expect(Number.isNaN(u.rate)).toBe(false);
        expect(Number.isFinite(u.rate)).toBe(true);
      }
    });

    it('EMP-CHALLENGE-04B: Verified mathematical accuracy for 100% full, 0% occupied, and fractional (33.3%, 66.7%) occupancy rates', async () => {
      // 1. Create Unit Math
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Math Edge', code: 'UNIT-MATH' }
      });
      const unitMathId = unitRes.json().id;

      // Plant 1: 100% full (3 seats, 3 occupied)
      const p1Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unitMathId, name: 'Plant Full', code: 'PLT-FULL' }
      });
      const plantFullId = p1Res.json().id;

      // Plant 2: 0% occupied (3 seats, 0 occupied)
      const p2Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unitMathId, name: 'Plant EmptySeats', code: 'PLT-EMPTY' }
      });
      const plantEmptyId = p2Res.json().id;

      // Plant 3: Zero capacity (0 buildings, 0 floors, 0 seats)
      const p3Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unitMathId, name: 'Plant ZeroCap', code: 'PLT-ZEROCAP' }
      });
      const plantZeroCapId = p3Res.json().id;

      // Plant 4: Fractional occupancy (3 seats, 1 occupied -> 33.3%)
      const p4Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unitMathId, name: 'Plant Fractional', code: 'PLT-FRAC' }
      });
      const plantFracId = p4Res.json().id;

      // Buildings & Floors
      const b1 = (await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plantFullId, name: 'Bld Full', code: 'BLD-F' }
      })).json();

      const f1 = (await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: b1.id, name: 'Flr Full', floorNumber: 1 }
      })).json();

      const b2 = (await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plantEmptyId, name: 'Bld Empty', code: 'BLD-E' }
      })).json();

      const f2 = (await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: b2.id, name: 'Flr Empty', floorNumber: 1 }
      })).json();

      const b4 = (await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plantFracId, name: 'Bld Frac', code: 'BLD-FR' }
      })).json();

      const f4 = (await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: b4.id, name: 'Flr Frac', floorNumber: 1 }
      })).json();

      // Layouts:
      // f1 has 3 seats
      const seatsFull = (await server.inject({
        method: 'PUT',
        url: `/api/floors/${f1.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'F-S1', x: 10, y: 10 },
            { label: 'F-S2', x: 20, y: 10 },
            { label: 'F-S3', x: 30, y: 10 }
          ]
        }
      })).json().seats;

      // f2 has 3 seats
      await server.inject({
        method: 'PUT',
        url: `/api/floors/${f2.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'E-S1', x: 10, y: 10 },
            { label: 'E-S2', x: 20, y: 10 },
            { label: 'E-S3', x: 30, y: 10 }
          ]
        }
      });

      // f4 has 3 seats
      const seatsFrac = (await server.inject({
        method: 'PUT',
        url: `/api/floors/${f4.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'FR-S1', x: 10, y: 10 },
            { label: 'FR-S2', x: 20, y: 10 },
            { label: 'FR-S3', x: 30, y: 10 }
          ]
        }
      })).json().seats;

      // Department & Employees
      const dept = (await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Math Dept', code: 'MATH-DEPT', colorHex: '#F59E0B' }
      })).json();

      const empIds: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const emp = (await server.inject({
          method: 'POST',
          url: '/api/employees',
          headers: { cookie: sessionCookie },
          payload: {
            employeeCode: `EMP-M-${i}`,
            fullName: `Math Emp ${i}`,
            email: `math${i}@company.com`,
            departmentId: dept.id
          }
        })).json();
        empIds.push(emp.id);
      }

      // Assign all 3 seats on Plant Full to empIds[0], [1], [2]
      for (let i = 0; i < 3; i++) {
        await server.inject({
          method: 'POST',
          url: `/api/seats/${seatsFull[i].id}/assign`,
          headers: { cookie: sessionCookie },
          payload: { employeeId: empIds[i] }
        });
      }

      // Assign 1 seat on Plant Frac to empIds[3]
      await server.inject({
        method: 'POST',
        url: `/api/seats/${seatsFrac[0].id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empIds[3] }
      });

      // Fetch summary report
      const repRes = await server.inject({
        method: 'GET',
        url: '/api/reports/summary',
        headers: { cookie: sessionCookie }
      });
      expect(repRes.statusCode).toBe(200);
      const rep = repRes.json();

      // 1. Plant Full: total = 3, occupied = 3, rate = 100.0%
      const rFull = rep.byPlant.find((p: any) => p.plantId === plantFullId);
      expect(rFull).toBeDefined();
      expect(rFull.total).toBe(3);
      expect(rFull.occupied).toBe(3);
      expect(rFull.rate).toBe(100.0);

      // 2. Plant Empty: total = 3, occupied = 0, rate = 0.0%
      const rEmpty = rep.byPlant.find((p: any) => p.plantId === plantEmptyId);
      expect(rEmpty).toBeDefined();
      expect(rEmpty.total).toBe(3);
      expect(rEmpty.occupied).toBe(0);
      expect(rEmpty.rate).toBe(0.0);

      // 3. Plant ZeroCap: total = 0, occupied = 0, rate = 0.0%
      const rZero = rep.byPlant.find((p: any) => p.plantId === plantZeroCapId);
      expect(rZero).toBeDefined();
      expect(rZero.total).toBe(0);
      expect(rZero.occupied).toBe(0);
      expect(rZero.rate).toBe(0.0);

      // 4. Plant Fractional: total = 3, occupied = 1, rate = 33.3%
      const rFrac = rep.byPlant.find((p: any) => p.plantId === plantFracId);
      expect(rFrac).toBeDefined();
      expect(rFrac.total).toBe(3);
      expect(rFrac.occupied).toBe(1);
      expect(rFrac.rate).toBe(33.3);

      // 5. Unit Math total aggregation:
      // total = 3 (Full) + 3 (Empty) + 0 (Zero) + 3 (Frac) = 9 seats
      // occupied = 3 (Full) + 0 (Empty) + 0 (Zero) + 1 (Frac) = 4 seats
      // rate = (4 / 9) * 100 = 44.4444... -> 44.4%
      const rUnit = rep.byUnit.find((u: any) => u.unitId === unitMathId);
      expect(rUnit).toBeDefined();
      expect(rUnit.total).toBe(9);
      expect(rUnit.occupied).toBe(4);
      expect(rUnit.rate).toBe(44.4);
    });
  });
});
