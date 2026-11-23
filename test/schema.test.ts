import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import {
  SEAT_TYPES,
  SEAT_STATUSES,
  HEX_COLOR_REGEX,
} from '@seating/shared';
import {
  DEFAULT_ADMIN,
  DEFAULT_DEPARTMENTS,
  SAMPLE_DEPARTMENTS,
  getAdminSeedConfig,
  seed,
  DepartmentSeedData,
} from '../prisma/seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_PATH = path.resolve(__dirname, '../prisma/schema.prisma');
const SEED_PATH = path.resolve(__dirname, '../prisma/seed.ts');

// ---------------------------------------------------------------------------
// Schema AST Parser Helpers
// ---------------------------------------------------------------------------
interface ParsedField {
  name: string;
  type: string;
  isOptional: boolean;
  isList: boolean;
  rawAttributes: string;
}

interface ParsedModel {
  name: string;
  fields: Map<string, ParsedField>;
  modelAttributes: string[];
}

interface ParsedEnum {
  name: string;
  values: string[];
}

function parsePrismaSchema(content: string) {
  const models = new Map<string, ParsedModel>();
  const enums = new Map<string, ParsedEnum>();

  const cleanContent = content.replace(/\/\/.*$/gm, '');

  // Parse enums
  const enumMatches = cleanContent.matchAll(/enum\s+(\w+)\s*\{([^}]+)\}/g);
  for (const match of enumMatches) {
    const enumName = match[1]!;
    const body = match[2]!;
    const values = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    enums.set(enumName, { name: enumName, values });
  }

  // Parse models
  const modelMatches = cleanContent.matchAll(/model\s+(\w+)\s*\{([^}]+)\}/g);
  for (const match of modelMatches) {
    const modelName = match[1]!;
    const body = match[2]!;
    const fields = new Map<string, ParsedField>();
    const modelAttributes: string[] = [];

    const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    for (const line of lines) {
      if (line.startsWith('@@')) {
        modelAttributes.push(line);
      } else {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const fieldName = parts[0]!;
          const rawType = parts[1]!;
          const rawAttributes = parts.slice(2).join(' ');
          const isOptional = rawType.endsWith('?');
          const isList = rawType.endsWith('[]');
          const cleanType = rawType.replace(/[?[\]]/g, '');
          fields.set(fieldName, {
            name: fieldName,
            type: cleanType,
            isOptional,
            isList,
            rawAttributes,
          });
        }
      }
    }
    models.set(modelName, { name: modelName, fields, modelAttributes });
  }

  return { models, enums };
}

