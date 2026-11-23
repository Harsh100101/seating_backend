import { PrismaClient, Prisma } from '@prisma/client';
import { assertDisposableTestDatabaseUrl, getExplicitTestDatabaseUrl } from '../src/utils/test-database-guard.js';

const testDatabaseUrl = getExplicitTestDatabaseUrl();
assertDisposableTestDatabaseUrl(testDatabaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl! } } });

interface TestResult {
  name: string;
  passed: boolean;
  details?: any;
  error?: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, details?: any, error?: string) {
  results.push({ name, passed, details, error });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${name}`);
  if (error) console.error(`   Error: ${error}`);
  if (details && !passed) console.error(`   Details:`, details);
}

async function runEmpiricalChallenges() {
  console.log('====================================================');
  console.log('Starting Milestone 1 Empirical Challenge Suite');
  console.log('====================================================\n');

  try {
    // -------------------------------------------------------------------------
    // Challenge 1: Exact Hierarchy Verification in MongoDB Atlas
    // -------------------------------------------------------------------------
    console.log('--- 1. Querying MongoDB Atlas Hierarchy State ---');

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

    // Check 1.1: Exactly 5 Units exist
    const unitCount = units.length;
    record(
      'Atlas contains exactly 5 Units',
      unitCount === 5,
      { count: unitCount, units: units.map((u) => ({ id: u.id, name: u.name, code: u.code })) },
      unitCount !== 5 ? `Expected 5 units, found ${unitCount}` : undefined
    );

    // Check 1.2: Unit codes and names match Unit 1 to Unit 5 / UNIT-1 to UNIT-5
    const expectedUnits = [
      { name: 'Unit 1', code: 'UNIT-1' },
      { name: 'Unit 2', code: 'UNIT-2' },
      { name: 'Unit 3', code: 'UNIT-3' },
      { name: 'Unit 4', code: 'UNIT-4' },
      { name: 'Unit 5', code: 'UNIT-5' },
    ];

    const unitsMatch = expectedUnits.every((expected) => {
      const match = units.find((u) => u.code === expected.code && u.name === expected.name);
      return !!match;
    });
    record(
      'All 5 units match expected names and codes (Unit 1..5 / UNIT-1..5)',
      unitsMatch,
      { expectedUnits, actual: units.map((u) => ({ name: u.name, code: u.code })) }
    );

    // Check 1.3: Units 1, 3, 4, 5 have exactly 0 plants
    const emptyUnits = units.filter((u) => u.code !== 'UNIT-2');
    const allEmptyZeroPlants = emptyUnits.every((u) => u.plants.length === 0);
    record(
      'Units 1, 3, 4, and 5 have exactly 0 plants',
      allEmptyZeroPlants,
      emptyUnits.map((u) => ({ code: u.code, plantCount: u.plants.length }))
    );

    // Check 1.4: Unit 2 has exactly 1 plant ('Unit 2 - Plant 1', code 'PLT-U2-01')
    const unit2 = units.find((u) => u.code === 'UNIT-2');
    const u2PlantCount = unit2?.plants.length ?? 0;
    const u2Plant = unit2?.plants[0];
    const u2PlantValid =
      u2PlantCount === 1 &&
      u2Plant?.name === 'Unit 2 - Plant 1' &&
      u2Plant?.code === 'PLT-U2-01';

    record(
      'Unit 2 has exactly 1 Plant (Unit 2 - Plant 1 / PLT-U2-01)',
      u2PlantValid,
      { plantCount: u2PlantCount, plant: u2Plant ? { name: u2Plant.name, code: u2Plant.code } : null }
    );

    // Check 1.5: Plant 1 has exactly 1 Building ('Unit 2 - Main Building' / 'BLD-U2-01')
    const u2BldCount = u2Plant?.buildings.length ?? 0;
    const u2Bld = u2Plant?.buildings[0];
    const u2BldValid =
      u2BldCount === 1 &&
      u2Bld?.name === 'Unit 2 - Main Building' &&
      u2Bld?.code === 'BLD-U2-01';

    record(
      'Plant 1 has exactly 1 Building (Unit 2 - Main Building / BLD-U2-01)',
      u2BldValid,
      { buildingCount: u2BldCount, building: u2Bld ? { name: u2Bld.name, code: u2Bld.code } : null }
    );

    // Check 1.6: Building 1 has exactly 3 Floors (Floor 1, Floor 2, Floor 3)
    const u2FloorCount = u2Bld?.floors.length ?? 0;
    const floors = u2Bld?.floors ?? [];
    const floorsValid =
      u2FloorCount === 3 &&
      floors[0]?.floorNumber === 1 &&
      floors[0]?.name === 'Floor 1' &&
      floors[1]?.floorNumber === 2 &&
      floors[1]?.name === 'Floor 2' &&
      floors[2]?.floorNumber === 3 &&
      floors[2]?.name === 'Floor 3' &&
      floors.every((f) => f.canvasWidth === 1600 && f.canvasHeight === 1000);

    record(
      'Building 1 has exactly 3 Floors (Floor 1, 2, 3 with 1600x1000 canvas)',
      floorsValid,
      floors.map((f) => ({ name: f.name, num: f.floorNumber, w: f.canvasWidth, h: f.canvasHeight }))
    );

    // -------------------------------------------------------------------------
    // Challenge 2: Unique Constraint Violations
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Stress-Testing Unique Constraints ---');

    // Check 2.1: Duplicate Unit code
    let duplicateCodeRejected = false;
    try {
      await prisma.unit.create({
        data: {
          name: 'Conflict Unit Code',
          code: 'UNIT-1', // Already exists!
        },
      });
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        duplicateCodeRejected = true;
      } else {
        console.warn('Unexpected error type for duplicate unit code:', e);
      }
    }
    record(
      'Database rejects duplicate Unit code (P2002 unique violation)',
      duplicateCodeRejected
    );

    // Check 2.2: Duplicate Unit name
    let duplicateNameRejected = false;
    try {
      await prisma.unit.create({
        data: {
          name: 'Unit 1', // Already exists!
          code: 'UNIT-NEW-UNIQUE',
        },
      });
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        duplicateNameRejected = true;
      } else {
        console.warn('Unexpected error type for duplicate unit name:', e);
      }
    }
    record(
      'Database rejects duplicate Unit name (P2002 unique violation)',
      duplicateNameRejected
    );

    // Check 2.3: Duplicate Plant code within same Unit
    let duplicatePlantCodeRejected = false;
    if (unit2) {
      try {
        await prisma.plant.create({
          data: {
            name: 'Another Plant Same Code',
            code: 'PLT-U2-01', // Already exists in Unit 2!
            unitId: unit2.id,
          },
        });
      } catch (e: any) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          duplicatePlantCodeRejected = true;
        } else {
          console.warn('Unexpected error type for duplicate plant code:', e);
        }
      }
    }
    record(
      'Database rejects duplicate Plant code within same Unit (P2002 @@unique([unitId, code]))',
      duplicatePlantCodeRejected
    );

    // Check 2.4: Same Plant code in a DIFFERENT Unit is permitted
    let crossUnitPlantCodeAllowed = false;
    let crossUnitPlantId: string | null = null;
    const unit1 = units.find((u) => u.code === 'UNIT-1');
    if (unit1) {
      try {
        const p = await prisma.plant.create({
          data: {
            name: 'Plant in Unit 1 with same code',
            code: 'PLT-U2-01', // Same code as in Unit 2, but different unitId!
            unitId: unit1.id,
          },
        });
        crossUnitPlantId = p.id;
        crossUnitPlantCodeAllowed = true;
      } catch (e: any) {
        console.warn('Failed cross-unit plant code creation:', e);
      } finally {
        if (crossUnitPlantId) {
          await prisma.plant.delete({ where: { id: crossUnitPlantId } });
        }
      }
    }
    record(
      'Database allows same Plant code under different Units (scoped unique constraint)',
      crossUnitPlantCodeAllowed
    );

    // Check 2.5: Duplicate Building code within same Plant
    let duplicateBuildingCodeRejected = false;
    if (u2Plant) {
      try {
        await prisma.building.create({
          data: {
            name: 'Duplicate Building Code',
            code: 'BLD-U2-01', // Already exists in Plant 1!
            plantId: u2Plant.id,
          },
        });
      } catch (e: any) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          duplicateBuildingCodeRejected = true;
        } else {
          console.warn('Unexpected error type for duplicate building code:', e);
        }
      }
    }
    record(
      'Database rejects duplicate Building code within same Plant (P2002 @@unique([plantId, code]))',
      duplicateBuildingCodeRejected
    );

    // Check 2.6: Duplicate Floor number within same Building
    let duplicateFloorNumberRejected = false;
    if (u2Bld) {
      try {
        await prisma.floor.create({
          data: {
            name: 'Duplicate Floor 1',
            floorNumber: 1, // Already exists in Building 1!
            buildingId: u2Bld.id,
          },
        });
      } catch (e: any) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          duplicateFloorNumberRejected = true;
        } else {
          console.warn('Unexpected error type for duplicate floor number:', e);
        }
      }
    }
    record(
      'Database rejects duplicate Floor number within same Building (P2002 @@unique([buildingId, floorNumber]))',
      duplicateFloorNumberRejected
    );

    // -------------------------------------------------------------------------
    // Challenge 3: Referential Integrity & Cascade Deletion Invariants
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Referential Integrity & Cascade Behaviors ---');

    // Check 3.1: Cascade deletion through 5 tiers
    // Create an isolated sandbox Unit -> Plant -> Building -> Floor -> Seat
    const sandboxUnit = await prisma.unit.create({
      data: {
        name: 'Challenger Sandbox Unit',
        code: 'UNIT-CHALLENGER-TEST',
        plants: {
          create: {
            name: 'Sandbox Plant',
            code: 'PLT-SANDBOX-01',
            buildings: {
              create: {
                name: 'Sandbox Building',
                code: 'BLD-SANDBOX-01',
                floors: {
                  create: {
                    name: 'Sandbox Floor',
                    floorNumber: 99,
                    seats: {
                      create: {
                        label: 'SB-01',
                        x: 100,
                        y: 100,
                        type: 'STANDARD_DESK',
                        status: 'AVAILABLE',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      include: {
        plants: {
          include: {
            buildings: {
              include: {
                floors: {
                  include: {
                    seats: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const sbUnitId = sandboxUnit.id;
    const sbPlantId = sandboxUnit.plants[0].id;
    const sbBuildingId = sandboxUnit.plants[0].buildings[0].id;
    const sbFloorId = sandboxUnit.plants[0].buildings[0].floors[0].id;
    const sbSeatId = sandboxUnit.plants[0].buildings[0].floors[0].seats[0].id;

    console.log(`   Sandbox hierarchy created: Unit=${sbUnitId}, Plant=${sbPlantId}, Building=${sbBuildingId}, Floor=${sbFloorId}, Seat=${sbSeatId}`);

    // Delete sandbox Unit and test if cascade reaches all descendants
    await prisma.unit.delete({
      where: { id: sbUnitId },
    });

    const plantRemains = await prisma.plant.findUnique({ where: { id: sbPlantId } });
    const buildingRemains = await prisma.building.findUnique({ where: { id: sbBuildingId } });
    const floorRemains = await prisma.floor.findUnique({ where: { id: sbFloorId } });
    const seatRemains = await prisma.seat.findUnique({ where: { id: sbSeatId } });

    const fullCascadeSuccess = !plantRemains && !buildingRemains && !floorRemains && !seatRemains;

    record(
      'Full cascade deletion: deleting Unit cascades through Plant -> Building -> Floor -> Seat',
      fullCascadeSuccess,
      {
        plantRemains: !!plantRemains,
        buildingRemains: !!buildingRemains,
        floorRemains: !!floorRemains,
        seatRemains: !!seatRemains,
      }
    );

    // Check 3.2: Prisma validates ObjectId format on foreign keys
    let malformedIdRejected = false;
    try {
      await prisma.plant.create({
        data: {
          name: 'Invalid ObjectId Plant',
          code: 'PLT-INVALID-OID',
          unitId: 'not-a-valid-hex-object-id',
        },
      });
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2023') {
        malformedIdRejected = true;
      }
    }
    record(
      'Database rejects malformed ObjectId format on foreign key unitId (P2023)',
      malformedIdRejected
    );

    // Check 3.3: Prisma rejects connecting a Plant to a non-existent Unit ID
    let nonExistentRelationRejected = false;
    try {
      await prisma.plant.create({
        data: {
          name: 'Orphan Plant',
          code: 'PLT-ORPHAN',
          unit: {
            connect: {
              id: '000000000000000000000000',
            },
          },
        },
      });
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        nonExistentRelationRejected = true;
      }
    }
    record(
      'Prisma relational connect rejects non-existent Unit ID (P2025 Record to connect not found)',
      nonExistentRelationRejected
    );

    // Check 3.4: Cascade deletion when deleting Floor
    const testFloorHierarchy = await prisma.unit.create({
      data: {
        name: 'Cascade Floor Test Unit',
        code: 'UNIT-CASCADE-FL',
        plants: {
          create: {
            name: 'Cascade Floor Plant',
            code: 'PLT-CASCADE-FL',
            buildings: {
              create: {
                name: 'Cascade Floor Building',
                code: 'BLD-CASCADE-FL',
                floors: {
                  create: {
                    name: 'Test Floor For Cascade',
                    floorNumber: 50,
                    seats: {
                      create: {
                        label: 'CF-01',
                        x: 50,
                        y: 50,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      include: {
        plants: {
          include: {
            buildings: {
              include: {
                floors: {
                  include: {
                    seats: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const cfFloorId = testFloorHierarchy.plants[0].buildings[0].floors[0].id;
    const cfSeatId = testFloorHierarchy.plants[0].buildings[0].floors[0].seats[0].id;
    const cfUnitId = testFloorHierarchy.id;

    // Delete floor directly
    await prisma.floor.delete({ where: { id: cfFloorId } });
    const cfSeatRemains = await prisma.seat.findUnique({ where: { id: cfSeatId } });
    const floorCascadeSuccess = !cfSeatRemains;

    // Clean up test unit
    await prisma.unit.delete({ where: { id: cfUnitId } });

    record(
      'Direct Floor deletion cascades to its Seats',
      floorCascadeSuccess,
      { cfSeatRemains: !!cfSeatRemains }
    );

    // -------------------------------------------------------------------------
    // Challenge 4: Re-verification of Seed State post-testing
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Re-verifying Clean Seed State Post-Adversarial Tests ---');
    const finalUnits = await prisma.unit.findMany({
      include: {
        plants: {
          include: {
            buildings: {
              include: {
                floors: true,
              },
            },
          },
        },
      },
    });

    const stateClean =
      finalUnits.length === 5 &&
      finalUnits.every((u) => {
        if (u.code === 'UNIT-2') {
          return u.plants.length === 1 && u.plants[0].buildings.length === 1 && u.plants[0].buildings[0].floors.length === 3;
        }
        return u.plants.length === 0;
      });

    record(
      'Database state remains pristine after adversarial tests (no orphan records)',
      stateClean,
      { totalUnits: finalUnits.length }
    );

  } catch (err: any) {
    console.error('Fatal challenge exception:', err);
    record('Challenge suite execution', false, null, err.message || String(err));
  } finally {
    await prisma.$disconnect();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log('Challenge Results Summary');
  console.log('====================================================');
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`Total tests: ${total}`);
  console.log(`Passed:      ${passed}`);
  console.log(`Failed:      ${failed}`);

  if (failed > 0) {
    console.error('\nFAILURES DETECTED:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => console.error(`- ${r.name}: ${r.error || JSON.stringify(r.details)}`));
    process.exit(1);
  } else {
    console.log('\nALL EMPIRICAL CHALLENGES PASSED! VERDICT: APPROVE');
    process.exit(0);
  }
}

runEmpiricalChallenges();
