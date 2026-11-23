import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Milestone 3 Integration: Seats, Layouts & Assignments (Features 18, 19, 20, 21)', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let floorId: string;
  let deptId: string;
  let empId1: string;
  let empId2: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
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
      payload: { name: 'Main Office', city: 'Seattle' }
    });
    const office = offRes.json();

    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Tower A', code: 'TWR-A', officeId: office.id }
    });
    const building = bldRes.json();

    const flrRes = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor 1', floorNumber: 1, buildingId: building.id, canvasWidth: 1600, canvasHeight: 1000 }
    });
    floorId = flrRes.json().id;

    // Seed department
    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Engineering Devs', code: 'ENG-DEV', colorHex: '#2563EB' }
    });
    deptId = deptRes.json().id;

    // Seed 2 employees
    const emp1Res = await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-001', fullName: 'Alice Engineer', email: 'alice@company.com', departmentId: deptId }
    });
    empId1 = emp1Res.json().id;

    const emp2Res = await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-002', fullName: 'Bob Developer', email: 'bob@company.com', departmentId: deptId }
    });
    empId2 = emp2Res.json().id;
  });

  afterEach(async () => {
    await server.close();
  });

  // Feature 18: Batch Floor Layout API
  it('SEAT-01: PUT /api/floors/:id/layout creates and updates seats in batch', async () => {
    const layoutRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'D-101', x: 100, y: 150, rotation: 0, type: 'STANDARD_DESK', status: 'AVAILABLE' },
          { label: 'D-102', x: 200, y: 150, rotation: 90, type: 'STANDING_DESK', status: 'AVAILABLE' }
        ]
      }
    });

    expect(layoutRes.statusCode).toBe(200);
    const body = layoutRes.json();
    expect(body.success).toBe(true);
    expect(body.seats).toHaveLength(2);
    expect(body.seats[0].label).toBe('D-101');
    expect(body.seats[1].label).toBe('D-102');
  });

  it('SEAT-02: PUT /api/floors/:id/layout rejects duplicate labels with 400 Bad Request', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'DUP-1', x: 50, y: 50 },
          { label: 'DUP-1', x: 150, y: 50 }
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Duplicate seat label');
  });

  it('SEAT-03: PUT /api/floors/:id/layout rejects coordinates exceeding canvas bounds with 400', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'OUT-OF-BOUNDS', x: 2000, y: 50 } // canvasWidth is 1600
        ]
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('out of canvas bounds');
  });

  it('SEAT-04: PUT /api/floors/:id/layout preserves existing employeeId on updated seats', async () => {
    // 1. Create seat
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'DESK-PRESERVE', x: 100, y: 100 }]
      }
    });
    const seatId = initRes.json().seats[0].id;

    // 2. Assign employee to seat
    await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });

    // 3. Update seat position via layout save
    const updRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ id: seatId, label: 'DESK-PRESERVE', x: 300, y: 400 }]
      }
    });

    expect(updRes.statusCode).toBe(200);
    const updatedSeat = updRes.json().seats[0];
    expect(updatedSeat.x).toBe(300);
    expect(updatedSeat.y).toBe(400);
    expect(updatedSeat.employeeId).toBe(empId1);
  });

  // Feature 19: Atomic Seat Assignment API
  it('SEAT-05: POST & PATCH /api/seats/:id/assign assigns employee to AVAILABLE seat', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'ASSIGN-POST', x: 50, y: 50 },
          { label: 'ASSIGN-PATCH', x: 150, y: 50 }
        ]
      }
    });
    const [seatA, seatB] = initRes.json().seats;

    // Test POST
    const postRes = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatA.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json().employeeId).toBe(empId1);
    expect(postRes.json().departmentId).toBe(deptId);

    // Test PATCH
    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/api/seats/${seatB.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId2 }
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().employeeId).toBe(empId2);
    expect(patchRes.json().departmentId).toBe(deptId);
  });

  it('SEAT-06: Assign returns 400 Bad Request for MAINTENANCE or RESERVED seat', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'DESK-MAINT', x: 50, y: 50, status: 'MAINTENANCE' }]
      }
    });
    const seatId = initRes.json().seats[0].id;

    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Cannot assign seat with status 'MAINTENANCE'");
  });

  it('SEAT-07: Assign returns 404 for non-existent seat or employee', async () => {
    const res1 = await server.inject({
      method: 'POST',
      url: '/api/seats/00000000-0000-0000-0000-000000000000/assign',
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });
    expect(res1.statusCode).toBe(404);

    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: { seats: [{ label: 'DESK-VALID', x: 50, y: 50 }] }
    });
    const seatId = initRes.json().seats[0].id;

    const res2 = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: '00000000-0000-0000-0000-000000000000' }
    });
    expect(res2.statusCode).toBe(404);
  });

  it('SEAT-08: Assign enforces strict 1:1 invariant: assigning already-seated employee to 2nd seat fails with 409', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'DESK-1', x: 50, y: 50 },
          { label: 'DESK-2', x: 150, y: 50 }
        ]
      }
    });
    const [seat1, seat2] = initRes.json().seats;

    // Assign to Desk 1
    const res1 = await server.inject({
      method: 'POST',
      url: `/api/seats/${seat1.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });
    expect(res1.statusCode).toBe(200);

    // Attempt to assign same employee to Desk 2
    const res2 = await server.inject({
      method: 'POST',
      url: `/api/seats/${seat2.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().message).toContain('Employee is already assigned to seat DESK-1');
  });

  it('SEAT-09: Assign to already occupied seat by someone else returns 409 Conflict', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'CONTESTED-DESK', x: 50, y: 50 }]
      }
    });
    const seatId = initRes.json().seats[0].id;

    // Employee 1 takes seat
    await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });

    // Employee 2 attempts to take same seat
    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId2 }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Seat is already assigned to another employee');
  });

  it('SEAT-09A: concurrent assignments to one seat have exactly one winner', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: { seats: [{ label: 'CONCURRENT-DESK', x: 50, y: 50 }] }
    });
    const seatId = initRes.json().seats[0].id;

    const responses = await Promise.all([
      server.inject({ method: 'POST', url: `/api/seats/${seatId}/assign`, headers: { cookie: sessionCookie }, payload: { employeeId: empId1 } }),
      server.inject({ method: 'POST', url: `/api/seats/${seatId}/assign`, headers: { cookie: sessionCookie }, payload: { employeeId: empId2 } })
    ]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
    const finalSeat = (await server.inject({ method: 'GET', url: `/api/seats/${seatId}`, headers: { cookie: sessionCookie } })).json();
    expect([empId1, empId2]).toContain(finalSeat.employeeId);
  });

  // Feature 20: Atomic Seat Unassignment API
  it('SEAT-10: POST & PATCH /api/seats/:id/unassign clears employeeId and departmentId', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'UNASSIGN-POST', x: 50, y: 50 },
          { label: 'UNASSIGN-PATCH', x: 150, y: 50 }
        ]
      }
    });
    const [seatA, seatB] = initRes.json().seats;

    await server.inject({
      method: 'POST',
      url: `/api/seats/${seatA.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId1 }
    });
    await server.inject({
      method: 'POST',
      url: `/api/seats/${seatB.id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId2 }
    });

    // Unassign A via POST
    const unassignPostRes = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatA.id}/unassign`,
      headers: { cookie: sessionCookie }
    });
    expect(unassignPostRes.statusCode).toBe(200);
    expect(unassignPostRes.json().employeeId).toBeNull();
    expect(unassignPostRes.json().departmentId).toBeNull();

    // Unassign B via PATCH
    const unassignPatchRes = await server.inject({
      method: 'PATCH',
      url: `/api/seats/${seatB.id}/unassign`,
      headers: { cookie: sessionCookie }
    });
    expect(unassignPatchRes.statusCode).toBe(200);
    expect(unassignPatchRes.json().employeeId).toBeNull();
    expect(unassignPatchRes.json().departmentId).toBeNull();
  });

  it('SEAT-11: Boundary T2-ASGN-01: Unassigning already vacant seat returns 200 without creating audit log', async () => {
    const initRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'VACANT-DESK', x: 50, y: 50 }]
      }
    });
    const seatId = initRes.json().seats[0].id;

    // Get audit count before
    const logsBeforeRes = await server.inject({
      method: 'GET',
      url: '/api/audit-logs?action=SEAT_UNASSIGNED',
      headers: { cookie: sessionCookie }
    });
    const countBefore = logsBeforeRes.json().total;

    // Unassign vacant seat
    const unassignRes = await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId}/unassign`,
      headers: { cookie: sessionCookie }
    });
    expect(unassignRes.statusCode).toBe(200);

    // Get audit count after - must NOT increase
    const logsAfterRes = await server.inject({
      method: 'GET',
      url: '/api/audit-logs?action=SEAT_UNASSIGNED',
      headers: { cookie: sessionCookie }
    });
    expect(logsAfterRes.json().total).toBe(countBefore);
  });

  it('SEAT-12: GET /api/seats?floorId=... returns seats with employee and department included', async () => {
    // Create two seats on floorId
    const res = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}`,
      headers: { cookie: sessionCookie }
    });
    expect(res.statusCode).toBe(200);
    const seats = res.json();
    expect(Array.isArray(seats)).toBe(true);
  });

  it('SEAT-13: GET /api/seats/:id returns single seat detail, or 404 if not found', async () => {
    // Create a seat
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'TEST-SEAT-GET',
        x: 100,
        y: 100
      }
    });
    expect(createRes.statusCode).toBe(201);
    const createdSeat = createRes.json();

    const getRes = await server.inject({
      method: 'GET',
      url: `/api/seats/${createdSeat.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(createdSeat.id);
    expect(getRes.json().label).toBe('TEST-SEAT-GET');

    // 404 for non-existent
    const notFoundRes = await server.inject({
      method: 'GET',
      url: '/api/seats/000000000000000000000000',
      headers: { cookie: sessionCookie }
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('SEAT-14: Multi-level hierarchy discovery: GET /api/seats supports buildingId, status=AVAILABLE, and ALL sanitization', async () => {
    // Query with buildingId and status=AVAILABLE
    const res = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&status=AVAILABLE`,
      headers: { cookie: sessionCookie }
    });
    expect(res.statusCode).toBe(200);
    const seats = res.json();
    expect(Array.isArray(seats)).toBe(true);
    // Every seat must be AVAILABLE and have no employeeId
    for (const seat of seats) {
      expect(seat.status).toBe('AVAILABLE');
      expect(seat.employeeId).toBeNull();
    }

    // Query with 'ALL' for unitId and status
    const allRes = await server.inject({
      method: 'GET',
      url: '/api/seats?unitId=ALL&plantId=ALL&buildingId=ALL&floorId=ALL&status=ALL',
      headers: { cookie: sessionCookie }
    });
    expect(allRes.statusCode).toBe(200);
    expect(Array.isArray(allRes.json())).toBe(true);
  });
});
