import { describe, it, expect } from 'vitest';
import argon2 from 'argon2';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  DEFAULT_ADMIN,
  DEFAULT_DEPARTMENTS,
  seedAdminUser,
  seed,
  type DepartmentSeedData,
} from '../prisma/seed.js';

// ============================================================================
// CHALLENGE SUITE 1: STRICT 1:1 SEAT-EMPLOYEE INVARIANT & RELATIONAL ORACLE
// ============================================================================

describe('Challenger 1: Strict 1:1 Invariant & Relational Integrity Oracle', () => {
  it('DMMF Datamodel guarantees Seat.employeeId isUnique === true and isRequired === false', () => {
    const seatModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Seat');
    expect(seatModel, 'Seat model must exist in DMMF').toBeDefined();

    const employeeIdField = seatModel!.fields.find((f) => f.name === 'employeeId');
    expect(employeeIdField, 'Seat.employeeId field must exist').toBeDefined();
    expect(employeeIdField!.type).toBe('String');
    expect(employeeIdField!.isRequired).toBe(false); // Nullable allows unassigned seats
    expect(employeeIdField!.isUnique).toBe(true); // @unique enforces strict 1:1 invariant
  });

  it('DMMF Datamodel guarantees Employee.seat is 1:1 scalar relation (isList === false)', () => {
    const employeeModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Employee');
    expect(employeeModel, 'Employee model must exist in DMMF').toBeDefined();

    const seatRelation = employeeModel!.fields.find((f) => f.name === 'seat');
    expect(seatRelation, 'Employee.seat relation field must exist').toBeDefined();
    expect(seatRelation!.type).toBe('Seat');
    expect(seatRelation!.isList).toBe(false); // MUST NOT be an array/list (which would allow multiple seats)
    expect(seatRelation!.isRequired).toBe(false); // Employee may not currently have a seat
  });

  it('DMMF Datamodel guarantees Seat.employee is scalar relation (isList === false)', () => {
    const seatModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Seat')!;
    const employeeRel = seatModel.fields.find((f) => f.name === 'employee');
    expect(employeeRel, 'Seat.employee relation field must exist').toBeDefined();
    expect(employeeRel!.type).toBe('Employee');
    expect(employeeRel!.isList).toBe(false);
    expect(employeeRel!.isRequired).toBe(false);
    expect(employeeRel!.relationFromFields).toEqual(['employeeId']);
    expect(employeeRel!.relationToFields).toEqual(['id']);
  });

  // Empirical in-memory relational store to test the exact constraint semantics
  it('Empirical Oracle: Simulating database state rejects duplicate seat assignment to same employee', () => {
    interface SeatRecord {
      id: string;
      label: string;
      floorId: string;
      employeeId: string | null;
    }

    class MockSeatStore {
      private seats = new Map<string, SeatRecord>();

      public insert(seat: SeatRecord): void {
        // Enforce @@unique([floorId, label])
        for (const existing of this.seats.values()) {
          if (existing.floorId === seat.floorId && existing.label === seat.label) {
            throw new Error(`Unique constraint violation: floorId_label (${seat.floorId}, ${seat.label})`);
          }
        }

        // Enforce @unique on employeeId (ignoring null)
        if (seat.employeeId !== null) {
          for (const existing of this.seats.values()) {
            if (existing.employeeId === seat.employeeId) {
              throw new Error(`Unique constraint violation: Seat_employeeId_key (${seat.employeeId})`);
            }
          }
        }

        this.seats.set(seat.id, { ...seat });
      }

      public updateEmployee(seatId: string, employeeId: string | null): void {
        const target = this.seats.get(seatId);
        if (!target) throw new Error('Seat not found');

        if (employeeId !== null) {
          for (const existing of this.seats.values()) {
            if (existing.id !== seatId && existing.employeeId === employeeId) {
              throw new Error(`Unique constraint violation: Seat_employeeId_key (${employeeId})`);
            }
          }
        }

        target.employeeId = employeeId;
      }

      public getSeatsByEmployee(employeeId: string): SeatRecord[] {
        return Array.from(this.seats.values()).filter((s) => s.employeeId === employeeId);
      }

      public countUnassigned(): number {
        return Array.from(this.seats.values()).filter((s) => s.employeeId === null).length;
      }
    }

    const store = new MockSeatStore();

    // 1. Unassigned seats can exist in arbitrary quantity (nullable unique)
    store.insert({ id: 's1', floorId: 'f1', label: 'Seat-101', employeeId: null });
    store.insert({ id: 's2', floorId: 'f1', label: 'Seat-102', employeeId: null });
    store.insert({ id: 's3', floorId: 'f1', label: 'Seat-103', employeeId: null });
    expect(store.countUnassigned()).toBe(3);

    // 2. Assign employee E-1 to Seat 1
    store.updateEmployee('s1', 'emp-1');
    expect(store.getSeatsByEmployee('emp-1')).toHaveLength(1);

    // 3. ADVERSARIAL CHALLENGE: Attempting to assign employee E-1 to Seat 2 MUST throw
    expect(() => {
      store.updateEmployee('s2', 'emp-1');
    }).toThrow('Unique constraint violation: Seat_employeeId_key (emp-1)');

    // 4. ADVERSARIAL CHALLENGE: Attempting to insert a new Seat with employee E-1 MUST throw
    expect(() => {
      store.insert({ id: 's4', floorId: 'f1', label: 'Seat-104', employeeId: 'emp-1' });
    }).toThrow('Unique constraint violation: Seat_employeeId_key (emp-1)');

    // 5. Unassigning E-1 from Seat 1 frees employee E-1 to be assigned to Seat 2
    store.updateEmployee('s1', null);
    expect(store.getSeatsByEmployee('emp-1')).toHaveLength(0);

    store.updateEmployee('s2', 'emp-1');
    expect(store.getSeatsByEmployee('emp-1')).toHaveLength(1);
    expect(store.getSeatsByEmployee('emp-1')[0].id).toBe('s2');

    // 6. Duplicate label on same floor MUST throw
    expect(() => {
      store.insert({ id: 's5', floorId: 'f1', label: 'Seat-102', employeeId: null });
    }).toThrow('Unique constraint violation: floorId_label (f1, Seat-102)');
  });
});

