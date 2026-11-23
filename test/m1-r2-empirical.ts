// apps/backend/test/m1-r2-empirical.ts
/**
 * Empirical Verification Challenger Suite for Milestone 1 Fix (Round 2)
 *
 * Verifies:
 * 1. Absence of P2032 on prisma.building.findMany()
 * 2. Exactly 1 building returned: "Unit 2 - Main Building" (code BLD-U2-01)
 * 3. Absence of P2032 on prisma.floor.findMany({ include: { building: true } })
 * 4. Exactly 3 floors returned, linked to Unit 2 - Main Building
 * 5. Exactly 5 units exist, Unit 2 has 1 Plant -> 1 Building -> 3 Floors, Units 1, 3, 4, 5 have 0 plants
 * 6. Raw MongoDB collection check: offices dropped, buildings count = 1, floors count = 3
 * 7. Adversarial purge test: verifies cleanLegacyPreRefactorRecords purges legacy documents
 * 8. Seed idempotency: seed runs repeatedly without creating duplicates or errors
 */

import { PrismaClient } from '@prisma/client';
import { assertDisposableTestDatabaseUrl, getExplicitTestDatabaseUrl } from '../src/utils/test-database-guard.js';
import { cleanLegacyPreRefactorRecords, seedIndustrialHierarchy } from '../prisma/seed';

const testDatabaseUrl = getExplicitTestDatabaseUrl();
assertDisposableTestDatabaseUrl(testDatabaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl! } } });

interface CheckResult {
  name: string;
  passed: boolean;
  details?: any;
  error?: string;
}

const checks: CheckResult[] = [];

