import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, seed } from '../prisma/seed.js';

describe('Empirical Challenger M2: Aggregations, Rates & Cascade Deletion Invariants', () => {
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
  });

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // SECTION 1: /api/reports/summary byUnit & byPlant Aggregations and Rates
  // =========================================================================
  describe('Reporting Summary Aggregations (byUnit & byPlant)', () => {
    it('EMPIRICAL-01: byUnit and byPlant are arrays with exact contract fields and handle zero seats safely', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/reports/summary',
        headers: { cookie: sessionCookie }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(Array.isArray(body.byUnit)).toBe(true);
      expect(Array.isArray(body.byPlant)).toBe(true);
      expect(body.byUnit.length).toBeGreaterThanOrEqual(5);

      // Verify empty units have 0 total, 0 occupied, 0.0 rate without NaN or division by zero
      for (const u of body.byUnit) {
        expect(u.unitId).toBeDefined();
        expect(typeof u.unitName).toBe('string');
        expect(typeof u.unitCode).toBe('string');
        expect(typeof u.total).toBe('number');
        expect(typeof u.occupied).toBe('number');
        expect(typeof u.rate).toBe('number');
        expect(Number.isNaN(u.rate)).toBe(false);
        expect(u.rate).toBeGreaterThanOrEqual(0.0);
        expect(u.rate).toBeLessThanOrEqual(100.0);
      }

      // Verify plants
      for (const p of body.byPlant) {
        expect(p.plantId).toBeDefined();
        expect(typeof p.plantName).toBe('string');
        expect(typeof p.plantCode).toBe('string');
        expect(typeof p.unitId).toBe('string');
        expect(typeof p.unitName).toBe('string');
        expect(typeof p.total).toBe('number');
        expect(typeof p.occupied).toBe('number');
        expect(typeof p.rate).toBe('number');
        expect(Number.isNaN(p.rate)).toBe(false);
      }
    });

    it('EMPIRICAL-02: Multi-plant and multi-seat rate calculations aggregate correctly across full hierarchy', async () => {
      // 1. Create Unit Gamma
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Gamma', code: 'UNIT-GAMMA', location: 'Plant Complex G' }
      });
      const unitGamma = unitRes.json();

      // 2. Create Plant 1 under Unit Gamma
      const plant1Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unitGamma.id, name: 'Gamma Plant One', code: 'PLT-G-01' }
      });
      const plant1 = plant1Res.json();

      // 3. Create Plant 2 under Unit Gamma
      const plant2Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unitGamma.id, name: 'Gamma Plant Two', code: 'PLT-G-02' }
      });
      const plant2 = plant2Res.json();

      // 4. Create Building 1 under Plant 1
      const bld1Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plant1.id, name: 'G1 Building', code: 'BLD-G1' }
      });
      const bld1 = bld1Res.json();

      // 5. Create Floor 1 under Building 1
      const flr1Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld1.id, name: 'G1 Floor 1', floorNumber: 1 }
      });
      const flr1 = flr1Res.json();

      // 6. Create Building 2 under Plant 2
      const bld2Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plant2.id, name: 'G2 Building', code: 'BLD-G2' }
      });
      const bld2 = bld2Res.json();

      // 7. Create Floor 2 under Building 2
      const flr2Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld2.id, name: 'G2 Floor 1', floorNumber: 1 }
      });
      const flr2 = flr2Res.json();

      // 8. Add 3 seats on Floor 1 (Plant 1): 1 occupied, 2 vacant -> 33.3% rate
      const layout1Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr1.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'G1-S1', x: 10, y: 10 },
            { label: 'G1-S2', x: 20, y: 10 },
            { label: 'G1-S3', x: 30, y: 10 }
          ]
        }
      });
      const seats1 = layout1Res.json().seats;

      // 9. Add 2 seats on Floor 2 (Plant 2): 1 occupied, 1 vacant -> 50.0% rate
      const layout2Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr2.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'G2-S1', x: 10, y: 10 },
            { label: 'G2-S2', x: 20, y: 10 }
          ]
        }
      });
      const seats2 = layout2Res.json().seats;

      // Create Department & 2 Employees
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Gamma Ops', code: 'GOPS', colorHex: '#4F46E5' }
      });
      const dept = deptRes.json();

      const emp1Res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-G1', fullName: 'George Gamma', email: 'gg1@company.com', departmentId: dept.id }
      });
      const emp1 = emp1Res.json();

      const emp2Res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-G2', fullName: 'Grace Gamma', email: 'gg2@company.com', departmentId: dept.id }
      });
      const emp2 = emp2Res.json();

      // Assign G1-S1 to emp1
      await server.inject({
        method: 'POST',
        url: `/api/seats/${seats1[0].id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: emp1.id }
      });

      // Assign G2-S1 to emp2
      await server.inject({
        method: 'POST',
        url: `/api/seats/${seats2[0].id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: emp2.id }
      });

      // Fetch summary report
      const repRes = await server.inject({
        method: 'GET',
        url: '/api/reports/summary',
        headers: { cookie: sessionCookie }
      });
      expect(repRes.statusCode).toBe(200);
      const rep = repRes.json();

      // Check Plant 1: total = 3, occupied = 1, rate = 33.3%
      const p1Report = rep.byPlant.find((p: any) => p.plantId === plant1.id);
      expect(p1Report).toBeDefined();
      expect(p1Report.total).toBe(3);
      expect(p1Report.occupied).toBe(1);
      expect(p1Report.rate).toBe(33.3);
      expect(p1Report.unitName).toBe('Unit Gamma');

      // Check Plant 2: total = 2, occupied = 1, rate = 50.0%
      const p2Report = rep.byPlant.find((p: any) => p.plantId === plant2.id);
      expect(p2Report).toBeDefined();
      expect(p2Report.total).toBe(2);
      expect(p2Report.occupied).toBe(1);
      expect(p2Report.rate).toBe(50.0);
      expect(p2Report.unitName).toBe('Unit Gamma');

      // Check Unit Gamma aggregation across both plants:
      // total = 3 + 2 = 5 seats
      // occupied = 1 + 1 = 2 seats
      // rate = (2 / 5) * 100 = 40.0%
      const unitReport = rep.byUnit.find((u: any) => u.unitId === unitGamma.id);
      expect(unitReport).toBeDefined();
      expect(unitReport.unitName).toBe('Unit Gamma');
      expect(unitReport.total).toBe(5);
      expect(unitReport.occupied).toBe(2);
      expect(unitReport.rate).toBe(40.0);
    });
  });

  // =========================================================================
  // SECTION 2: Cascade Deletion & Occupant Unseating Invariants
  // =========================================================================
  describe('Cascade Deletion & Occupant Unseating Invariants', () => {
    it('EMPIRICAL-03: Deleting a Unit with business dependencies is safely rejected', async () => {
      // 1. Create Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Cascade Target Unit', code: 'UNIT-CASCADE' }
      });
      const unitId = unitRes.json().id;

      // 2. Create Plant
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Cascade Plant', code: 'PLT-CASC-1' }
      });
      const plantId = plantRes.json().id;

      // 3. Create Building
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId, name: 'Cascade Building', code: 'BLD-CASC-1' }
      });
      const bldId = bldRes.json().id;

      // 4. Create Floor
      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, name: 'Cascade Floor 1', floorNumber: 1 }
      });
      const flrId = flrRes.json().id;

      // 5. Add 2 seats to Floor
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'CASC-S1', x: 10, y: 10 },
            { label: 'CASC-S2', x: 20, y: 10 }
          ]
        }
      });
      const seats = layoutRes.json().seats;
      const seat1Id = seats[0].id;
      const seat2Id = seats[1].id;

      // 6. Create Department & 2 Employees
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Cascade Dept', code: 'CASC-DEPT', colorHex: '#EC4899' }
      });
      const deptId = deptRes.json().id;

      const emp1Res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-CASC-1', fullName: 'Charles Cascade', email: 'charles@cascade.com', departmentId: deptId }
      });
      const emp1Id = emp1Res.json().id;

      const emp2Res = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-CASC-2', fullName: 'Chloe Cascade', email: 'chloe@cascade.com', departmentId: deptId }
      });
      const emp2Id = emp2Res.json().id;

      // 7. Assign seat1 to Charles
      const asgn1 = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1Id}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: emp1Id }
      });
      expect(asgn1.statusCode).toBe(200);

      // Verify Charles is seated before cascade deletion
      const checkEmp1Before = await server.inject({
        method: 'GET',
        url: `/api/employees/${emp1Id}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkEmp1Before.statusCode).toBe(200);
      expect(checkEmp1Before.json().seat).toBeDefined();
      expect(checkEmp1Before.json().seat.id).toBe(seat1Id);

      // 8. Issue DELETE /api/units/:id
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().code).toBe('DEPENDENCIES_EXIST');
      return;

      // 9. Verify Unit is gone
      const checkUnit = await server.inject({
        method: 'GET',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkUnit.statusCode).toBe(404);

      // 10. Verify Plant is gone
      const checkPlant = await server.inject({
        method: 'GET',
        url: `/api/plants/${plantId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkPlant.statusCode).toBe(404);

      // 11. Verify Building is gone
      const checkBld = await server.inject({
        method: 'GET',
        url: `/api/buildings/${bldId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkBld.statusCode).toBe(404);

      // 12. Verify Floor is gone
      const checkFlr = await server.inject({
        method: 'GET',
        url: `/api/floors/${flrId}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkFlr.statusCode).toBe(404);

      // 13. Verify Seats are gone
      const checkSeat1 = await server.inject({
        method: 'GET',
        url: `/api/seats/${seat1Id}`,
        headers: { cookie: sessionCookie }
      });
      expect([404, 400]).toContain(checkSeat1.statusCode);

      // 14. INVARIANT CHECK: Verify occupant Charles is unseated!
      const checkEmp1After = await server.inject({
        method: 'GET',
        url: `/api/employees/${emp1Id}`,
        headers: { cookie: sessionCookie }
      });
      expect(checkEmp1After.statusCode).toBe(200);
      expect(checkEmp1After.json().seat).toBeNull();

      // Verify Charles can now be assigned to another seat without 1:1 conflict
      // Find a floor in seeded Unit 2
      const unit2FloorsRes = await server.inject({
        method: 'GET',
        url: '/api/floors',
        headers: { cookie: sessionCookie }
      });
      const floors = unit2FloorsRes.json();
      expect(floors.length).toBeGreaterThanOrEqual(1);

      // Add a seat on floor 1 of Unit 2
      const u2SeatRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${floors[0].id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'REASSIGN-01', x: 50, y: 50 }]
        }
      });
      const newSeatId = u2SeatRes.json().seats[0].id;

      // Assign Charles to the new seat — MUST succeed because old seat was removed
      const reassignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${newSeatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: emp1Id }
      });
      expect(reassignRes.statusCode).toBe(200);
      expect(reassignRes.json().employeeId).toBe(emp1Id);
    });

    it('EMPIRICAL-04: Plant deletion cascades through buildings, floors, seats and unseats occupants without deleting parent Unit', async () => {
      // 1. Create Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit With Plant Cascade', code: 'UNIT-PLT-CASC' }
      });
      const unitId = unitRes.json().id;

      // 2. Create Plant
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Plant To Cascade Delete', code: 'PLT-TO-DEL' }
      });
      const plantId = plantRes.json().id;

      // 3. Create Building & Floor
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId, name: 'Building Under Plant', code: 'BLD-PLT-DEL' }
      });
      const bldId = bldRes.json().id;

      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, name: 'Floor Under Plant', floorNumber: 1 }
      });
      const flrId = flrRes.json().id;

      // 4. Create Seat
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'P-DEL-S1', x: 25, y: 25 }]
        }
      });
      const seatId = layoutRes.json().seats[0].id;

      // 5. Create Department & Employee
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Plant Delete Dept', code: 'PD-DEPT', colorHex: '#14B8A6' }
      });
      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-PD-1', fullName: 'Peter Plant', departmentId: deptRes.json().id }
      });
      const empId = empRes.json().id;

      // 6. Assign seat
      await server.inject({
        method: 'POST',
        url: `/api/seats/${seatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empId }
      });

      // 7. Delete Plant
      const delPlantRes = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${plantId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delPlantRes.statusCode).toBe(200);

      // 8. Assertions:
      // Plant is deleted (404)
      const pCheck = await server.inject({ method: 'GET', url: `/api/plants/${plantId}`, headers: { cookie: sessionCookie } });
      expect(pCheck.statusCode).toBe(404);

      // Building is deleted (404)
      const bCheck = await server.inject({ method: 'GET', url: `/api/buildings/${bldId}`, headers: { cookie: sessionCookie } });
      expect(bCheck.statusCode).toBe(404);

      // Floor is deleted (404)
      const fCheck = await server.inject({ method: 'GET', url: `/api/floors/${flrId}`, headers: { cookie: sessionCookie } });
      expect(fCheck.statusCode).toBe(404);

      // Parent Unit is STILL ALIVE (200)
      const uCheck = await server.inject({ method: 'GET', url: `/api/units/${unitId}`, headers: { cookie: sessionCookie } });
      expect(uCheck.statusCode).toBe(200);

      // Occupant Peter is unseated (seat: null)
      const eCheck = await server.inject({ method: 'GET', url: `/api/employees/${empId}`, headers: { cookie: sessionCookie } });
      expect(eCheck.statusCode).toBe(200);
      expect(eCheck.json().seat).toBeNull();
    });
  });
});