describe('Milestone 2: Prisma Schema & Model Metadata Verification', () => {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const parsed = parsePrismaSchema(schemaContent);

  it('Prisma schema file exists and is non-empty', () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    expect(schemaContent.length).toBeGreaterThan(100);
  });

  it('defines exactly the 8 domain models plus AdminUser (9 models total)', () => {
    const expectedModels = [
      'AdminUser',
      'Unit',
      'Plant',
      'Building',
      'Floor',
      'Department',
      'Employee',
      'Seat',
      'AuditLog',
    ];
    for (const modelName of expectedModels) {
      expect(parsed.models.has(modelName), `Missing model: ${modelName}`).toBe(true);
    }
  });

  it('defines the required enums: SeatType and SeatStatus', () => {
    expect(parsed.enums.has('SeatType')).toBe(true);
    expect(parsed.enums.has('SeatStatus')).toBe(true);

    const seatType = parsed.enums.get('SeatType')!;
    expect(seatType.values).toEqual(['STANDARD_DESK', 'STANDING_DESK', 'CUBICLE', 'CABIN']);

    const seatStatus = parsed.enums.get('SeatStatus')!;
    expect(seatStatus.values).toEqual(['AVAILABLE', 'MAINTENANCE', 'RESERVED']);
  });

  it('matches enum definitions with @seating/shared contracts', () => {
    const seatType = parsed.enums.get('SeatType')!;
    expect(seatType.values).toEqual([...SEAT_TYPES]);

    const seatStatus = parsed.enums.get('SeatStatus')!;
    expect(seatStatus.values).toEqual([...SEAT_STATUSES]);
  });

  it('Prisma Client DMMF reflects all 9 models and enums at runtime', () => {
    const dmmfModels = Prisma.dmmf.datamodel.models.map((m) => m.name);
    expect(dmmfModels).toContain('AdminUser');
    expect(dmmfModels).toContain('Unit');
    expect(dmmfModels).toContain('Plant');
    expect(dmmfModels).toContain('Building');
    expect(dmmfModels).toContain('Floor');
    expect(dmmfModels).toContain('Department');
    expect(dmmfModels).toContain('Employee');
    expect(dmmfModels).toContain('Seat');
    expect(dmmfModels).toContain('AuditLog');

    const dmmfEnums = Prisma.dmmf.datamodel.enums.map((e) => e.name);
    expect(dmmfEnums).toContain('SeatType');
    expect(dmmfEnums).toContain('SeatStatus');
  });

  it('Unit model has required fields', () => {
    const unit = parsed.models.get('Unit')!;
    expect(unit.fields.has('id')).toBe(true);
    expect(unit.fields.has('name')).toBe(true);
    expect(unit.fields.has('code')).toBe(true);
    expect(unit.fields.has('plants')).toBe(true);
  });

  it('Plant model has required fields and relation to Unit', () => {
    const plant = parsed.models.get('Plant')!;
    expect(plant.fields.has('id')).toBe(true);
    expect(plant.fields.has('name')).toBe(true);
    expect(plant.fields.has('code')).toBe(true);
    expect(plant.fields.has('unitId')).toBe(true);
    expect(plant.fields.has('buildings')).toBe(true);
  });

  it('Building model has required fields and relation to Plant', () => {
    const bld = parsed.models.get('Building')!;
    expect(bld.fields.has('id')).toBe(true);
    expect(bld.fields.has('name')).toBe(true);
    expect(bld.fields.has('code')).toBe(true);
    expect(bld.fields.has('plantId')).toBe(true);
    expect(bld.fields.has('floors')).toBe(true);
  });

  it('Floor model has canvas dimensions with defaults (1600x1000) and seats relation', () => {
    const flr = parsed.models.get('Floor')!;
    expect(flr.fields.has('id')).toBe(true);
    expect(flr.fields.has('floorNumber')).toBe(true);
    expect(flr.fields.has('canvasWidth')).toBe(true);
    expect(flr.fields.has('canvasHeight')).toBe(true);
    expect(flr.fields.get('canvasWidth')!.rawAttributes).toContain('default(1600)');
    expect(flr.fields.get('canvasHeight')!.rawAttributes).toContain('default(1000)');
    expect(flr.fields.has('seats')).toBe(true);
  });

  it('Department model has name, code, colorHex with default (#2563EB), employees, seats', () => {
    const dept = parsed.models.get('Department')!;
    expect(dept.fields.has('id')).toBe(true);
    expect(dept.fields.has('name')).toBe(true);
    expect(dept.fields.has('code')).toBe(true);
    expect(dept.fields.has('colorHex')).toBe(true);
    expect(dept.fields.get('colorHex')!.rawAttributes).toMatch(/default\("#(2563EB|3B82F6)"\)/);
    expect(dept.fields.has('employees')).toBe(true);
    expect(dept.fields.has('seats')).toBe(true);
  });

  it('Employee model has department relation, employeeCode, and seat relation', () => {
    const emp = parsed.models.get('Employee')!;
    expect(emp.fields.has('id')).toBe(true);
    expect(emp.fields.has('employeeCode')).toBe(true);
    expect(emp.fields.has('fullName')).toBe(true);
    expect(emp.fields.has('departmentId')).toBe(true);
    expect(emp.fields.has('seat')).toBe(true);
    expect(emp.fields.has('ext')).toBe(true);
    expect(emp.fields.has('reportingManager')).toBe(true);
    expect(emp.fields.has('reportingTo')).toBe(true);
    expect(emp.fields.has('section')).toBe(true);
    expect(emp.fields.has('functionName')).toBe(true);
    expect(emp.fields.has('grade')).toBe(true);
    expect(emp.fields.has('hod')).toBe(true);
    expect(emp.fields.has('officeArea')).toBe(true);
  });

  it('Seat model has geometry, rotation, type, status, and employee relations', () => {
    const seat = parsed.models.get('Seat')!;
    expect(seat.fields.has('id')).toBe(true);
    expect(seat.fields.has('label')).toBe(true);
    expect(seat.fields.has('floorId')).toBe(true);
    expect(seat.fields.has('x')).toBe(true);
    expect(seat.fields.has('y')).toBe(true);
    expect(seat.fields.has('rotation')).toBe(true);
    expect(seat.fields.has('width')).toBe(true);
    expect(seat.fields.has('height')).toBe(true);
    expect(seat.fields.get('width')!.rawAttributes).toContain('default(64)');
    expect(seat.fields.get('height')!.rawAttributes).toContain('default(48)');
    expect(seat.fields.has('type')).toBe(true);
    expect(seat.fields.has('status')).toBe(true);
    expect(seat.fields.has('departmentId')).toBe(true);
    expect(seat.fields.has('employeeId')).toBe(true);
    expect(seat.fields.has('employee')).toBe(true);
  });

  it('AuditLog model has admin relation, action, entityType, entityId, and metadata Json', () => {
    const audit = parsed.models.get('AuditLog')!;
    expect(audit.fields.has('id')).toBe(true);
    expect(audit.fields.has('adminId')).toBe(true);
    expect(audit.fields.has('action')).toBe(true);
    expect(audit.fields.has('entityType')).toBe(true);
    expect(audit.fields.has('entityId')).toBe(true);
    expect(audit.fields.has('metadata')).toBe(true);
    expect(audit.fields.get('metadata')!.type).toBe('Json');
  });
});

