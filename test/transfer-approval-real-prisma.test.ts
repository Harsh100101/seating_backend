import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { buildServer } from '../src/server.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

// Opt in only with a disposable local MongoDB replica set. Never use DATABASE_URL.
const testUrl = process.env.TRANSFER_TEST_DATABASE_URL;
const enabled = process.env.RUN_REAL_PRISMA_TRANSFER === '1'
  && process.env.ALLOW_DISPOSABLE_TEST_DB_WRITES === '1'
  && process.env.TEST_ENVIRONMENT === 'disposable'
  && Boolean(testUrl);

describe.skipIf(!enabled)('Transfer approval against real Prisma and MongoDB', () => {
  let prisma: PrismaClient | undefined;
  let server: ReturnType<typeof buildServer> | undefined;

  afterAll(async () => {
    await server?.close();
    await prisma?.$disconnect();
  });

  it('approves across units and then reallocates within the target unit with valid seat status', async () => {
    await verifyDisposableTestDatabase(testUrl);

    prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await prisma.$connect();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const password = `test-password-${suffix}`;
    const passwordHash = await argon2.hash(password);

    const sourceUnit = await prisma.unit.create({ data: { name: `Source ${suffix}`, code: `SRC-${suffix}` } });
    const targetUnit = await prisma.unit.create({ data: { name: `Target ${suffix}`, code: `DST-${suffix}` } });
    const sourcePlant = await prisma.plant.create({ data: { name: 'Source Plant', code: 'SP', unitId: sourceUnit.id } });
    const targetPlant = await prisma.plant.create({ data: { name: 'Target Plant', code: 'TP', unitId: targetUnit.id } });
    const sourceBuilding = await prisma.building.create({ data: { name: 'Source Building', code: 'SB', plantId: sourcePlant.id } });
    const targetBuilding = await prisma.building.create({ data: { name: 'Target Building', code: 'TB', plantId: targetPlant.id } });
    const sourceFloor = await prisma.floor.create({ data: { name: 'Source Floor', floorNumber: 1, buildingId: sourceBuilding.id } });
    const targetFloor = await prisma.floor.create({ data: { name: 'Target Floor', floorNumber: 1, buildingId: targetBuilding.id } });
    const sourceDepartment = await prisma.department.create({ data: { name: 'Source Department', code: 'SD', unitId: sourceUnit.id } });
    const targetDepartment = await prisma.department.create({ data: { name: 'Target Department', code: 'TD', unitId: targetUnit.id } });
    const employee = await prisma.employee.create({ data: { employeeCode: `EMP-${suffix}`, fullName: 'Prisma Transfer Employee', departmentId: sourceDepartment.id } });
    const sourceSeat = await prisma.seat.create({ data: { label: 'SOURCE', floorId: sourceFloor.id, x: 1, y: 1, status: 'AVAILABLE', employeeId: employee.id } });
    const firstTargetSeat = await prisma.seat.create({ data: { label: 'TARGET-1', floorId: targetFloor.id, x: 2, y: 2, status: 'AVAILABLE' } });
    const secondTargetSeat = await prisma.seat.create({ data: { label: 'TARGET-2', floorId: targetFloor.id, x: 3, y: 3, status: 'AVAILABLE' } });
    const sourceEmail = `source-${suffix}@example.invalid`;
    const targetEmail = `target-${suffix}@example.invalid`;
    await prisma.adminUser.create({ data: { email: sourceEmail, passwordHash, name: 'Source Admin', role: 'UNIT_ADMIN', assignedUnitId: sourceUnit.id } });
    await prisma.adminUser.create({ data: { email: targetEmail, passwordHash, name: 'Target Admin', role: 'UNIT_ADMIN', assignedUnitId: targetUnit.id } });

    server = buildServer({ prisma, sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!' });
    await server.ready();
    const login = async (email: string) => {
      const response = await server!.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(response.statusCode).toBe(200);
      return response.headers['set-cookie'] as string;
    };
    const sourceCookie = await login(sourceEmail);
    const targetCookie = await login(targetEmail);

    const created = await server.inject({
      method: 'POST', url: '/api/transfer-requests', headers: { cookie: sourceCookie },
      payload: { employeeId: employee.id, targetUnitId: targetUnit.id, reason: 'Real Prisma regression' }
    });
    expect(created.statusCode).toBe(201);
    const requestId = JSON.parse(created.body).id;
    const approved = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${requestId}/action`, headers: { cookie: targetCookie },
      payload: {
        action: 'APPROVE', allocatedSeatId: firstTargetSeat.id,
        targetPlantId: targetPlant.id, targetBuildingId: targetBuilding.id,
        targetFloorId: targetFloor.id, departmentId: targetDepartment.id
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.body).status).toBe('APPROVED');
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: sourceSeat.id } })).employeeId).toBeNull();
    expect(await prisma.seat.findUniqueOrThrow({ where: { id: firstTargetSeat.id } })).toMatchObject({
      status: 'AVAILABLE', employeeId: employee.id
    });

    const sameUnit = await server.inject({
      method: 'POST', url: '/api/transfer-requests', headers: { cookie: targetCookie },
      payload: {
        employeeId: employee.id, targetUnitId: targetUnit.id,
        targetSeatId: secondTargetSeat.id, targetPlantId: targetPlant.id,
        targetBuildingId: targetBuilding.id, targetFloorId: targetFloor.id,
        reason: 'Same-unit real Prisma regression'
      }
    });
    expect(sameUnit.statusCode).toBe(400);
    expect(JSON.parse(sameUnit.body)).toMatchObject({ error: 'SAME_UNIT_TRANSFER_NOT_ALLOWED' });
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: firstTargetSeat.id } })).employeeId).toBe(employee.id);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: secondTargetSeat.id } })).employeeId).toBeNull();
    expect(await prisma.seat.count({ where: { employeeId: employee.id } })).toBe(1);
  }, 30000);
});
