import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Milestone Atomic Operations: Quick-Assign & Relocate', () => {
  let server: FastifyInstance;
  let adminCookie: string;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma);
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Login as admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    expect(loginRes.statusCode).toBe(200);
    adminCookie = loginRes.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  it('ATOMIC-01: Quick-Assign creates employee and occupies seat in single transaction', async () => {
    const departments = await mockPrisma.department.findMany();
    const dept = departments[0];

    const seat = await mockPrisma.seat.findFirst({
      where: { status: 'AVAILABLE', employeeId: null }
    });
    expect(seat).toBeDefined();

    const empCode = `QA-TEST-${Date.now().toString().slice(-4)}`;
    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${seat!.id}/quick-assign`,
      headers: { cookie: adminCookie },
      payload: {
        fullName: 'Quick Assign Employee',
        employeeCode: empCode,
        departmentId: dept.id,
        email: `qa.${empCode.toLowerCase()}@company.com`
      }
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.id).toBe(seat!.id);
    expect(data.employee).toBeDefined();
    expect(data.employee.employeeCode).toBe(empCode);
    expect(data.employeeId).toBe(data.employee.id);

    // Verify DB state
    const dbSeat = await mockPrisma.seat.findUnique({
      where: { id: seat!.id },
      include: { employee: true }
    });
    expect(dbSeat?.employeeId).toBe(data.employee.id);
  });

  it('ATOMIC-02: Quick-Assign rolls back completely if employeeCode already exists', async () => {
    const departments = await mockPrisma.department.findMany();
    const dept = departments[0];
    const existing = await mockPrisma.employee.create({
      data: {
        fullName: 'Already Exists',
        employeeCode: 'EXISTING-01',
        departmentId: dept.id
      }
    });

    const seat = await mockPrisma.seat.findFirst({
      where: { status: 'AVAILABLE', employeeId: null }
    });
    expect(seat).toBeDefined();

    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${seat!.id}/quick-assign`,
      headers: { cookie: adminCookie },
      payload: {
        fullName: 'Duplicate Employee',
        employeeCode: existing.employeeCode,
        departmentId: dept.id
      }
    });

    expect(res.statusCode).toBe(409);
    // Verify seat is still vacant
    const dbSeat = await mockPrisma.seat.findUnique({ where: { id: seat!.id } });
    expect(dbSeat?.employeeId).toBeNull();
  });

  it('ATOMIC-03: Transfer atomically relocates occupant from source to target seat', async () => {
    const departments = await mockPrisma.department.findMany();
    const dept = departments[0];
    const emp = await mockPrisma.employee.create({
      data: {
        fullName: 'Transfer Tester',
        employeeCode: 'TRF-001',
        departmentId: dept.id
      }
    });

    // Seat A (source)
    const availableSeats = await mockPrisma.seat.findMany({
      where: { status: 'AVAILABLE', employeeId: null },
      take: 2
    });
    expect(availableSeats.length).toBeGreaterThanOrEqual(2);

    const sourceSeat = await mockPrisma.seat.update({
      where: { id: availableSeats[0].id },
      data: { employeeId: emp.id, departmentId: dept.id, status: 'AVAILABLE' }
    });

    const targetSeat = availableSeats[1];

    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${sourceSeat.id}/transfer`,
      headers: { cookie: adminCookie },
      payload: {
        targetSeatId: targetSeat.id
      }
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.sourceSeat.employeeId).toBeNull();
    expect(result.targetSeat.employeeId).toBe(emp.id);

    // Verify in DB
    const freshSource = await mockPrisma.seat.findUnique({ where: { id: sourceSeat.id } });
    const freshTarget = await mockPrisma.seat.findUnique({ where: { id: targetSeat.id } });
    expect(freshSource?.employeeId).toBeNull();
    expect(freshTarget?.employeeId).toBe(emp.id);
  });

  it('ATOMIC-04: Transfer aborts and rolls back if target seat is already occupied', async () => {
    const departments = await mockPrisma.department.findMany();
    const dept = departments[0];
    const emp1 = await mockPrisma.employee.create({
      data: { fullName: 'Occupant One', employeeCode: 'EMP-OCC-1', departmentId: dept.id }
    });
    const emp2 = await mockPrisma.employee.create({
      data: { fullName: 'Occupant Two', employeeCode: 'EMP-OCC-2', departmentId: dept.id }
    });

    const seats = await mockPrisma.seat.findMany({
      where: { status: 'AVAILABLE', employeeId: null },
      take: 2
    });

    const sourceSeat = await mockPrisma.seat.update({
      where: { id: seats[0].id },
      data: { employeeId: emp1.id, status: 'AVAILABLE' }
    });

    const targetSeat = await mockPrisma.seat.update({
      where: { id: seats[1].id },
      data: { employeeId: emp2.id, status: 'AVAILABLE' }
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${sourceSeat.id}/transfer`,
      headers: { cookie: adminCookie },
      payload: {
        targetSeatId: targetSeat.id
      }
    });

    expect(res.statusCode).toBe(409);
    // Source seat still keeps employee
    const freshSource = await mockPrisma.seat.findUnique({ where: { id: sourceSeat.id } });
    expect(freshSource?.employeeId).toBe(emp1.id);
  });
});
