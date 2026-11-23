import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import xlsx from '../utils/xlsx.js';
import { PrismaClient, SeatPlacementSource } from '@prisma/client';
import argon2 from 'argon2';
import { normalizeAreaName } from '../utils/seat-area.js';
import { normalizeEmpCode, isVacantOrPlaceholder } from '../utils/employee-code.js';

export const ENTERPRISE_COLOR_PALETTE = [
  '#2563EB', // Blue
  '#7C3AED', // Violet
  '#059669', // Emerald
  '#D97706', // Amber
  '#DC2626', // Red
  '#0891B2', // Cyan
  '#4F46E5', // Indigo
  '#EA580C', // Orange
  '#16A34A', // Green
  '#9333EA', // Purple
  '#0D9488', // Teal
  '#E11D48', // Rose
  '#CA8A04', // Yellow
  '#6366F1', // Indigo Accent
  '#0284C7', // Sky Blue
  '#475569', // Slate
];

export interface DumpEmployeeInfo {
  name: string;
  email: string;
  designation: string;
  department: string;
  mobile: string;
  ext?: string | null;
  section?: string | null;
  functionName?: string | null;
  reportingManager?: string | null;
  reportingTo?: string | null;
  hod?: string | null;
  grade?: string | null;
  isActive?: boolean;
}

export function deptToCode(deptName: string): string {
  if (!deptName) return 'GEN';
  const clean = deptName.replace(/[^a-zA-Z0-9\s]/g, '').trim().toUpperCase();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 8);
  const initials = words.map((w) => w[0]).join('').slice(0, 8);
  return initials || 'DEPT';
}

