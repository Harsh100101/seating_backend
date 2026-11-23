import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEMO_PASSWORD, seed } from '../prisma/seed.js';

describe('Seat capacity consistency', () => {
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

  async function login(email: string) {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: DEMO_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie'] as string;
  }

  it('keeps dashboard and transfer-option available counts identical and excludes empty units', async () => {
    const units = await prisma.unit.findMany();
    const unit1 = units.find((unit: any) => unit.code === 'UNIT-1');
    const unit2 = units.find((unit: any) => unit.code === 'UNIT-2');
    const emptyUnit = await prisma.unit.create({ data: { name: 'Capacity Empty Unit', code: `CAP-EMPTY-${Date.now()}` } });
    const plant1 = await prisma.plant.create({ data: { name: 'Capacity Plant 1', code: `CAP-P1-${Date.now()}`, unitId: unit1.id } });
    const building1 = await prisma.building.create({ data: { name: 'Capacity Building 1', code: `CAP-B1-${Date.now()}`, plantId: plant1.id } });
    const floor1 = await prisma.floor.create({ data: { name: 'Capacity Floor 1', floorNumber: 701, buildingId: building1.id } });
    await prisma.seat.create({ data: { label: 'CAP-AVAILABLE-1', floorId: floor1.id, status: 'AVAILABLE' } });
    await prisma.seat.create({ data: { label: 'CAP-AVAILABLE-2', floorId: floor1.id, status: 'AVAILABLE' } });
    await prisma.seat.create({ data: { label: 'CAP-RESERVED', floorId: floor1.id, status: 'RESERVED' } });
    const inactiveFloor = await prisma.floor.create({ data: { name: 'Capacity Inactive Floor', floorNumber: 702, buildingId: building1.id, isActive: false } });
    await prisma.seat.create({ data: { label: 'CAP-INACTIVE', floorId: inactiveFloor.id, status: 'AVAILABLE' } });

    const superAdminCookie = await login('superadmin@shaktiman.com');
    const unitAdminCookie = await login('unit1.admin@shaktiman.com');
    const summaryResponse = await server.inject({ method: 'GET', url: '/api/reports/summary', headers: { cookie: superAdminCookie } });
    const optionsResponse = await server.inject({ method: 'GET', url: '/api/transfer-requests/options', headers: { cookie: unitAdminCookie } });
    expect(summaryResponse.statusCode).toBe(200);
    expect(optionsResponse.statusCode).toBe(200);

    const summary = JSON.parse(summaryResponse.body);
    const options = JSON.parse(optionsResponse.body);
    const optionCounts = new Map(options.availableSeatCounts.map((item: any) => [item.unitId, item.availableSeats]));
    const summaryCounts = new Map(summary.byUnit.map((item: any) => [item.unitId, item.availableSeats]));
    for (const [unitId, count] of optionCounts) expect(summaryCounts.get(unitId)).toBe(count);
    expect(optionCounts.get(unit1.id)).toBe(2);
    expect(optionCounts.has(emptyUnit.id)).toBe(false);
    expect(summary.availableSeats).toBe(Array.from(optionCounts.values()).reduce((total: number, count: number) => total + count, 0));
    expect(optionCounts.get(unit2.id)).toBe(summaryCounts.get(unit2.id));
  });
});
