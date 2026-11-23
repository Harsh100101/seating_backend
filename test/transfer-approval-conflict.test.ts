import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEMO_PASSWORD, seed } from '../prisma/seed.js';

describe('Transfer approval transaction conflict recovery', () => {
  let server: FastifyInstance;
  let prisma: any;

  beforeEach(async () => {
    prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });
    server = buildServer({
      prisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();
  });

  afterEach(async () => server.close());

  async function login(unit: number) {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `unit${unit}.admin@shaktiman.com`, password: DEMO_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie'] as string;
  }

  async function createTransfer() {
    const units = await prisma.unit.findMany();
    const sourceUnit = units.find((unit: any) => unit.code === 'UNIT-2');
    const targetUnit = units.find((unit: any) => unit.code === 'UNIT-1');
    const suffix = Date.now().toString();
    const sourcePlant = await prisma.plant.create({ data: { name: `Conflict Source Plant ${suffix}`, code: `CSP-${suffix}`, unitId: sourceUnit.id } });
    const sourceBuilding = await prisma.building.create({ data: { name: `Conflict Source Building ${suffix}`, code: `CSB-${suffix}`, plantId: sourcePlant.id } });
    const sourceFloor = await prisma.floor.create({ data: { name: `Conflict Source Floor ${suffix}`, floorNumber: 801, buildingId: sourceBuilding.id } });
    const sourceDepartment = await prisma.department.create({ data: { name: `Conflict Source Department ${suffix}`, code: `CSD-${suffix}`, unitId: sourceUnit.id } });
    const employee = await prisma.employee.create({ data: { employeeCode: `CEMP-${suffix}`, fullName: 'Conflict Test Employee', email: `conflict-${suffix}@example.com`, departmentId: sourceDepartment.id } });
    const sourceSeat = await prisma.seat.create({ data: { label: `C-SOURCE-${suffix}`, floorId: sourceFloor.id, employeeId: employee.id, departmentId: sourceDepartment.id, status: 'AVAILABLE' } });

    const targetPlant = await prisma.plant.create({ data: { name: `Conflict Target Plant ${suffix}`, code: `CTP-${suffix}`, unitId: targetUnit.id } });
    const targetBuilding = await prisma.building.create({ data: { name: `Conflict Target Building ${suffix}`, code: `CTB-${suffix}`, plantId: targetPlant.id } });
    const targetFloor = await prisma.floor.create({ data: { name: `Conflict Target Floor ${suffix}`, floorNumber: 802, buildingId: targetBuilding.id } });
    const targetDepartment = await prisma.department.create({ data: { name: `Conflict Target Department ${suffix}`, code: `CTD-${suffix}`, unitId: targetUnit.id } });
    const targetSeat = await prisma.seat.create({ data: { label: `C-TARGET-${suffix}`, floorId: targetFloor.id, status: 'AVAILABLE' } });

    const sourceCookie = await login(2);
    const targetCookie = await login(1);
    const created = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: sourceCookie },
      payload: { employeeId: employee.id, targetUnitId: targetUnit.id, reason: 'Transaction conflict regression' }
    });
    expect(created.statusCode).toBe(201);

    return { sourceCookie, targetCookie, targetSeat, targetPlant, targetBuilding, targetFloor, targetDepartment, request: JSON.parse(created.body), sourceSeat };
  }

  function approvalPayload(data: any) {
    return {
      action: 'APPROVE',
      allocatedSeatId: data.targetSeat.id,
      targetPlantId: data.targetPlant.id,
      targetBuildingId: data.targetBuilding.id,
      targetFloorId: data.targetFloor.id,
      departmentId: data.targetDepartment.id
    };
  }

  it('retries one transient transaction conflict and completes approval', async () => {
    const data = await createTransfer();
    const originalTransaction = prisma.$transaction;
    let attempts = 0;
    prisma.$transaction = async (callback: any) => {
      attempts++;
      if (attempts === 1) {
        const error: any = new Error('Write conflict during transaction');
        error.code = 'P2034';
        throw error;
      }
      return originalTransaction(callback);
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie },
      payload: approvalPayload(data)
    });

    expect(response.statusCode).toBe(200);
    expect(attempts).toBe(2);
    expect((await prisma.seat.findUnique({ where: { id: data.targetSeat.id } })).employeeId).toBe(data.request.employeeId);
  });

  it('persists recipient-scoped transfer notifications and supports read state', async () => {
    const data = await createTransfer();
    const incoming = await server.inject({
      method: 'GET',
      url: '/api/notifications?unreadOnly=true',
      headers: { cookie: data.targetCookie }
    });
    expect(incoming.statusCode).toBe(200);
    const incomingPayload = JSON.parse(incoming.body);
    expect(incomingPayload.unreadCount).toBe(1);
    expect(incomingPayload.notifications[0].type).toBe('TRANSFER_PENDING');
    expect(incomingPayload.notifications[0].transferRequestId).toBe(data.request.id);

    const sourceView = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: data.sourceCookie }
    });
    expect(JSON.parse(sourceView.body).notifications).toHaveLength(0);

    const read = await server.inject({
      method: 'PATCH',
      url: `/api/notifications/${incomingPayload.notifications[0].id}/read`,
      headers: { cookie: data.targetCookie }
    });
    expect(read.statusCode).toBe(200);
    const afterRead = await server.inject({
      method: 'GET',
      url: '/api/notifications?unreadOnly=true',
      headers: { cookie: data.targetCookie }
    });
    expect(JSON.parse(afterRead.body).unreadCount).toBe(0);
  });

  it('rejects invalid persisted statuses and approves using employee occupancy', async () => {
    const data = await createTransfer();
    await expect(prisma.seat.updateMany({
      where: { id: data.targetSeat.id }, data: { status: 'OCCUPIED' }
    })).rejects.toThrow('Invalid SeatStatus');

    const approved = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.body).status).toBe('APPROVED');
    const source = await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } });
    const target = await prisma.seat.findUnique({ where: { id: data.targetSeat.id } });
    expect(source.employeeId).toBeNull();
    expect(source.status).toBe('AVAILABLE');
    expect(target.employeeId).toBe(data.request.employeeId);
    expect(target.status).toBe('AVAILABLE');
    expect((await prisma.seat.findMany({ where: { employeeId: data.request.employeeId } }))).toHaveLength(1);
  });

  it('does not expose Prisma details when an unexpected approval error occurs', async () => {
    const data = await createTransfer();
    prisma.$transaction = async () => {
      throw new Error('Invalid tx.seat.updateMany invocation with employeeId: private-value');
    };
    const response = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('TRANSFER_APPROVAL_FAILED');
    expect(response.body).not.toContain('tx.seat.updateMany');
    expect(response.body).not.toContain('private-value');
    expect((await prisma.seatTransferRequest.findUnique({ where: { id: data.request.id } })).status).toBe('PENDING_TARGET_ADMIN');
  });

  it('rejects a request that becomes approved after the initial read', async () => {
    const data = await createTransfer();
    const originalFindUnique = prisma.seatTransferRequest.findUnique;
    const originalUpdate = prisma.seatTransferRequest.update;
    let injectedRace = false;

    prisma.seatTransferRequest.findUnique = async (args: any) => {
      const result = await originalFindUnique(args);
      if (!injectedRace && args.where?.id === data.request.id && args.include) {
        injectedRace = true;
        await originalUpdate({ where: { id: data.request.id }, data: { status: 'APPROVED' } });
      }
      return result;
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie },
      payload: { action: 'REJECT', comment: 'Too late' }
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).message).toContain('no longer pending');
    expect((await originalFindUnique({ where: { id: data.request.id } })).status).toBe('APPROVED');
  });

  it('unsets the released source employee field and permits a later transfer', async () => {
    const data = await createTransfer();
    const originalUpdateMany = prisma.seat.updateMany;
    let releasedWithUnset = false;
    prisma.seat.updateMany = async (args: any) => {
      if (args.where?.id === data.sourceSeat.id) releasedWithUnset = args.data?.employeeId?.unset === true;
      return originalUpdateMany(args);
    };
    const approved = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });
    expect(approved.statusCode).toBe(200);
    expect(releasedWithUnset).toBe(true);
    const unit2 = (await prisma.unit.findMany()).find((unit: any) => unit.code === 'UNIT-2');
    const next = await server.inject({
      method: 'POST', url: '/api/transfer-requests', headers: { cookie: data.targetCookie },
      payload: { employeeId: data.request.employeeId, targetUnitId: unit2.id, reason: 'Next transfer after approval' }
    });
    expect(next.statusCode).toBe(201);
  });

  it('returns a stable retryable conflict after bounded transient retries', async () => {
    const data = await createTransfer();
    let attempts = 0;
    prisma.$transaction = async () => {
      attempts++;
      const error: any = new Error('Transient transaction conflict');
      error.code = 'P2034';
      throw error;
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie },
      payload: approvalPayload(data)
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe('TRANSFER_TRANSACTION_CONFLICT');
    expect(attempts).toBe(3);
  });

  it('does not retry a deterministic destination-seat conflict', async () => {
    const data = await createTransfer();
    await prisma.seat.update({ where: { id: data.targetSeat.id }, data: { employeeId: 'another-employee', status: 'AVAILABLE' } });
    const originalTransaction = prisma.$transaction;
    let attempts = 0;
    prisma.$transaction = async (callback: any) => {
      attempts++;
      return originalTransaction(callback);
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie },
      payload: approvalPayload(data)
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).message).toContain('already occupied');
    expect(attempts).toBe(1);
  });

  it('returns a specific occupied conflict and preserves the pending request and source seat', async () => {
    const data = await createTransfer();
    await prisma.seat.update({ where: { id: data.targetSeat.id }, data: { employeeId: 'another-employee' } });

    const response = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe('TRANSFER_DESTINATION_ALREADY_OCCUPIED');
    expect((await prisma.seatTransferRequest.findUnique({ where: { id: data.request.id } })).status).toBe('PENDING_TARGET_ADMIN');
    expect((await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } })).employeeId).toBe(data.request.employeeId);
  });

  it.each(['MAINTENANCE', 'RESERVED'])('returns a specific unavailable conflict for %s seats', async (status) => {
    const data = await createTransfer();
    await prisma.seat.update({ where: { id: data.targetSeat.id }, data: { status } });

    const response = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe('TRANSFER_DESTINATION_NOT_AVAILABLE');
    expect((await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } })).employeeId).toBe(data.request.employeeId);
  });

  it('returns a race-lost conflict when the conditional claim loses after validation', async () => {
    const data = await createTransfer();
    const originalUpdateMany = prisma.seat.updateMany;
    prisma.seat.updateMany = async (args: any) => {
      if (args.where?.id === data.targetSeat.id && args.data?.employeeId === data.request.employeeId) return { count: 0 };
      return originalUpdateMany(args);
    };

    const response = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe('TRANSFER_DESTINATION_RACE_LOST');
    expect((await prisma.seatTransferRequest.findUnique({ where: { id: data.request.id } })).status).toBe('PENDING_TARGET_ADMIN');
    expect((await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } })).employeeId).toBe(data.request.employeeId);
    expect((await prisma.seat.findUnique({ where: { id: data.targetSeat.id } })).employeeId).toBeNull();
  });

  it.each([
    { target: ['employeeId'], code: 'TRANSFER_EMPLOYEE_SEAT_CONFLICT' },
    { target: 'seats_employee_id_key', code: 'TRANSFER_EMPLOYEE_SEAT_CONFLICT' },
    { target: ['activeTransferKey'], code: 'TRANSFER_ACTIVE_REQUEST_CONFLICT' },
    { target: ['otherUniqueField'], code: 'TRANSFER_UNIQUE_CONFLICT' },
  ])('reports $code without changing seats or the pending request', async ({ target, code }) => {
    const data = await createTransfer();
    let attempts = 0;
    prisma.$transaction = async () => {
      attempts++;
      const error: any = new Error('Unique constraint failed');
      error.code = 'P2002';
      error.meta = { target };
      throw error;
    };
    const response = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${data.request.id}/action`,
      headers: { cookie: data.targetCookie }, payload: approvalPayload(data)
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe(code);
    expect(attempts).toBe(1);
    expect((await prisma.seatTransferRequest.findUnique({ where: { id: data.request.id } })).status).toBe('PENDING_TARGET_ADMIN');
    expect((await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } })).employeeId).toBe(data.request.employeeId);
    expect((await prisma.seat.findUnique({ where: { id: data.targetSeat.id } })).employeeId).toBeNull();
  });
});
