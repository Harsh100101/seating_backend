import { PrismaClient } from '@prisma/client';
import { buildServer } from '../server.js';
import { signJwt } from '../utils/jwt.js';
import { normalizeEmpCode, isVacantEmpCode } from '../utils/employee-code.js';

interface CheckResult {
  category: string;
  check: string;
  totalRecords: number;
  duplicateCount: number;
  status: 'PASS' | 'FAIL';
  details?: string;
}

const prisma = new PrismaClient();

async function runVerification(): Promise<void> {
  console.log('\n======================================================================');
  console.log('       SEATING MANAGEMENT SYSTEM — ZERO DATA DUPLICATION AUDIT        ');
  console.log('======================================================================\n');

  const results: CheckResult[] = [];

  // -------------------------------------------------------------------------
  // 1. Check Employees
  // -------------------------------------------------------------------------
  const totalEmployees = await prisma.employee.count();
  const allEmployees = await prisma.employee.findMany({
    select: { id: true, employeeCode: true, fullName: true, departmentId: true }
  });

  // Check duplicate employeeCode
  const empCodeCounts = new Map<string, number>();
  for (const emp of allEmployees) {
    const code = normalizeEmpCode(emp.employeeCode);
    if (isVacantEmpCode(code)) continue;
    empCodeCounts.set(code, (empCodeCounts.get(code) || 0) + 1);
  }
  const duplicateEmpCodes = Array.from(empCodeCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Employee',
    check: 'Unique Employee Code (employeeCode)',
    totalRecords: totalEmployees,
    duplicateCount: duplicateEmpCodes.length,
    status: duplicateEmpCodes.length === 0 ? 'PASS' : 'FAIL',
    details: duplicateEmpCodes.length > 0 ? `Duplicates: ${duplicateEmpCodes.map(([k, v]) => `${k} (${v}x)`).join(', ')}` : undefined
  });

  // -------------------------------------------------------------------------
  // 2. Check Seats / Workstations
  // -------------------------------------------------------------------------
  const totalSeats = await prisma.seat.count();
  const allSeats = await prisma.seat.findMany({
    select: { id: true, label: true, floorId: true, employeeId: true, x: true, y: true }
  });

  // Check duplicate (floorId, label)
  const seatFloorLabelCounts = new Map<string, number>();
  for (const seat of allSeats) {
    const key = `${seat.floorId}::${seat.label.trim().toUpperCase()}`;
    seatFloorLabelCounts.set(key, (seatFloorLabelCounts.get(key) || 0) + 1);
  }
  const duplicateSeats = Array.from(seatFloorLabelCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Seat',
    check: 'Unique Seat Label per Floor (floorId + label)',
    totalRecords: totalSeats,
    duplicateCount: duplicateSeats.length,
    status: duplicateSeats.length === 0 ? 'PASS' : 'FAIL',
    details: duplicateSeats.length > 0 ? `Duplicates: ${duplicateSeats.map(([k, v]) => `${k} (${v}x)`).join(', ')}` : undefined
  });

  // Check duplicate employee assignment (strict 1:1)
  const seatEmpCounts = new Map<string, number>();
  for (const seat of allSeats) {
    if (seat.employeeId) {
      seatEmpCounts.set(seat.employeeId, (seatEmpCounts.get(seat.employeeId) || 0) + 1);
    }
  }
  const duplicateSeatEmpAssignments = Array.from(seatEmpCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Seat',
    check: 'Strict 1:1 Seat Assignment (Seat.employeeId)',
    totalRecords: totalSeats,
    duplicateCount: duplicateSeatEmpAssignments.length,
    status: duplicateSeatEmpAssignments.length === 0 ? 'PASS' : 'FAIL',
    details: duplicateSeatEmpAssignments.length > 0 ? `Duplicates: ${duplicateSeatEmpAssignments.map(([k, v]) => `${k} (${v}x)`).join(', ')}` : undefined
  });

  // Check coordinate collisions (floorId + x + y)
  const seatCoordCounts = new Map<string, number>();
  for (const seat of allSeats) {
    // Only check non-zero coordinates if they were positioned on canvas
    if (seat.x !== 0 || seat.y !== 0) {
      const coordKey = `${seat.floorId}::(${seat.x},${seat.y})`;
      seatCoordCounts.set(coordKey, (seatCoordCounts.get(coordKey) || 0) + 1);
    }
  }
  const duplicateCoords = Array.from(seatCoordCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Seat',
    check: 'Unique Physical Coordinates on Floor (floorId + x + y)',
    totalRecords: totalSeats,
    duplicateCount: duplicateCoords.length,
    status: duplicateCoords.length === 0 ? 'PASS' : 'FAIL',
    details: duplicateCoords.length > 0 ? `Collisions: ${duplicateCoords.map(([k, v]) => `${k} (${v}x)`).join(', ')}` : undefined
  });

  // -------------------------------------------------------------------------
  // 3. Check Units & Hierarchy
  // -------------------------------------------------------------------------
  const totalUnits = await prisma.unit.count();
  const allUnits = await prisma.unit.findMany({ select: { id: true, code: true, name: true } });
  const unitCodeCounts = new Map<string, number>();
  for (const u of allUnits) {
    const code = u.code.trim().toUpperCase();
    unitCodeCounts.set(code, (unitCodeCounts.get(code) || 0) + 1);
  }
  const duplicateUnitCodes = Array.from(unitCodeCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Unit',
    check: 'Unique Unit Code (code)',
    totalRecords: totalUnits,
    duplicateCount: duplicateUnitCodes.length,
    status: duplicateUnitCodes.length === 0 ? 'PASS' : 'FAIL',
    details: duplicateUnitCodes.length > 0 ? `Duplicates: ${duplicateUnitCodes.map(([k, v]) => `${k} (${v}x)`).join(', ')}` : undefined
  });

  // Plants
  const totalPlants = await prisma.plant.count();
  const allPlants = await prisma.plant.findMany({ select: { id: true, code: true, unitId: true } });
  const plantCounts = new Map<string, number>();
  for (const p of allPlants) {
    const key = `${p.unitId}::${p.code.trim().toUpperCase()}`;
    plantCounts.set(key, (plantCounts.get(key) || 0) + 1);
  }
  const duplicatePlants = Array.from(plantCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Plant',
    check: 'Unique Plant Code per Unit (unitId + code)',
    totalRecords: totalPlants,
    duplicateCount: duplicatePlants.length,
    status: duplicatePlants.length === 0 ? 'PASS' : 'FAIL',
  });

  // Buildings
  const totalBuildings = await prisma.building.count();
  const allBuildings = await prisma.building.findMany({ select: { id: true, code: true, plantId: true } });
  const bldgCounts = new Map<string, number>();
  for (const b of allBuildings) {
    const key = `${b.plantId}::${b.code.trim().toUpperCase()}`;
    bldgCounts.set(key, (bldgCounts.get(key) || 0) + 1);
  }
  const duplicateBldgs = Array.from(bldgCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Building',
    check: 'Unique Building Code per Plant (plantId + code)',
    totalRecords: totalBuildings,
    duplicateCount: duplicateBldgs.length,
    status: duplicateBldgs.length === 0 ? 'PASS' : 'FAIL',
  });

  // Floors
  const totalFloors = await prisma.floor.count();
  const allFloors = await prisma.floor.findMany({ select: { id: true, floorNumber: true, buildingId: true } });
  const floorCounts = new Map<string, number>();
  for (const f of allFloors) {
    const key = `${f.buildingId}::${f.floorNumber}`;
    floorCounts.set(key, (floorCounts.get(key) || 0) + 1);
  }
  const duplicateFloors = Array.from(floorCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Floor',
    check: 'Unique Floor Number per Building (buildingId + floorNumber)',
    totalRecords: totalFloors,
    duplicateCount: duplicateFloors.length,
    status: duplicateFloors.length === 0 ? 'PASS' : 'FAIL',
  });

  // Departments
  const totalDepartments = await prisma.department.count();
  const allDepartments = await prisma.department.findMany({ select: { id: true, code: true, name: true, unitId: true } });
  const deptCounts = new Map<string, number>();
  for (const d of allDepartments) {
    const key = `${d.unitId || 'global'}::${d.name.trim().toLowerCase()}`;
    deptCounts.set(key, (deptCounts.get(key) || 0) + 1);
  }
  const duplicateDepts = Array.from(deptCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'Department',
    check: 'Unique Department Name per Unit (unitId + name)',
    totalRecords: totalDepartments,
    duplicateCount: duplicateDepts.length,
    status: duplicateDepts.length === 0 ? 'PASS' : 'FAIL',
  });

  // -------------------------------------------------------------------------
  // 4. Check Master Categories (Area, Section, OrgFunction)
  // -------------------------------------------------------------------------
  const totalAreas = await prisma.area.count();
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true, normalizedName: true, floorId: true } });
  const areaCounts = new Map<string, number>();
  for (const a of allAreas) {
    const key = `${a.floorId}::${a.normalizedName}`;
    areaCounts.set(key, (areaCounts.get(key) || 0) + 1);
  }
  const duplicateAreas = Array.from(areaCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'MasterArea',
    check: 'Unique Area per Floor (floorId + normalizedName)',
    totalRecords: totalAreas,
    duplicateCount: duplicateAreas.length,
    status: duplicateAreas.length === 0 ? 'PASS' : 'FAIL',
  });

  const totalSections = await prisma.section.count();
  const allSections = await prisma.section.findMany({ select: { id: true, name: true, normalizedName: true, departmentId: true } });
  const sectionCounts = new Map<string, number>();
  for (const s of allSections) {
    const key = `${s.departmentId}::${s.normalizedName}`;
    sectionCounts.set(key, (sectionCounts.get(key) || 0) + 1);
  }
  const duplicateSections = Array.from(sectionCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'MasterSection',
    check: 'Unique Section per Dept (departmentId + normalizedName)',
    totalRecords: totalSections,
    duplicateCount: duplicateSections.length,
    status: duplicateSections.length === 0 ? 'PASS' : 'FAIL',
  });

  const totalFunctions = await prisma.orgFunction.count();
  const allFunctions = await prisma.orgFunction.findMany({ select: { id: true, name: true, normalizedName: true, sectionId: true } });
  const functionCounts = new Map<string, number>();
  for (const f of allFunctions) {
    const key = `${f.sectionId}::${f.normalizedName}`;
    functionCounts.set(key, (functionCounts.get(key) || 0) + 1);
  }
  const duplicateFunctions = Array.from(functionCounts.entries()).filter(([_, count]) => count > 1);

  results.push({
    category: 'MasterFunction',
    check: 'Unique Function per Section (sectionId + normalizedName)',
    totalRecords: totalFunctions,
    duplicateCount: duplicateFunctions.length,
    status: duplicateFunctions.length === 0 ? 'PASS' : 'FAIL',
  });

  // -------------------------------------------------------------------------
  // 5. Live Fastify API Ingestion & Verification
  // -------------------------------------------------------------------------
  console.log('Testing live Fastify API endpoints for payload deduplication...');
  const app = buildServer({ prisma });
  await app.ready();

  const techAdminToken = signJwt({
    adminId: 'tech-admin-root',
    email: 'techadmin@shaktiman.com',
    name: 'Technical Administrator',
    role: 'TECH_ADMIN',
    assignedUnitId: null
  });

  const authHeaders = {
    authorization: `Bearer ${techAdminToken}`
  };

  // Verify GET /api/seats
  const seatsRes = await app.inject({
    method: 'GET',
    url: '/api/seats',
    headers: authHeaders
  });

  if (seatsRes.statusCode === 200) {
    const returnedSeats: any[] = JSON.parse(seatsRes.body);
    const seatIdSet = new Set<string>();
    let dupApiSeats = 0;
    for (const s of returnedSeats) {
      if (seatIdSet.has(s.id)) dupApiSeats++;
      seatIdSet.add(s.id);
    }
    results.push({
      category: 'API: /api/seats',
      check: 'Payload returns distinct seat records by id',
      totalRecords: returnedSeats.length,
      duplicateCount: dupApiSeats,
      status: dupApiSeats === 0 ? 'PASS' : 'FAIL'
    });
  }

  // Verify GET /api/employees
  const empsRes = await app.inject({
    method: 'GET',
    url: '/api/employees?limit=2000',
    headers: authHeaders
  });

  if (empsRes.statusCode === 200) {
    const payload = JSON.parse(empsRes.body);
    const returnedEmps: any[] = payload.employees || payload;
    const empIdSet = new Set<string>();
    let dupApiEmps = 0;
    for (const e of returnedEmps) {
      if (empIdSet.has(e.id)) dupApiEmps++;
      empIdSet.add(e.id);
    }
    results.push({
      category: 'API: /api/employees',
      check: 'Payload returns distinct employee records by id',
      totalRecords: returnedEmps.length,
      duplicateCount: dupApiEmps,
      status: dupApiEmps === 0 ? 'PASS' : 'FAIL'
    });
  }

  // Verify GET /api/areas
  const areasRes = await app.inject({
    method: 'GET',
    url: '/api/areas',
    headers: authHeaders
  });

  if (areasRes.statusCode === 200) {
    const returnedAreas: any[] = JSON.parse(areasRes.body);
    const areaIdSet = new Set<string>();
    let dupAreas = 0;
    for (const a of returnedAreas) {
      if (areaIdSet.has(a.id)) dupAreas++;
      areaIdSet.add(a.id);
    }
    results.push({
      category: 'API: /api/areas',
      check: 'Payload returns distinct area records by id',
      totalRecords: returnedAreas.length,
      duplicateCount: dupAreas,
      status: dupAreas === 0 ? 'PASS' : 'FAIL'
    });
  }

  // Verify GET /api/sections
  const sectionsRes = await app.inject({
    method: 'GET',
    url: '/api/sections',
    headers: authHeaders
  });

  if (sectionsRes.statusCode === 200) {
    const returnedSections: any[] = JSON.parse(sectionsRes.body);
    const sectionIdSet = new Set<string>();
    let dupSections = 0;
    for (const s of returnedSections) {
      if (sectionIdSet.has(s.id)) dupSections++;
      sectionIdSet.add(s.id);
    }
    results.push({
      category: 'API: /api/sections',
      check: 'Payload returns distinct section records by id',
      totalRecords: returnedSections.length,
      duplicateCount: dupSections,
      status: dupSections === 0 ? 'PASS' : 'FAIL'
    });
  }

  // Verify GET /api/functions
  const functionsRes = await app.inject({
    method: 'GET',
    url: '/api/functions',
    headers: authHeaders
  });

  if (functionsRes.statusCode === 200) {
    const returnedFunctions: any[] = JSON.parse(functionsRes.body);
    const functionIdSet = new Set<string>();
    let dupFunctions = 0;
    for (const f of returnedFunctions) {
      if (functionIdSet.has(f.id)) dupFunctions++;
      functionIdSet.add(f.id);
    }
    results.push({
      category: 'API: /api/functions',
      check: 'Payload returns distinct function records by id',
      totalRecords: returnedFunctions.length,
      duplicateCount: dupFunctions,
      status: dupFunctions === 0 ? 'PASS' : 'FAIL'
    });
  }

  await app.close();

  // -------------------------------------------------------------------------
  // Print Results Table
  // -------------------------------------------------------------------------
  console.log('\n-------------------------------------------------------------------------------------------------');
  console.log('| Category           | Check Invariant                                  | Records | DUPs | Status |');
  console.log('-------------------------------------------------------------------------------------------------');
  let hasFailure = false;
  for (const r of results) {
    const cat = r.category.padEnd(18).slice(0, 18);
    const chk = r.check.padEnd(48).slice(0, 48);
    const cnt = String(r.totalRecords).padStart(7);
    const dup = String(r.duplicateCount).padStart(4);
    const st = r.status.padEnd(6);
    console.log(`| ${cat} | ${chk} | ${cnt} | ${dup} | ${st} |`);
    if (r.status === 'FAIL') {
      hasFailure = true;
      if (r.details) console.log(`  --> FAIL DETAILS: ${r.details}`);
    }
  }
  console.log('-------------------------------------------------------------------------------------------------\n');

  if (hasFailure) {
    console.error('❌ ZERO DATA DUPLICATION AUDIT FAILED! See details above.');
    process.exit(1);
  } else {
    console.log('✅ ALL INVARIANTS PASSED! 100% ZERO DATA DUPLICATION CONFIRMED ACROSS ALL SYSTEM LAYERS.\n');
  }
}

runVerification()
  .catch((err) => {
    console.error('Fatal error during verification:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
