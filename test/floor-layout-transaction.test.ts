import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Floor Layout Transaction & Delta Update Regression Suite', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let sessionCookie: string;
  let floorId: string;
  let deptId: string;
  let empId1: string;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Authenticate admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;

    // Seed office, building, floor
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'HQ Office', city: 'Metropolis' }
    });
    const office = offRes.json();

    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Building A', code: 'BLD-A', officeId: office.id }
    });
    const building = bldRes.json();

    const flrRes = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor 1', floorNumber: 1, buildingId: building.id, canvasWidth: 1600, canvasHeight: 1000 }
    });
    floorId = flrRes.json().id;

    // Seed department & employee
    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Transaction Test Dept', code: 'TX-DEPT', colorHex: '#2563EB' }
    });
    deptId = deptRes.json().id;

    const empRes = await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-TX-100', fullName: 'Alice Engineer', email: 'alice.tx@company.com', departmentId: deptId }
    });
    empId1 = empRes.json().id;
  });

  afterEach(async () => {
    await server.close();
  });

  // 1. Single seat delta update: only modified seat is written, unmodified seats are not touched
  it('Delta Update: saves only changed seats without updating unchanged seats', async () => {
    // Seed 5 initial workstations
    const seedRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'WS-01', x: 10, y: 10, rotation: 0, width: 64, height: 48, placementSource: 'MANUAL' },
          { label: 'WS-02', x: 100, y: 10, rotation: 0, width: 64, height: 48, placementSource: 'MANUAL' },
          { label: 'WS-03', x: 200, y: 10, rotation: 0, width: 64, height: 48, placementSource: 'MANUAL' },
          { label: 'WS-04', x: 300, y: 10, rotation: 0, width: 64, height: 48, placementSource: 'MANUAL' },
          { label: 'WS-05', x: 400, y: 10, rotation: 0, width: 64, height: 48, placementSource: 'MANUAL' },
        ]
      }
    });
    expect(seedRes.statusCode).toBe(200);
    const initialSeats = seedRes.json().seats;
    expect(initialSeats).toHaveLength(5);

    // Spy on mockPrisma.seat.update
    const originalSeatUpdate = mockPrisma.seat.update.bind(mockPrisma.seat);
    const updateSpy = vi.fn(async (args) => originalSeatUpdate(args));
    mockPrisma.seat.update = updateSpy;

    // Move ONLY WS-01 from (10, 10) to (50, 60), leaving WS-02..WS-05 unchanged
    const payloadSeats = initialSeats.map((s: any) => {
      if (s.label === 'WS-01') {
        return { ...s, x: 50, y: 60 };
      }
      return { ...s };
    });

    const updateRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: { seats: payloadSeats }
    });

    expect(updateRes.statusCode).toBe(200);
    const updatedSeats = updateRes.json().seats;
    expect(updatedSeats).toHaveLength(5);

    // WS-01 has moved
    const movedWs1 = updatedSeats.find((s: any) => s.label === 'WS-01');
    expect(movedWs1.x).toBe(50);
    expect(movedWs1.y).toBe(60);

    // Verify update was called EXACTLY ONCE for WS-01, NOT for all 5 seats
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0].where.id).toBe(initialSeats[0].id);
    expect(updateSpy.mock.calls[0][0].data.x).toBe(50);
    expect(updateSpy.mock.calls[0][0].data.y).toBe(60);
  });

  // 2. Multiple changes (place, move, unplace) in a single batch
  it('Batch Changes: handles place, move, and unplace while preserving workstation business data', async () => {
    // 1. Create 3 seats initially
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'WS-MOVE', x: 20, y: 20, placementSource: 'MANUAL' },
          { label: 'WS-UNPLACE', x: 40, y: 40, placementSource: 'MANUAL' },
          { label: 'WS-TO-PLACE', x: 0, y: 0, placementSource: null }
        ]
      }
    });
    expect(initRes.statusCode).toBe(200);
    const [seatMove, seatUnplace, seatToPlace] = initRes.json().seats;

    // 2. Assign employee to WS-UNPLACE
    const assignRes = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatUnplace.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });
    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().employeeId).toBe(empId1);

    // 3. Batch operation:
    // - Move WS-MOVE to (80, 90)
    // - Place WS-TO-PLACE at (120, 130) with placementSource: MANUAL
    // - Unplace WS-UNPLACE (sent in unplacedSeatIds)
    // - Create a new seat WS-BRAND-NEW at (200, 200)
    const batchRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { id: seatMove.id, label: 'WS-MOVE', x: 80, y: 90, placementSource: 'MANUAL' },
          { id: seatToPlace.id, label: 'WS-TO-PLACE', x: 120, y: 130, placementSource: 'MANUAL' },
          { label: 'WS-BRAND-NEW', x: 200, y: 200, placementSource: 'MANUAL' }
        ],
        unplacedSeatIds: [seatUnplace.id]
      }
    });

    expect(batchRes.statusCode).toBe(200);

    // Verify in DB
    const movedInDb = await mockPrisma.seat.findUnique({ where: { id: seatMove.id } });
    expect(movedInDb.x).toBe(80);
    expect(movedInDb.y).toBe(90);

    const placedInDb = await mockPrisma.seat.findUnique({ where: { id: seatToPlace.id } });
    expect(placedInDb.x).toBe(120);
    expect(placedInDb.y).toBe(130);
    expect(placedInDb.placementSource).toBe('MANUAL');

    const unplacedInDb = await mockPrisma.seat.findUnique({ where: { id: seatUnplace.id } });
    expect(unplacedInDb.placementSource).toBeNull();
    // BUSINESS DATA PRESERVATION: employeeId and departmentId remain completely intact!
    expect(unplacedInDb.employeeId).toBe(empId1);
    expect(unplacedInDb.departmentId).toBe(deptId);

    const allFloorSeats = await mockPrisma.seat.findMany({ where: { floorId } });
    const newInDb = allFloorSeats.find((s: any) => s.label === 'WS-BRAND-NEW');
    expect(newInDb).toBeDefined();
    expect(newInDb.x).toBe(200);
  });

  // 3. Transaction conflict retry: transparently retries on transient conflict and succeeds
  it('Transaction Retry: retries on transient write conflict and succeeds on subsequent attempt', async () => {
    let attemptCount = 0;
    const originalTransaction = mockPrisma.$transaction.bind(mockPrisma);

    mockPrisma.$transaction = vi.fn(async (callback: any, ...rest: any[]) => {
      attemptCount++;
      if (attemptCount === 1) {
        const conflictErr = new Error('WriteConflict: transaction write conflict on documents');
        (conflictErr as any).code = 'P2034';
        throw conflictErr;
      }
      return originalTransaction(callback, ...rest);
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'WS-RETRY', x: 50, y: 50 }]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(attemptCount).toBe(2);
    expect(res.json().success).toBe(true);
    expect(res.json().seats[0].label).toBe('WS-RETRY');
  });

  // 4. Retry exhaustion: returns controlled 409 Conflict after 3 failed attempts
  it('Retry Exhaustion: returns controlled 409 Conflict after max attempts exhausted without exposing raw Prisma errors', async () => {
    let attemptCount = 0;
    mockPrisma.$transaction = vi.fn(async () => {
      attemptCount++;
      const conflictErr = new Error('WriteConflict: mongo document locked by concurrent write');
      (conflictErr as any).code = 'P2034';
      throw conflictErr;
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'WS-EXHAUST', x: 50, y: 50 }]
      }
    });

    expect(res.statusCode).toBe(409);
    expect(attemptCount).toBe(3);
    const body = res.json();
    expect(body.error).toBe('Conflict');
    expect(body.message).toContain('Could not save layout due to concurrent modifications');
    // Ensure raw Prisma invocation stack is NEVER exposed
    expect(body.message).not.toContain('Invalid `prisma.seat.updateMany()` invocation');
    expect(body.message).not.toContain('P2034');
  });

  // 5. Non-retryable errors: do NOT retry client or validation errors
  it('Non-Retryable Errors: immediately rejects 400/403/404 without opening transactions or retrying', async () => {
    const txSpy = vi.fn();
    mockPrisma.$transaction = txSpy;

    // A. 400 Bad Request on coordinate out of bounds
    const boundsRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'WS-OOB', x: 99999, y: 50 }]
      }
    });
    expect(boundsRes.statusCode).toBe(400);
    expect(boundsRes.json().message).toContain('coordinates out of canvas bounds');
    expect(txSpy).not.toHaveBeenCalled();

    // B. 404 Floor Not Found
    const notFoundRes = await server.inject({
      method: 'PUT',
      url: '/api/floors/000000000000000000000000/layout',
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'WS-404', x: 10, y: 10 }]
      }
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.json().message).toBe('Floor not found');
    expect(txSpy).not.toHaveBeenCalled();

    // C. Non-retryable internal error inside transaction should fail fast without retrying 3 times
    let innerAttempts = 0;
    mockPrisma.$transaction = vi.fn(async () => {
      innerAttempts++;
      throw new Error('Permanent database configuration error');
    });

    const fatalRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'WS-FATAL', x: 10, y: 10 }]
      }
    });
    expect(fatalRes.statusCode).toBe(500);
    expect(innerAttempts).toBe(1); // Exactly 1 attempt! No retries for non-transient errors.
    expect(fatalRes.json().message).toBe('An unexpected error occurred while saving floor layout.');
  });

  // 6. Disjoint validation: rejects overlapping seat IDs with 400 Bad Request
  it('Disjoint Validation: rejects overlapping seat IDs between placements, unplacedSeatIds, and deletedSeatIds', async () => {
    // Seed a seat
    const seedRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'WS-DISJOINT', x: 20, y: 20 }]
      }
    });
    const seatId = seedRes.json().seats[0].id;

    // A. Overlap between seats (placements) and unplacedSeatIds
    const overlapUnplaced = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ id: seatId, label: 'WS-DISJOINT', x: 25, y: 25 }],
        unplacedSeatIds: [seatId]
      }
    });
    expect(overlapUnplaced.statusCode).toBe(400);
    expect(overlapUnplaced.json().message).toContain('cannot appear in both placements and unplacedSeatIds');

    // B. Overlap between seats (placements) and deletedSeatIds
    const overlapDeleted = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ id: seatId, label: 'WS-DISJOINT', x: 25, y: 25 }],
        deletedSeatIds: [seatId]
      }
    });
    expect(overlapDeleted.statusCode).toBe(400);
    expect(overlapDeleted.json().message).toContain('cannot appear in both placements and deletedSeatIds');

    // C. Overlap between unplacedSeatIds and deletedSeatIds
    const overlapUnplacedDeleted = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        unplacedSeatIds: [seatId],
        deletedSeatIds: [seatId]
      }
    });
    expect(overlapUnplacedDeleted.statusCode).toBe(400);
    expect(overlapUnplacedDeleted.json().message).toContain('cannot appear in both unplacedSeatIds and deletedSeatIds');

    // D. Deduplication works seamlessly when duplicate IDs are provided within unplacedSeatIds or placements
    const dedupRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { id: seatId, label: 'WS-DISJOINT', x: 45, y: 45 },
          { id: seatId, label: 'WS-DISJOINT', x: 45, y: 45 } // duplicate ID in placements
        ]
      }
    });
    expect(dedupRes.statusCode).toBe(200);
    expect(dedupRes.json().seats).toHaveLength(1);
    expect(dedupRes.json().seats[0].x).toBe(45);
  });
});