// ============================================================================
// CHALLENGE SUITE 2: PRISMA CLIENT GENERATION & DELEGATES VERIFICATION
// ============================================================================

describe('Challenger 2: Prisma Client Generation & Model Delegates Verification', () => {
  const client = new PrismaClient();

  const REQUIRED_MODELS = [
    'adminUser',
    'unit',
    'plant',
    'building',
    'floor',
    'department',
    'employee',
    'seat',
    'auditLog',
  ] as const;

  it('exports all 9 required model delegates on PrismaClient instance', () => {
    for (const modelKey of REQUIRED_MODELS) {
      expect(client[modelKey], `PrismaClient.${modelKey} delegate must exist`).toBeDefined();
      expect(typeof client[modelKey]).toBe('object');
    }
  });

  it('every model delegate exposes standard CRUD and aggregation operations', () => {
    const requiredMethods = [
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      'count',
      'aggregate',
      'groupBy',
    ];

    for (const modelKey of REQUIRED_MODELS) {
      const delegate = client[modelKey] as Record<string, unknown>;
      for (const method of requiredMethods) {
        expect(
          typeof delegate[method],
          `${modelKey}.${method} must be an executable function`
        ).toBe('function');
      }
    }
  });

  it('DMMF datamodel contains all required models and enums', () => {
    expect(Prisma.dmmf.datamodel.models.length).toBeGreaterThanOrEqual(9);
    expect(Prisma.dmmf.datamodel.enums.length).toBeGreaterThanOrEqual(2);

    const enumNames = Prisma.dmmf.datamodel.enums.map((e) => e.name);
    expect(enumNames).toContain('SeatType');
    expect(enumNames).toContain('SeatStatus');
  });

  it('verifies Floor model default canvas dimensions are 1600x1000', () => {
    const floor = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Floor')!;
    const widthField = floor.fields.find((f) => f.name === 'canvasWidth')!;
    const heightField = floor.fields.find((f) => f.name === 'canvasHeight')!;

    expect(widthField.default).toBe(1600);
    expect(heightField.default).toBe(1000);
  });

  it('verifies Seat model default geometry (64x48) and defaults (STANDARD_DESK, AVAILABLE)', () => {
    const seat = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Seat')!;
    const width = seat.fields.find((f) => f.name === 'width')!;
    const height = seat.fields.find((f) => f.name === 'height')!;
    const type = seat.fields.find((f) => f.name === 'type')!;
    const status = seat.fields.find((f) => f.name === 'status')!;

    expect(width.default).toBe(64);
    expect(height.default).toBe(48);
    expect(type.default).toBe('STANDARD_DESK');
    expect(status.default).toBe('AVAILABLE');
  });

  it('verifies operational hierarchy indexes and unique constraints on Floor and Seat', () => {
    const building = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Building')!;
    const floor = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Floor')!;
    const seat = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Seat')!;

    // Building's legacy Plant relation is optional. Operational ownership is
    // Unit -> Building, and Mongo compatibility uses non-destructive indexes
    // while the route enforces duplicate prevention.
    // Prisma's Mongo DMMF does not expose non-unique @@index declarations.
    // Verify the schema text instead of asserting a fabricated @unique index.
    const schema = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prisma/schema.prisma'),
      'utf8',
    );
    expect(schema).toContain('@@index([unitId, code])');

    // Floor @@unique([buildingId, floorNumber])
    expect(
      floor.uniqueIndexes.some((idx) =>
        idx.fields.includes('buildingId') && idx.fields.includes('floorNumber')
      )
    ).toBe(true);

    // Seat @@unique([floorId, label])
    expect(
      seat.uniqueIndexes.some((idx) =>
        idx.fields.includes('floorId') && idx.fields.includes('label')
      )
    ).toBe(true);
  });

  it('DMMF datamodel enforces exact referential actions (Cascade, SetNull, Restrict)', () => {
    const getOnDelete = (modelName: string, fieldName: string) => {
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
      const field = model?.fields.find((f) => f.name === fieldName);
      return field?.relationOnDelete;
    };

    expect(getOnDelete('Plant', 'unit')).toBe('Cascade');
    expect(getOnDelete('Building', 'plant')).toBe('SetNull');
    expect(getOnDelete('Floor', 'building')).toBe('Cascade');
    expect(getOnDelete('Seat', 'floor')).toBe('Cascade');
    expect(getOnDelete('Seat', 'department')).toBe('SetNull');
    expect(getOnDelete('Seat', 'employee')).toBe('SetNull');
    expect(getOnDelete('Employee', 'department')).toBe('Restrict');
    expect(getOnDelete('AuditLog', 'admin')).toBe('Restrict');
  });
});