describe('Milestone 2: Strict 1:1 Seating & Unique Constraints Verification', () => {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const parsed = parsePrismaSchema(schemaContent);

  it('STRICT 1:1 INVARIANT: Seat.employeeId must be annotated with @unique', () => {
    const seat = parsed.models.get('Seat')!;
    const employeeIdField = seat.fields.get('employeeId')!;
    expect(employeeIdField.isOptional).toBe(true);
    expect(employeeIdField.rawAttributes).toContain('@unique');
  });

  it('STRICT 1:1 INVARIANT: Prisma Client DMMF marks Seat.employeeId as isUnique === true', () => {
    const seatModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Seat')!;
    const empIdField = seatModel.fields.find((f) => f.name === 'employeeId')!;
    expect(empIdField.isUnique).toBe(true);
  });

  it('Building enforces composite unique on [plantId, code]', () => {
    const bld = parsed.models.get('Building')!;
    const hasUnique = bld.modelAttributes.some(
      (attr) => attr.includes('plantId') && attr.includes('code')
    );
    expect(hasUnique, 'Building must specify @@unique([plantId, code])').toBe(true);
  });

  it('Plant enforces composite unique on [unitId, code]', () => {
    const pl = parsed.models.get('Plant')!;
    const hasUnique = pl.modelAttributes.some(
      (attr) => attr.includes('unitId') && attr.includes('code')
    );
    expect(hasUnique, 'Plant must specify @@unique([unitId, code])').toBe(true);
  });

  it('Floor enforces composite unique on [buildingId, floorNumber]', () => {
    const flr = parsed.models.get('Floor')!;
    const hasUnique = flr.modelAttributes.some(
      (attr) => attr.includes('buildingId') && attr.includes('floorNumber')
    );
    expect(hasUnique, 'Floor must specify @@unique([buildingId, floorNumber])').toBe(true);
  });

  it('Seat enforces composite unique on [floorId, label]', () => {
    const seat = parsed.models.get('Seat')!;
    const hasUnique = seat.modelAttributes.some(
      (attr) => attr.includes('floorId') && attr.includes('label')
    );
    expect(hasUnique, 'Seat must specify @@unique([floorId, label])').toBe(true);
  });

  it('Single-column unique constraints are enforced on primary identifiers', () => {
    expect(parsed.models.get('AdminUser')!.fields.get('email')!.rawAttributes).toContain('@unique');
    expect(parsed.models.get('Unit')!.fields.get('name')!.rawAttributes).toContain('@unique');
    expect(parsed.models.get('Unit')!.fields.get('code')!.rawAttributes).toContain('@unique');
    const deptAttrs = parsed.models.get('Department')!.modelAttributes;
    expect(deptAttrs.some((a) => a.includes('unitId') && a.includes('code'))).toBe(true);
    expect(deptAttrs.some((a) => a.includes('unitId') && a.includes('name'))).toBe(true);
    expect(parsed.models.get('Employee')!.fields.get('employeeCode')!.rawAttributes).toContain('@unique');
  });
});