function recordCheck(name: string, passed: boolean, details?: any, error?: string) {
  checks.push({ name, passed, details, error });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon}: ${name}`);
  if (details && !passed) {
    console.log(`   Details:`, JSON.stringify(details, null, 2));
  }
  if (error) {
    console.error(`   Error:`, error);
  }
}

async function runEmpiricalSuite() {
  console.log('================================================================');
  console.log('CHALLENGER M1 ROUND 2: EMPIRICAL VERIFICATION HARNESS');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // TEST 1: prisma.building.findMany() does NOT throw P2032 & returns 1 building
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: prisma.building.findMany() [P2032 Check & Count] ---');
    let buildings: any[] = [];
    let test1Error: any = null;
    try {
      buildings = await prisma.building.findMany({
        include: { plant: true },
      });
    } catch (err: any) {
      test1Error = err;
    }

    const test1NoP2032 = test1Error === null;
    recordCheck(
      'prisma.building.findMany() executes without P2032 or any runtime crash',
      test1NoP2032,
      test1Error ? { code: test1Error.code, message: test1Error.message } : null,
      test1Error ? test1Error.message : undefined
    );

    const test1CountMatch = buildings.length === 1;
    const singleBuilding = buildings[0];
    const test1BuildingDetails =
      singleBuilding?.name === 'Unit 2 - Main Building' &&
      singleBuilding?.code === 'BLD-U2-01' &&
      typeof singleBuilding?.plantId === 'string' &&
      singleBuilding?.plant?.name === 'Unit 2 - Plant 1';

    recordCheck(
      'prisma.building.findMany() returns exactly 1 building: "Unit 2 - Main Building" (code BLD-U2-01)',
      test1CountMatch && test1BuildingDetails,
      { count: buildings.length, building: singleBuilding }
    );

    // -------------------------------------------------------------------------
    // TEST 2: prisma.floor.findMany({ include: { building: true } }) [P2032 Check]
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: prisma.floor.findMany({ include: { building: true } }) ---');
    let floors: any[] = [];
    let test2Error: any = null;
    try {
      floors = await prisma.floor.findMany({
        orderBy: { floorNumber: 'asc' },
        include: { building: true },
      });
    } catch (err: any) {
      test2Error = err;
    }

    const test2NoP2032 = test2Error === null;
    recordCheck(
      'prisma.floor.findMany({ include: { building: true } }) executes without P2032 or runtime crash',
      test2NoP2032,
      test2Error ? { code: test2Error.code, message: test2Error.message } : null,
      test2Error ? test2Error.message : undefined
    );

    const test2CountMatch = floors.length === 3;
    const test2FloorsDetails =
      test2CountMatch &&
      floors[0]?.floorNumber === 1 &&
      floors[0]?.name === 'Floor 1' &&
      floors[1]?.floorNumber === 2 &&
      floors[1]?.name === 'Floor 2' &&
      floors[2]?.floorNumber === 3 &&
      floors[2]?.name === 'Floor 3' &&
      floors.every(
        (f) =>
          f.buildingId === singleBuilding?.id &&
          f.building?.name === 'Unit 2 - Main Building' &&
          f.canvasWidth === 1600 &&
          f.canvasHeight === 1000
      );

    recordCheck(
      'prisma.floor.findMany({ include: { building: true } }) returns exactly 3 floors, all linked to Unit 2 - Main Building',
      test2FloorsDetails,
      {
        count: floors.length,
        floors: floors.map((f) => ({
          num: f.floorNumber,
          name: f.name,
          buildingId: f.buildingId,
          buildingName: f.building?.name,
          dims: `${f.canvasWidth}x${f.canvasHeight}`,
        })),
      }
    );

    // -------------------------------------------------------------------------
    // TEST 3: Hierarchy verification (5 Units, Unit 2 hierarchy, Units 1, 3, 4, 5 empty)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Full 5-Tier Hierarchy Verification ---');
    const units = await prisma.unit.findMany({
      orderBy: { code: 'asc' },
      include: {
        plants: {
          include: {
            buildings: {
              include: {
                floors: {
                  orderBy: { floorNumber: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    const test3UnitCount = units.length === 5;
    recordCheck(
      'Atlas contains exactly 5 Units (Unit 1 to Unit 5)',
      test3UnitCount,
      { count: units.length, units: units.map((u) => u.name) }
    );

    const expectedCodes = ['UNIT-1', 'UNIT-2', 'UNIT-3', 'UNIT-4', 'UNIT-5'];
    const actualCodes = units.map((u) => u.code);
    const test3CodesMatch =
      expectedCodes.length === actualCodes.length &&
      expectedCodes.every((code, idx) => actualCodes[idx] === code);

    recordCheck(
      'All 5 units have correct sequential codes (UNIT-1 to UNIT-5)',
      test3CodesMatch,
      { expectedCodes, actualCodes }
    );

    const emptyUnits = units.filter((u) => u.code !== 'UNIT-2');
    const test3EmptyUnitsHaveZeroPlants = emptyUnits.every((u) => u.plants.length === 0);
    recordCheck(
      'Units 1, 3, 4, and 5 have exactly 0 plants (empty for admin configuration)',
      test3EmptyUnitsHaveZeroPlants,
      emptyUnits.map((u) => ({ unit: u.name, code: u.code, plantCount: u.plants.length }))
    );

    const unit2 = units.find((u) => u.code === 'UNIT-2');
    const test3Unit2Hierarchy =
      unit2 !== undefined &&
      unit2.plants.length === 1 &&
      unit2.plants[0].name === 'Unit 2 - Plant 1' &&
      unit2.plants[0].code === 'PLT-U2-01' &&
      unit2.plants[0].buildings.length === 1 &&
      unit2.plants[0].buildings[0].name === 'Unit 2 - Main Building' &&
      unit2.plants[0].buildings[0].code === 'BLD-U2-01' &&
      unit2.plants[0].buildings[0].floors.length === 3;

    recordCheck(
      'Unit 2 has exactly 1 Plant -> 1 Building -> 3 Floors',
      Boolean(test3Unit2Hierarchy),
      {
        unit2Name: unit2?.name,
        plantCount: unit2?.plants.length,
        plantName: unit2?.plants[0]?.name,
        buildingCount: unit2?.plants[0]?.buildings.length,
        buildingName: unit2?.plants[0]?.buildings[0]?.name,
        floorCount: unit2?.plants[0]?.buildings[0]?.floors.length,
      }
    );

    // -------------------------------------------------------------------------
    // TEST 4: Raw MongoDB Collection Validation
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Raw MongoDB Atlas State & Collections ---');
    const collectionsRes: any = await prisma.$runCommandRaw({
      listCollections: 1,
      filter: { name: 'offices' },
    });
    const officesCollectionExists =
      collectionsRes?.cursor?.firstBatch && collectionsRes.cursor.firstBatch.length > 0;

    recordCheck(
      'Obsolete "offices" collection is dropped in MongoDB Atlas',
      !officesCollectionExists,
      { collectionsFound: collectionsRes?.cursor?.firstBatch }
    );

    const rawBuildingsRes: any = await prisma.$runCommandRaw({
      find: 'buildings',
      filter: {},
    });
    const rawBuildings = rawBuildingsRes?.cursor?.firstBatch || [];
    recordCheck(
      'Raw MongoDB "buildings" collection contains exactly 1 document with valid plant_id',
      rawBuildings.length === 1 && rawBuildings[0]?.plant_id !== undefined,
      { rawBuildingCount: rawBuildings.length, rawBuildings }
    );

    const rawFloorsRes: any = await prisma.$runCommandRaw({
      find: 'floors',
      filter: {},
    });
    const rawFloors = rawFloorsRes?.cursor?.firstBatch || [];
    recordCheck(
      'Raw MongoDB "floors" collection contains exactly 3 documents with valid building_id',
      rawFloors.length === 3 && rawFloors.every((f: any) => f.building_id !== undefined),
      { rawFloorsCount: rawFloors.length }
    );

    // -------------------------------------------------------------------------
    // TEST 5: Stress-Test cleanLegacyPreRefactorRecords (Adversarial Cleanup)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Adversarial Challenge — Legacy Injection & Purge ---');
    // Inject a fake legacy building without plant_id using raw command
    const fakeLegacyBuildingId = { $oid: '111111111111111111111111' };
    const fakeOrphanFloorId = { $oid: '222222222222222222222222' };

    await prisma.$runCommandRaw({
      insert: 'buildings',
      documents: [
        {
          _id: fakeLegacyBuildingId,
          name: 'Corrupted Legacy Tower',
          code: 'TWR-1',
          office_id: { $oid: '333333333333333333333333' },
          // Notice: NO plant_id
        },
      ],
    });

    await prisma.$runCommandRaw({
      insert: 'floors',
      documents: [
        {
          _id: fakeOrphanFloorId,
          name: 'Orphan Legacy Floor',
          floor_number: 99,
          building_id: fakeLegacyBuildingId,
        },
      ],
    });

    // Verify that the corrupted document triggers P2032 on findMany (confirming attack vector)
    let attackVectorConfirmed = false;
    try {
      await prisma.building.findMany();
    } catch (e: any) {
      if (e.code === 'P2032') {
        attackVectorConfirmed = true;
      }
    }

    recordCheck(
      'Simulated legacy injection successfully reproduced P2032 vulnerability condition',
      attackVectorConfirmed
    );

    // Now run cleanLegacyPreRefactorRecords
    await cleanLegacyPreRefactorRecords(prisma);

    // Now verify that P2032 is eliminated and the fake records are purged!
    let postPurgeBuildings: any[] = [];
    let postPurgeError: any = null;
    try {
      postPurgeBuildings = await prisma.building.findMany();
    } catch (e: any) {
      postPurgeError = e;
    }

    const purgeSuccessful =
      postPurgeError === null &&
      postPurgeBuildings.length === 1 &&
      postPurgeBuildings[0].code === 'BLD-U2-01';

    recordCheck(
      'cleanLegacyPreRefactorRecords successfully purged corrupted legacy documents and restored query sanity',
      purgeSuccessful,
      { count: postPurgeBuildings.length, error: postPurgeError?.message }
    );

    // Verify orphan floor was also cleaned up
    const postPurgeFloors = await prisma.floor.findMany();
    recordCheck(
      'cleanLegacyPreRefactorRecords purged orphaned floor linked to legacy building',
      postPurgeFloors.length === 3 && postPurgeFloors.every((f) => f.floorNumber <= 3),
      { count: postPurgeFloors.length }
    );

    // -------------------------------------------------------------------------
    // TEST 6: Seed Idempotency & Stability Post-Stress
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Re-seed Idempotency Verification ---');
    const seedResult = await seedIndustrialHierarchy(prisma);
    const postSeedUnits = await prisma.unit.findMany();
    const postSeedBuildings = await prisma.building.findMany();
    const postSeedFloors = await prisma.floor.findMany();

    const idempotencyPreserved =
      postSeedUnits.length === 5 &&
      postSeedBuildings.length === 1 &&
      postSeedFloors.length === 3;

    recordCheck(
      'Re-running seedIndustrialHierarchy maintains exact invariant counts: 5 units, 1 building, 3 floors',
      idempotencyPreserved,
      {
        units: postSeedUnits.length,
        buildings: postSeedBuildings.length,
        floors: postSeedFloors.length,
      }
    );

  } catch (err: any) {
    console.error('Fatal test suite exception:', err);
    recordCheck('Empirical suite execution without uncaught fatal errors', false, null, err.message);
  } finally {
    await prisma.$disconnect();
  }

  // ---------------------------------------------------------------------------
  // Summary & Verdict
  // ---------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('CHALLENGER RESULTS SUMMARY');
  console.log('================================================================');
  const total = checks.length;
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  console.log(`Total checks:  ${total}`);
  console.log(`Passed:        ${passed}`);
  console.log(`Failed:        ${failed}`);

  if (failed > 0) {
    console.error('\n❌ VERDICT: REJECT');
    checks
      .filter((c) => !c.passed)
      .forEach((c) => console.error(`  - FAIL: ${c.name} (${c.error || JSON.stringify(c.details)})`));
    process.exit(1);
  } else {
    console.log('\n✅ VERDICT: APPROVE');
    process.exit(0);
  }
}

runEmpiricalSuite();