// ============================================================================
// CHALLENGE SUITE 3: ARGON2ID CRYPTOGRAPHIC STRESS TEST
// ============================================================================

describe('Challenger 3: Argon2id Cryptographic Stress Test', () => {
  it('hashes standard password with argon2id parameters ($argon2id$v=19$m=65536,t=3,p=4)', async () => {
    const password = DEFAULT_ADMIN.password;
    const hash = await argon2.hash(password, { type: argon2.argon2id });

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).toContain('m=65536');
    expect(hash).toContain('p=4');
    expect(hash).toContain('t=3');

    const isValid = await argon2.verify(hash, password);
    expect(isValid).toBe(true);
  });

  it('adversarial input: empty string password', async () => {
    const emptyPassword = '';
    const hash = await argon2.hash(emptyPassword, { type: argon2.argon2id });

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(await argon2.verify(hash, '')).toBe(true);
    expect(await argon2.verify(hash, 'not_empty')).toBe(false);
  });

  it('adversarial input: massive 10,000 character password', async () => {
    const longPassword = 'A'.repeat(10000);
    const hash = await argon2.hash(longPassword, { type: argon2.argon2id });

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(await argon2.verify(hash, longPassword)).toBe(true);
    expect(await argon2.verify(hash, longPassword.slice(0, -1))).toBe(false);
  });

  it('adversarial input: multi-byte UTF-8, unicode emojis, and international scripts', async () => {
    const complexPassword = '🔐Pass-密码-日本語-العربية-Русский-€£¥-!@#$%^&*()_+{}|:"<>?~`';
    const hash = await argon2.hash(complexPassword, { type: argon2.argon2id });

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(await argon2.verify(hash, complexPassword)).toBe(true);
    expect(await argon2.verify(hash, complexPassword + ' ')).toBe(false);
  });

  it('adversarial input: embedded null bytes and escape characters', async () => {
    const nullBytePassword = 'admin\0password\r\n\t\\';
    const hash = await argon2.hash(nullBytePassword, { type: argon2.argon2id });

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(await argon2.verify(hash, nullBytePassword)).toBe(true);
    expect(await argon2.verify(hash, 'admin')).toBe(false);
  });

  it('tampered hash verification rejects forged or corrupted hashes', async () => {
    const originalHash = await argon2.hash('ValidPassword123!', { type: argon2.argon2id });

    // Flip characters in the hash part
    const parts = originalHash.split('$');
    const b64Hash = parts[parts.length - 1];
    const tamperedB64 = (b64Hash[0] === 'A' ? 'B' : 'A') + b64Hash.slice(1);
    parts[parts.length - 1] = tamperedB64;
    const tamperedHash = parts.join('$');

    const result = await argon2.verify(tamperedHash, 'ValidPassword123!').catch(() => false);
    expect(result).toBe(false);
  });

  it('Argon2id uses unique CSPRNG salts (hashing same password twice yields distinct hashes)', async () => {
    const password = 'IdenticalPassword123!';
    const hash1 = await argon2.hash(password, { type: argon2.argon2id });
    const hash2 = await argon2.hash(password, { type: argon2.argon2id });

    expect(hash1).not.toBe(hash2);
    expect(await argon2.verify(hash1, password)).toBe(true);
    expect(await argon2.verify(hash2, password)).toBe(true);
  });
});

