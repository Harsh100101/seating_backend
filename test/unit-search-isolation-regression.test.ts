import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Unit Admin employee search isolation', () => {
  let server: FastifyInstance;
  let unit1AdminCookie: string;
  let foreignEmployeeCode: string;

  beforeEach(async () => {
    const prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });

    const unit1 = await prisma.unit.findFirst({ where: { code: 'UNIT-1' } });
    const unit2 = await prisma.unit.findFirst({ where: { code: 'UNIT-2' } });
    const unit1Department = await prisma.department.create({ data: { name: 'Unit 1 Search QA', code: `U1-SQA-${Date.now()}`, unitId: unit1.id } });
    const unit2Department = await prisma.department.create({ data: { name: 'Unit 2 Search QA', code: `U2-SQA-${Date.now()}`, unitId: unit2.id } });
    const plant = await prisma.plant.create({ data: { name: 'Unit 1 Search Plant', code: `U1-SP-${Date.now()}`, unitId: unit1.id } });
    const building = await prisma.building.create({ data: { name: 'Unit 1 Search Building', code: `U1-SB-${Date.now()}`, plantId: plant.id } });
    const floor = await prisma.floor.create({ data: { name: 'Unit 1 Search Floor', floorNumber: 901, buildingId: building.id } });
    const employee = await prisma.employee.create({
      data: {
        employeeCode: `U2-SEARCH-${Date.now()}`,
        fullName: 'Unit 2 Search Isolation Employee',
        email: `u2-search-${Date.now()}@example.com`,
        departmentId: unit2Department.id,
        section: 'Unit 2 Only'
      }
    });
    foreignEmployeeCode = employee.employeeCode;

    // Simulate a transfer/legacy mismatch: Unit 2 ownership with a Unit 1 seat.
    await prisma.seat.create({
      data: {
        label: `U1-SEARCH-SEAT-${Date.now()}`,
        floorId: floor.id,
        employeeId: employee.id,
        departmentId: unit2Department.id,
        status: 'AVAILABLE'
      }
    });

    // Keep the local variable referenced so the fixture documents both
    // tenancy records and does not accidentally regress to a single-unit test.
    expect(unit1Department.unitId).toBe(unit1.id);
    server = buildServer({ prisma, sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!' });
    await server.ready();
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'unit1.admin@shaktiman.com', password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    unit1AdminCookie = login.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  it('does not leak a foreign-department employee through search when its seat is local', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/employees?search=${encodeURIComponent(foreignEmployeeCode)}`,
      headers: { cookie: unit1AdminCookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().employees).toHaveLength(0);
    expect(response.json().total).toBe(0);
  });

  it('does not leak foreign employee filter values when a foreign employee has a local seat', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/employees/filter-options',
      headers: { cookie: unit1AdminCookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sections).not.toContain('Unit 2 Only');
  });
});