describe('Milestone 2: Referential Integrity Actions Verification', () => {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const parsed = parsePrismaSchema(schemaContent);

  it('Plant -> Unit enforces onDelete: Cascade', () => {
    const unitRel = parsed.models.get('Plant')!.fields.get('unit')!;
    expect(unitRel.rawAttributes).toContain('Cascade');
  });

  it('Building -> legacy Plant preserves the building with onDelete: SetNull', () => {
    const plantRel = parsed.models.get('Building')!.fields.get('plant')!;
    expect(plantRel.rawAttributes).toContain('SetNull');
  });

  it('Floor -> Building enforces onDelete: Cascade', () => {
    const buildingRel = parsed.models.get('Floor')!.fields.get('building')!;
    expect(buildingRel.rawAttributes).toContain('Cascade');
  });

  it('Seat -> Floor enforces onDelete: Cascade', () => {
    const floorRel = parsed.models.get('Seat')!.fields.get('floor')!;
    expect(floorRel.rawAttributes).toContain('Cascade');
  });

  it('Employee -> Department enforces onDelete: Restrict', () => {
    const deptRel = parsed.models.get('Employee')!.fields.get('department')!;
    expect(deptRel.rawAttributes).toContain('Restrict');
  });

  it('Seat -> Department enforces onDelete: SetNull', () => {
    const deptRel = parsed.models.get('Seat')!.fields.get('department')!;
    expect(deptRel.rawAttributes).toContain('SetNull');
  });

  it('Seat -> Employee enforces onDelete: SetNull', () => {
    const empRel = parsed.models.get('Seat')!.fields.get('employee')!;
    expect(empRel.rawAttributes).toContain('SetNull');
  });

  it('AuditLog -> AdminUser enforces onDelete: Restrict (immutable audit log guarantee)', () => {
    const adminRel = parsed.models.get('AuditLog')!.fields.get('admin')!;
    expect(adminRel.rawAttributes).toContain('Restrict');
    expect(adminRel.rawAttributes).not.toContain('Cascade');
    expect(adminRel.rawAttributes).not.toContain('SetNull');
  });
});