// ============================================================================
// CHALLENGE SUITE 4: DATABASE SEEDING IDEMPOTENCY & EDGE CASES
// ============================================================================

describe('Challenger 4: Seeding Idempotency & Edge Cases', () => {
  it('executing seed() 5 consecutive times produces identical state and zero duplicate records', { timeout: 30000 }, async () => {
    // Stateful database simulator to track exact DB rows
    const statefulDb = {
      adminUsers: new Map<string, { id: string; email: string; name: string; passwordHash: string }>(),
      departments: new Map<string, { id: string; code: string; name: string; colorHex: string }>(),
      units: new Map<string, any>(),
      plants: new Map<string, any>(),
      buildings: new Map<string, any>(),
      floors: new Map<string, any>(),
    };

    let idCounter = 1;

    const mockPrismaClient = {
      adminUser: {
        findUnique: async ({ where }: { where: { email?: string } }) =>
          where.email ? statefulDb.adminUsers.get(where.email) || null : null,
        count: async () => statefulDb.adminUsers.size,
        upsert: async (args: {
          where: { email: string };
          update: { name: string; passwordHash: string };
          create: { email: string; name: string; passwordHash: string };
        }) => {
          const existing = statefulDb.adminUsers.get(args.where.email);
          if (existing) {
            existing.name = args.update.name;
            existing.passwordHash = args.update.passwordHash;
            return existing;
          }
          const created = {
            id: `admin-${idCounter++}`,
            email: args.create.email,
            name: args.create.name,
            passwordHash: args.create.passwordHash,
          };
          statefulDb.adminUsers.set(args.create.email, created);
          return created;
        },
      },
      department: {
        upsert: async (args: {
          where: { code: string };
          update: { name: string; colorHex: string };
          create: { code: string; name: string; colorHex: string };
        }) => {
          const existing = statefulDb.departments.get(args.where.code);
          if (existing) {
            existing.name = args.update.name;
            existing.colorHex = args.update.colorHex;
            return existing;
          }
          const created = {
            id: `dept-${idCounter++}`,
            code: args.create.code,
            name: args.create.name,
            colorHex: args.create.colorHex,
          };
          statefulDb.departments.set(args.create.code, created);
          return created;
        },
      },
      unit: {
        upsert: async (args: any) => {
          const existing = statefulDb.units.get(args.where.code);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          const created = { id: `unit-${idCounter++}`, ...args.create };
          statefulDb.units.set(args.where.code, created);
          return created;
        },
      },
      plant: {
        upsert: async (args: any) => {
          const key = `${args.where.unitId_code.unitId}_${args.where.unitId_code.code}`;
          const existing = statefulDb.plants.get(key);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          const created = { id: `plant-${idCounter++}`, ...args.create };
          statefulDb.plants.set(key, created);
          return created;
        },
      },
      building: {
        findFirst: async (args: any) => {
          for (const building of statefulDb.buildings.values()) {
            if (building.plantId === args.where?.plantId && building.code === args.where?.code) {
              return building;
            }
          }
          return null;
        },
        create: async (args: any) => {
          const created = { id: `building-${idCounter++}`, ...args.data };
          statefulDb.buildings.set(`${created.plantId}_${created.code}`, created);
          return created;
        },
        update: async (args: any) => {
          for (const building of statefulDb.buildings.values()) {
            if (building.id === args.where.id) {
              Object.assign(building, args.data);
              return building;
            }
          }
          throw new Error('Building not found');
        },
        upsert: async (args: any) => {
          const key = `${args.where.plantId_code.plantId}_${args.where.plantId_code.code}`;
          const existing = statefulDb.buildings.get(key);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          const created = { id: `building-${idCounter++}`, ...args.create };
          statefulDb.buildings.set(key, created);
          return created;
        },
      },
      floor: {
        upsert: async (args: any) => {
          const key = `${args.where.buildingId_floorNumber.buildingId}_${args.where.buildingId_floorNumber.floorNumber}`;
          const existing = statefulDb.floors.get(key);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          const created = { id: `floor-${idCounter++}`, ...args.create };
          statefulDb.floors.set(key, created);
          return created;
        },
      },
      $runCommandRaw: async () => ({ cursor: { firstBatch: [] } }),
    } as unknown as PrismaClient;

    // Run seed 5 times sequentially
    for (let run = 1; run <= 5; run++) {
      const result = await seed(mockPrismaClient);
      expect(result.admin.email).toBe(DEFAULT_ADMIN.email);
      expect(result.departments).toHaveLength(8);

      // Verify DB table sizes NEVER grow beyond 1 admin and 8 departments
      expect(statefulDb.adminUsers.size).toBe(1);
      expect(statefulDb.departments.size).toBe(8);
    }
  });

  it('seedAdminUser updates name and passwordHash when called with updated credentials', { timeout: 15000 }, async () => {
    let storedAdmin: { email: string; name: string; passwordHash: string } | null = null;

    const mockPrisma = {
      adminUser: {
        findUnique: async ({ where }: { where: { email?: string } }) =>
          where.email && storedAdmin?.email === where.email ? storedAdmin : null,
        count: async () => (storedAdmin ? 1 : 0),
        upsert: async (args: {
          where: { email: string };
          update: { name: string; passwordHash: string };
          create: { email: string; name: string; passwordHash: string };
        }) => {
          if (storedAdmin && storedAdmin.email === args.where.email) {
            storedAdmin.name = args.update.name;
            storedAdmin.passwordHash = args.update.passwordHash;
            return storedAdmin;
          }
          storedAdmin = {
            email: args.create.email,
            name: args.create.name,
            passwordHash: args.create.passwordHash,
          };
          return storedAdmin;
        },
      },
    } as unknown as PrismaClient;

    // Run 1: default admin
    await seedAdminUser(mockPrisma, {
      email: 'admin@company.com',
      password: 'InitialPassword1!',
      name: 'Initial Admin',
    });
    expect(storedAdmin!.name).toBe('Initial Admin');
    const initialHash = storedAdmin!.passwordHash;
    expect(await argon2.verify(initialHash, 'InitialPassword1!')).toBe(true);

    // Run 2: updated name and password
    await seedAdminUser(mockPrisma, {
      email: 'admin@company.com',
      password: 'UpdatedPassword2@',
      name: 'Updated Admin Name',
    });
    expect(storedAdmin!.name).toBe('Updated Admin Name');
    expect(storedAdmin!.passwordHash).not.toBe(initialHash);
    expect(await argon2.verify(storedAdmin!.passwordHash, 'UpdatedPassword2@')).toBe(true);
    expect(await argon2.verify(storedAdmin!.passwordHash, 'InitialPassword1!')).toBe(false);
  });

  it('all 8 departments have strictly unique codes and unique names', () => {
    const codes = DEFAULT_DEPARTMENTS.map((d: DepartmentSeedData) => d.code);
    const names = DEFAULT_DEPARTMENTS.map((d: DepartmentSeedData) => d.name);

    expect(new Set(codes).size).toBe(DEFAULT_DEPARTMENTS.length);
    expect(new Set(names).size).toBe(DEFAULT_DEPARTMENTS.length);
  });
});
