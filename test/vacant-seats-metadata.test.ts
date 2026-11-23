import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('STEP 1: Vacant Workstation & Seating Area Metadata Contract', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let unitId: string;
  let plantId: string;
  let buildingId: string;
  let floorId: string;
  let deptId: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Authenticate super admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;

    // Create 5-tier hierarchy: Unit -> Plant -> Building -> Floor
    const unitRes = await server.inject({
      method: 'POST',
      url: '/api/units',
      headers: { cookie: sessionCookie },
      payload: { name: 'Unit 1 Manufacturing', code: 'U1-MFG' }
    });
    unitId = unitRes.json().id;

    const plantRes = await server.inject({
      method: 'POST',
      url: '/api/plants',
      headers: { cookie: sessionCookie },
      payload: { name: 'Assembly Plant 1', code: 'PLT-U1-01', unitId }
    });
    plantId = plantRes.json().id;

    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Engineering Block', code: 'BLD-ENG', plantId }
    });
    buildingId = bldRes.json().id;

    const flrRes = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor 2', floorNumber: 2, buildingId, canvasWidth: 1600, canvasHeight: 1000 }
    });
    floorId = flrRes.json().id;

    // Create department
    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Engineering', code: 'ENG', colorHex: '#2563EB', unitId }
    });
    deptId = deptRes.json().id;
  });

  afterEach(async () => {
    await server.close();
  });

  it('VACANT-META-01: POST /api/seats persists rich location context (pcNumber, officeArea, zone, remarks)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'WS-204',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        departmentId: deptId,
        pcNumber: 'PC-ENG-204',
        officeArea: 'R&D Wing',
        zone: 'Bay A',
        remarks: 'Near North Window'
      }
    });

    expect(createRes.statusCode).toBe(201);
    const seat = createRes.json();
    expect(seat.label).toBe('WS-204');
    expect(seat.status).toBe('AVAILABLE');
    expect(seat.pcNumber).toBe('PC-ENG-204');
    expect(seat.officeArea).toBe('R&D Wing');
    expect(seat.zone).toBe('Bay A');
    expect(seat.remarks).toBe('Near North Window');
    expect(seat.floor).toBeDefined();
    expect(seat.floor.building.plant.unit.code).toBe('U1-MFG');
  });

  it('VACANT-META-02: GET /api/seats returns rich location metadata and resolves officeArea for vacant seats', async () => {
    // Create two seats: one explicit officeArea, one with label pattern resolving officeArea
    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'WS-205',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        departmentId: deptId,
        pcNumber: 'PC-205',
        officeArea: 'Design & R&D Wing'
      }
    });

    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'CABIN-01',
        type: 'CABIN',
        status: 'AVAILABLE',
        departmentId: deptId,
        pcNumber: 'PC-CABIN-01'
      }
    });

    const getRes = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&status=AVAILABLE`,
      headers: { cookie: sessionCookie }
    });

    expect(getRes.statusCode).toBe(200);
    const seats = getRes.json();
    expect(seats.length).toBeGreaterThanOrEqual(2);

    const ws205 = seats.find((s: any) => s.label === 'WS-205');
    expect(ws205).toBeDefined();
    expect(ws205.officeArea).toBe('Design & R&D Wing');
    expect(ws205.pcNumber).toBe('PC-205');
    expect(ws205.department.name).toBe('Engineering');
    expect(ws205.floor.name).toBe('Floor 2');
    expect(ws205.floor.building.name).toBe('Engineering Block');
    expect(ws205.floor.building.plant.unit.name).toBe('Unit 1 Manufacturing');

    const cabin = seats.find((s: any) => s.label === 'CABIN-01');
    expect(cabin).toBeDefined();
    // Resolves fallback area
    expect(cabin.officeArea).toBeTruthy();
    expect(cabin.floor.building.plant.unit).toBeDefined();
  });

  it('VACANT-META-03: GET /api/seats supports filtering by officeArea, type, forTransfer, and search query', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'WS-ENG-01',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        officeArea: 'Main Bay',
        pcNumber: 'PC-1001'
      }
    });

    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'CABIN-EXEC',
        type: 'CABIN',
        status: 'AVAILABLE',
        officeArea: 'Executive Cabin Zone',
        pcNumber: 'PC-EXEC-01'
      }
    });

    // Filter by type
    const typeRes = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&type=CABIN`,
      headers: { cookie: sessionCookie }
    });
    expect(typeRes.statusCode).toBe(200);
    const cabinSeats = typeRes.json();
    expect(cabinSeats.every((s: any) => s.type === 'CABIN')).toBe(true);

    // Filter by officeArea
    const areaRes = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&officeArea=Main Bay`,
      headers: { cookie: sessionCookie }
    });
    expect(areaRes.statusCode).toBe(200);
    expect(areaRes.json().some((s: any) => s.label === 'WS-ENG-01')).toBe(true);
    expect(areaRes.json().some((s: any) => s.label === 'CABIN-EXEC')).toBe(false);

    // Filter by search (PC Number)
    const searchRes = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&search=PC-EXEC-01`,
      headers: { cookie: sessionCookie }
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().length).toBe(1);
    expect(searchRes.json()[0].label).toBe('CABIN-EXEC');

    // Filter by forTransfer
    const transferRes = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&forTransfer=true`,
      headers: { cookie: sessionCookie }
    });
    expect(transferRes.statusCode).toBe(200);
    expect(transferRes.json().every((s: any) => s.status === 'AVAILABLE' && !s.employeeId)).toBe(true);
  });

  it('VACANT-META-04: GET /api/floors/:id returns enriched seats with officeArea and floor building path', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'WS-FLOOR-TEST',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        officeArea: 'Testing Lab',
        pcNumber: 'PC-TEST-99'
      }
    });

    const floorRes = await server.inject({
      method: 'GET',
      url: `/api/floors/${floorId}`,
      headers: { cookie: sessionCookie }
    });

    expect(floorRes.statusCode).toBe(200);
    const floorData = floorRes.json();
    expect(Array.isArray(floorData.seats)).toBe(true);

    const testSeat = floorData.seats.find((s: any) => s.label === 'WS-FLOOR-TEST');
    expect(testSeat).toBeDefined();
    expect(testSeat.officeArea).toBe('Testing Lab');
    expect(testSeat.pcNumber).toBe('PC-TEST-99');
    expect(testSeat.floor).toBeDefined();
    expect(testSeat.floor.building).toBeDefined();
  });

  it('VACANT-META-05: UNIT_ADMIN can query seats within their assignedUnitId with strict unit isolation', async () => {
    const passwordHash = await argon2.hash(DEFAULT_ADMIN.password, { type: argon2.argon2id });

    // Seed seat in Unit 1
    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'WS-U1-ADM',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        officeArea: 'Unit 1 Engineering Bay'
      }
    });

    // Create a separate Unit 2 hierarchy with a floor and seat
    const u2Res = await server.inject({
      method: 'POST',
      url: '/api/units',
      headers: { cookie: sessionCookie },
      payload: { name: 'Unit 2 Manufacturing', code: 'U2-MFG' }
    });
    const unit2Id = u2Res.json().id;

    const plt2Res = await server.inject({
      method: 'POST',
      url: '/api/plants',
      headers: { cookie: sessionCookie },
      payload: { name: 'Unit 2 Plant 1', code: 'PLT-U2-01', unitId: unit2Id }
    });
    const plant2Id = plt2Res.json().id;

    const bld2Res = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Unit 2 Block A', code: 'BLD-U2-01', plantId: plant2Id }
    });
    const building2Id = bld2Res.json().id;

    const flr2Res = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor 1', floorNumber: 1, buildingId: building2Id, canvasWidth: 1600, canvasHeight: 1000 }
    });
    const floor2Id = flr2Res.json().id;

    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId: floor2Id,
        label: 'WS-U2-ISOLATED',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        officeArea: 'Unit 2 Isolated Bay'
      }
    });

    // Create and authenticate Unit 1 UNIT_ADMIN
    await (server as any).prisma.adminUser.create({
      data: {
        email: 'admin.unit1@shaktiman.com',
        name: 'Unit 1 Admin',
        passwordHash,
        role: 'UNIT_ADMIN',
        assignedUnitId: unitId
      }
    });

    const adminLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin.unit1@shaktiman.com', password: DEFAULT_ADMIN.password }
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = adminLogin.headers['set-cookie'] as string;

    const adminSeatsRes = await server.inject({
      method: 'GET',
      url: '/api/seats',
      headers: { cookie: adminCookie }
    });
    expect(adminSeatsRes.statusCode).toBe(200);
    const adminSeats = adminSeatsRes.json();
    expect(adminSeats.some((s: any) => s.label === 'WS-U1-ADM')).toBe(true);
    expect(adminSeats.some((s: any) => s.label === 'WS-U2-ISOLATED')).toBe(false);
  });

  it('VACANT-META-07: GET /api/seats?officeArea=ALL safely ignores ALL filter and returns all seats', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/seats',
      headers: { cookie: sessionCookie },
      payload: {
        floorId,
        label: 'WS-ALL-TEST',
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        officeArea: 'Main Bay'
      }
    });

    const allRes = await server.inject({
      method: 'GET',
      url: `/api/seats?floorId=${floorId}&officeArea=ALL`,
      headers: { cookie: sessionCookie }
    });
    expect(allRes.statusCode).toBe(200);
    expect(Array.isArray(allRes.json())).toBe(true);
    expect(allRes.json().length).toBeGreaterThanOrEqual(1);
    expect(allRes.json().some((s: any) => s.label === 'WS-ALL-TEST')).toBe(true);
  });
});