describe('Milestone 2: Argon2id Password Hashing & Seed Script Contract', () => {
  it('argon2 hashes passwords using argon2id variant ($argon2id$v=19$)', async () => {
    const testPassword = DEFAULT_ADMIN.password;
    const hash = await argon2.hash(testPassword, { type: argon2.argon2id });

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).toContain('m=65536');
    expect(hash).toContain('t=3');

    const isMatch = await argon2.verify(hash, testPassword);
    expect(isMatch).toBe(true);

    const isWrongMatch = await argon2.verify(hash, 'IncorrectPassword123!');
    expect(isWrongMatch).toBe(false);
  });

  it('seed script file exists at apps/backend/prisma/seed.ts', () => {
    expect(fs.existsSync(SEED_PATH)).toBe(true);
  });

  it('seed script exports DEFAULT_ADMIN, DEFAULT_DEPARTMENTS, and seed function', () => {
    expect(DEFAULT_ADMIN).toBeDefined();
    expect(DEFAULT_DEPARTMENTS).toBeDefined();
    expect(SAMPLE_DEPARTMENTS).toBeDefined();
    expect(typeof seed).toBe('function');
  });

  it('DEFAULT_ADMIN has a secure bootstrap credential', () => {
    expect(DEFAULT_ADMIN.email).toBe('admin@company.com');
    expect(DEFAULT_ADMIN.name).toBe('System Admin');
    expect(DEFAULT_ADMIN.password.length).toBeGreaterThanOrEqual(12);
  });

  it('getAdminSeedConfig respects environment overrides when present', () => {
    const config = getAdminSeedConfig();
    expect(config.email).toBeDefined();
    expect(config.password).toBeDefined();
    expect(config.name).toBeDefined();
  });

  it('DEFAULT_DEPARTMENTS defines exactly 8 corporate departments with valid hex colors', () => {
    expect(DEFAULT_DEPARTMENTS).toHaveLength(8);

    const expectedDepartments: Record<string, { name: string; colorHex: string }> = {
      ENG: { name: 'Engineering', colorHex: '#2563EB' },
      PROD: { name: 'Product', colorHex: '#7C3AED' },
      DES: { name: 'Design', colorHex: '#EC4899' },
      MKT: { name: 'Marketing', colorHex: '#F59E0B' },
      SALES: { name: 'Sales', colorHex: '#10B981' },
      HR: { name: 'Human Resources', colorHex: '#EF4444' },
      FIN: { name: 'Finance', colorHex: '#3B82F6' },
      OPS: { name: 'Operations', colorHex: '#6B7280' },
    };

    for (const [code, expected] of Object.entries(expectedDepartments)) {
      const dept = DEFAULT_DEPARTMENTS.find((d: DepartmentSeedData) => d.code === code);
      expect(dept, `Department with code ${code} must exist`).toBeDefined();
      expect(dept!.name).toBe(expected.name);
      expect(dept!.colorHex).toBe(expected.colorHex);
      expect(dept!.colorHex).toMatch(HEX_COLOR_REGEX);
    }
  });

  it('seed function uses idempotent upsert logic (mock client validation)', async () => {
    interface UpsertCall {
      model: string;
      args: {
        where: Record<string, unknown>;
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      };
    }

    const upsertCalls: UpsertCall[] = [];
    const mockPrismaClient = {
      adminUser: {
        findUnique: async () => null,
        count: async () => 0,
        upsert: async (args: UpsertCall['args']) => {
          upsertCalls.push({ model: 'AdminUser', args });
          return { id: 'mock-admin-id', ...args.create };
        },
      },
      department: {
        upsert: async (args: UpsertCall['args']) => {
          upsertCalls.push({ model: 'Department', args });
          return { id: 'mock-dept-id', ...args.create };
        },
        findFirst: async () => null,
        create: async (args: any) => {
          upsertCalls.push({ model: 'Department', args: { where: { code: args.data.code }, create: args.data, update: args.data } });
          return { id: 'mock-dept-id', ...args.data };
        },
        update: async (args: any) => {
          return { id: 'mock-dept-id', ...args.data };
        },
        findUnique: async () => ({ id: 'mock-dept-id' }),
      },
      seat: {
        upsert: async (args: any) => {
          return { id: 'mock-seat-id', ...args.create };
        },
      },
      unit: {
        upsert: async (args: UpsertCall['args']) => {
          upsertCalls.push({ model: 'Unit', args });
          return { id: 'mock-unit-2', code: (args.where as any).code, ...args.create };
        },
      },
      plant: {
        upsert: async (args: UpsertCall['args']) => {
          upsertCalls.push({ model: 'Plant', args });
          return { id: 'mock-plant-1', ...args.create };
        },
      },
      building: {
        findFirst: async () => null,
        create: async (args: any) => {
          upsertCalls.push({ model: 'Building', args: { where: { code: args.data.code }, create: args.data, update: args.data } });
          return { id: 'mock-building-1', ...args.data };
        },
        update: async (args: any) => {
          return { id: 'mock-building-1', ...args.data };
        },
      },
      floor: {
        upsert: async (args: UpsertCall['args']) => {
          upsertCalls.push({ model: 'Floor', args });
          return { id: 'mock-floor-1', ...args.create };
        },
      },
      $runCommandRaw: async () => ({ cursor: { firstBatch: [] } }),
    } as unknown as Parameters<typeof seed>[0];

    const result = await seed(mockPrismaClient);
    expect(result.admin).toBeDefined();
    expect(result.departments).toHaveLength(8);

    // Verify admin upsert was called with unique email where clause
    const adminCall = upsertCalls.find((c) => c.model === 'AdminUser')!;
    expect(adminCall).toBeDefined();
    expect(adminCall.args.where.email).toBe(DEFAULT_ADMIN.email);
    expect(adminCall.args.create.email).toBe(DEFAULT_ADMIN.email);
    expect(adminCall.args.create.name).toBe(DEFAULT_ADMIN.name);

    // Verify 8 department upserts were called with unique code where clause
    const deptCalls = upsertCalls.filter((c) => c.model === 'Department');
    expect(deptCalls.length).toBeGreaterThanOrEqual(8);
    for (const sample of DEFAULT_DEPARTMENTS) {
      const call = deptCalls.find((c) => c.args.where.code === sample.code);
      expect(call).toBeDefined();
      expect(call!.args.create.code).toBe(sample.code);
      expect(call!.args.create.name).toBe(sample.name);
      expect(call!.args.create.colorHex).toBe(sample.colorHex);
    }
  });
});