export function findTestDataDirectory(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const possiblePaths = [
    path.resolve(process.cwd(), 'test data'),
    path.resolve(process.cwd(), '../../test data'),
    path.resolve(process.cwd(), '../test data'),
    path.resolve(currentDir, '../../../../test data'),
    path.resolve(currentDir, '../../../test data'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Could not locate 'test data' directory in: ${possiblePaths.join(', ')}`);
}

export interface IngestionResult {
  unitsCount: number;
  plantsCount: number;
  buildingsCount: number;
  floorsCount: number;
  departmentsCount: number;
  workstationsCount: number;
  employeesCount: number;
  unit1Stats: {
    buildings: number;
    floors: number;
    departments: number;
    seats: number;
    occupied: number;
  };
  unit2Stats: {
    buildings: number;
    floors: number;
    departments: number;
    seats: number;
    occupied: number;
  };
}

async function pMap<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, concurrency = 15): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const U2_AUTOCAD_SEAT_LABELS = new Set([
  'WS-201', 'WS-202', 'WS-203', 'WS-204', 'WS-205', 'WS-206', 'WS-207', 'WS-208', 'WS-209', 'WS-210',
  'WS-211', 'WS-212', 'WS-213', 'WS-214', 'WS-215', 'WS-216', 'WS-217', 'WS-218', 'WS-219', 'WS-220',
  'WS-221', 'WS-222', 'WS-223', 'WS-224', 'WS-225', 'WS-226', 'WS-227', 'WS-228', 'WS-229', 'WS-230',
  'WS-231', 'WS-232', 'WS-233', 'WS-234', 'WS-235', 'WS-236', 'WS-237', 'WS-238', 'WS-239', 'WS-240',
  'MEET-01', 'MEET-02', 'MEET-03', 'MEET-04', 'MEET-05', 'MEET-06', 'MEET-07', 'MEET-08', 'MEET-09', 'MEET-10', 'MEET-11', 'MEET-12',
  'CLASS-INS', 'CLASS-01', 'CLASS-02', 'CLASS-03', 'CLASS-04', 'CLASS-05', 'CLASS-06', 'CLASS-07', 'CLASS-08', 'CLASS-09', 'CLASS-10',
  'CLASS-11', 'CLASS-12', 'CLASS-13', 'CLASS-14', 'CLASS-15', 'CLASS-16', 'CLASS-17', 'CLASS-18', 'CLASS-19', 'CLASS-20', 'CLASS-21',
  'CLASS-22', 'CLASS-23', 'CLASS-24', 'RECEP-01',
  'CONF-01', 'CONF-02', 'CONF-03', 'CONF-04', 'CONF-05', 'CONF-06', 'CONF-07', 'CONF-08', 'CONF-09', 'CONF-10', 'CONF-11', 'CONF-12',
  'CONF-13', 'CONF-14', 'CONF-15', 'CONF-16', 'CONF-17', 'CONF-18',
  'MD-EXEC', 'MD-MEET-1', 'MD-MEET-2', 'MD-MEET-3', 'MD-MEET-4',
  'CHAIR-EXEC', 'CHAIR-MEET-1', 'CHAIR-MEET-2', 'CHAIR-MEET-3', 'CHAIR-MEET-4',
  'EXEC-01', 'EXEC-02', 'EXEC-03', 'EXEC-04', 'CORP-01', 'CORP-02', 'FIN-01', 'FIN-02', 'HR-01', 'HR-02', 'HR-03',
  'CABIN-E1', 'CABIN-E2', 'CABIN-E3', 'CABIN-E4', 'OFFICE-W1', 'OFFICE-W2',
  'TR1-TRAINER', 'TR1-T1', 'TR1-T2', 'TR1-T3', 'TR1-T4', 'TR1-T5', 'TR1-T6', 'TR1-T7', 'TR1-T8', 'TR1-T9', 'TR1-T10',
  'TR1-B1', 'TR1-B2', 'TR1-B3', 'TR1-B4', 'TR1-B5', 'TR1-B6', 'TR1-B7', 'TR1-B8', 'TR1-B9', 'TR1-B10',
  'TR1-E1', 'TR1-E2', 'TR1-E3', 'TR1-E4',
  'TR2-TRAINER', 'TR2-T1', 'TR2-T2', 'TR2-T3', 'TR2-T4', 'TR2-T5', 'TR2-T6', 'TR2-T7', 'TR2-T8', 'TR2-T9', 'TR2-T10',
  'TR2-B1', 'TR2-B2', 'TR2-B3', 'TR2-B4', 'TR2-B5', 'TR2-B6', 'TR2-B7', 'TR2-B8', 'TR2-B9', 'TR2-B10',
  'TR2-E1', 'TR2-E2', 'TR2-E3', 'TR2-E4',
]);

interface PreparedSeat {
  floorId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: any;
  departmentId: string;
  assignedEmpId: string | null;
  sortOrder: number;
  officeArea?: string | null;
  zone?: string | null;
  remarks?: string | null;
  pcNumber?: string | null;
}

export async function importExcelData(prisma: PrismaClient): Promise<IngestionResult> {
  const startTime = Date.now();
  console.info('\n===============================================================');
  console.info('[Excel Ingestion] Starting Idempotent Real Excel Data Pipeline');
  console.info('===============================================================');

  const testDataDir = findTestDataDirectory();
  const u1Path = path.join(testDataDir, 'Unit_1_Workstation Details.xlsx');
  const u2Path = path.join(testDataDir, 'Unit_2_Work Station Details.xlsx');

  if (!fs.existsSync(u1Path)) {
    throw new Error(`Unit 1 workbook not found at ${u1Path}`);
  }
  if (!fs.existsSync(u2Path)) {
    throw new Error(`Unit 2 workbook not found at ${u2Path}`);
  }

  // 1. Build Dump employee lookup map from Unit 2 workbook
  console.info('[Excel Ingestion] Parsing Unit 2 "Dump" sheet for master employee lookup...');
  const wb2 = xlsx.readFile(u2Path);
  const dumpMap = new Map<string, DumpEmployeeInfo>();
  const dumpByNameMap = new Map<string, { code: string; info: DumpEmployeeInfo }>();
  const deptToHodMap = new Map<string, string>();

  const unit2RosterSheet = wb2.Sheets['Dump'] || wb2.Sheets['Unit 2 Employee Roster'];
  if (unit2RosterSheet) {
    const dumpRows: any[] = xlsx.utils.sheet_to_json(unit2RosterSheet, { defval: '' });
    for (const r of dumpRows) {
      const code = normalizeEmpCode(r['EmpNo'] || r['Emp Code'] || r['Emp id'] || '');
      const name = String(r['Name'] || r['E. Name'] || '').trim();
      if (code) {
        const ext = String(r['Ext'] || r['Extension'] || r['Intercom'] || r['Ext.'] || r['Ext No'] || r['Phone Ext'] || '').trim() || null;
        const rep = String(r['Reporting Manager'] || r['Report To'] || r['Reporting to'] || '').trim() || null;
        const info: DumpEmployeeInfo = {
          name,
          email: String(r['Email ID(Office)'] || '').trim().toLowerCase(),
          designation: String(r['Designation'] || '').trim(),
          department: String(r['Department'] || r['Function'] || r['Section'] || '').trim(),
          mobile: String(r['Mobile No. (Office)'] || '').trim(),
          ext,
          section: String(r['Section'] || '').trim() || null,
          functionName: String(r['Function'] || '').trim() || null,
          reportingManager: rep || String(r['Reporting to'] || r['manager'] || '').trim() || null,
          reportingTo: rep || String(r['Reporting to'] || r['manager'] || '').trim() || null,
          hod: String(r['Department Head (HOD)'] || r['HOD'] || '').trim() || null,
          grade: String(r['Grade'] || '').trim() || null,
          isActive: String(r['Employee Status'] || r['Active or not'] || '').trim().toLowerCase() !== 'inactive' && String(r['Employee Status'] || r['Active or not'] || '').trim().toLowerCase() !== 'left',
        };
        dumpMap.set(normalizeEmpCode(code), info);
        if (name) {
          dumpByNameMap.set(name.toLowerCase(), { code: normalizeEmpCode(code), info });
        }
        if (info.department && info.hod && info.hod !== '0' && !deptToHodMap.has(info.department.toLowerCase())) {
          deptToHodMap.set(info.department.toLowerCase(), info.hod);
        }
      }
    }
  }
  console.info(`[Excel Ingestion] ✓ Loaded ${dumpMap.size} employee profiles from Dump roster.`);

  // 2. Ensure top-level units 1-5 exist
  const defaultUnits = [
    { name: 'Unit 1', code: 'UNIT-1', location: 'Bhunava' },
    { name: 'Unit 2', code: 'UNIT-2', location: 'Hadamtala' },
    { name: 'Unit 3', code: 'UNIT-3', location: 'Bhunava' },
    { name: 'Unit 4', code: 'UNIT-4', location: 'Bhunava' },
    { name: 'Unit 5', code: 'UNIT-5', location: 'Bhunava' },
  ];

  const unitMap = new Map<string, any>();
  for (const u of defaultUnits) {
    const record = await prisma.unit.upsert({
      where: { code: u.code },
      update: { name: u.name, location: u.location },
      create: { name: u.name, code: u.code, location: u.location },
    });
    unitMap.set(u.code, record);
  }
  console.info(`[Excel Ingestion] ✓ All 5 top-level Units verified.`);

  const unit1 = unitMap.get('UNIT-1');
  const unit2 = unitMap.get('UNIT-2');

  // Track all buildings and floors created
  const buildingMap = new Map<string, any>();
  const floorMap = new Map<string, any>();

  async function getOrCreateBuilding(unitId: string, code: string, name: string) {
    const key = `${unitId}_${code}`;
    if (!buildingMap.has(key)) {
      const existing = await prisma.building.findFirst({
        where: { code, OR: [{ unitId }, { plant: { unitId } }] }
      });
      const bld = existing
        ? await prisma.building.update({ where: { id: existing.id }, data: { name, unitId } })
        : await prisma.building.create({ data: { name, code, unitId } });
      buildingMap.set(key, bld);
    }
    return buildingMap.get(key);
  }

  async function getOrCreateFloor(
    buildingId: string,
    floorNumber: number,
    name: string,
    cWidth = 1600,
    cHeight = 1000,
    imageUrl: string | null = null
  ) {
    const key = `${buildingId}_${floorNumber}`;
    if (!floorMap.has(key)) {
      const flr = await prisma.floor.upsert({
        where: { buildingId_floorNumber: { buildingId, floorNumber } },
        update: { name, canvasWidth: cWidth, canvasHeight: cHeight, ...(imageUrl ? { imageUrl } : {}) },
        create: { name, floorNumber, buildingId, canvasWidth: cWidth, canvasHeight: cHeight, imageUrl },
      });
      floorMap.set(key, flr);
    }
    return floorMap.get(key);
  }

  // Pre-seed Unit 2 Santosh Bhavan & Floors 1, 2, 3
  const santoshBhavan = await getOrCreateBuilding(unit2.id, 'BLD-U2-01', 'Santosh Bhavan');
  const u2F1 = await getOrCreateFloor(santoshBhavan.id, 1, 'Floor 1', 1600, 1000);
  const u2F2 = await getOrCreateFloor(santoshBhavan.id, 2, 'Floor 2', 2400, 1640, '/floor-plans/unit2-floor2.png');
  const u2F3 = await getOrCreateFloor(santoshBhavan.id, 3, 'Floor 3', 1600, 1000);

  // Department caches: unitId -> Map(deptNameUpper -> deptRecord)
  const unitDeptCache = new Map<string, Map<string, any>>();
  const unitDeptCodeCache = new Map<string, Set<string>>();

  const existingDepts = await prisma.department.findMany();
  for (const d of existingDepts) {
    if (d.unitId) {
      if (!unitDeptCache.has(d.unitId)) unitDeptCache.set(d.unitId, new Map());
      if (!unitDeptCodeCache.has(d.unitId)) unitDeptCodeCache.set(d.unitId, new Set());
      unitDeptCache.get(d.unitId)!.set(d.name.trim().toUpperCase(), d);
      unitDeptCodeCache.get(d.unitId)!.add(d.code.trim().toUpperCase());
    }
  }

  async function resolveUnitDepartment(unitId: string, rawDeptName: string): Promise<any> {
    let deptName = (rawDeptName || '').trim();
    if (!deptName || deptName.toLowerCase().includes('vacant') || deptName.toLowerCase().includes('out sour')) {
      deptName = 'General Operations';
    }
    const deptNameUpper = deptName.toUpperCase();

    if (!unitDeptCache.has(unitId)) unitDeptCache.set(unitId, new Map());
    if (!unitDeptCodeCache.has(unitId)) unitDeptCodeCache.set(unitId, new Set());

    const nameMap = unitDeptCache.get(unitId)!;
    const codeSet = unitDeptCodeCache.get(unitId)!;

    if (nameMap.has(deptNameUpper)) {
      return nameMap.get(deptNameUpper);
    }

    const baseCode = deptToCode(deptName);
    let code = baseCode;
    let suffix = 1;
    while (codeSet.has(code.toUpperCase())) {
      code = `${baseCode}_${suffix++}`;
    }

    const colorHex = ENTERPRISE_COLOR_PALETTE[nameMap.size % ENTERPRISE_COLOR_PALETTE.length];

    let record = await prisma.department.findFirst({
      where: {
        unitId,
        name: { equals: deptName, mode: 'insensitive' },
      },
    });

    if (!record) {
      record = await prisma.department.create({
        data: {
          name: deptName,
          code,
          colorHex,
          unitId,
        },
      });
    }

    nameMap.set(deptNameUpper, record);
    codeSet.add(record.code.toUpperCase());
    return record;
  }

  // Pre-load all existing employees to maintain uniqueness
  const existingEmployees = await prisma.employee.findMany();
  const empCodeToRecord = new Map<string, any>();
  const emailToCode = new Map<string, string>();
  for (const emp of existingEmployees) {
    empCodeToRecord.set(normalizeEmpCode(emp.employeeCode), emp);
    if (emp.email) {
      emailToCode.set(emp.email.toLowerCase(), emp.employeeCode);
    }
  }

  // Helper to upsert employee cleanly with Dump enrichment
  async function resolveOrCreateEmployee(
    rawCode: string,
    rawName: string,
    deptId: string,
    fallbackIndex: number,
    extraDetails?: {
      ext?: string | null;
      section?: string | null;
      functionName?: string | null;
      reportingManager?: string | null;
      reportingTo?: string | null;
      hod?: string | null;
      isActive?: boolean;
      officeArea?: string | null;
      subLocation?: string | null;
      deptName?: string | null;
    }
  ): Promise<any> {
    let cleanCode = normalizeEmpCode(rawCode);
    const cleanName = String(rawName || '').trim();

    // Auto-resolve code from Dump roster if missing
    if (!cleanCode || cleanCode === '0') {
      const dumpMatch = dumpByNameMap.get(cleanName.toLowerCase());
      if (dumpMatch?.code) {
        cleanCode = normalizeEmpCode(dumpMatch.code);
      } else {
        const slug = cleanName.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase().slice(0, 15) || 'EMP';
        cleanCode = normalizeEmpCode(`EMP-${slug}-${fallbackIndex}`);
      }
    }

    const fullName = cleanName || `Employee ${cleanCode}`;
    const dumpInfo = dumpMap.get(normalizeEmpCode(cleanCode));

    const ext = extraDetails?.ext !== undefined ? extraDetails.ext : (dumpInfo?.ext || null);
    const section = extraDetails?.section || dumpInfo?.section || null;
    const functionName = extraDetails?.functionName || dumpInfo?.functionName || null;
    const reportingManager = extraDetails?.reportingManager || extraDetails?.reportingTo || dumpInfo?.reportingManager || dumpInfo?.reportingTo || null;
    const reportingTo = extraDetails?.reportingTo || extraDetails?.reportingManager || dumpInfo?.reportingTo || dumpInfo?.reportingManager || null;
    const hod = extraDetails?.hod || dumpInfo?.hod || null;
    const designation = dumpInfo?.designation || null;
    const grade = dumpInfo?.grade || null;
    const phone = dumpInfo?.mobile || null;
    const isActive = extraDetails?.isActive !== undefined ? extraDetails.isActive : (dumpInfo?.isActive !== undefined ? dumpInfo.isActive : true);

    let emailCandidate = dumpInfo?.email || `${cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '')}@shaktiman.com`;
    if (emailToCode.has(emailCandidate) && emailToCode.get(emailCandidate) !== cleanCode) {
      emailCandidate = `${cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '')}.${fallbackIndex}@shaktiman.com`;
    }

    const emp = await prisma.employee.upsert({
      where: { employeeCode: cleanCode },
      update: {
        fullName,
        email: emailCandidate,
        departmentId: deptId,
        ext,
        section,
        functionName,
        reportingManager,
        reportingTo,
        hod,
        isActive,
        officeArea: extraDetails?.officeArea !== undefined ? extraDetails.officeArea : null,
        subLocation: extraDetails?.subLocation !== undefined ? extraDetails.subLocation : null,
        ...(designation ? { designation } : {}),
        ...(grade ? { grade } : {}),
        ...(phone ? { phone } : {}),
      },
      create: {
        employeeCode: cleanCode,
        fullName,
        email: emailCandidate,
        departmentId: deptId,
        ext,
        section,
        functionName,
        reportingManager,
        reportingTo,
        hod,
        isActive,
        officeArea: extraDetails?.officeArea !== undefined ? extraDetails.officeArea : null,
        subLocation: extraDetails?.subLocation !== undefined ? extraDetails.subLocation : null,
        designation,
        grade,
        phone,
      },
    });

    empCodeToRecord.set(normalizeEmpCode(cleanCode), emp);
    emailToCode.set(emailCandidate, cleanCode);
    return emp;
  }

  // Seat grid coordinate generator per floor
  const floorGridCounters = new Map<string, number>();
  function getGridCoordinates(floorId: string, maxCanvasWidth = 1600): { x: number; y: number } {
    const count = floorGridCounters.get(floorId) || 0;
    floorGridCounters.set(floorId, count + 1);

    const cols = Math.max(1, Math.floor((maxCanvasWidth - 160) / 90));
    const col = count % cols;
    const row = Math.floor(count / cols);

    const x = 80 + col * 90;
    const y = 80 + row * 70;
    return { x, y };
  }

  // -------------------------------------------------------------------------
  // 4. CLEANUP DUPLICATE / STALE IMPORTED SEATS (IDEMPOTENT BASELINE RESET)
  // -------------------------------------------------------------------------
  console.info('[Excel Ingestion] Resetting Excel-imported seat assignments to guarantee idempotency...');
  const u1Buildings = await prisma.building.findMany({ where: { unitId: unit1.id } });
  const u1Floors = await prisma.floor.findMany({ where: { buildingId: { in: u1Buildings.map((b) => b.id) } } });
  const u1FloorIds = u1Floors.map((f) => f.id);

  if (u1FloorIds.length > 0) {
    await prisma.seat.deleteMany({ where: { floorId: { in: u1FloorIds } } });
  }
  await prisma.seat.deleteMany({ where: { floorId: { in: [u2F1.id, u2F3.id] } } });
  // On Floor 2, delete non-AutoCAD seats so the 162 calibrated seats remain intact
  const u2F2Seats = await prisma.seat.findMany({ where: { floorId: u2F2.id }, select: { id: true, label: true } });
  const u2F2SeatsToDelete = u2F2Seats.filter((s) => !U2_AUTOCAD_SEAT_LABELS.has(s.label)).map((s) => s.id);
  if (u2F2SeatsToDelete.length > 0) {
    await prisma.seat.deleteMany({ where: { id: { in: u2F2SeatsToDelete } } });
  }
  // Clear any existing employee assignments on the 162 AutoCAD seats so they don't collide
  await prisma.$runCommandRaw({
    update: 'seats',
    updates: [
      {
        q: { floor_id: { $oid: u2F2.id }, employee_id: { $exists: true } },
        u: { $unset: { employee_id: '' } },
        multi: true,
      },
    ],
  });
  console.info('[Excel Ingestion] ✓ Previous imported seats reset cleanly.');

  // Intra-file label tracking per floor: floorId -> Map(baseLabel -> count)
  const seenLabelsCountPerFloor = new Map<string, Map<string, number>>();
  function getDeterministicSeatLabel(floorId: string, baseLabel: string): string {
    if (!seenLabelsCountPerFloor.has(floorId)) {
      seenLabelsCountPerFloor.set(floorId, new Map());
    }
    const counts = seenLabelsCountPerFloor.get(floorId)!;
    const count = (counts.get(baseLabel) || 0) + 1;
    counts.set(baseLabel, count);
    return count === 1 ? baseLabel : `${baseLabel} (${count})`;
  }

  // -------------------------------------------------------------------------
  // 5. IN-MEMORY SEAT PREPARATION (STRICT 1:1 OCCUPANCY RESOLUTION)
  // -------------------------------------------------------------------------
  const preparedSeats: PreparedSeat[] = [];
  const empToSeatMap = new Map<string, PreparedSeat>();

  // 5A. Parse Unit 1 Workbook
  console.info('[Excel Ingestion] Preparing Unit 1 seats...');
  const wb1 = xlsx.readFile(u1Path);
  const u1S1: any[] = xlsx.utils.sheet_to_json(wb1.Sheets['Sheet1'] || {}, { defval: '' });
  const u1S3: any[] = xlsx.utils.sheet_to_json(wb1.Sheets['Sheet3'] || {}, { defval: '' });

  for (let idx = 0; idx < u1S1.length; idx++) {
    const row = u1S1[idx];
    const loc = String(row['Location'] || '').trim();
    const sub = String(row['Sub-location'] || '').trim();
    const wsNo = String(row['WS NO'] || `WS-${idx + 1}`).trim();
    const empCodeRaw = String(row['Emp Code'] || '').trim();
    const empName = String(row['E. Name'] || '').trim();
    const deptName = String(row['Department'] || '').trim();

    const locUpper = loc.toUpperCase();
    const subUpper = sub.toUpperCase();

    let bCode = 'BLD-U1-MFG';
    let bName = 'Main Manufacturing Block';
    let fNum = 1;
    let fName = 'Ground Floor';

    if (locUpper.includes('ADMIN')) {
      bCode = 'BLD-U1-ADM';
      bName = 'Admin Building';
      if (subUpper.includes('GROUND') || subUpper.includes('GF')) { fNum = 1; fName = 'Ground Floor'; }
      else if (subUpper.includes('1ST') || subUpper.includes('FIRST')) { fNum = 2; fName = 'Floor 1'; }
      else if (subUpper.includes('2ND') || subUpper.includes('SECOND')) { fNum = 3; fName = 'Floor 2'; }
      else if (subUpper.includes('3RD') || subUpper.includes('THIRD')) { fNum = 4; fName = 'Floor 3'; }
    } else if (locUpper.includes('R&D')) {
      bCode = 'BLD-U1-RND';
      bName = 'R&D Center';
      if (subUpper.includes('2ND') || subUpper.includes('SECOND')) { fNum = 2; fName = 'Floor 2'; }
      else { fNum = 1; fName = 'Floor 1'; }
    } else if (locUpper.includes('TECHNOLOCY') || locUpper.includes('TECHNOLOGY')) {
      bCode = 'BLD-U1-TECH';
      bName = 'Technology Center';
      fNum = 1; fName = 'Floor 1';
    } else if (locUpper.includes('HR')) {
      bCode = 'BLD-U1-HR';
      bName = 'HR Building';
      if (subUpper.includes('1ST') || subUpper.includes('FIRST')) { fNum = 2; fName = 'Floor 1'; }
      else { fNum = 1; fName = 'Ground Floor'; }
    } else if (locUpper.includes('HTFE')) {
      bCode = 'BLD-U1-HTFE';
      bName = 'HTFE Building';
      if (subUpper.includes('1ST') || subUpper.includes('FIRST')) { fNum = 2; fName = 'Floor 1'; }
      else { fNum = 1; fName = 'Ground Floor'; }
    } else if (locUpper.includes('FE')) {
      bCode = 'BLD-U1-FE';
      bName = 'Farm Equipment Building';
      if (subUpper.includes('1ST') || subUpper.includes('FIRST')) { fNum = 2; fName = 'Floor 1'; }
      else { fNum = 1; fName = 'Ground Floor'; }
    } else if (locUpper.includes('G&T')) {
      bCode = 'BLD-U1-GNT';
      bName = 'Gears & Transmission Building';
      fNum = 1; fName = 'Ground Floor';
    } else if (locUpper.includes('STORE') || locUpper.includes('DISPATCH') || locUpper.includes('SPARE') || locUpper.includes('LOGISTIC')) {
      bCode = 'BLD-U1-STORE';
      bName = 'Central Stores & Logistics';
      fNum = 1; fName = 'Ground Floor';
    } else if (locUpper.includes('QUALITY') || locUpper.includes('I.Q.C') || locUpper.includes('CQ') || locUpper.includes('TESTING') || locUpper.includes('LAB')) {
      bCode = 'BLD-U1-QC';
      bName = 'Quality & Testing Center';
      fNum = 1; fName = 'Ground Floor';
    }

    const bld = await getOrCreateBuilding(unit1.id, bCode, bName);
    const flr = await getOrCreateFloor(bld.id, fNum, fName);
    const dept = await resolveUnitDepartment(unit1.id, deptName);
    const seatLabel = getDeterministicSeatLabel(flr.id, wsNo);

    const vacant = isVacantOrPlaceholder(empCodeRaw, empName);
    let assignedEmpId: string | null = null;
    const rawArea = row['Office / Area'] || row['Sub-location'] || row['Location'];
    const seatOfficeArea = normalizeAreaName(rawArea) || null;
    const seatSubLocation = String(row['Sub-location'] || row['Section'] || '').trim() || null;
    const seatPcNumber = String(row['PC NO'] || row['Desktop No'] || row['PC Number'] || '').trim() || null;

    if (!vacant) {
      const ext = String(row['Ext'] || row['Extension'] || row['Intercom'] || row['Ext.'] || row['Ext No'] || '').trim() || null;
      const section = String(row['Section'] || '').trim() || null;
      const functionName = String(row['Function'] || '').trim() || null;
      const rep = String(row['Reporting Manager'] || row['Reporting to'] || row['Report To'] || '').trim() || null;
      const activeOrNot = String(row['Active or not'] || '').trim().toLowerCase();
      const isActive = activeOrNot !== 'inactive';
      const emp = await resolveOrCreateEmployee(empCodeRaw, empName, dept.id, idx + 1, {
        ext,
        section,
        functionName,
        reportingManager: rep,
        reportingTo: rep,
        isActive,
        officeArea: seatOfficeArea,
        subLocation: seatSubLocation,
        deptName,
      });
      assignedEmpId = emp.id;
    }

    const { x, y } = getGridCoordinates(flr.id, flr.canvasWidth);

    const seatItem: PreparedSeat = {
      floorId: flr.id,
      label: seatLabel,
      x,
      y,
      width: 64,
      height: 48,
      type: 'STANDARD_DESK',
      departmentId: dept.id,
      assignedEmpId,
      sortOrder: preparedSeats.length,
      officeArea: seatOfficeArea,
      zone: seatSubLocation,
      pcNumber: seatPcNumber,
    };

    if (assignedEmpId) {
      const prevSeat = empToSeatMap.get(assignedEmpId);
      if (prevSeat) {
        prevSeat.assignedEmpId = null;
      }
      empToSeatMap.set(assignedEmpId, seatItem);
    }

    preparedSeats.push(seatItem);
  }

  // 5B. Unit 1 Sheet 3 Cabins
  for (let idx = 0; idx < u1S3.length; idx++) {
    const row = u1S3[idx];
    const code = String(row['User Emp.NO.'] || '').trim();
    const userName = String(row['User Name'] || '').trim();
    const officeNo = String(row['Office NO '] || row['TBL NO '] || `CABIN-${idx + 1}`).trim();
    const deptName = String(row['Department'] || '').trim();
    const loc = String(row['Location Name'] || '').trim().toUpperCase();
    const remark = String(row['Remark'] || '').trim().toUpperCase();

    if (code === 'User Emp.NO.' || (!code && !userName)) continue;

    let bCode = 'BLD-U1-ADM';
    let bName = 'Admin Building';
    let fNum = 1;
    let fName = 'Ground Floor';

    if (loc.includes('R&D')) {
      bCode = 'BLD-U1-RND'; bName = 'R&D Center';
      fNum = remark.includes('2') ? 2 : 1;
      fName = remark.includes('2') ? 'Floor 2' : 'Floor 1';
    } else if (loc.includes('HTFE')) {
      bCode = 'BLD-U1-HTFE'; bName = 'HTFE Building';
      fNum = remark.includes('1') ? 2 : 1;
      fName = fNum === 2 ? 'Floor 1' : 'Ground Floor';
    } else if (loc.includes('FE')) {
      bCode = 'BLD-U1-FE'; bName = 'Farm Equipment Building';
      fNum = 1; fName = 'Floor 1';
    } else if (loc.includes('HR')) {
      bCode = 'BLD-U1-HR'; bName = 'HR Building';
      fNum = remark.includes('1') ? 2 : 1;
      fName = fNum === 2 ? 'Floor 1' : 'Ground Floor';
    } else {
      bCode = 'BLD-U1-ADM'; bName = 'Admin Building';
      if (remark.includes('GROUND') || remark.includes('00')) { fNum = 1; fName = 'Ground Floor'; }
      else if (remark.includes('1ST') || remark.includes('1 FLOOR')) { fNum = 2; fName = 'Floor 1'; }
      else if (remark.includes('2ND') || remark.includes('2 FLOOR')) { fNum = 3; fName = 'Floor 2'; }
      else if (remark.includes('3') || remark.includes('3 FLOOR')) { fNum = 4; fName = 'Floor 3'; }
    }

    const bld = await getOrCreateBuilding(unit1.id, bCode, bName);
    const flr = await getOrCreateFloor(bld.id, fNum, fName);
    const dept = await resolveUnitDepartment(unit1.id, deptName);

    const baseCabinLabel = `OFFICE-${officeNo.replace(/\s+/g, '')}`;
    const seatLabel = getDeterministicSeatLabel(flr.id, baseCabinLabel);

    const vacant = isVacantOrPlaceholder(code, userName);
    let assignedEmpId: string | null = null;
    const rawCabinArea = row['Location Name'] || loc || 'Admin Office';
    const cabinOfficeArea = normalizeAreaName(rawCabinArea) || null;
    const cabinZone = String(row['Remark'] || remark || 'Executive Cabin Zone').trim() || null;
    const cabinPc = String(row['PC NO'] || row['Desktop No'] || '').trim() || null;

    if (!vacant) {
      const ext = String(row['Ext'] || row['Extension'] || row['Intercom'] || row['Ext.'] || row['Ext No'] || '').trim() || null;
      const emp = await resolveOrCreateEmployee(code, userName, dept.id, 1000 + idx, {
        ext,
        officeArea: cabinOfficeArea,
        subLocation: cabinZone,
      });
      assignedEmpId = emp.id;
    }

    const { x, y } = getGridCoordinates(flr.id, flr.canvasWidth);

    const seatItem: PreparedSeat = {
      floorId: flr.id,
      label: seatLabel,
      x,
      y,
      width: 72,
      height: 54,
      type: 'CABIN',
      departmentId: dept.id,
      assignedEmpId,
      sortOrder: preparedSeats.length,
      officeArea: cabinOfficeArea,
      zone: cabinZone,
      pcNumber: cabinPc,
    };

    if (assignedEmpId) {
      const prevSeat = empToSeatMap.get(assignedEmpId);
      if (prevSeat) {
        prevSeat.assignedEmpId = null;
      }
      empToSeatMap.set(assignedEmpId, seatItem);
    }

    preparedSeats.push(seatItem);
  }

  // 5C. Unit 2 Update data
  console.info('[Excel Ingestion] Preparing Unit 2 seats...');
  const u2FixedSheet = wb2.Sheets['Unit 2 Seat Allocation'];
  const u2SeatSheet = wb2.Sheets['Update data'] || u2FixedSheet || {};
  const u2Update: any[] = xlsx.utils.sheet_to_json(u2SeatSheet, { defval: '' });
  const isFixedUnit2Allocation = Boolean(!wb2.Sheets['Update data'] && u2FixedSheet);

  for (let idx = 0; idx < u2Update.length; idx++) {
    const row = u2Update[idx];
    const sub = String(row['Sub-location'] || row['Floor'] || '').trim().toLowerCase();
    const office = String(row['Office / Area'] || row['Office'] || '').trim();
    const wsNo = String(row['WS NO'] || row['Seat'] || `WS-${idx + 1}`).trim();
    const empCodeRaw = String(row['Emp Code'] || row['Emp id'] || '').trim();
    const empName = String(row['E. Name'] || '').trim();
    const deptName = String(row['Department'] || row['Function'] || row['Section'] || '').trim();

    let targetFloor = u2F1;
    if (sub.includes('1st') || sub.includes('first') || sub === '2' || sub.includes('floor 2')) targetFloor = u2F2;
    else if (sub.includes('2nd') || sub.includes('second') || sub === '3' || sub.includes('floor 3')) targetFloor = u2F3;

    const dept = await resolveUnitDepartment(unit2.id, deptName);

    const officeCode = office ? office.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() : '';
    const baseLabel = isFixedUnit2Allocation ? wsNo : (officeCode ? `${officeCode}-${wsNo}` : wsNo);
    const seatLabel = getDeterministicSeatLabel(targetFloor.id, baseLabel);

    const vacant = isVacantOrPlaceholder(empCodeRaw, empName);
    let assignedEmpId: string | null = null;
    const rawU2Area = row['Office / Area'] || row['Office'] || office || sub || 'Santosh Bhavan Workstation Bay';
    const u2OfficeArea = normalizeAreaName(rawU2Area) || null;
    const u2SubLocation = String(row['Sub-location'] || row['Floor'] || sub || '').trim() || null;
    const u2PcNumber = String(row['PC NO'] || row['Desktop No'] || row['PC Number'] || '').trim() || null;

    if (!vacant) {
      const ext = String(row['Ext'] || row['Extension'] || row['Intercom'] || row['Ext.'] || row['Ext No'] || '').trim() || null;
      const section = String(row['Section'] || '').trim() || null;
      const functionName = String(row['Function'] || '').trim() || null;
      const rep = String(row['Reporting Manager'] || row['Reporting to'] || row['Report To'] || '').trim() || null;
      const hod = String(row['HOD'] || '').trim() || null;
      const activeOrNot = String(row['Active or not'] || '').trim().toLowerCase();
      const isActive = activeOrNot !== 'inactive';
      const emp = await resolveOrCreateEmployee(empCodeRaw, empName, dept.id, 2000 + idx, {
        ext,
        section,
        functionName,
        reportingManager: rep,
        reportingTo: rep,
        hod,
        isActive,
        officeArea: u2OfficeArea,
        subLocation: u2SubLocation,
        deptName,
      });
      assignedEmpId = emp.id;
    }

    const { x, y } = getGridCoordinates(targetFloor.id, targetFloor.canvasWidth);
    const seatType = seatLabel.includes('CABIN') ? 'CABIN' : 'STANDARD_DESK';

    const seatItem: PreparedSeat = {
      floorId: targetFloor.id,
      label: seatLabel,
      x,
      y,
      width: seatType === 'CABIN' ? 72 : 64,
      height: seatType === 'CABIN' ? 54 : 48,
      type: seatType,
      departmentId: dept.id,
      assignedEmpId,
      sortOrder: preparedSeats.length,
      officeArea: u2OfficeArea,
      zone: u2SubLocation,
      pcNumber: u2PcNumber,
    };

    if (assignedEmpId) {
      const prevSeat = empToSeatMap.get(assignedEmpId);
      if (prevSeat) {
        prevSeat.assignedEmpId = null;
      }
      empToSeatMap.set(assignedEmpId, seatItem);
    }

    preparedSeats.push(seatItem);
  }

  // -------------------------------------------------------------------------
  // 6. PERSIST ALL PREPARED SEATS TO DATABASE
  // -------------------------------------------------------------------------
  console.info(`[Excel Ingestion] Persisting ${preparedSeats.length} workstations to MongoDB...`);
  await pMap(
    preparedSeats,
    async (item) => {
      await prisma.seat.create({
        data: {
          floorId: item.floorId,
          label: item.label,
          x: item.x,
          y: item.y,
          // Workbook rows are arranged for a readable logical list, not an
          // architectural map. Keep their generated grid distinct from a
          // reviewed physical workstation placement.
          placementSource: SeatPlacementSource.LEGACY_AUTO,
          width: item.width,
          height: item.height,
          type: item.type,
          status: 'AVAILABLE',
          departmentId: item.departmentId,
          officeArea: item.officeArea || null,
          zone: item.zone || null,
          remarks: item.remarks || null,
          pcNumber: item.pcNumber || null,
          ...(item.assignedEmpId ? { employeeId: item.assignedEmpId } : {}),
        },
      });
    },
    15
  );
  console.info(`[Excel Ingestion] ✓ All ${preparedSeats.length} workstations persisted successfully.`);

  // Ensure AutoCAD seats on Floor 2 have calibrated officeArea set
  const cadSeats = await prisma.seat.findMany({ where: { floorId: u2F2.id } });
  for (const s of cadSeats) {
    if (!s.officeArea) {
      const lbl = s.label.toUpperCase();
      let area = 'Main Workstation Bay';
      if (lbl.startsWith('WS-20') || lbl.startsWith('WS-210') || lbl.startsWith('WS-211') || lbl.startsWith('WS-212')) {
        area = 'South Bay 1 - Engineering';
      } else if (lbl.startsWith('WS-21') || lbl.startsWith('WS-220') || lbl.startsWith('WS-221') || lbl.startsWith('WS-222') || lbl.startsWith('WS-223') || lbl.startsWith('WS-224')) {
        area = 'South Bay 2 - Product';
      } else if (lbl.startsWith('WS-22') || lbl.startsWith('WS-23') || lbl.startsWith('WS-240')) {
        area = 'South Bay 3 - Design & Marketing';
      } else if (lbl.startsWith('MEET')) {
        area = 'Meeting Bay';
      } else if (lbl.startsWith('CLASS')) {
        area = 'Training Wing - Classroom';
      } else if (lbl.startsWith('RECEP')) {
        area = 'Main Reception Area';
      } else if (lbl.startsWith('CONF')) {
        area = 'North Board Conference Hall';
      } else if (lbl.startsWith('MD-')) {
        area = 'Executive Suite - MD Wing';
      } else if (lbl.startsWith('CHAIR-')) {
        area = 'Executive Suite - Chairman Wing';
      } else if (lbl.startsWith('CABIN-E')) {
        area = 'East Executive Cabins';
      } else if (lbl.startsWith('OFFICE-W')) {
        area = 'West Management Offices';
      } else if (lbl.startsWith('TR1')) {
        area = 'Training Center 1';
      } else if (lbl.startsWith('TR2')) {
        area = 'Training Center 2';
      }
      await prisma.seat.update({
        where: { id: s.id },
        data: { officeArea: area, zone: 'Santosh Bhavan Floor 2' },
      });
    }
  }

  // -------------------------------------------------------------------------
  // 7. PRESERVE & LINK DEMO RBAC ACCOUNTS
  // -------------------------------------------------------------------------
  console.info('[Excel Ingestion] Preserving and verifying 6 demo RBAC accounts...');
  const DEMO_PASSWORD = process.env.DEMO_PASSWORD || randomBytes(32).toString('base64url');
  const TECH_ADMIN_EMAIL = process.env.TECH_ADMIN_EMAIL || 'techadmin@shaktiman.com';
  const TECH_ADMIN_PASSWORD = process.env.TECH_ADMIN_PASSWORD || randomBytes(32).toString('base64url');
  const demoHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });
  const techHash = await argon2.hash(TECH_ADMIN_PASSWORD, { type: argon2.argon2id });

  await prisma.adminUser.upsert({
    where: { email: TECH_ADMIN_EMAIL },
    update: {
      name: 'Technology Administrator (Global Control)',
      role: 'TECH_ADMIN' as any,
      assignedUnitId: null,
      departmentId: null,
      employeeId: null,
    },
    create: {
      email: TECH_ADMIN_EMAIL,
      name: 'Technology Administrator (Global Control)',
      passwordHash: techHash,
      role: 'TECH_ADMIN' as any,
    },
  });

  // 1. Super Admin
  await prisma.adminUser.upsert({
    where: { email: 'superadmin@shaktiman.com' },
    update: { name: 'Super Admin (Global God Mode)', role: 'SUPER_ADMIN' as any },
    create: { email: 'superadmin@shaktiman.com', name: 'Super Admin (Global God Mode)', passwordHash: demoHash, role: 'SUPER_ADMIN' as any },
  });

  // 2. Unit Admins for Units 1 to 5
  const allUnitsForDemo = await prisma.unit.findMany();
  for (let i = 1; i <= 5; i++) {
    const targetUnit = allUnitsForDemo.find((u) => u.code === `UNIT-${i}` || u.name === `Unit ${i}`) || (i === 1 ? unit1 : (i === 2 ? unit2 : null));
    const targetUnitId = targetUnit?.id || null;

    await prisma.adminUser.upsert({
      where: { email: `unit${i}.admin@shaktiman.com` },
      update: { name: `Unit ${i} Admin`, role: 'UNIT_ADMIN' as any, assignedUnitId: targetUnitId },
      create: { email: `unit${i}.admin@shaktiman.com`, name: `Unit ${i} Admin`, passwordHash: demoHash, role: 'UNIT_ADMIN' as any, assignedUnitId: targetUnitId },
    });
  }

  console.info('[Excel Ingestion] ✓ All 6 demo RBAC accounts verified.');

  // -------------------------------------------------------------------------
  // 8. COMPUTE EXACT DATABASE COUNTS
  // -------------------------------------------------------------------------
  const [totalUnits, totalPlants, totalBuildings, totalFloors, totalDepartments, totalWorkstations, totalEmployees] =
    await Promise.all([
      prisma.unit.count(),
      prisma.plant.count(),
      prisma.building.count(),
      prisma.floor.count(),
      prisma.department.count(),
      prisma.seat.count(),
      prisma.employee.count(),
    ]);

  // Unit 1 breakdown
  const finalU1Floors = await prisma.floor.findMany({ where: { buildingId: { in: u1Buildings.map((b) => b.id) } } });
  const finalU1FloorIds = finalU1Floors.map((f) => f.id);
  const [u1DeptsCount, u1DbSeats, u1OccupiedSeats] = await Promise.all([
    prisma.department.count({ where: { unitId: unit1.id } }),
    prisma.seat.count({ where: { floorId: { in: finalU1FloorIds } } }),
    prisma.seat.count({ where: { floorId: { in: finalU1FloorIds }, employeeId: { not: null } } }),
  ]);

  // Unit 2 breakdown
  const [u2DeptsCount, u2DbSeats, u2OccupiedSeats] = await Promise.all([
    prisma.department.count({ where: { unitId: unit2.id } }),
    prisma.seat.count({ where: { floorId: { in: [u2F1.id, u2F2.id, u2F3.id] } } }),
    prisma.seat.count({ where: { floorId: { in: [u2F1.id, u2F2.id, u2F3.id] }, employeeId: { not: null } } }),
  ]);

  const elapsed = Date.now() - startTime;
  console.info('\n===============================================================');
  console.info(`[Excel Ingestion] ✓ Finished Real Excel Ingestion in ${elapsed}ms`);
  console.info('===============================================================');
  console.info(`Total Units:                  ${totalUnits}`);
  console.info(`Total Plants:                 ${totalPlants}`);
  console.info(`Total Buildings:              ${totalBuildings}`);
  console.info(`Total Floors:                 ${totalFloors}`);
  console.info(`Total Unit-Scoped Depts:      ${totalDepartments}`);
  console.info(`Total Workstations:           ${totalWorkstations}`);
  console.info(`Total Employees:              ${totalEmployees}`);
  console.info(`---------------------------------------------------------------`);
  console.info(`Unit 1: ${u1Buildings.length} Buildings | ${finalU1Floors.length} Floors | ${u1DeptsCount} Depts | ${u1DbSeats} Seats (${u1OccupiedSeats} Occupied)`);
  console.info(`Unit 2: 1 Buildings | 3 Floors | ${u2DeptsCount} Depts | ${u2DbSeats} Seats (${u2OccupiedSeats} Occupied)`);
  console.info('===============================================================\n');

  return {
    unitsCount: totalUnits,
    plantsCount: totalPlants,
    buildingsCount: totalBuildings,
    floorsCount: totalFloors,
    departmentsCount: totalDepartments,
    workstationsCount: totalWorkstations,
    employeesCount: totalEmployees,
    unit1Stats: {
      buildings: u1Buildings.length,
      floors: finalU1Floors.length,
      departments: u1DeptsCount,
      seats: u1DbSeats,
      occupied: u1OccupiedSeats,
    },
    unit2Stats: {
      buildings: 1,
      floors: 3,
      departments: u2DeptsCount,
      seats: u2DbSeats,
      occupied: u2OccupiedSeats,
    },
  };
}
