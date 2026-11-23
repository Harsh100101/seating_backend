import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { buildServer } from '../src/server.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

// Opt in only with a disposable local MongoDB replica set. Never use DATABASE_URL.
const testUrl = process.env.CATEGORY_TEST_DATABASE_URL;
const enabled = process.env.RUN_REAL_PRISMA_CATEGORY === '1'
  && process.env.ALLOW_DISPOSABLE_TEST_DB_WRITES === '1'
  && process.env.TEST_ENVIRONMENT === 'disposable'
  && Boolean(testUrl);

function expectExactStandardConflict(res: { statusCode: number; json: () => any }) {
  expect(res.statusCode).toBe(409);
  const body = res.json();
  expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
  expect(body.statusCode).toBe(409);
  expect(body.error).toBe('Conflict');
  expect(typeof body.message).toBe('string');
  expect(body.message.trim().length).toBeGreaterThan(0);
}

describe.skipIf(!enabled)('Category duplicate protection against real Prisma and MongoDB', () => {
  let prisma: PrismaClient | undefined;
  let server: ReturnType<typeof buildServer> | undefined;
  let unitId: string | undefined;
  let adminEmail: string | undefined;

  afterAll(async () => {
    if (prisma && unitId) {
      await prisma.unit.delete({ where: { id: unitId } }).catch(() => {});
    }
    if (prisma && adminEmail) {
      await prisma.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => {});
    }
    await server?.close();
    await prisma?.$disconnect();
  });

  it('enforces category uniqueness at the API boundary and the database where a safe unique index exists', async () => {
    await verifyDisposableTestDatabase(testUrl);

    prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await prisma.$connect();

    const suffix = Date.now().toString();
    const password = `cat-test-${suffix}`;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    adminEmail = `cat-admin-${suffix}@example.invalid`;

    const unit = await prisma.unit.create({
      data: { name: `Category Test Unit ${suffix}`, code: `CTU-${suffix}` }
    });
    unitId = unit.id;

    const plant = await prisma.plant.create({
      data: { name: `Category Test Plant ${suffix}`, code: `CTP-${suffix}`, unitId: unit.id }
    });

    await prisma.adminUser.create({
      data: {
        email: adminEmail,
        passwordHash,
        name: 'Category Test Super Admin',
        role: 'SUPER_ADMIN'
      }
    });

    server = buildServer({
      prisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminEmail, password }
    });
    expect(loginRes.statusCode).toBe(200);
    const cookie = loginRes.headers['set-cookie'] as string;

    // 1. Building: legacy Plant is compatibility data, so Mongo does not have
    // a compound unique index for [plantId, code].  The API owns this business
    // invariant; do not add an unsafe production index merely for this test.
    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie },
      payload: { name: `Building ${suffix}`, code: `BLD-${suffix}`, plantId: plant.id }
    });
    expect(bldRes.statusCode).toBe(201);
    const building = bldRes.json();

    const legacyCompatibleDuplicate = await prisma.building.create({
      data: { name: 'Dup Building DB', code: building.code, plantId: plant.id }
    });
    expect(legacyCompatibleDuplicate.id).toBeDefined();
    await prisma.building.delete({ where: { id: legacyCompatibleDuplicate.id } });

    const bldDupApi = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie },
      payload: { name: 'Dup Building API', code: building.code.toLowerCase(), plantId: plant.id }
    });
    expectExactStandardConflict(bldDupApi);
    expect(await prisma.building.count({ where: { plantId: plant.id, code: building.code } })).toBe(1);

    // 2. Floor: unique [buildingId, floorNumber]
    const floorRes = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie },
      payload: { name: `Floor 1 ${suffix}`, floorNumber: 1, buildingId: building.id }
    });
    expect(floorRes.statusCode).toBe(201);
    const floor = floorRes.json();

    await expect(
      prisma.floor.create({
        data: { name: 'Dup Floor DB', floorNumber: 1, buildingId: building.id }
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    const floorDupApi = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie },
      payload: { name: 'Dup Floor API', floorNumber: 1, buildingId: building.id }
    });
    expectExactStandardConflict(floorDupApi);
    expect(await prisma.floor.count({ where: { buildingId: building.id, floorNumber: 1 } })).toBe(1);

    // 3. Department: unique [unitId, code] and [unitId, name]
    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie },
      payload: { name: `Dept ${suffix}`, code: `DPT-${suffix}`, colorHex: '#3B82F6', unitId: unit.id }
    });
    expect(deptRes.statusCode).toBe(201);
    const department = deptRes.json();

    await expect(
      prisma.department.create({
        data: { name: 'Dup Dept DB', code: department.code, colorHex: '#3B82F6', unitId: unit.id }
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    const deptDupApi = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie },
      payload: { name: department.name, code: `OTHER-${suffix}`, colorHex: '#3B82F6', unitId: unit.id }
    });
    expectExactStandardConflict(deptDupApi);
    expect(await prisma.department.count({ where: { unitId: unit.id, code: department.code } })).toBe(1);

    // 4. Area: unique [floorId, normalizedName]
    const areaRes = await server.inject({
      method: 'POST',
      url: '/api/areas',
      headers: { cookie },
      payload: { name: `East Wing ${suffix}`, floorId: floor.id }
    });
    expect(areaRes.statusCode).toBe(201);
    const area = areaRes.json();

    await expect(
      prisma.area.create({
        data: { name: 'Dup Area DB', normalizedName: area.normalizedName, floorId: floor.id }
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    const areaDupApi = await server.inject({
      method: 'POST',
      url: '/api/areas',
      headers: { cookie },
      payload: { name: `  east   wing   ${suffix} `, floorId: floor.id }
    });
    expectExactStandardConflict(areaDupApi);
    expect(await prisma.area.count({ where: { floorId: floor.id, normalizedName: area.normalizedName } })).toBe(1);

    // 5. Section: unique [departmentId, normalizedName]
    const secRes = await server.inject({
      method: 'POST',
      url: '/api/sections',
      headers: { cookie },
      payload: { name: `Assembly Bay ${suffix}`, departmentId: department.id }
    });
    expect(secRes.statusCode).toBe(201);
    const section = secRes.json();

    await expect(
      prisma.section.create({
        data: { name: 'Dup Section DB', normalizedName: section.normalizedName, departmentId: department.id }
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    const secDupApi = await server.inject({
      method: 'POST',
      url: '/api/sections',
      headers: { cookie },
      payload: { name: `  assembly   bay  ${suffix}`, departmentId: department.id }
    });
    expectExactStandardConflict(secDupApi);
    expect(await prisma.section.count({ where: { departmentId: department.id, normalizedName: section.normalizedName } })).toBe(1);

    // 6. OrgFunction: unique [sectionId, normalizedName]
    const fnRes = await server.inject({
      method: 'POST',
      url: '/api/functions',
      headers: { cookie },
      payload: { name: `Quality Check ${suffix}`, sectionId: section.id }
    });
    expect(fnRes.statusCode).toBe(201);
    const fn = fnRes.json();

    await expect(
      prisma.orgFunction.create({
        data: { name: 'Dup Function DB', normalizedName: fn.normalizedName, sectionId: section.id }
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    const fnDupApi = await server.inject({
      method: 'POST',
      url: '/api/functions',
      headers: { cookie },
      payload: { name: `  quality   check  ${suffix} `, sectionId: section.id }
    });
    expectExactStandardConflict(fnDupApi);
    expect(await prisma.orgFunction.count({ where: { sectionId: section.id, normalizedName: fn.normalizedName } })).toBe(1);
  }, 30000);
});
