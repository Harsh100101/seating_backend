// apps/backend/prisma/seed.ts
/**
 * Database Seeding Script for Company Seating Management System (Phase 1 MVP)
 *
 * Seeds:
 * 1. Default Admin User with Argon2id password hash (from environment variables or defaults)
 * 2. 8 Representative Corporate Departments with unique codes and canvas hex colors
 *
 * Execution:
 * - pnpm --filter @seating/backend db:seed
 * - npx prisma db seed (via package.json "prisma.seed" configuration)
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { importExcelData } from '../src/services/excel-importer.service.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

// Re-export for universal importer access
export { importExcelData };

// ---------------------------------------------------------------------------
// Environment Configuration
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: false, quiet: true });
}

const generatedBootstrapPassword = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------
// Constants & Department Definitions
// ---------------------------------------------------------------------------
export interface DepartmentSeedData {
  name: string;
  code: string;
  colorHex: string;
}

export const DEFAULT_DEPARTMENTS: readonly DepartmentSeedData[] = [
  { name: 'Engineering', code: 'ENG', colorHex: '#2563EB' },
  { name: 'Product', code: 'PROD', colorHex: '#7C3AED' },
  { name: 'Design', code: 'DES', colorHex: '#EC4899' },
  { name: 'Marketing', code: 'MKT', colorHex: '#F59E0B' },
  { name: 'Sales', code: 'SALES', colorHex: '#10B981' },
  { name: 'Human Resources', code: 'HR', colorHex: '#EF4444' },
  { name: 'Finance', code: 'FIN', colorHex: '#3B82F6' },
  { name: 'Operations', code: 'OPS', colorHex: '#6B7280' },
] as const;

// Alias for universal contract compatibility
export const SAMPLE_DEPARTMENTS = DEFAULT_DEPARTMENTS;

export interface AdminSeedConfig {
  email: string;
  password: string;
  name: string;
}

export const DEFAULT_ADMIN: AdminSeedConfig = {
  email: 'admin@company.com',
  password: process.env.ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD || generatedBootstrapPassword(),
  name: 'System Admin',
};

export function getAdminSeedConfig(): AdminSeedConfig {
  return {
    email: process.env.ADMIN_EMAIL || process.env.SEED_ADMIN_EMAIL || DEFAULT_ADMIN.email,
    password: process.env.ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD || DEFAULT_ADMIN.password,
    name: process.env.ADMIN_NAME || process.env.SEED_ADMIN_NAME || DEFAULT_ADMIN.name,
  };
}

// ---------------------------------------------------------------------------
// Seeder Functions (Exported for Unit / Integration Testing & CLI Execution)
// ---------------------------------------------------------------------------

/**
 * Seeds or updates the default AdminUser record using Argon2id password hashing.
 * Idempotent via email upsert.
 */
export async function seedAdminUser(
  prisma: PrismaClient,
  config: AdminSeedConfig = getAdminSeedConfig()
) {
  console.info(`[seed] Seeding AdminUser (${config.email})...`);

  // The legacy bootstrap account is retained for historical audit references,
  // but must never be reactivated or recreated once the database has moved to
  // the enterprise RBAC accounts.  On a genuinely empty first install it is
  // still created to preserve bootstrap safety.
  const isLegacyBootstrapAccount = config.email.toLowerCase() === DEFAULT_ADMIN.email;
  const existing = await prisma.adminUser.findUnique({ where: { email: config.email } });
  if (isLegacyBootstrapAccount && existing?.isActive === false) {
    console.info(`[seed] Skipping inactive legacy AdminUser (${config.email}).`);
    return existing;
  }
  if (isLegacyBootstrapAccount && !existing && (await prisma.adminUser.count()) > 0) {
    console.info(`[seed] Skipping legacy AdminUser recreation (${config.email}); other admins already exist.`);
    return null;
  }

  // Hash password using Argon2id
  const passwordHash = await argon2.hash(config.password, {
    type: argon2.argon2id,
  });

  // Verify hash integrity before persistence
  const isValid = await argon2.verify(passwordHash, config.password);
  if (!isValid) {
    throw new Error('[seed] Argon2id password hash self-verification failed.');
  }

  // Idempotent upsert by email
  const admin = await prisma.adminUser.upsert({
    where: { email: config.email },
    update: {
      name: config.name,
      passwordHash,
      role: 'SUPER_ADMIN' as any,
    },
    create: {
      email: config.email,
      name: config.name,
      passwordHash,
      role: 'SUPER_ADMIN' as any,
    },
  });

  console.info(`[seed] ✓ AdminUser ready: ${admin.email} (ID: ${admin.id})`);
  return admin;
}

/**
 * Seeds or updates the baseline corporate departments with branding colors.
 * Idempotent via department code upsert.
 */
