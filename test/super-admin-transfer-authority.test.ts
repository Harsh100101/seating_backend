import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD, TECH_ADMIN_PASSWORD } from '../prisma/seed.js';

describe('SUPER_ADMIN transfer authority policy', () => {
  let server: FastifyInstance;
  let prisma: any;
  let unit1: any;
  let unit2: any;
  let sourceEmployee: any;
  let sourceSeat: any;
  let destination: any;

  async function login(email: string, password = DEMO_PASSWORD) {
    const response = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie'] as string;
  }

  async function createFixture() {
    const units = await prisma.unit.findMany();
    unit1 = units.find((unit: any) => unit.code === 'UNIT-1');
    unit2 = units.find((unit: any) => unit.code === 'UNIT-2');

    const sourcePlant = await prisma.plant.create({ data: { name: 'SA Source Plant', code: `SA-SRC-${Date.now()}`, unitId: unit2.id } });
    const sourceBuilding = await prisma.building.create({ data: { name: 'SA Source Building', code: `SA-SRC-B-${Date.now()}`, plantId: sourcePlant.id } });
    const sourceFloor = await prisma.floor.create({ data: { name: 'SA Source Floor', floorNumber: 801, buildingId: sourceBuilding.id } });
    const sourceDepartment = await prisma.department.create({ data: { name: 'SA Source Department', code: `SA-SRC-D-${Date.now()}`, unitId: unit2.id } });
    sourceEmployee = await prisma.employee.create({
      data: {
        employeeCode: `SA-EMP-${Date.now()}`,
        fullName: 'Super Admin Transfer Employee',
        email: `sa-transfer-${Date.now()}@example.com`,
        departmentId: sourceDepartment.id
      }
    });
    sourceSeat = await prisma.seat.create({
      data: {
        label: `SA-SRC-SEAT-${Date.now()}`,
        floorId: sourceFloor.id,
        employeeId: sourceEmployee.id,
        departmentId: sourceDepartment.id,
        status: 'AVAILABLE'
      }
    });

    const targetPlant = await prisma.plant.create({ data: { name: 'SA Target Plant', code: `SA-DST-${Date.now()}`, unitId: unit1.id } });
    const targetBuilding = await prisma.building.create({ data: { name: 'SA Target Building', code: `SA-DST-B-${Date.now()}`, plantId: targetPlant.id } });
    const targetFloor = await prisma.floor.create({ data: { name: 'SA Target Floor', floorNumber: 802, buildingId: targetBuilding.id } });
    const targetDepartment = await prisma.department.create({ data: { name: 'SA Target Department', code: `SA-DST-D-${Date.now()}`, unitId: unit1.id } });
    const targetSeat = await prisma.seat.create({ data: { label: `SA-DST-SEAT-${Date.now()}`, floorId: targetFloor.id, status: 'AVAILABLE' } });
    destination = { targetPlant, targetBuilding, targetFloor, targetDepartment, targetSeat };
  }

  beforeEach(async () => {
    prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });
    server = buildServer({ prisma, sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!' });
    await server.ready();
    await createFixture();
  });

  afterEach(async () => server.close());

  it('creates with explicit source-unit validation and rejects an employee/source mismatch', async () => {
    const superAdmin = await login('superadmin@shaktiman.com');

    const mismatch = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdmin },
      payload: { employeeId: sourceEmployee.id, sourceUnitId: unit1.id, targetUnitId: unit2.id, reason: 'Invalid source selection' }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(JSON.parse(mismatch.body).error).toBe('SOURCE_UNIT_EMPLOYEE_MISMATCH');

    const created = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdmin },
      payload: { employeeId: sourceEmployee.id, sourceUnitId: unit2.id, targetUnitId: unit1.id, reason: 'Super Admin transfer request' }
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).sourceUnitId).toBe(unit2.id);
  });

  it('allows SUPER_ADMIN approval with atomic source release, destination claim, actor history, and deduped notification', async () => {
    const superAdmin = await login('superadmin@shaktiman.com');
    const created = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdmin },
      payload: { employeeId: sourceEmployee.id, sourceUnitId: unit2.id, targetUnitId: unit1.id, reason: 'Approve from global authority' }
    });
    const request = JSON.parse(created.body);

    const approvePayload = {
      action: 'APPROVE',
      allocatedSeatId: destination.targetSeat.id,
      targetPlantId: destination.targetPlant.id,
      targetBuildingId: destination.targetBuilding.id,
      targetFloorId: destination.targetFloor.id,
      departmentId: destination.targetDepartment.id
    };
    const approved = await server.inject({ method: 'POST', url: `/api/transfer-requests/${request.id}/action`, headers: { cookie: superAdmin }, payload: approvePayload });
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.body).targetAdminApproval.adminRole).toBe('SUPER_ADMIN');

    const sourceAfter = await prisma.seat.findUnique({ where: { id: sourceSeat.id } });
    const destinationAfter = await prisma.seat.findUnique({ where: { id: destination.targetSeat.id } });
    expect(sourceAfter.employeeId).toBeNull();
    expect(destinationAfter.employeeId).toBe(sourceEmployee.id);

    const notifications = await prisma.notification.findMany({ where: { transferRequestId: request.id } });
    expect(notifications.filter((notification: any) => notification.type === 'TRANSFER_PENDING')).toHaveLength(1);
    expect(notifications.filter((notification: any) => notification.type === 'TRANSFER_APPROVED')).toHaveLength(1);

    const duplicate = await server.inject({ method: 'POST', url: `/api/transfer-requests/${request.id}/action`, headers: { cookie: superAdmin }, payload: approvePayload });
    expect(duplicate.statusCode).toBe(400);
    expect(await prisma.notification.findMany({ where: { transferRequestId: request.id } })).toHaveLength(2);
  });

  it('allows SUPER_ADMIN rejection while preserving source assignment and records the actual actor', async () => {
    const superAdmin = await login('superadmin@shaktiman.com');
    const created = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdmin },
      payload: { employeeId: sourceEmployee.id, sourceUnitId: unit2.id, targetUnitId: unit1.id, reason: 'Reject from global authority' }
    });
    const request = JSON.parse(created.body);

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${request.id}/action`,
      headers: { cookie: superAdmin },
      payload: { action: 'REJECT', comment: 'Business need not approved' }
    });
    expect(rejected.statusCode).toBe(200);
    const body = JSON.parse(rejected.body);
    expect(body.status).toBe('REJECTED');
    expect(body.rejectedByRole).toBe('SUPER_ADMIN');
    expect(body.targetAdminApproval.adminRole).toBe('SUPER_ADMIN');
    expect((await prisma.seat.findUnique({ where: { id: sourceSeat.id } })).employeeId).toBe(sourceEmployee.id);
  });

  it('allows TECH_ADMIN and denies unrelated Unit Admin decisions', async () => {
    const superAdmin = await login('superadmin@shaktiman.com');
    const techAdmin = await login('techadmin@shaktiman.com', TECH_ADMIN_PASSWORD);
    const unit3Admin = await login('unit3.admin@shaktiman.com');
    const created = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdmin },
      payload: { employeeId: sourceEmployee.id, sourceUnitId: unit2.id, targetUnitId: unit1.id, reason: 'RBAC decision test' }
    });
    const request = JSON.parse(created.body);
    const payload = { action: 'REJECT', comment: 'No access' };

    const unrelatedResponse = await server.inject({ method: 'POST', url: `/api/transfer-requests/${request.id}/action`, headers: { cookie: unit3Admin }, payload });
    expect(unrelatedResponse.statusCode).toBe(403);

    const techResponse = await server.inject({ method: 'POST', url: `/api/transfer-requests/${request.id}/action`, headers: { cookie: techAdmin }, payload });
    expect(techResponse.statusCode).toBe(200);
    expect(JSON.parse(techResponse.body).status).toBe('REJECTED');
  });
});
