import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD, TECH_ADMIN_PASSWORD } from '../prisma/seed.js';

const directions = Array.from({ length: 5 }, (_, i) => i + 1)
  .flatMap((source) => Array.from({ length: 5 }, (_, i) => i + 1)
    .filter((target) => target !== source)
    .map((target) => ({ source, target })));

describe('Part 2: five-unit transfer recovery', () => {
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

  async function fixture(sourceUnitNumber: number, targetUnitNumber: number) {
    const units = await prisma.unit.findMany();
    const unit = (number: number) => units.find((item: any) => item.code === `UNIT-${number}`);
    const sourceUnit = unit(sourceUnitNumber);
    const targetUnit = unit(targetUnitNumber);
    const sourcePlant = await prisma.plant.create({ data: { name: `P-${sourceUnitNumber}`, code: `P-${sourceUnitNumber}-${Date.now()}`, unitId: sourceUnit.id } });
    const sourceBuilding = await prisma.building.create({ data: { name: `B-${sourceUnitNumber}`, code: `B-${sourceUnitNumber}-${Date.now()}`, plantId: sourcePlant.id } });
    const sourceFloor = await prisma.floor.create({ data: { name: `F-${sourceUnitNumber}`, floorNumber: 91, buildingId: sourceBuilding.id } });
    const sourceDepartment = await prisma.department.create({ data: { name: `D-${sourceUnitNumber}`, code: `D-${sourceUnitNumber}-${Date.now()}`, unitId: sourceUnit.id } });
    const sourceEmployee = await prisma.employee.create({ data: { employeeCode: `E-${sourceUnitNumber}-${Date.now()}`, fullName: `Transfer Employee ${sourceUnitNumber}`, email: `transfer-${sourceUnitNumber}-${Date.now()}@example.com`, departmentId: sourceDepartment.id } });
    const sourceSeat = await prisma.seat.create({ data: { label: `SRC-${sourceUnitNumber}-${Date.now()}`, floorId: sourceFloor.id, employeeId: sourceEmployee.id, departmentId: sourceDepartment.id, status: 'AVAILABLE' } });

    const targetPlant = await prisma.plant.create({ data: { name: `P-${targetUnitNumber}`, code: `P-${targetUnitNumber}-${Date.now()}`, unitId: targetUnit.id } });
    const targetBuilding = await prisma.building.create({ data: { name: `B-${targetUnitNumber}`, code: `B-${targetUnitNumber}-${Date.now()}`, plantId: targetPlant.id } });
    const targetFloor = await prisma.floor.create({ data: { name: `F-${targetUnitNumber}`, floorNumber: 92, buildingId: targetBuilding.id } });
    const targetDepartment = await prisma.department.create({ data: { name: `D-${targetUnitNumber}`, code: `D-${targetUnitNumber}-${Date.now()}`, unitId: targetUnit.id } });
    const targetSeat = await prisma.seat.create({ data: { label: `DST-${targetUnitNumber}-${Date.now()}`, floorId: targetFloor.id, status: 'AVAILABLE' } });
    return { sourceUnit, targetUnit, sourceEmployee, sourceSeat, targetPlant, targetBuilding, targetFloor, targetDepartment, targetSeat };
  }

  it.each(directions)('supports Unit $source -> Unit $target', async ({ source, target }) => {
    const data = await fixture(source, target);
    const sourceCookie = await login(source);
    const targetCookie = await login(target);

    const created = await server.inject({
      method: 'POST', url: '/api/transfer-requests', headers: { cookie: sourceCookie },
      payload: { employeeId: data.sourceEmployee.id, targetUnitId: data.targetUnit.id, reason: 'Part 2 direction validation' }
    });
    expect(created.statusCode).toBe(201);
    const request = JSON.parse(created.body);
    expect(request.status).toBe('PENDING_TARGET_ADMIN');
    expect(request.sourceUnitId).toBe(data.sourceUnit.id);
    expect(request.targetUnitId).toBe(data.targetUnit.id);

    const approved = await server.inject({
      method: 'POST', url: `/api/transfer-requests/${request.id}/action`, headers: { cookie: targetCookie },
      payload: {
        action: 'APPROVE', allocatedSeatId: data.targetSeat.id,
        targetPlantId: data.targetPlant.id, targetBuildingId: data.targetBuilding.id,
        targetFloorId: data.targetFloor.id, departmentId: data.targetDepartment.id
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.body).status).toBe('APPROVED');
    expect((await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } })).employeeId).toBeNull();
    expect((await prisma.seat.findUnique({ where: { id: data.targetSeat.id } })).employeeId).toBe(data.sourceEmployee.id);
  });

  it('allows Tech Admin global transfer controls', async () => {
    const data = await fixture(2, 1);
    const tech = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'techadmin@shaktiman.com', password: TECH_ADMIN_PASSWORD } });
    expect(tech.statusCode).toBe(200);
    const options = await server.inject({ method: 'GET', url: '/api/transfer-requests/options', headers: { cookie: tech.headers['set-cookie'] as string } });
    expect(options.statusCode).toBe(200);
    const create = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: tech.headers['set-cookie'] as string },
      payload: { employeeId: data.sourceEmployee.id, targetUnitId: data.targetUnit.id, reason: 'Tech Admin global authority' }
    });
    expect(create.statusCode).toBe(201);
  });

  it('allows only the initiating source Unit Admin to cancel pending requests', async () => {
    const data = await fixture(2, 1);
    const sourceCookie = await login(2);
    const targetCookie = await login(1);
    const created = await server.inject({ method: 'POST', url: '/api/transfer-requests', headers: { cookie: sourceCookie }, payload: { employeeId: data.sourceEmployee.id, targetUnitId: data.targetUnit.id, reason: 'cancel test' } });
    const request = JSON.parse(created.body);
    const wrong = await server.inject({ method: 'POST', url: `/api/transfer-requests/${request.id}/cancel`, headers: { cookie: targetCookie }, payload: { reason: 'not source' } });
    expect(wrong.statusCode).toBe(403);
    const cancelled = await server.inject({ method: 'POST', url: `/api/transfer-requests/${request.id}/cancel`, headers: { cookie: sourceCookie }, payload: { reason: 'source changed plan' } });
    expect(cancelled.statusCode).toBe(200);
    expect(JSON.parse(cancelled.body).status).toBe('CANCELLED');
    expect((await prisma.seat.findUnique({ where: { id: data.sourceSeat.id } })).employeeId).toBe(data.sourceEmployee.id);
  });

  it('allows only one approval to claim the final destination seat', async () => {
    const first = await fixture(2, 1);
    const units = await prisma.unit.findMany();
    const unit3 = units.find((item: any) => item.code === 'UNIT-3');
    const plant3 = await prisma.plant.create({ data: { name: 'P-3-concurrency', code: `P-3-${Date.now()}`, unitId: unit3.id } });
    const building3 = await prisma.building.create({ data: { name: 'B-3-concurrency', code: `B-3-${Date.now()}`, plantId: plant3.id } });
    const floor3 = await prisma.floor.create({ data: { name: 'F-3-concurrency', floorNumber: 93, buildingId: building3.id } });
    const department3 = await prisma.department.create({ data: { name: 'D-3-concurrency', code: `D-3-${Date.now()}`, unitId: unit3.id } });
    const employee3 = await prisma.employee.create({ data: { employeeCode: `E-3-${Date.now()}`, fullName: 'Concurrent Transfer Employee', email: `concurrent-${Date.now()}@example.com`, departmentId: department3.id } });
    const sourceSeat3 = await prisma.seat.create({ data: { label: `SRC-3-${Date.now()}`, floorId: floor3.id, employeeId: employee3.id, departmentId: department3.id, status: 'AVAILABLE' } });
    const source2 = await login(2);
    const source3 = await login(3);
    const target = await login(1);
    const createPayload = (employeeId: string) => ({ employeeId, targetUnitId: first.targetUnit.id, reason: 'last-seat contention' });
    const [created1, created2] = await Promise.all([
      server.inject({ method: 'POST', url: '/api/transfer-requests', headers: { cookie: source2 }, payload: createPayload(first.sourceEmployee.id) }),
      server.inject({ method: 'POST', url: '/api/transfer-requests', headers: { cookie: source3 }, payload: createPayload(employee3.id) })
    ]);
    expect(created1.statusCode).toBe(201);
    expect(created2.statusCode).toBe(201);
    const request1 = JSON.parse(created1.body);
    const request2 = JSON.parse(created2.body);
    const approve = (requestId: string) => server.inject({
      method: 'POST', url: `/api/transfer-requests/${requestId}/action`, headers: { cookie: target },
      payload: { action: 'APPROVE', allocatedSeatId: first.targetSeat.id, targetPlantId: first.targetPlant.id, targetBuildingId: first.targetBuilding.id, targetFloorId: first.targetFloor.id, departmentId: first.targetDepartment.id }
    });
    const results = await Promise.all([approve(request1.id), approve(request2.id)]);
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1);
    expect(results.filter((result) => result.statusCode === 409)).toHaveLength(1);
    expect((await prisma.seat.findUnique({ where: { id: first.targetSeat.id } })).employeeId).toBeTruthy();
    expect((await prisma.seat.findUnique({ where: { id: sourceSeat3.id } })).employeeId === employee3.id || (await prisma.seat.findUnique({ where: { id: first.sourceSeat.id } })).employeeId === first.sourceEmployee.id).toBe(true);
  });
});