export async function seedDepartments(
  prisma: PrismaClient,
  departments: readonly DepartmentSeedData[] = DEFAULT_DEPARTMENTS
) {
  console.info(`[seed] Seeding ${departments.length} corporate departments...`);
  const seeded = [];

  for (const dept of departments) {
    let record: any;
    if (typeof prisma.department.findFirst === 'function') {
      record = await prisma.department.findFirst({
        where: { floorId: null, code: dept.code },
      });
      if (record) {
        record = await prisma.department.update({
          where: { id: record.id },
          data: { name: dept.name, colorHex: dept.colorHex },
        });
      } else {
        record = await prisma.department.create({
          data: { name: dept.name, code: dept.code, colorHex: dept.colorHex, floorId: null },
        });
      }
    } else if (typeof (prisma.department as any).upsert === 'function') {
      record = await (prisma.department as any).upsert({
        where: { code: dept.code },
        update: { name: dept.name, colorHex: dept.colorHex },
        create: { name: dept.name, code: dept.code, colorHex: dept.colorHex, floorId: null },
      });
    }

    console.info(`[seed]   ✓ [${record.code}] ${record.name} (${record.colorHex})`);
    seeded.push(record);
  }

  console.info(`[seed] ✓ All ${seeded.length} departments seeded successfully.`);
  return seeded;
}

// ---------------------------------------------------------------------------
// Industrial Manufacturing Hierarchy Constants & Seeder
// ---------------------------------------------------------------------------
export interface UnitSeedData {
  name: string;
  code: string;
}

export const DEFAULT_UNITS: readonly UnitSeedData[] = [
  { name: 'Unit 1', code: 'UNIT-1' },
  { name: 'Unit 2', code: 'UNIT-2' },
  { name: 'Unit 3', code: 'UNIT-3' },
  { name: 'Unit 4', code: 'UNIT-4' },
  { name: 'Unit 5', code: 'UNIT-5' },
] as const;

/**
 * Purges legacy pre-refactor records from MongoDB Atlas:
 * 1. Obsolete `offices` collection documents
 * 2. Legacy `buildings` lacking `plant_id` or referencing legacy `office_id` (e.g. Tower 1, TWR-1)
 * 3. Orphaned `floors` referencing legacy buildings or lacking valid industrial parent references
 *
 * Uses raw MongoDB commands via prisma.$runCommandRaw so that records lacking
 * required non-nullable schema fields can be purged without triggering Prisma runtime
 * deserialization exceptions (P2032). 100% idempotent and safe to run repeatedly.
 */
export async function cleanLegacyPreRefactorRecords(prisma: PrismaClient) {
  console.info('[seed] Purging legacy pre-refactor records from MongoDB Atlas...');

  // 1. Purge legacy buildings (missing plant_id, having office_id, or legacy code TWR-1)
  try {
    await prisma.$runCommandRaw({
      delete: 'buildings',
      deletes: [
        {
          q: {
            $or: [
              { plant_id: { $exists: false } },
              { office_id: { $exists: true } },
              { code: 'TWR-1' },
            ],
          },
          limit: 0,
        },
      ],
    });
    console.info('[seed]   ✓ Purged legacy buildings');
  } catch (err: any) {
    console.warn('[seed]   ⚠ Warning during legacy building cleanup:', err?.message || err);
  }

  // 2. Purge orphaned floors (referencing legacy Tower 1 building id or missing parent)
  try {
    // Delete floors pointing to known legacy Tower 1 building id
    await prisma.$runCommandRaw({
      delete: 'floors',
      deletes: [
        {
          q: {
            $or: [
              { building_id: { $oid: '6ae4198ec6f32ca6392edef2' } },
            ],
          },
          limit: 0,
        },
      ],
    });

    // Also purge any floors referencing buildings that do not exist or lack plant_id
    const validBuildingsRes: any = await prisma.$runCommandRaw({
      find: 'buildings',
      filter: { plant_id: { $exists: true } },
      projection: { _id: 1 },
    });
    const validBuildingIds: any[] = validBuildingsRes?.cursor?.firstBatch?.map((b: any) => b._id) || [];
    if (validBuildingIds.length > 0) {
      await prisma.$runCommandRaw({
        delete: 'floors',
        deletes: [
          {
            q: {
              building_id: { $nin: validBuildingIds },
            },
            limit: 0,
          },
        ],
      });
    }
    console.info('[seed]   ✓ Purged legacy / orphaned floors');
  } catch (err: any) {
    console.warn('[seed]   ⚠ Warning during legacy floor cleanup:', err?.message || err);
  }

  // 3. Drop obsolete legacy 'offices' collection if it exists
  try {
    await prisma.$runCommandRaw({
      drop: 'offices',
    });
    console.info('[seed]   ✓ Dropped obsolete "offices" collection');
  } catch (err: any) {
    if (err?.code !== 26 && !err?.message?.includes('ns not found')) {
      console.warn('[seed]   ⚠ Note during obsolete collection cleanup:', err?.message || err);
    }
  }

  // 4. Purge stray non-standard test units created by adversarial suites
  try {
    const validCodes = ['UNIT-1', 'UNIT-2', 'UNIT-3', 'UNIT-4', 'UNIT-5'];
    const strayUnitsRes: any = await prisma.$runCommandRaw({
      find: 'units',
      filter: { code: { $nin: validCodes } },
      projection: { _id: 1, code: 1 },
    });
    const strayUnits: any[] = strayUnitsRes?.cursor?.firstBatch || [];
    if (strayUnits.length > 0) {
      const strayIds = strayUnits.map(u => u._id);
      console.info(`[seed]   Purging ${strayUnits.length} stray test units...`);
      await prisma.$runCommandRaw({
        delete: 'plants',
        deletes: [{ q: { unit_id: { $in: strayIds } }, limit: 0 }],
      });
      await prisma.$runCommandRaw({
        delete: 'units',
        deletes: [{ q: { _id: { $in: strayIds } }, limit: 0 }],
      });
      console.info('[seed]   ✓ Purged stray test units and plants');
    }
  } catch (err: any) {
    console.warn('[seed]   ⚠ Note during stray unit cleanup:', err?.message || err);
  }

  console.info('[seed] ✓ Legacy pre-refactor cleanup complete.');
}

