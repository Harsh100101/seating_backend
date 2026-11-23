// apps/backend/test/m1-std-empirical-verification.ts
/**
 * Empirical Verification Challenger Suite for Milestone 1
 * Standardized Facility & HR Matrix Filter System
 */

import { PrismaClient } from '@prisma/client';
import { assertDisposableTestDatabaseUrl, getExplicitTestDatabaseUrl } from '../src/utils/test-database-guard.js';

const testDatabaseUrl = getExplicitTestDatabaseUrl();
assertDisposableTestDatabaseUrl(testDatabaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl! } } });

export interface CheckResult {
  category: string;
  name: string;
  passed: boolean;
  expected: any;
  actual: any;
  details?: any;
  error?: string;
}

export const verificationResults: CheckResult[] = [];

function record(category: string, name: string, passed: boolean, expected: any, actual: any, details?: any, error?: string) {
  verificationResults.push({ category, name, passed, expected, actual, details, error });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [${category}] ${name}`);
  if (!passed) {
    console.log(`   Expected:`, expected);
    console.log(`   Actual:  `, actual);
    if (details) console.log(`   Details: `, JSON.stringify(details, null, 2));
    if (error) console.error(`   Error:   `, error);
  }
}

async function runEmpiricalInspection() {
  console.log('================================================================');
  console.log('EMPIRICAL VERIFICATION HARNESS: MILESTONE 1 INVARIANTS');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // CATEGORY 1: Admin Users Invariants
    // -------------------------------------------------------------------------
    console.log('--- CATEGORY 1: Admin Users ---');
    const admins = await prisma.adminUser.findMany();
    record('Admin Users', 'Admin count via Prisma === 7', admins.length === 7, 7, admins.length, admins.map(a => ({ email: a.email, role: a.role })));

    const validRoles = new Set(['SUPER_ADMIN', 'UNIT_ADMIN']);
    const allRolesValid = admins.every(a => validRoles.has(a.role));
    record('Admin Users', 'All admin roles valid in Prisma enum', allRolesValid, true, allRolesValid);

    const superAdmins = admins.filter(a => a.role === 'SUPER_ADMIN').map(a => a.email).sort();
    const expectedSuperAdmins = ['admin@company.com', 'superadmin@shaktiman.com'].sort();
    record('Admin Users', 'SUPER_ADMIN accounts match expected', JSON.stringify(superAdmins) === JSON.stringify(expectedSuperAdmins), expectedSuperAdmins, superAdmins);

    const unitAdmins = admins.filter(a => a.role === 'UNIT_ADMIN');
    record('Admin Users', 'Exactly 5 UNIT_ADMIN accounts exist', unitAdmins.length === 5, 5, unitAdmins.length);

    const unitAdminsAssigned = unitAdmins.every(a => Boolean(a.assignedUnitId));
    record('Admin Users', 'All UNIT_ADMIN accounts have valid assignedUnitId', unitAdminsAssigned, true, unitAdminsAssigned);

    // Raw MongoDB collection inspection for admin_users
    const rawAdminsRes: any = await prisma.$runCommandRaw({
      find: 'admin_users',
      filter: {},
    });
    const rawAdmins = rawAdminsRes?.cursor?.firstBatch || [];
    record('Admin Users', 'Raw MongoDB admin_users count === 7', rawAdmins.length === 7, 7, rawAdmins.length);

    const corruptAdmins = rawAdmins.filter((a: any) => !a.role || !['SUPER_ADMIN', 'UNIT_ADMIN'].includes(a.role));
    record('Admin Users', 'Raw MongoDB documents with invalid/missing role === 0', corruptAdmins.length === 0, 0, corruptAdmins.length, corruptAdmins);

    const legacyAdmins = rawAdmins.filter((a: any) => 
      ['admin@company.local', 'it.hod@shaktiman.com', 'it.manager@shaktiman.com', 'employee@shaktiman.com'].includes(a.email) ||
      (a.email && a.email.endsWith('.hod@shaktiman.com'))
    );
    record('Admin Users', 'Raw MongoDB legacy/orphaned admin accounts === 0', legacyAdmins.length === 0, 0, legacyAdmins.length, legacyAdmins);

    // -------------------------------------------------------------------------
    // CATEGORY 2: Facility Hierarchy Invariants
    // -------------------------------------------------------------------------
    console.log('\n--- CATEGORY 2: Facility Hierarchy ---');
    const units = await prisma.unit.findMany({
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
      orderBy: { code: 'asc' },
    });
    record('Hierarchy', 'Exactly 5 Units exist', units.length === 5, 5, units.length, units.map(u => u.code));

    const unitCodes = units.map(u => u.code);
    const expectedUnitCodes = ['UNIT-1', 'UNIT-2', 'UNIT-3', 'UNIT-4', 'UNIT-5'];
    record('Hierarchy', 'Unit codes match UNIT-1 through UNIT-5', JSON.stringify(unitCodes) === JSON.stringify(expectedUnitCodes), expectedUnitCodes, unitCodes);

    const u2 = units.find(u => u.code === 'UNIT-2');
    record('Hierarchy', 'Unit 2 exists', Boolean(u2), true, Boolean(u2));

    const u2Plants = u2?.plants || [];
    record('Hierarchy', 'Unit 2 has exactly 1 Plant', u2Plants.length === 1, 1, u2Plants.length);

    const emptyUnits = units.filter(u => u.code !== 'UNIT-2');
    const emptyUnitsHaveNoPlants = emptyUnits.every(u => u.plants.length === 0);
    record('Hierarchy', 'Units 1, 3, 4, 5 have 0 plants', emptyUnitsHaveNoPlants, true, emptyUnitsHaveNoPlants, emptyUnits.map(u => ({ unit: u.code, plantCount: u.plants.length })));

    const plant1 = u2Plants[0];
    const buildings = plant1?.buildings || [];
    record('Hierarchy', 'Plant 1 has exactly 1 Building', buildings.length === 1, 1, buildings.length);

    const bld = buildings[0];
    record('Hierarchy', 'Building name is Santosh Bhavan', bld?.name === 'Santosh Bhavan', 'Santosh Bhavan', bld?.name);
    record('Hierarchy', 'Building code is BLD-U2-01', bld?.code === 'BLD-U2-01', 'BLD-U2-01', bld?.code);

    const floors = (bld?.floors || []).sort((a, b) => a.floorNumber - b.floorNumber);
    record('Hierarchy', 'Santosh Bhavan has exactly 3 Floors', floors.length === 3, 3, floors.length);

    const floorNumbers = floors.map(f => f.floorNumber);
    record('Hierarchy', 'Floors are numbered 1, 2, 3', JSON.stringify(floorNumbers) === JSON.stringify([1, 2, 3]), [1, 2, 3], floorNumbers);

    // Raw MongoDB collection checks
    const rawBuildingsRes: any = await prisma.$runCommandRaw({
      find: 'buildings',
      filter: {},
    });
    const rawBuildings = rawBuildingsRes?.cursor?.firstBatch || [];
    record('Hierarchy', 'Raw MongoDB buildings count === 1', rawBuildings.length === 1, 1, rawBuildings.length, rawBuildings.map((b: any) => ({ name: b.name, code: b.code })));

    const rawFloorsRes: any = await prisma.$runCommandRaw({
      find: 'floors',
      filter: {},
    });
    const rawFloors = rawFloorsRes?.cursor?.firstBatch || [];
    record('Hierarchy', 'Raw MongoDB floors count === 3', rawFloors.length === 3, 3, rawFloors.length);

    // -------------------------------------------------------------------------
    // CATEGORY 3: Floor 2 Workstations & Occupancy Invariants
    // -------------------------------------------------------------------------
    console.log('\n--- CATEGORY 3: Floor 2 Workstations & Occupancy ---');
    const floor2 = floors.find(f => f.floorNumber === 2);
    if (!floor2) {
      record('Floor 2 Seats', 'Floor 2 exists in Santosh Bhavan', false, true, false);
    } else {
      const f2Seats = await prisma.seat.findMany({
        where: { floorId: floor2.id },
        include: { employee: true },
      });
      record('Floor 2 Seats', 'Total seats on Floor 2 === 220', f2Seats.length === 220, 220, f2Seats.length);

      const occupiedSeats = f2Seats.filter(s => Boolean(s.employeeId));
      record('Floor 2 Seats', 'Occupied seats on Floor 2 === 56', occupiedSeats.length === 56, 56, occupiedSeats.length);

      const availableSeats = f2Seats.filter(s => !s.employeeId);
      record('Floor 2 Seats', 'Available seats on Floor 2 === 164', availableSeats.length === 164, 164, availableSeats.length);

      const occupiedWithEmployees = occupiedSeats.every(s => Boolean(s.employee));
      record('Floor 2 Seats', 'All 56 occupied seats link to existing Employee', occupiedWithEmployees, true, occupiedWithEmployees);

      const seatStatuses = f2Seats.map(s => s.status);
      const validSeatStatuses = seatStatuses.every(st => ['AVAILABLE', 'MAINTENANCE', 'RESERVED'].includes(st));
      record('Floor 2 Seats', 'All seat statuses belong to SeatStatus enum', validSeatStatuses, true, validSeatStatuses);

      // Check Floor 1 and Floor 3 seat counts
      const floor1 = floors.find(f => f.floorNumber === 1);
      const floor3 = floors.find(f => f.floorNumber === 3);
      const f1Seats = floor1 ? await prisma.seat.count({ where: { floorId: floor1.id } }) : 0;
      const f3Seats = floor3 ? await prisma.seat.count({ where: { floorId: floor3.id } }) : 0;
      record('Other Floors', 'Floor 1 seat count recorded', f1Seats > 0, '> 0', f1Seats);
      record('Other Floors', 'Floor 3 seat count recorded', f3Seats > 0, '> 0', f3Seats);
    }

    // -------------------------------------------------------------------------
    // CATEGORY 4: Mock Records Purge Invariants
    // -------------------------------------------------------------------------
    console.log('\n--- CATEGORY 4: Mock Records Purge ---');
    const mockCodePrefixes = ['EMP-', 'EMPA-', 'EMPB-', 'EMPC-'];
    const mockEmpsByCode = await prisma.employee.count({
      where: {
        OR: mockCodePrefixes.map(p => ({ employeeCode: { startsWith: p } })),
      },
    });
    record('Mock Purge', 'Mock employee codes (EMP-*, EMPA-*, EMPB-*, EMPC-*) === 0', mockEmpsByCode === 0, 0, mockEmpsByCode);

    const mockNamesPatterns = ['vacant', 'vaccant', 'contractor', 'printer', 'Employee Alpha', 'Employee Beta', 'Employee Gamma'];
    const mockEmpsByName = await prisma.employee.count({
      where: {
        OR: mockNamesPatterns.map(name => ({ fullName: { contains: name, mode: 'insensitive' } })),
      },
    });
    record('Mock Purge', 'Placeholder names (vacant, contractor, printer, demo names) === 0', mockEmpsByName === 0, 0, mockEmpsByName);

    // Direct MongoDB regex scan for mock patterns
    const rawMockEmpsRes: any = await prisma.$runCommandRaw({
      find: 'employees',
      filter: {
        $or: [
          { employee_code: { $regex: '^EMP-[A-Z]+', $options: 'i' } },
          { employee_code: { $regex: '^EMPA-', $options: 'i' } },
          { full_name: { $regex: 'vacant|vaccant|contractor|printer|Employee Alpha', $options: 'i' } },
        ],
      },
    });
    const rawMockEmps = rawMockEmpsRes?.cursor?.firstBatch || [];
    record('Mock Purge', 'Raw MongoDB mock employees count === 0', rawMockEmps.length === 0, 0, rawMockEmps.length, rawMockEmps);

    // -------------------------------------------------------------------------
    // CATEGORY 5: HR Attributes Completeness Invariants
    // -------------------------------------------------------------------------
    console.log('\n--- CATEGORY 5: HR Attributes Completeness ---');
    if (floor2) {
      const seatedEmps = await prisma.employee.findMany({
        where: {
          seat: {
            floorId: floor2.id,
          },
        },
        include: {
          department: true,
          seat: true,
        },
      });
      record('HR Attributes', 'Total seated employees on Floor 2 === 56', seatedEmps.length === 56, 56, seatedEmps.length);

      const missingDept = seatedEmps.filter(e => !e.departmentId || !e.department);
      record('HR Attributes', 'All 56 have valid departmentId & department relation', missingDept.length === 0, 0, missingDept.length, missingDept);

      const missingSection = seatedEmps.filter(e => typeof e.section !== 'string' || e.section.trim() === '');
      record('HR Attributes', 'All 56 have populated Section', missingSection.length === 0, 0, missingSection.length, missingSection.map(e => e.employeeCode));

      const missingFunction = seatedEmps.filter(e => typeof e.functionName !== 'string' || e.functionName.trim() === '');
      record('HR Attributes', 'All 56 have populated FunctionName', missingFunction.length === 0, 0, missingFunction.length, missingFunction.map(e => e.employeeCode));

      const missingManager = seatedEmps.filter(e => (!e.reportingManager || e.reportingManager.trim() === '') && (!e.reportingTo || e.reportingTo.trim() === ''));
      record('HR Attributes', 'All 56 have populated Reporting Manager (or Reporting To)', missingManager.length === 0, 0, missingManager.length, missingManager.map(e => e.employeeCode));

      const missingHod = seatedEmps.filter(e => typeof e.hod !== 'string' || e.hod.trim() === '');
      record('HR Attributes', 'All 56 have populated HOD', missingHod.length === 0, 0, missingHod.length, missingHod.map(e => e.employeeCode));

      const missingActiveStatus = seatedEmps.filter(e => typeof e.isActive !== 'boolean');
      record('HR Attributes', 'All 56 have valid boolean isActive', missingActiveStatus.length === 0, 0, missingActiveStatus.length, missingActiveStatus.map(e => e.employeeCode));

      const activeCount = seatedEmps.filter(e => e.isActive === true).length;
      const inactiveCount = seatedEmps.filter(e => e.isActive === false).length;
      record('HR Attributes', 'Active vs Inactive breakdown recorded', true, '56 total', `Active: ${activeCount}, Inactive: ${inactiveCount}`);

      const extCount = seatedEmps.filter(e => e.ext !== null && e.ext !== undefined && String(e.ext).trim() !== '').length;
      record('HR Attributes', 'Ext column empirical check recorded', true, 'recorded', `Populated: ${extCount}, Null: ${56 - extCount}`);

      const bidirectionalSeatLink = seatedEmps.every(e => e.seat && e.seat.employeeId === e.id);
      record('HR Attributes', 'All 56 employees bidirectionally linked to seat', bidirectionalSeatLink, true, bidirectionalSeatLink);
    }

    // -------------------------------------------------------------------------
    // SUMMARY
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('EMPIRICAL VERIFICATION RESULTS SUMMARY');
    console.log('================================================================');
    const totalChecks = verificationResults.length;
    const passedChecks = verificationResults.filter(r => r.passed).length;
    const failedChecks = verificationResults.filter(r => !r.passed).length;
    console.log(`Total Invariant Checks: ${totalChecks}`);
    console.log(`Passed: ${passedChecks}`);
    console.log(`Failed: ${failedChecks}`);

    if (failedChecks > 0) {
      console.log('\n❌ VERDICT: REJECT');
      console.log('Failed Invariants:');
      verificationResults.filter(r => !r.passed).forEach(r => {
        console.log(`- [${r.category}] ${r.name}: Expected ${JSON.stringify(r.expected)}, Got ${JSON.stringify(r.actual)}`);
      });
      process.exitCode = 1;
    } else {
      console.log('\n✅ VERDICT: APPROVE');
      console.log('All empirical invariant checks passed with 100% compliance.');
      process.exitCode = 0;
    }

  } catch (err) {
    console.error('Fatal error during empirical inspection:', err);
    process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

runEmpiricalInspection();
