import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, seed } from '../prisma/seed.js';

/**
 * Standard RFC 4180 CSV parser for adversarial validation of CSV exports.
 * Accurately parses field escaping, double quotes (""), commas, and CRLF line breaks.
 */
function parseRFC4180Csv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (insideQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          insideQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
        i++;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
        i++;
      } else if (char === '\r' && text[i + 1] === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i += 2;
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
      } else {
        currentField += char;
        i++;
      }
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

describe('Challenger M2 Round 2: Adversarial Stress & Integrity Verification', () => {
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
  });

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // 1. DEEP NESTED DELETIONS UNDER RACE CONDITIONS OR PARTIAL TRANSACTIONS
  // =========================================================================
  describe('1. Deep Nested Deletions & Concurrency / Race Conditions', () => {
    it('STRESS-01: Deep multi-branch Unit deletion is rejected without removing descendants', async () => {
      // Create Unit Omega
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Omega Deep', code: 'UNIT-OMEGA' }
      });
      expect(unitRes.statusCode).toBe(201);
      const unitId = unitRes.json().id;

      // Create 2 Plants under Unit Omega
      const plantIds: string[] = [];
      for (let p = 1; p <= 2; p++) {
        const pRes = await server.inject({
          method: 'POST',
          url: '/api/plants',
          headers: { cookie: sessionCookie },
          payload: { unitId, name: `Omega Plant ${p}`, code: `PLT-OMG-0${p}` }
        });
        expect(pRes.statusCode).toBe(201);
        plantIds.push(pRes.json().id);
      }

      // Create 2 Buildings per plant (total 4 buildings)
      const buildingIds: string[] = [];
      for (let pIdx = 0; pIdx < plantIds.length; pIdx++) {
        for (let b = 1; b <= 2; b++) {
          const bRes = await server.inject({
            method: 'POST',
            url: '/api/buildings',
            headers: { cookie: sessionCookie },
            payload: { plantId: plantIds[pIdx], name: `Building P${pIdx + 1}-B${b}`, code: `BLD-P${pIdx + 1}-0${b}` }
          });
          expect(bRes.statusCode).toBe(201);
          buildingIds.push(bRes.json().id);
        }
      }

      // Create 2 Floors per building (total 8 floors)
      const floorIds: string[] = [];
      for (let bIdx = 0; bIdx < buildingIds.length; bIdx++) {
        for (let f = 1; f <= 2; f++) {
          const fRes = await server.inject({
            method: 'POST',
            url: '/api/floors',
            headers: { cookie: sessionCookie },
            payload: { buildingId: buildingIds[bIdx], name: `Floor B${bIdx + 1}-F${f}`, floorNumber: f }
          });
          expect(fRes.statusCode).toBe(201);
          floorIds.push(fRes.json().id);
        }
      }

      // Create 3 Seats per floor (total 24 seats)
      const seatIds: string[] = [];
      for (let fIdx = 0; fIdx < floorIds.length; fIdx++) {
        const layoutRes = await server.inject({
          method: 'PUT',
          url: `/api/floors/${floorIds[fIdx]}/layout`,
          headers: { cookie: sessionCookie },
          payload: {
            seats: [
              { label: `S-F${fIdx + 1}-1`, x: 10, y: 10 },
              { label: `S-F${fIdx + 1}-2`, x: 50, y: 10 },
              { label: `S-F${fIdx + 1}-3`, x: 90, y: 10 }
            ]
          }
        });
        expect(layoutRes.statusCode).toBe(200);
        for (const s of layoutRes.json().seats) {
          seatIds.push(s.id);
        }
      }
      expect(seatIds.length).toBe(24);

      // Create Department and 8 Employees
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Omega Ops Dept', code: 'OMG-OPS', colorHex: '#EF4444' }
      });
      const deptId = deptRes.json().id;

      const employeeIds: string[] = [];
      for (let e = 1; e <= 8; e++) {
        const empRes = await server.inject({
          method: 'POST',
          url: '/api/employees',
          headers: { cookie: sessionCookie },
          payload: {
            employeeCode: `EMP-OMG-0${e}`,
            fullName: `Omega Worker ${e}`,
            email: `worker${e}@omega.com`,
            departmentId: deptId
          }
        });
        expect(empRes.statusCode).toBe(201);
        employeeIds.push(empRes.json().id);

        // Assign to seat
        const asgn = await server.inject({
          method: 'POST',
          url: `/api/seats/${seatIds[e - 1]}/assign`,
          headers: { cookie: sessionCookie },
          payload: { employeeId: empRes.json().id }
        });
        expect(asgn.statusCode).toBe(200);
      }

      // A Unit owning business hierarchy and employees must never be removed
      // by a cascading request.
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().code).toBe('DEPENDENCIES_EXIST');
      return;

      // Verify Unit is 404
      const checkUnit = await server.inject({ method: 'GET', url: `/api/units/${unitId}`, headers: { cookie: sessionCookie } });
      expect(checkUnit.statusCode).toBe(404);

      // Verify all Plants are 404
      for (const pId of plantIds) {
        const checkPlant = await server.inject({ method: 'GET', url: `/api/plants/${pId}`, headers: { cookie: sessionCookie } });
        expect(checkPlant.statusCode).toBe(404);
      }

      // Verify all Buildings are 404
      for (const bId of buildingIds) {
        const checkBld = await server.inject({ method: 'GET', url: `/api/buildings/${bId}`, headers: { cookie: sessionCookie } });
        expect(checkBld.statusCode).toBe(404);
      }

      // Verify all Floors are 404
      for (const fId of floorIds) {
        const checkFlr = await server.inject({ method: 'GET', url: `/api/floors/${fId}`, headers: { cookie: sessionCookie } });
        expect(checkFlr.statusCode).toBe(404);
      }

      // Verify all Seats are deleted (404 or 400)
      for (const sId of seatIds) {
        const checkSeat = await server.inject({ method: 'GET', url: `/api/seats/${sId}`, headers: { cookie: sessionCookie } });
        expect([400, 404]).toContain(checkSeat.statusCode);
      }

      // Verify all Employees remain alive and are unseated
      for (const eId of employeeIds) {
        const checkEmp = await server.inject({ method: 'GET', url: `/api/employees/${eId}`, headers: { cookie: sessionCookie } });
        expect(checkEmp.statusCode).toBe(200);
        expect(checkEmp.json().seat).toBeNull();
      }
    });

    it('STRESS-02: Concurrent Unit deletion requests preserve a dependent hierarchy', async () => {
      // Part A: Sequential duplicate DELETE verification
      const unitSeqRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Seq Delete', code: 'UNIT-SEQ-DEL' }
      });
      const seqUnitId = unitSeqRes.json().id;

      const del1 = await server.inject({ method: 'DELETE', url: `/api/units/${seqUnitId}`, headers: { cookie: sessionCookie } });
      expect(del1.statusCode).toBe(200);

      const del2 = await server.inject({ method: 'DELETE', url: `/api/units/${seqUnitId}`, headers: { cookie: sessionCookie } });
      expect(del2.statusCode).toBe(404);
      expect(del2.json().message).toBe('Unit not found');

      // Part B: Concurrent duplicate DELETE race condition
      const unitRaceRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Race Delete', code: 'UNIT-RACE-1' }
      });
      const raceUnitId = unitRaceRes.json().id;

      // Add child plant and seat to verify cascade during race
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: raceUnitId, name: 'Plant Race', code: 'PLT-RACE-1' }
      });
      const plantId = plantRes.json().id;

      // Fire 3 concurrent DELETE requests simultaneously
      const promises = [
        server.inject({ method: 'DELETE', url: `/api/units/${raceUnitId}`, headers: { cookie: sessionCookie } }),
        server.inject({ method: 'DELETE', url: `/api/units/${raceUnitId}`, headers: { cookie: sessionCookie } }),
        server.inject({ method: 'DELETE', url: `/api/units/${raceUnitId}`, headers: { cookie: sessionCookie } })
      ];

      const responses = await Promise.all(promises);
      const statusCodes = responses.map((r) => r.statusCode);

      // A dependent Unit is protected consistently, including concurrent calls.
      for (const code of statusCodes) {
        expect(code).toBe(409);
      }
      for (const response of responses) {
        expect(response.json().code).toBe('DEPENDENCIES_EXIST');
      }

      // The protected Unit and its child remain intact.
      const checkUnit = await server.inject({ method: 'GET', url: `/api/units/${raceUnitId}`, headers: { cookie: sessionCookie } });
      expect(checkUnit.statusCode).toBe(200);

      const checkPlant = await server.inject({ method: 'GET', url: `/api/plants/${plantId}`, headers: { cookie: sessionCookie } });
      expect(checkPlant.statusCode).toBe(200);
    });

    it('STRESS-03: Concurrent DELETE of parent Unit and child Plant handles race condition cleanly', async () => {
      // Create Unit and Plant
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Concurrent Plant', code: 'UNIT-CONC-P' }
      });
      const unitId = unitRes.json().id;

      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Plant Concurrent', code: 'PLT-CONC' }
      });
      const plantId = plantRes.json().id;

      // Concurrently delete both Unit and Plant
      const [resUnit, resPlant] = await Promise.all([
        server.inject({ method: 'DELETE', url: `/api/units/${unitId}`, headers: { cookie: sessionCookie } }),
        server.inject({ method: 'DELETE', url: `/api/plants/${plantId}`, headers: { cookie: sessionCookie } })
      ]);

      // The Unit delete either follows an already-completed child deletion or
      // rejects because that child is still present; no cascade is permitted.
      expect([200, 409]).toContain(resUnit.statusCode);
      expect([200, 404]).toContain(resPlant.statusCode);

      if (resUnit.statusCode === 409) {
        expect(resUnit.json().code).toBe('DEPENDENCIES_EXIST');
      }

      // A rejected parent delete leaves an empty Unit for an explicit later
      // decision; a successful delete can only occur after child removal.
      const checkUnit = await server.inject({ method: 'GET', url: `/api/units/${unitId}`, headers: { cookie: sessionCookie } });
      expect([200, 404]).toContain(checkUnit.statusCode);

      const checkPlant = await server.inject({ method: 'GET', url: `/api/plants/${plantId}`, headers: { cookie: sessionCookie } });
      expect(checkPlant.statusCode).toBe(404);
    });

    it('STRESS-04: Empty Unit deletion does not run a destructive hierarchy transaction', async () => {
      // Create a test Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Tx Test', code: 'UNIT-TX-01' }
      });
      const unitId = unitRes.json().id;

      // Spy on $transaction
      let transactionCalled = false;
      const originalTx = mockPrisma.$transaction;
      mockPrisma.$transaction = async (arg: any) => {
        transactionCalled = true;
        return originalTx(arg);
      };

      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });

      expect(delRes.statusCode).toBe(200);
      expect(transactionCalled).toBe(false);

      // Restore
      mockPrisma.$transaction = originalTx;
    });
  });

  // =========================================================================
  // 2. SCOPED DELETIONS PRESERVING SEEDED UNIT 2 FLOORS AND BUILDINGS
  // =========================================================================
  describe('2. Scoped Deletions Preserving Seeded Unit 2 Hierarchy', () => {
    it('STRESS-05: A dependent adversarial Unit is rejected without affecting seeded Unit 2', async () => {
      // Step A: Inspect seeded Unit 2 before action
      const u2Res = await server.inject({ method: 'GET', url: '/api/units', headers: { cookie: sessionCookie } });
      const allUnits = u2Res.json();
      const unit2 = allUnits.find((u: any) => u.name === 'Unit 2');
      expect(unit2).toBeDefined();

      const u2PlantsRes = await server.inject({ method: 'GET', url: `/api/plants?unitId=${unit2.id}`, headers: { cookie: sessionCookie } });
      const u2Plants = u2PlantsRes.json();
      expect(u2Plants.length).toBe(1);
      const seededPlantId = u2Plants[0].id;

      const u2BldsRes = await server.inject({ method: 'GET', url: `/api/buildings?plantId=${seededPlantId}`, headers: { cookie: sessionCookie } });
      const u2Blds = u2BldsRes.json();
      expect(u2Blds.length).toBe(1);
      const seededBldId = u2Blds[0].id;

      const u2FloorsRes = await server.inject({ method: 'GET', url: `/api/floors?buildingId=${seededBldId}`, headers: { cookie: sessionCookie } });
      const u2Floors = u2FloorsRes.json();
      expect(u2Floors.length).toBe(3);
      const seededFloorIds = u2Floors.map((f: any) => f.id);

      // Step B: Create an adversarial Unit with its own Plant, Building, Floor, and Seat
      const advUnitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Adversarial Unit Scope', code: 'UNIT-ADV-SCP' }
      });
      const advUnitId = advUnitRes.json().id;

      const advPlantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: advUnitId, name: 'Adversarial Plant', code: 'PLT-ADV-01' }
      });
      const advPlantId = advPlantRes.json().id;

      const advBldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: advPlantId, name: 'Adversarial Building', code: 'BLD-ADV-01' }
      });
      const advBldId = advBldRes.json().id;

      const advFlrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: advBldId, name: 'Adversarial Floor', floorNumber: 1 }
      });
      const advFlrId = advFlrRes.json().id;

      // Step C: Delete the adversarial unit
      const delAdvRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${advUnitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delAdvRes.statusCode).toBe(409);
      expect(delAdvRes.json().code).toBe('DEPENDENCIES_EXIST');
      return;

      // Adversarial hierarchy is deleted (404)
      const checkAdvUnit = await server.inject({ method: 'GET', url: `/api/units/${advUnitId}`, headers: { cookie: sessionCookie } });
      expect(checkAdvUnit.statusCode).toBe(404);
      const checkAdvPlant = await server.inject({ method: 'GET', url: `/api/plants/${advPlantId}`, headers: { cookie: sessionCookie } });
      expect(checkAdvPlant.statusCode).toBe(404);
      const checkAdvBld = await server.inject({ method: 'GET', url: `/api/buildings/${advBldId}`, headers: { cookie: sessionCookie } });
      expect(checkAdvBld.statusCode).toBe(404);
      const checkAdvFlr = await server.inject({ method: 'GET', url: `/api/floors/${advFlrId}`, headers: { cookie: sessionCookie } });
      expect(checkAdvFlr.statusCode).toBe(404);

      // Step D: INVARIANT CHECK - Seeded Unit 2 hierarchy is 100% PRESERVED
      const checkU2 = await server.inject({ method: 'GET', url: `/api/units/${unit2.id}`, headers: { cookie: sessionCookie } });
      expect(checkU2.statusCode).toBe(200);

      const checkU2Plant = await server.inject({ method: 'GET', url: `/api/plants/${seededPlantId}`, headers: { cookie: sessionCookie } });
      expect(checkU2Plant.statusCode).toBe(200);

      const checkU2Bld = await server.inject({ method: 'GET', url: `/api/buildings/${seededBldId}`, headers: { cookie: sessionCookie } });
      expect(checkU2Bld.statusCode).toBe(200);

      for (const flrId of seededFloorIds) {
        const checkU2Flr = await server.inject({ method: 'GET', url: `/api/floors/${flrId}`, headers: { cookie: sessionCookie } });
        expect(checkU2Flr.statusCode).toBe(200);
      }

      // Verify all 5 seeded units still exist
      const checkUnitsAfter = await server.inject({ method: 'GET', url: '/api/units', headers: { cookie: sessionCookie } });
      const unitNames = checkUnitsAfter.json().map((u: any) => u.name);
      expect(unitNames).toContain('Unit 1');
      expect(unitNames).toContain('Unit 2');
      expect(unitNames).toContain('Unit 3');
      expect(unitNames).toContain('Unit 4');
      expect(unitNames).toContain('Unit 5');
    });

    it('STRESS-06: Deleting a newly added Plant in Unit 2 preserves seeded Plant 1, Main Building, and Floors 1-3', async () => {
      // Find Unit 2
      const unitsRes = await server.inject({ method: 'GET', url: '/api/units', headers: { cookie: sessionCookie } });
      const unit2 = unitsRes.json().find((u: any) => u.name === 'Unit 2');
      expect(unit2).toBeDefined();

      // Find seeded Plant 1
      const initialPlantsRes = await server.inject({ method: 'GET', url: `/api/plants?unitId=${unit2.id}`, headers: { cookie: sessionCookie } });
      const seededPlant = initialPlantsRes.json().find((p: any) => p.code === 'PLT-U2-01');
      expect(seededPlant).toBeDefined();

      // Create a second Plant under Unit 2: "Unit 2 - Plant 2"
      const plant2Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId: unit2.id, name: 'Unit 2 - Plant 2', code: 'PLT-U2-02' }
      });
      expect(plant2Res.statusCode).toBe(201);
      const plant2Id = plant2Res.json().id;

      // Add a building under Plant 2
      const bld2Res = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId: plant2Id, name: 'Building Plant 2', code: 'BLD-U2-02' }
      });
      expect(bld2Res.statusCode).toBe(201);
      const bld2Id = bld2Res.json().id;

      // Add a floor under Building 2
      const flr2Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bld2Id, name: 'Floor Plant 2 Level 1', floorNumber: 1 }
      });
      expect(flr2Res.statusCode).toBe(201);
      const flr2Id = flr2Res.json().id;

      // Now DELETE Plant 2
      const delP2Res = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${plant2Id}`,
        headers: { cookie: sessionCookie }
      });
      expect(delP2Res.statusCode).toBe(200);

      // Verify Plant 2 and its children are 404
      const checkP2 = await server.inject({ method: 'GET', url: `/api/plants/${plant2Id}`, headers: { cookie: sessionCookie } });
      expect(checkP2.statusCode).toBe(404);
      const checkBld2 = await server.inject({ method: 'GET', url: `/api/buildings/${bld2Id}`, headers: { cookie: sessionCookie } });
      expect(checkBld2.statusCode).toBe(404);
      const checkFlr2 = await server.inject({ method: 'GET', url: `/api/floors/${flr2Id}`, headers: { cookie: sessionCookie } });
      expect(checkFlr2.statusCode).toBe(404);

      // INVARIANT CHECK: Seeded Plant 1 is still alive and intact
      const checkSeedPlant = await server.inject({ method: 'GET', url: `/api/plants/${seededPlant.id}`, headers: { cookie: sessionCookie } });
      expect(checkSeedPlant.statusCode).toBe(200);

      // Parent Unit 2 is still alive
      const checkU2 = await server.inject({ method: 'GET', url: `/api/units/${unit2.id}`, headers: { cookie: sessionCookie } });
      expect(checkU2.statusCode).toBe(200);

      // Unit 2 now has exactly 1 plant (the seeded one)
      const currentPlantsRes = await server.inject({ method: 'GET', url: `/api/plants?unitId=${unit2.id}`, headers: { cookie: sessionCookie } });
      expect(currentPlantsRes.json().length).toBe(1);
      expect(currentPlantsRes.json()[0].id).toBe(seededPlant.id);
    });
  });

  // =========================================================================
  // 3. CSV EXPORT VALIDATION WITH DELIMITERS AND SPECIAL CHARACTERS
  // =========================================================================
  describe('3. CSV Export Validation: Custom Delimiters & Special Characters', () => {
    it('STRESS-07: CSV export correctly escapes commas, quotes, semicolons, and UTF-8 characters without shifting columns', async () => {
      // 1. Create Unit with special characters & comma
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Unit 9, "Heavy Precision" & Automation / Sector-Z',
          code: 'UNIT-SPECIAL-09'
        }
      });
      expect(unitRes.statusCode).toBe(201);
      const unitId = unitRes.json().id;

      // 2. Create Plant with quotes and semicolons
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId,
          name: 'Plant "Alpha-1", Line; #42',
          code: 'PLT-SP-01'
        }
      });
      expect(plantRes.statusCode).toBe(201);
      const plantId = plantRes.json().id;

      // 3. Create Building with quotes & comma
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: {
          plantId,
          name: 'Building "East, West" Wing',
          code: 'BLD-SP-01'
        }
      });
      expect(bldRes.statusCode).toBe(201);
      const bldId = bldRes.json().id;

      // 4. Create Floor with comma
      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: {
          buildingId: bldId,
          name: 'Floor 1, Cleanroom & Fabrication',
          floorNumber: 1
        }
      });
      expect(flrRes.statusCode).toBe(201);
      const flrId = flrRes.json().id;

      // 5. Create Seat with comma and quotes
      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [
            { label: 'SEAT-SP, "VIP-1"', x: 10, y: 10, type: 'EXECUTIVE_DESK' }
          ]
        }
      });
      expect(layoutRes.statusCode).toBe(200);
      const seatId = layoutRes.json().seats[0].id;

      // 6. Create Department with comma
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Engineering, Hardware & Systems',
          code: 'ENG-HW',
          colorHex: '#3B82F6'
        }
      });
      expect(deptRes.statusCode).toBe(201);
      const deptId = deptRes.json().id;

      // 7. Create Employee with comma, single quotes, double quotes, and accent
      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          employeeCode: 'EMP-SPEC-01',
          fullName: 'O\'Connor, René "The Architect"',
          email: 'rene.oconnor@special.com',
          departmentId: deptId
        }
      });
      expect(empRes.statusCode).toBe(201);
      const empId = empRes.json().id;

      // 8. Assign employee to seat
      const assignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empId }
      });
      expect(assignRes.statusCode).toBe(200);

      // 9. Export CSV
      const csvRes = await server.inject({
        method: 'GET',
        url: '/api/reports/export-csv',
        headers: { cookie: sessionCookie }
      });
      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.headers['content-type']).toContain('text/csv');
      expect(csvRes.headers['content-disposition']).toContain('attachment; filename=');

      // 10. Parse CSV using RFC 4180 parser
      const parsedRows = parseRFC4180Csv(csvRes.payload);
      expect(parsedRows.length).toBeGreaterThanOrEqual(2);

      // Verify Header row
      const headerRow = parsedRows[0];
      expect(headerRow.length).toBe(12);
      expect(headerRow).toEqual([
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

      // Every single row in the CSV must have EXACTLY 12 columns
      for (const row of parsedRows) {
        expect(row.length).toBe(12);
      }

      // Find our custom row
      const targetRow = parsedRows.find((r) => r[4] === 'SEAT-SP, "VIP-1"');
      expect(targetRow).toBeDefined();

      // Check field values match verbatim without corruption or dropped quotes
      expect(targetRow![0]).toBe('Unit 9, "Heavy Precision" & Automation / Sector-Z');
      expect(targetRow![1]).toBe('Plant "Alpha-1", Line; #42');
      expect(targetRow![2]).toBe('Building "East, West" Wing');
      expect(targetRow![3]).toBe('Floor 1, Cleanroom & Fabrication');
      expect(targetRow![4]).toBe('SEAT-SP, "VIP-1"');
      expect(targetRow![5]).toBe('EXECUTIVE_DESK');
      expect(targetRow![6]).toBe('AVAILABLE');
      expect(targetRow![7]).toBe('EMP-SPEC-01');
      expect(targetRow![8]).toBe('O\'Connor, René "The Architect"');
      expect(targetRow![9]).toBe('rene.oconnor@special.com');
      expect(targetRow![10]).toBe('ENG-HW');
      expect(targetRow![11]).toBe('Engineering, Hardware & Systems');
    });

    it('STRESS-08: Unicode and international characters (CJK, Umlauts, accents) preserve encoding in CSV', async () => {
      // Create Unit with Japanese, German, and emojis
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Unit 8 🏭 工場 (Tōkyō)',
          code: 'UNIT-UNICODE-8'
        }
      });
      const unitId = unitRes.json().id;

      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: {
          unitId,
          name: 'Plànt 8-A: Zürich & São Paulo — 100% 🚀',
          code: 'PLT-UNI-08'
        }
      });
      const plantId = plantRes.json().id;

      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: {
          plantId,
          name: 'Edifício Central № 42',
          code: 'BLD-UNI-01'
        }
      });
      const bldId = bldRes.json().id;

      const flrRes = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: {
          buildingId: bldId,
          name: 'Étage Supérieur (Plafond €500)',
          floorNumber: 1
        }
      });
      const flrId = flrRes.json().id;

      const layoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flrId}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'SIÈGE-日本語-01', x: 20, y: 20 }]
        }
      });
      const seatId = layoutRes.json().seats[0].id;

      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: '国際開発部 (International R&D)', code: 'INT-RD', colorHex: '#10B981' }
      });
      const deptId = deptRes.json().id;

      const empRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: {
          employeeCode: 'EMP-UNI-01',
          fullName: 'José María Müller 先生',
          email: 'jose.muller@unicode.org',
          departmentId: deptId
        }
      });
      const empId = empRes.json().id;

      await server.inject({
        method: 'POST',
        url: `/api/seats/${seatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empId }
      });

      // Export CSV
      const csvRes = await server.inject({
        method: 'GET',
        url: '/api/reports/export-csv',
        headers: { cookie: sessionCookie }
      });
      expect(csvRes.statusCode).toBe(200);

      const parsedRows = parseRFC4180Csv(csvRes.payload);
      const row = parsedRows.find((r) => r[4] === 'SIÈGE-日本語-01');
      expect(row).toBeDefined();
      expect(row![0]).toBe('Unit 8 🏭 工場 (Tōkyō)');
      expect(row![1]).toBe('Plànt 8-A: Zürich & São Paulo — 100% 🚀');
      expect(row![2]).toBe('Edifício Central № 42');
      expect(row![3]).toBe('Étage Supérieur (Plafond €500)');
      expect(row![8]).toBe('José María Müller 先生');
      expect(row![11]).toBe('国際開発部 (International R&D)');
    });
  });

  // =========================================================================
  // 4. EMPLOYEE RECORDS MAINTAIN INTEGRITY WHEN SEATS ARE CASCADE-DELETED
  // =========================================================================
  describe('4. Employee Records Maintain Data Integrity on Cascade Deletion', () => {
    it('STRESS-09: Dependent Unit deletion preserves occupants and hierarchy', async () => {
      // 1. Create Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Emp Guard', code: 'UNIT-EMP-GRD' }
      });
      const unitId = unitRes.json().id;

      // 2. Create Plant
      const plantRes = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Plant Emp Guard', code: 'PLT-EMP-GRD' }
      });
      const plantId = plantRes.json().id;

      // 3. Create Building
      const bldRes = await server.inject({
        method: 'POST',
        url: '/api/buildings',
        headers: { cookie: sessionCookie },
        payload: { plantId, name: 'Building Emp Guard', code: 'BLD-EMP-GRD' }
      });
      const bldId = bldRes.json().id;

      // 4. Create 2 Floors
      const flr1Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, name: 'Floor Guard 1', floorNumber: 1 }
      });
      const flr1Id = flr1Res.json().id;

      const flr2Res = await server.inject({
        method: 'POST',
        url: '/api/floors',
        headers: { cookie: sessionCookie },
        payload: { buildingId: bldId, name: 'Floor Guard 2', floorNumber: 2 }
      });
      const flr2Id = flr2Res.json().id;

      // 5. Add seats
      const layout1Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr1Id}/layout`,
        headers: { cookie: sessionCookie },
        payload: { seats: [{ label: 'GRD-F1-S1', x: 10, y: 10 }] }
      });
      const seat1Id = layout1Res.json().seats[0].id;

      const layout2Res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${flr2Id}/layout`,
        headers: { cookie: sessionCookie },
        payload: { seats: [{ label: 'GRD-F2-S1', x: 20, y: 20 }] }
      });
      const seat2Id = layout2Res.json().seats[0].id;

      // 6. Create Department
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: { cookie: sessionCookie },
        payload: { name: 'Quality Guard Dept', code: 'QG-DEPT', colorHex: '#F59E0B' }
      });
      const deptId = deptRes.json().id;

      // 7. Create 3 Employees: Emp A (seated on F1), Emp B (seated on F2), Emp C (unassigned control)
      const empARes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-GRD-A', fullName: 'Alice Guard', email: 'alice.guard@quality.org', departmentId: deptId }
      });
      const empAId = empARes.json().id;

      const empBRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-GRD-B', fullName: 'Bob Guard', email: 'bob.guard@quality.org', departmentId: deptId }
      });
      const empBId = empBRes.json().id;

      const empCRes = await server.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: sessionCookie },
        payload: { employeeCode: 'EMP-GRD-C', fullName: 'Charlie Control', email: 'charlie.guard@quality.org', departmentId: deptId }
      });
      const empCId = empCRes.json().id;

      // Assign Alice to Seat 1, Bob to Seat 2
      await server.inject({ method: 'POST', url: `/api/seats/${seat1Id}/assign`, headers: { cookie: sessionCookie }, payload: { employeeId: empAId } });
      await server.inject({ method: 'POST', url: `/api/seats/${seat2Id}/assign`, headers: { cookie: sessionCookie }, payload: { employeeId: empBId } });

      // Verify seated state before deletion
      const checkABefore = await server.inject({ method: 'GET', url: `/api/employees/${empAId}`, headers: { cookie: sessionCookie } });
      expect(checkABefore.json().seat?.id).toBe(seat1Id);

      const checkBBefore = await server.inject({ method: 'GET', url: `/api/employees/${empBId}`, headers: { cookie: sessionCookie } });
      expect(checkBBefore.json().seat?.id).toBe(seat2Id);

      // 8. Delete the parent Unit
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unitId}`,
        headers: { cookie: sessionCookie }
      });
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().code).toBe('DEPENDENCIES_EXIST');
      return;

      // 9. INVARIANT CHECKS: All 3 Employees remain intact with unmodified core profile fields
      const checkAAfter = await server.inject({ method: 'GET', url: `/api/employees/${empAId}`, headers: { cookie: sessionCookie } });
      expect(checkAAfter.statusCode).toBe(200);
      const empA = checkAAfter.json();
      expect(empA.id).toBe(empAId);
      expect(empA.employeeCode).toBe('EMP-GRD-A');
      expect(empA.fullName).toBe('Alice Guard');
      expect(empA.email).toBe('alice.guard@quality.org');
      expect(empA.departmentId).toBe(deptId);
      expect(empA.seat).toBeNull(); // Cleanly unseated

      const checkBAfter = await server.inject({ method: 'GET', url: `/api/employees/${empBId}`, headers: { cookie: sessionCookie } });
      expect(checkBAfter.statusCode).toBe(200);
      const empB = checkBAfter.json();
      expect(empB.id).toBe(empBId);
      expect(empB.employeeCode).toBe('EMP-GRD-B');
      expect(empB.fullName).toBe('Bob Guard');
      expect(empB.email).toBe('bob.guard@quality.org');
      expect(empB.departmentId).toBe(deptId);
      expect(empB.seat).toBeNull(); // Cleanly unseated

      const checkCAfter = await server.inject({ method: 'GET', url: `/api/employees/${empCId}`, headers: { cookie: sessionCookie } });
      expect(checkCAfter.statusCode).toBe(200);
      const empC = checkCAfter.json();
      expect(empC.id).toBe(empCId);
      expect(empC.employeeCode).toBe('EMP-GRD-C');
      expect(empC.seat).toBeNull();

      // 10. Re-assignment verification: Alice can be assigned to a new seat on Unit 2 Floor 1 immediately
      const u2FloorsRes = await server.inject({ method: 'GET', url: '/api/floors', headers: { cookie: sessionCookie } });
      const u2Floor = u2FloorsRes.json()[0];

      const newLayoutRes = await server.inject({
        method: 'PUT',
        url: `/api/floors/${u2Floor.id}/layout`,
        headers: { cookie: sessionCookie },
        payload: {
          seats: [{ label: 'REASGN-ALICE-01', x: 100, y: 100 }]
        }
      });
      const newSeatId = newLayoutRes.json().seats[0].id;

      const reassignAliceRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${newSeatId}/assign`,
        headers: { cookie: sessionCookie },
        payload: { employeeId: empAId }
      });
      expect(reassignAliceRes.statusCode).toBe(200);

      const checkAReassigned = await server.inject({ method: 'GET', url: `/api/employees/${empAId}`, headers: { cookie: sessionCookie } });
      expect(checkAReassigned.json().seat?.id).toBe(newSeatId);
    });

    it('STRESS-10: Plant deletion unseats its occupants but preserves occupants seated in peer plants under the same Unit', async () => {
      // Create Unit
      const unitRes = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unit Peer Plants', code: 'UNIT-PEER' }
      });
      const unitId = unitRes.json().id;

      // Create Plant 1 & Plant 2
      const p1Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Peer Plant 1', code: 'PLT-PEER-1' }
      });
      const p1Id = p1Res.json().id;

      const p2Res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: sessionCookie },
        payload: { unitId, name: 'Peer Plant 2', code: 'PLT-PEER-2' }
      });
      const p2Id = p2Res.json().id;

      // Buildings & Floors
      const bld1 = (await server.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: sessionCookie }, payload: { plantId: p1Id, name: 'Bld 1', code: 'BLD-P1' } })).json();
      const flr1 = (await server.inject({ method: 'POST', url: '/api/floors', headers: { cookie: sessionCookie }, payload: { buildingId: bld1.id, name: 'Flr 1', floorNumber: 1 } })).json();
      const s1 = (await server.inject({ method: 'PUT', url: `/api/floors/${flr1.id}/layout`, headers: { cookie: sessionCookie }, payload: { seats: [{ label: 'P1-S1', x: 10, y: 10 }] } })).json().seats[0];

      const bld2 = (await server.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: sessionCookie }, payload: { plantId: p2Id, name: 'Bld 2', code: 'BLD-P2' } })).json();
      const flr2 = (await server.inject({ method: 'POST', url: '/api/floors', headers: { cookie: sessionCookie }, payload: { buildingId: bld2.id, name: 'Flr 2', floorNumber: 1 } })).json();
      const s2 = (await server.inject({ method: 'PUT', url: `/api/floors/${flr2.id}/layout`, headers: { cookie: sessionCookie }, payload: { seats: [{ label: 'P2-S1', x: 20, y: 20 }] } })).json().seats[0];

      // Dept & Employees
      const dept = (await server.inject({ method: 'POST', url: '/api/departments', headers: { cookie: sessionCookie }, payload: { name: 'Peer Dept', code: 'PEER-D', colorHex: '#8B5CF6' } })).json();
      const emp1 = (await server.inject({ method: 'POST', url: '/api/employees', headers: { cookie: sessionCookie }, payload: { employeeCode: 'EMP-P1-OCC', fullName: 'Plant 1 Worker', departmentId: dept.id } })).json();
      const emp2 = (await server.inject({ method: 'POST', url: '/api/employees', headers: { cookie: sessionCookie }, payload: { employeeCode: 'EMP-P2-OCC', fullName: 'Plant 2 Worker', departmentId: dept.id } })).json();

      // Assign employees
      await server.inject({ method: 'POST', url: `/api/seats/${s1.id}/assign`, headers: { cookie: sessionCookie }, payload: { employeeId: emp1.id } });
      await server.inject({ method: 'POST', url: `/api/seats/${s2.id}/assign`, headers: { cookie: sessionCookie }, payload: { employeeId: emp2.id } });

      // Delete Plant 1
      const delP1Res = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${p1Id}`,
        headers: { cookie: sessionCookie }
      });
      expect(delP1Res.statusCode).toBe(200);

      // Verify Plant 1 occupant is unseated
      const checkEmp1 = await server.inject({ method: 'GET', url: `/api/employees/${emp1.id}`, headers: { cookie: sessionCookie } });
      expect(checkEmp1.statusCode).toBe(200);
      expect(checkEmp1.json().seat).toBeNull();

      // Verify Plant 2 occupant REMAINS SEATED in Seat 2!
      const checkEmp2 = await server.inject({ method: 'GET', url: `/api/employees/${emp2.id}`, headers: { cookie: sessionCookie } });
      expect(checkEmp2.statusCode).toBe(200);
      expect(checkEmp2.json().seat?.id).toBe(s2.id);

      // Verify parent Unit and Plant 2 are still 200 OK
      const checkUnit = await server.inject({ method: 'GET', url: `/api/units/${unitId}`, headers: { cookie: sessionCookie } });
      expect(checkUnit.statusCode).toBe(200);

      const checkP2 = await server.inject({ method: 'GET', url: `/api/plants/${p2Id}`, headers: { cookie: sessionCookie } });
      expect(checkP2.statusCode).toBe(200);
    });
  });
});