/**
 * Idempotently seeds the 5-tier industrial manufacturing hierarchy:
 * - 5 top-level Units (Unit 1 to Unit 5)
 * - In Unit 2: 1 Plant (Unit 2 - Plant 1, PLT-U2-01)
 * - In Unit 2 - Plant 1: 1 Building (Unit 2 - Main Building, BLD-U2-01)
 * - In Building 1: 3 Floors (Floor 1, Floor 2, Floor 3) with canvas dimensions 1600x1000
 * - Units 1, 3, 4, 5 remain completely empty (0 plants) for subsequent Admin configuration.
 */
export async function seedIndustrialHierarchy(prisma: PrismaClient) {
  // Purge legacy pre-refactor documents to prevent P2032 deserialization crashes
  await cleanLegacyPreRefactorRecords(prisma);

  console.info('[seed] Seeding 5-tier industrial manufacturing hierarchy...');

  const units = [];
  for (const u of DEFAULT_UNITS) {
    const record = await prisma.unit.upsert({
      where: { code: u.code },
      update: { name: u.name },
      create: {
        name: u.name,
        code: u.code,
      },
    });
    console.info(`[seed]   ✓ Unit ready: ${record.name} (${record.code})`);
    units.push(record);
  }

  const unit2 = units.find((u) => u.code === 'UNIT-2');
  if (!unit2) {
    throw new Error('[seed] Unit 2 record could not be found or created.');
  }

  const unit2Plant = await prisma.plant.upsert({
    where: {
      unitId_code: {
        unitId: unit2.id,
        code: 'PLT-U2-01',
      },
    },
    update: {
      name: 'Unit 2 - Plant 1',
    },
    create: {
      name: 'Unit 2 - Plant 1',
      code: 'PLT-U2-01',
      unitId: unit2.id,
    },
  });
  console.info(`[seed]   ✓ Plant ready: ${unit2Plant.name} (${unit2Plant.code}) under Unit 2`);

  let unit2Building = await prisma.building.findFirst({
    where: {
      plantId: unit2Plant.id,
      code: 'BLD-U2-01',
    },
  });

  if (!unit2Building) {
    unit2Building = await prisma.building.create({
      data: {
        name: 'Santosh Bhavan',
        code: 'BLD-U2-01',
        plantId: unit2Plant.id,
        unitId: unit2.id,
      },
    });
  } else {
    unit2Building = await prisma.building.update({
      where: { id: unit2Building.id },
      data: { name: 'Santosh Bhavan', unitId: unit2.id },
    });
  }
  console.info(`[seed]   ✓ Building ready: ${unit2Building.name} (${unit2Building.code}) under Plant 1`);

  const floors = [];
  for (let floorNum = 1; floorNum <= 3; floorNum++) {
    const imageUrl = floorNum === 2 ? '/floor-plans/unit2-floor2.png' : null;
    const cWidth = floorNum === 2 ? 2400 : 1600;
    const cHeight = floorNum === 2 ? 1640 : 1000;
    const floorRecord = await prisma.floor.upsert({
      where: {
        buildingId_floorNumber: {
          buildingId: unit2Building.id,
          floorNumber: floorNum,
        },
      },
      update: {
        name: `Floor ${floorNum}`,
        canvasWidth: cWidth,
        canvasHeight: cHeight,
        imageUrl,
      },
      create: {
        name: `Floor ${floorNum}`,
        floorNumber: floorNum,
        buildingId: unit2Building.id,
        canvasWidth: cWidth,
        canvasHeight: cHeight,
        imageUrl,
      },
    });
    console.info(`[seed]     ✓ Floor ready: ${floorRecord.name} (Floor ${floorRecord.floorNumber})`);
    floors.push(floorRecord);

    if (floorNum === 2 && (prisma as any).seat && typeof (prisma as any).seat.upsert === 'function' && typeof prisma.department.findFirst === 'function') {
      const floor2DeptsData = [
        { name: 'Executive', code: 'EXEC', colorHex: '#6366F1' },
        { name: 'Engineering', code: 'ENG', colorHex: '#0EA5E9' },
        { name: 'Product', code: 'PROD', colorHex: '#8B5CF6' },
        { name: 'Design', code: 'DES', colorHex: '#EC4899' },
        { name: 'Training', code: 'TRN', colorHex: '#10B981' },
        { name: 'HR/Admin', code: 'HR', colorHex: '#F59E0B' },
        { name: 'Operations', code: 'OPS', colorHex: '#EC4899' },
        { name: 'Sales', code: 'SALES', colorHex: '#10B981' },
        { name: 'Finance', code: 'FIN', colorHex: '#3B82F6' },
        { name: 'Marketing', code: 'MKT', colorHex: '#F59E0B' },
      ];

      const f2DeptMap = {};
      for (const d of floor2DeptsData) {
        let dRecord = await prisma.department.findFirst({
          where: { unitId: unit2.id, code: d.code },
        });
        if (dRecord) {
          dRecord = await prisma.department.update({
            where: { id: dRecord.id },
            data: { name: d.name, colorHex: d.colorHex, floorId: floorRecord.id },
          });
        } else {
          dRecord = await prisma.department.create({
            data: {
              name: d.name,
              code: d.code,
              colorHex: d.colorHex,
              unitId: unit2.id,
              floorId: floorRecord.id,
            },
          });
        }
        f2DeptMap[d.code] = dRecord;
      }

      const execDept = f2DeptMap['EXEC'];
      const engDept = f2DeptMap['ENG'];
      const prodDept = f2DeptMap['PROD'];
      const desDept = f2DeptMap['DES'];
      const mktDept = f2DeptMap['MKT'];
      const salesDept = f2DeptMap['SALES'];
      const hrDept = f2DeptMap['HR'];
      const finDept = f2DeptMap['FIN'];
      const opsDept = f2DeptMap['OPS'];
      const trnDept = f2DeptMap['TRN'];

      // 162-seat comprehensive AutoCAD calibrated layout (2400 x 1640)
      const seatLayouts: Array<{ label: string; x: number; y: number; width?: number; height?: number; type: string; deptId: string | null; officeArea?: string; pcNumber?: string }> = [];

      // 1. South Workstations Bay 1 (WS-201 to WS-212) - 12 desks (Engineering)
      const yRows = [1090, 1130, 1170, 1210];
      const b1Cols = [1160, 1200, 1245];
      let wNum = 201;
      for (const x of b1Cols) {
        for (const y of yRows) {
          seatLayouts.push({ label: `WS-${wNum++}`, x, y, width: 26, height: 22, type: 'STANDARD_DESK', deptId: engDept?.id || null });
        }
      }

      // 2. South Workstations Bay 2 (WS-213 to WS-224) - 12 desks (Product)
      const b2Cols = [1360, 1400, 1445];
      for (const x of b2Cols) {
        for (const y of yRows) {
          seatLayouts.push({ label: `WS-${wNum++}`, x, y, width: 26, height: 22, type: 'STANDARD_DESK', deptId: prodDept?.id || null });
        }
      }

      // 3. South Workstations Bay 3 (WS-225 to WS-240) - 16 desks (Design / Marketing)
      const b3Cols = [1565, 1605, 1650, 1695];
      for (const x of b3Cols) {
        for (const y of yRows) {
          const deptId = wNum <= 232 ? desDept?.id : mktDept?.id;
          seatLayouts.push({ label: `WS-${wNum++}`, x, y, width: 26, height: 22, type: 'STANDARD_DESK', deptId: deptId || null });
        }
      }

      // 4. Meeting / Discussion Room (MEET-01 to MEET-12) - 12 seats
      for (let i = 0; i < 6; i++) {
        const y = 1075 + i * 30;
        seatLayouts.push({ label: `MEET-${String(i + 1).padStart(2, '0')}`, x: 1040, y, width: 22, height: 22, type: 'CUBICLE', deptId: engDept?.id || null });
        seatLayouts.push({ label: `MEET-${String(i + 7).padStart(2, '0')}`, x: 1105, y, width: 22, height: 22, type: 'CUBICLE', deptId: engDept?.id || null });
      }

      // 5. Classroom / Seminar (25 seats: CLASS-INS + CLASS-01..CLASS-24)
      seatLayouts.push({ label: 'CLASS-INS', x: 965, y: 1200, width: 38, height: 28, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      const classCols = [780, 815, 875, 920];
      for (let c = 0; c < 4; c++) {
        const x = classCols[c];
        for (let r = 0; r < 6; r++) {
          const y = 1080 + r * 35;
          const num = c * 6 + r + 1;
          seatLayouts.push({ label: `CLASS-${String(num).padStart(2, '0')}`, x, y, width: 22, height: 22, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
        }
      }

      // 6. Reception Desk
      seatLayouts.push({ label: 'RECEP-01', x: 735, y: 1255, width: 28, height: 28, type: 'STANDARD_DESK', deptId: opsDept?.id || null });

      // 7. North Board Conference Room (CONF-01 to CONF-18) - 18 seats
      const confX = [825, 855, 885, 915, 945, 975, 1005, 1035];
      for (let i = 0; i < 8; i++) {
        seatLayouts.push({ label: `CONF-${String(i + 1).padStart(2, '0')}`, x: confX[i], y: 470, width: 24, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
        seatLayouts.push({ label: `CONF-${String(i + 9).padStart(2, '0')}`, x: confX[i], y: 540, width: 24, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      }
      seatLayouts.push({ label: 'CONF-17', x: 795, y: 505, width: 22, height: 26, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'CONF-18', x: 1045, y: 505, width: 22, height: 26, type: 'CUBICLE', deptId: opsDept?.id || null });

      // 8. MD Cabin (MD-EXEC + MD-MEET-1..4) - 5 seats
      seatLayouts.push({ label: 'MD-EXEC', x: 1205, y: 455, width: 68, height: 38, type: 'CABIN', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'MD-MEET-1', x: 1180, y: 595, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'MD-MEET-2', x: 1240, y: 595, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'MD-MEET-3', x: 1205, y: 565, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'MD-MEET-4', x: 1205, y: 625, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });

      // 9. Chairman Cabin (CHAIR-EXEC + CHAIR-MEET-1..4) - 5 seats
      seatLayouts.push({ label: 'CHAIR-EXEC', x: 1520, y: 455, width: 68, height: 38, type: 'CABIN', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'CHAIR-MEET-1', x: 1435, y: 595, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'CHAIR-MEET-2', x: 1495, y: 595, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'CHAIR-MEET-3', x: 1465, y: 565, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'CHAIR-MEET-4', x: 1465, y: 625, width: 22, height: 22, type: 'CUBICLE', deptId: opsDept?.id || null });

      // 10. East Cabins (CABIN-E1..CABIN-E4) - 4 seats
      seatLayouts.push({ label: 'CABIN-E1', x: 1690, y: 510, width: 60, height: 38, type: 'CABIN', deptId: salesDept?.id || null });
      seatLayouts.push({ label: 'CABIN-E2', x: 1690, y: 630, width: 60, height: 38, type: 'CABIN', deptId: salesDept?.id || null });
      seatLayouts.push({ label: 'CABIN-E3', x: 1690, y: 750, width: 60, height: 38, type: 'CABIN', deptId: finDept?.id || null });
      seatLayouts.push({ label: 'CABIN-E4', x: 1690, y: 870, width: 60, height: 38, type: 'CABIN', deptId: finDept?.id || null });

      // 11. West Offices (OFFICE-W1..OFFICE-W2) - 2 seats
      seatLayouts.push({ label: 'OFFICE-W1', x: 600, y: 680, width: 60, height: 38, type: 'CABIN', deptId: opsDept?.id || null });
      seatLayouts.push({ label: 'OFFICE-W2', x: 600, y: 800, width: 60, height: 38, type: 'CABIN', deptId: opsDept?.id || null });

      // 12. Training Room 1 (Center-Left) - 25 seats
      seatLayouts.push({ label: 'TR1-TRAINER', x: 740, y: 750, width: 38, height: 32, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      const tr1X = [815, 845, 875, 905, 935, 965, 995, 1025, 1055, 1085];
      for (let i = 0; i < 10; i++) {
        seatLayouts.push({ label: `TR1-T${i + 1}`, x: tr1X[i], y: 740, width: 24, height: 22, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
        seatLayouts.push({ label: `TR1-B${i + 1}`, x: tr1X[i], y: 935, width: 24, height: 22, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      }
      const tr1EY = [780, 815, 850, 885];
      for (let i = 0; i < 4; i++) {
        seatLayouts.push({ label: `TR1-E${i + 1}`, x: 1115, y: tr1EY[i], width: 22, height: 24, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      }

      // 13. Training Room 2 (Center-Right) - 25 seats
      seatLayouts.push({ label: 'TR2-TRAINER', x: 1630, y: 750, width: 38, height: 32, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      const tr2X = [1285, 1315, 1345, 1375, 1405, 1435, 1465, 1495, 1525, 1555];
      for (let i = 0; i < 10; i++) {
        seatLayouts.push({ label: `TR2-T${i + 1}`, x: tr2X[i], y: 740, width: 24, height: 22, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
        seatLayouts.push({ label: `TR2-B${i + 1}`, x: tr2X[i], y: 935, width: 24, height: 22, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      }
      const tr2WY = [780, 815, 850, 885];
      for (let i = 0; i < 4; i++) {
        seatLayouts.push({ label: `TR2-E${i + 1}`, x: 1255, y: tr2WY[i], width: 22, height: 24, type: 'STANDARD_DESK', deptId: hrDept?.id || null });
      }



      for (const s of seatLayouts) {
        const lbl = s.label.toUpperCase();
        let derivedArea = s.officeArea;
        if (!derivedArea) {
          if (lbl.startsWith('WS-20') || lbl.startsWith('WS-210') || lbl.startsWith('WS-211') || lbl.startsWith('WS-212')) {
            derivedArea = 'South Bay 1 - Engineering';
          } else if (lbl.startsWith('WS-21') || lbl.startsWith('WS-220') || lbl.startsWith('WS-221') || lbl.startsWith('WS-222') || lbl.startsWith('WS-223') || lbl.startsWith('WS-224')) {
            derivedArea = 'South Bay 2 - Product';
          } else if (lbl.startsWith('WS-22') || lbl.startsWith('WS-23') || lbl.startsWith('WS-240')) {
            derivedArea = 'South Bay 3 - Design & Marketing';
          } else if (lbl.startsWith('MEET')) {
            derivedArea = 'Meeting Bay';
          } else if (lbl.startsWith('CLASS')) {
            derivedArea = 'Training Wing - Classroom';
          } else if (lbl.startsWith('RECEP')) {
            derivedArea = 'Main Reception Area';
          } else if (lbl.startsWith('CONF')) {
            derivedArea = 'North Board Conference Hall';
          } else if (lbl.startsWith('MD-')) {
            derivedArea = 'Executive Suite - MD Wing';
          } else if (lbl.startsWith('CHAIR-')) {
            derivedArea = 'Executive Suite - Chairman Wing';
          } else if (lbl.startsWith('CABIN-E')) {
            derivedArea = 'East Executive Cabins';
          } else if (lbl.startsWith('OFFICE-W')) {
            derivedArea = 'West Management Offices';
          } else if (lbl.startsWith('TR1')) {
            derivedArea = 'Training Center 1';
          } else if (lbl.startsWith('TR2')) {
            derivedArea = 'Training Center 2';
          } else {
            derivedArea = 'Main Workstation Bay';
          }
        }

        await prisma.seat.upsert({
          where: {
            floorId_label: {
              floorId: floorRecord.id,
              label: s.label,
            },
          },
          update: {
            x: s.x,
            y: s.y,
            width: s.width || 64,
            height: s.height || 48,
            type: (s.type as any) || 'STANDARD_DESK',
            departmentId: s.deptId || null,
            officeArea: derivedArea,
          },
          create: {
            label: s.label,
            floorId: floorRecord.id,
            x: s.x,
            y: s.y,
            width: s.width || 64,
            height: s.height || 48,
            type: (s.type as any) || 'STANDARD_DESK',
            departmentId: s.deptId || null,
            officeArea: derivedArea,
          },
        });
      }
      console.info(`[seed]     ✓ Seeded ${seatLayouts.length} initial workstations for Santosh Bhavan Floor 2`);

      const employeeSeedList = [
        { code: 'EMP-EXEC-01', name: 'Dr. Arvind Patel', email: 'arvind.patel@shaktiman.com', deptId: opsDept?.id, seatLabel: 'MD-EXEC' },
        { code: 'EMP-EXEC-02', name: 'Mr. Dinesh Patel', email: 'dinesh.patel@shaktiman.com', deptId: opsDept?.id, seatLabel: 'CHAIR-EXEC' },
        { code: 'EMP-OPS-01', name: 'Kavita Joshi', email: 'kavita.j@shaktiman.com', deptId: opsDept?.id, seatLabel: 'RECEP-01' },
        { code: 'EMP-SALES-01', name: 'Vikram Malhotra', email: 'vikram.m@shaktiman.com', deptId: salesDept?.id, seatLabel: 'CABIN-E1' },
        { code: 'EMP-SALES-02', name: 'Sanjay Singhania', email: 'sanjay.s@shaktiman.com', deptId: salesDept?.id, seatLabel: 'CABIN-E2' },
        { code: 'EMP-FIN-01', name: 'Rajesh Iyer', email: 'rajesh.i@shaktiman.com', deptId: finDept?.id, seatLabel: 'CABIN-E3' },
        { code: 'EMP-FIN-02', name: 'Meera Deshmukh', email: 'meera.d@shaktiman.com', deptId: finDept?.id, seatLabel: 'CABIN-E4' },
        { code: 'EMP-OPS-02', name: 'Sunil Shinde', email: 'sunil.s@shaktiman.com', deptId: opsDept?.id, seatLabel: 'OFFICE-W1' },
        { code: 'EMP-OPS-03', name: 'Girish Rathod', email: 'girish.r@shaktiman.com', deptId: opsDept?.id, seatLabel: 'OFFICE-W2' },
        { code: 'EMP-HR-01', name: 'Deepak Chauhan', email: 'deepak.c@shaktiman.com', deptId: hrDept?.id, seatLabel: 'TR1-TRAINER' },
        { code: 'EMP-HR-02', name: 'Ritu Saxena', email: 'ritu.s@shaktiman.com', deptId: hrDept?.id, seatLabel: 'TR2-TRAINER' },
        { code: 'EMP-HR-03', name: 'Anand Kulkarni', email: 'anand.k@shaktiman.com', deptId: hrDept?.id, seatLabel: 'CLASS-INS' },
        { code: 'EMP-ENG-01', name: 'Rajesh Kumar', email: 'rajesh.k@shaktiman.com', deptId: engDept?.id, seatLabel: 'WS-201' },
        { code: 'EMP-ENG-02', name: 'Amit Patel', email: 'amit.p@shaktiman.com', deptId: engDept?.id, seatLabel: 'WS-202' },
        { code: 'EMP-ENG-03', name: 'Sneha Gupta', email: 'sneha.g@shaktiman.com', deptId: engDept?.id, seatLabel: 'WS-203' },
        { code: 'EMP-ENG-04', name: 'Rahul Verma', email: 'rahul.v@shaktiman.com', deptId: engDept?.id, seatLabel: 'WS-204' },
        { code: 'EMP-PROD-01', name: 'Ananya Sharma', email: 'ananya.s@shaktiman.com', deptId: prodDept?.id, seatLabel: 'WS-213' },
        { code: 'EMP-PROD-02', name: 'Pooja Singh', email: 'pooja.s@shaktiman.com', deptId: prodDept?.id, seatLabel: 'WS-214' },
        { code: 'EMP-PROD-03', name: 'Rohit Mehra', email: 'rohit.m@shaktiman.com', deptId: prodDept?.id, seatLabel: 'WS-215' },
        { code: 'EMP-DES-01', name: 'Karan Joshi', email: 'karan.j@shaktiman.com', deptId: desDept?.id, seatLabel: 'WS-225' },
        { code: 'EMP-DES-02', name: 'Divya Nair', email: 'divya.n@shaktiman.com', deptId: desDept?.id, seatLabel: 'WS-226' },
      ];

      const existingEmpCount = (prisma.employee && typeof prisma.employee.count === 'function')
        ? await prisma.employee.count()
        : 0;
      if (existingEmpCount === 0 && (prisma as any).employee && typeof (prisma as any).employee.upsert === 'function') {
        for (const empData of employeeSeedList) {
          if (!empData.deptId) continue;
          const emp = await prisma.employee.upsert({
            where: { employeeCode: empData.code },
            update: {
              fullName: empData.name,
              email: empData.email,
              departmentId: empData.deptId,
            },
            create: {
              employeeCode: empData.code,
              fullName: empData.name,
              email: empData.email,
              departmentId: empData.deptId,
            },
          });

          if (empData.seatLabel) {
            const seat = await prisma.seat.findUnique({
              where: {
                floorId_label: {
                  floorId: floorRecord.id,
                  label: empData.seatLabel,
                },
              },
            });
            if (seat) {
              await prisma.seat.update({
                where: { id: seat.id },
                data: { employeeId: emp.id, departmentId: empData.deptId },
              });
            }
          }
        }
        console.info('[seed]     ✓ Seeded and assigned employees for Santosh Bhavan Floor 2');
      } else {
        console.info(`[seed]     ✓ Preserving existing database employees (count: ${existingEmpCount}), skipping demo mock employee seeding.`);
      }
    }
  }

  console.info('[seed] ✓ Industrial hierarchy seeded successfully (Units 1, 3, 4, 5 empty).');
  return { units, plant: unit2Plant, building: unit2Building, floors };
}

/**
 * Backward compatibility alias for seedIndustrialHierarchy.
 */
export async function seedDefaultHierarchy(prisma: PrismaClient) {
  return seedIndustrialHierarchy(prisma);
}

// Test/demo identities must never share a repository-known password. Generate
// an ephemeral secret when a test runner has not supplied one; it is never
// printed and direct seeding is restricted to an explicitly disposable DB.
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || process.env.ADMIN_PASSWORD || randomBytes(32).toString('base64url');
export const TECH_ADMIN_EMAIL = process.env.TECH_ADMIN_EMAIL || 'techadmin@shaktiman.com';
export const TECH_ADMIN_PASSWORD = process.env.TECH_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || DEMO_PASSWORD;

/**
 * Seeds the Enterprise RBAC demo accounts:
 * - 1 TECH_ADMIN (techadmin@shaktiman.com) with global authorization
 * - 1 SUPER_ADMIN (superadmin@shaktiman.com)
 * - 5 UNIT_ADMIN accounts (unit1.admin@shaktiman.com to unit5.admin@shaktiman.com)
 */
export async function seedEnterpriseDemoAccounts(
  prisma: PrismaClient,
  units: any[],
  departments: any[]
) {
  if (process.env.NODE_ENV !== 'test' && !isDirectExecution) {
    throw new Error('[seed] Demo administrator provisioning is allowed only in tests or the guarded seed CLI.');
  }
  if (isDirectExecution) {
    await verifyDisposableTestDatabase(process.env.TEST_DATABASE_URL);
  }
  console.info('[seed] Seeding Enterprise RBAC Demo Accounts...');
  const demoHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });
  const techHash = await argon2.hash(TECH_ADMIN_PASSWORD, { type: argon2.argon2id });

  await prisma.adminUser.upsert({
    where: { email: TECH_ADMIN_EMAIL },
    update: {
      name: 'Technology Administrator (Global Control)',
      passwordHash: techHash,
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
  console.info(`[seed]   ✓ Technology Admin ready: ${TECH_ADMIN_EMAIL}`);

  // 1. Super Admin
  const superAdmin = await prisma.adminUser.upsert({
    where: { email: 'superadmin@shaktiman.com' },
    update: {
      name: 'Super Admin (Global God Mode)',
      passwordHash: demoHash,
      role: 'SUPER_ADMIN' as any,
    },
    create: {
      email: 'superadmin@shaktiman.com',
      name: 'Super Admin (Global God Mode)',
      passwordHash: demoHash,
      role: 'SUPER_ADMIN' as any,
    },
  });
  console.info(`[seed]   ✓ Super Admin ready: ${superAdmin.email}`);

  // 2. Unit Admins for Units 1 to 5
  for (let i = 1; i <= 5; i++) {
    const unit = units.find((u) => u.code === `UNIT-${i}`) || units[i - 1];
    const unitEmail = `unit${i}.admin@shaktiman.com`;
    await prisma.adminUser.upsert({
      where: { email: unitEmail },
      update: {
        name: `Unit ${i} Admin`,
        passwordHash: demoHash,
        role: 'UNIT_ADMIN' as any,
        assignedUnitId: unit?.id || null,
      },
      create: {
        email: unitEmail,
        name: `Unit ${i} Admin`,
        passwordHash: demoHash,
        role: 'UNIT_ADMIN' as any,
        assignedUnitId: unit?.id || null,
      },
    });
    console.info(`[seed]   ✓ Unit ${i} Admin ready: ${unitEmail}`);
  }

  // Clean up any legacy non-admin accounts if present
  try {
    await prisma.adminUser.deleteMany({
      where: {
        email: {
          in: [
            'unit1.hod@shaktiman.com',
            'unit2.hod@shaktiman.com',
            'unit3.hod@shaktiman.com',
            'unit4.hod@shaktiman.com',
            'unit5.hod@shaktiman.com',
            'it.hod@shaktiman.com',
            'it.manager@shaktiman.com',
            'employee@shaktiman.com',
          ],
        },
      },
    });
  } catch { }

  console.info('[seed] ✓ Enterprise RBAC demo accounts seeded successfully.');
}

export async function seed(
  prismaClient?: PrismaClient,
  options?: { includeDemoAccounts?: boolean; importExcelData?: boolean }
) {
  if (process.env.NODE_ENV !== 'test' && !isDirectExecution) {
    throw new Error('[seed] Database seeding is allowed only in tests or the guarded seed CLI.');
  }
  const shouldSeedDemo =
    options?.includeDemoAccounts ?? (isDirectExecution || process.env.SEED_DEMO_ACCOUNTS === 'true');
  const safeTestDatabase = prismaClient
    ? undefined
    : await verifyDisposableTestDatabase(process.env.TEST_DATABASE_URL);
  const prisma = prismaClient || new PrismaClient({
    datasources: { db: { url: safeTestDatabase!.url } }
  });
  const startTime = Date.now();

  console.info('[seed] ========================================');
  console.info('[seed] Starting Seating System Database Seed');
  console.info('[seed] ========================================');

  try {
    const admin = await seedAdminUser(prisma);
    const departments = await seedDepartments(prisma);
    const hierarchy = await seedIndustrialHierarchy(prisma);

    if (shouldSeedDemo) {
      await seedEnterpriseDemoAccounts(prisma, hierarchy.units, departments);
    }

    const shouldImportExcel =
      options?.importExcelData ?? (isDirectExecution && !process.env.VITEST);

    let excelStats = null;
    if (shouldImportExcel) {
      try {
        excelStats = await importExcelData(prisma);
      } catch (err: any) {
        console.warn(`[seed] ⚠️ Optional Excel ingestion skipped: ${err?.message || err}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.info('[seed] ========================================');
    console.info(`[seed] ✓ Seeding complete in ${elapsed}ms.`);
    console.info(`[seed]   - Admin: ${admin ? 1 : 0} (${admin?.email || 'legacy bootstrap skipped'})`);
    console.info(`[seed]   - Departments: ${departments.length}`);
    console.info(`[seed]   - Units: ${hierarchy.units.length} (Unit 2 populated with 1 Plant, 1 Building, 3 Floors)`);
    if (excelStats) {
      console.info(`[seed]   - Total Real Workstations: ${excelStats.workstationsCount}`);
      console.info(`[seed]   - Total Real Employees:    ${excelStats.employeesCount}`);
    }
    console.info('[seed] ========================================');

    return { admin, departments, hierarchy, excelStats };
  } finally {
    if (!prismaClient) {
      await prisma.$disconnect();
    }
  }
}

// Alias for main
export const main = seed;

// ---------------------------------------------------------------------------
// Standalone CLI Runner Entry Point
// ---------------------------------------------------------------------------
const isDirectExecution =
  Boolean(process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js'));

if (isDirectExecution) {
  (async () => {
    // The seed includes legacy cleanup and optional Excel import. Never allow
    // the CLI to connect to an application or production database.
    const safeTestDatabase = await verifyDisposableTestDatabase(process.env.TEST_DATABASE_URL);
    const prisma = new PrismaClient({ datasources: { db: { url: safeTestDatabase.url } } });
    return seed(prisma)
      .then(async () => {
        await prisma.$disconnect();
        process.exit(0);
      })
      .catch(async (error) => {
        console.error('[seed] ❌ Fatal error during database seeding:', error);
        await prisma.$disconnect();
        process.exit(1);
      });
  })().catch((error) => {
    console.error('[seed] Refusing unsafe test seed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
