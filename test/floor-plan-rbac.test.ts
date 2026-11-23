import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD, TECH_ADMIN_PASSWORD } from '../prisma/seed.js';

describe('Floor Plan Module RBAC & Layout Scoping', () => {
  let server: FastifyInstance;
  let prisma: any;
  let techAdminCookie: string;
  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;
  let unit1FloorId: string;
  let unit2FloorId: string;
  let unit1SeatId: string;
  let unit1Id: string;
  let unit2Id: string;
  let unit1EmployeeId: string;
  let unit2EmployeeId: string;
  let unit1EmployeeCode: string;

  beforeEach(async () => {
    prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });

    const unit1 = await prisma.unit.findFirst({ where: { code: 'UNIT-1' } });
    const unit2 = await prisma.unit.findFirst({ where: { code: 'UNIT-2' } });
    unit1Id = unit1!.id;
    unit2Id = unit2!.id;

    const unit1Department = await prisma.department.create({
      data: { name: `Floor Test U1 ${Date.now()}`, code: `FPU1${Date.now()}`, unitId: unit1!.id },
    });
    const unit2Department = await prisma.department.create({
      data: { name: `Floor Test U2 ${Date.now()}`, code: `FPU2${Date.now()}`, unitId: unit2!.id },
    });
    unit1EmployeeCode = `FP-U1-${Date.now()}`;
    const unit1Employee = await prisma.employee.create({
      data: { employeeCode: unit1EmployeeCode, fullName: 'Unit One Eligible Employee', departmentId: unit1Department.id, isActive: true },
    });
    const unit2Employee = await prisma.employee.create({
      data: { employeeCode: `FP-U2-${Date.now()}`, fullName: 'Unit Two Foreign Employee', departmentId: unit2Department.id, isActive: true },
    });
    unit1EmployeeId = unit1Employee.id;
    unit2EmployeeId = unit2Employee.id;

    // Ensure Unit 1 plant, building, floor, seat
    const plant1 = await prisma.plant.create({
      data: { name: 'Unit 1 Floor Test Plant', code: `U1-FP-${Date.now()}`, unitId: unit1!.id },
    });
    const bld1 = await prisma.building.create({
      data: { name: 'Unit 1 Floor Test Building', code: `U1-FB-${Date.now()}`, plantId: plant1.id },
    });
    const flr1 = await prisma.floor.create({
      data: { name: 'Unit 1 Floor Test', floorNumber: 1, buildingId: bld1.id, canvasWidth: 1600, canvasHeight: 1000 },
    });
    unit1FloorId = flr1.id;

    const seat1 = await prisma.seat.create({
      data: {
        label: 'WS-U1-01',
        floorId: flr1.id,
        x: 100,
        y: 200,
        width: 64,
        height: 48,
        status: 'AVAILABLE',
      },
    });
    unit1SeatId = seat1.id;

    // Ensure Unit 2 plant, building, floor
    const plant2 = await prisma.plant.create({
      data: { name: 'Unit 2 Floor Test Plant', code: `U2-FP-${Date.now()}`, unitId: unit2!.id },
    });
    const bld2 = await prisma.building.create({
      data: { name: 'Unit 2 Floor Test Building', code: `U2-FB-${Date.now()}`, plantId: plant2.id },
    });
    const flr2 = await prisma.floor.create({
      data: { name: 'Unit 2 Floor Test', floorNumber: 2, buildingId: bld2.id, canvasWidth: 1600, canvasHeight: 1000 },
    });
    unit2FloorId = flr2.id;

    server = buildServer({
      prisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
    });
    await server.ready();

    // Log in all admin roles
    const techLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'techadmin@shaktiman.com', password: TECH_ADMIN_PASSWORD },
    });
    expect(techLogin.statusCode).toBe(200);
    techAdminCookie = techLogin.headers['set-cookie'] as string;

    const superLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'superadmin@shaktiman.com', password: DEMO_PASSWORD },
    });
    expect(superLogin.statusCode).toBe(200);
    superAdminCookie = superLogin.headers['set-cookie'] as string;

    const u1Login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unit1.admin@shaktiman.com', password: DEMO_PASSWORD },
    });
    expect(u1Login.statusCode).toBe(200);
    unit1AdminCookie = u1Login.headers['set-cookie'] as string;

    const u2Login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unit2.admin@shaktiman.com', password: DEMO_PASSWORD },
    });
    expect(u2Login.statusCode).toBe(200);
    unit2AdminCookie = u2Login.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  it('TECH_ADMIN can view floor details in any unit', async () => {
    const resU1 = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit1FloorId}`,
      headers: { cookie: techAdminCookie },
    });
    expect(resU1.statusCode).toBe(200);

    const resU2 = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit2FloorId}`,
      headers: { cookie: techAdminCookie },
    });
    expect(resU2.statusCode).toBe(200);
  });

  it('SUPER_ADMIN can view floor details in any unit', async () => {
    const resU1 = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit1FloorId}`,
      headers: { cookie: superAdminCookie },
    });
    expect(resU1.statusCode).toBe(200);

    const resU2 = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit2FloorId}`,
      headers: { cookie: superAdminCookie },
    });
    expect(resU2.statusCode).toBe(200);
  });

  it('UNIT_ADMIN can view floor details in their own unit', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit1FloorId}`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe(unit1FloorId);
    expect(body.seats).toHaveLength(1);
    expect(body.seats[0].label).toBe('WS-U1-01');
  });

  it('UNIT_ADMIN is rejected with 403 when trying to access a foreign unit floor', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit2FloorId}`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns one floor-list item per database identity with counts scoped to that floor', async () => {
    const building = await prisma.floor.findUnique({ where: { id: unit1FloorId }, select: { buildingId: true } });
    const res = await server.inject({
      method: 'GET',
      url: `/api/floors?buildingId=${building!.buildingId}`,
      headers: { cookie: techAdminCookie },
    });
    expect(res.statusCode).toBe(200);
    const floors = JSON.parse(res.payload) as Array<{ id: string; _count: { seats: number } }>;
    expect(new Set(floors.map((floor) => floor.id)).size).toBe(floors.length);
    expect(floors.find((floor) => floor.id === unit1FloorId)?._count.seats).toBe(1);
  });

  it('UNIT_ADMIN can save workstation layout on their own unit floor', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/floors/${unit1FloorId}/layout`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        seats: [
          {
            id: unit1SeatId,
            label: 'WS-U1-01',
            x: 250,
            y: 350,
            placementSource: 'MANUAL',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);

    // Verify coordinates updated
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/floors/${unit1FloorId}`,
      headers: { cookie: unit1AdminCookie },
    });
    const floorBody = JSON.parse(getRes.payload);
    const updatedSeat = floorBody.seats.find((s: any) => s.id === unit1SeatId);
    expect(updatedSeat.x).toBe(250);
    expect(updatedSeat.y).toBe(350);
    expect(updatedSeat.placementSource).toBe('MANUAL');
  });

  it('UNIT_ADMIN is rejected with 403 when trying to save layout on a foreign unit floor', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/floors/${unit2FloorId}/layout`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        seats: [],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Workstations search isolates by unit for UNIT_ADMIN', async () => {
    const resU1 = await server.inject({
      method: 'GET',
      url: '/api/workstations?search=WS-U1-01',
      headers: { cookie: unit1AdminCookie },
    });
    expect(resU1.statusCode).toBe(200);
    const bodyU1 = JSON.parse(resU1.payload);
    expect(bodyU1.data.length).toBeGreaterThanOrEqual(1);
    expect(bodyU1.data[0].wsNo).toBe('WS-U1-01');

    // Unit 2 Admin searching for Unit 1 seat gets 0 results
    const resU2 = await server.inject({
      method: 'GET',
      url: '/api/workstations?search=WS-U1-01',
      headers: { cookie: unit2AdminCookie },
    });
    expect(resU2.statusCode).toBe(200);
    const bodyU2 = JSON.parse(resU2.payload);
    expect(bodyU2.data.length).toBe(0);
  });

  it('UNIT_ADMIN cannot assign a foreign-unit employee by direct API manipulation', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/seats/${unit1SeatId}/assign`,
      headers: { cookie: unit1AdminCookie },
      payload: { employeeId: unit2EmployeeId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('global employee search reports authoritative seated/unassigned state and rejects a second seat', async () => {
    const unassignedBefore = await server.inject({
      method: 'GET',
      url: `/api/employees?search=${encodeURIComponent(unit1EmployeeCode)}&assigned=false&isActive=true&seatEligible=true`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(unassignedBefore.statusCode).toBe(200);
    expect(JSON.parse(unassignedBefore.payload).employees).toHaveLength(1);
    expect(JSON.parse(unassignedBefore.payload).employees[0].seat).toBeNull();

    const assign = await server.inject({
      method: 'POST',
      url: `/api/seats/${unit1SeatId}/assign`,
      headers: { cookie: unit1AdminCookie },
      payload: { employeeId: unit1EmployeeId },
    });
    expect(assign.statusCode).toBe(200);

    const seatedByName = await server.inject({
      method: 'GET',
      url: '/api/employees?search=Unit%20One%20Eligible%20Employee&page=1&pageSize=20',
      headers: { cookie: unit1AdminCookie },
    });
    expect(seatedByName.statusCode).toBe(200);
    const seatedEmployee = JSON.parse(seatedByName.payload).employees.find((employee: any) => employee.id === unit1EmployeeId);
    expect(seatedEmployee.seat.label).toBe('WS-U1-01');
    expect(seatedEmployee.floor.id).toBe(unit1FloorId);

    const unassignedAfter = await server.inject({
      method: 'GET',
      url: `/api/employees?search=${encodeURIComponent(unit1EmployeeCode)}&assigned=false&isActive=true&seatEligible=true`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(JSON.parse(unassignedAfter.payload).employees).toHaveLength(0);

    const secondSeat = await prisma.seat.create({
      data: {
        label: 'WS-U1-02',
        floorId: unit1FloorId,
        x: 300,
        y: 400,
        width: 64,
        height: 48,
        status: 'AVAILABLE',
      },
    });
    const duplicate = await server.inject({
      method: 'POST',
      url: `/api/seats/${secondSeat.id}/assign`,
      headers: { cookie: unit1AdminCookie },
      payload: { employeeId: unit1EmployeeId },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(JSON.parse(duplicate.payload).error).toBe('EMPLOYEE_ALREADY_ASSIGNED');

    const release = await server.inject({
      method: 'POST',
      url: `/api/seats/${unit1SeatId}/unassign`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(release.statusCode).toBe(200);

    const unassignedAfterRelease = await server.inject({
      method: 'GET',
      url: `/api/employees?search=${encodeURIComponent(unit1EmployeeCode)}&assigned=false&isActive=true&seatEligible=true`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(JSON.parse(unassignedAfterRelease.payload).employees.map((employee: any) => employee.id)).toContain(unit1EmployeeId);
  });

  it('pending-transfer employees are hidden from the eligible picker and rejected by assignment', async () => {
    await prisma.seatTransferRequest.create({
      data: {
        requestNumber: `REQ-FP-${Date.now()}`,
        employeeId: unit1EmployeeId,
        activeTransferKey: unit1EmployeeId,
        sourceUnitId: unit1Id,
        targetUnitId: unit2Id,
        reason: 'Floor plan eligibility test',
        status: 'PENDING_TARGET_ADMIN',
      },
    });

    const list = await server.inject({
      method: 'GET',
      url: `/api/employees?assigned=false&isActive=true&seatEligible=true&unitId=${unit1Id}`,
      headers: { cookie: unit1AdminCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload).employees.some((employee: any) => employee.id === unit1EmployeeId)).toBe(false);

    const assign = await server.inject({
      method: 'POST',
      url: `/api/seats/${unit1SeatId}/assign`,
      headers: { cookie: techAdminCookie },
      payload: { employeeId: unit1EmployeeId },
    });
    expect(assign.statusCode).toBe(409);
    expect(JSON.parse(assign.payload).error).toBe('TRANSFER_PENDING');
  });

  it('stores floor-plan assets per Unit and denies cross-Unit or forged file references', async () => {
    const unitCookies = new Map<string, string>();
    const floorIds = new Map<string, string>();
    const imageRefs = new Map<string, string>();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const boundary = '----UnitGridFsBoundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="unit.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    for (let unitNumber = 1; unitNumber <= 5; unitNumber += 1) {
      const unit = await prisma.unit.findFirst({ where: { code: `UNIT-${unitNumber}` } });
      expect(unit).toBeTruthy();
      const plant = await prisma.plant.create({
        data: { name: `GridFS Test Plant ${unitNumber}`, code: `GFS-P-${unitNumber}-${Date.now()}`, unitId: unit.id },
      });
      const building = await prisma.building.create({
        data: { name: `GridFS Test Building ${unitNumber}`, code: `GFS-B-${unitNumber}-${Date.now()}`, unitId: unit.id, plantId: plant.id },
      });
      const floor = await prisma.floor.create({
        data: { name: `GridFS Test Floor ${unitNumber}`, floorNumber: 90, buildingId: building.id },
      });
      floorIds.set(String(unitNumber), floor.id);

      const login = await server.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `unit${unitNumber}.admin@shaktiman.com`, password: DEMO_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers['set-cookie'] as string;
      unitCookies.set(String(unitNumber), cookie);

      const upload = await server.inject({
        method: 'POST', url: `/api/floors/${floor.id}/image`,
        headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(upload.statusCode).toBe(200);
      imageRefs.set(String(unitNumber), upload.json().imageUrl);

      const own = await server.inject({ method: 'GET', url: `/api/floors/${floor.id}/image`, headers: { cookie } });
      expect(own.statusCode).toBe(200);
      expect(own.rawPayload).toEqual(png);
    }

    for (let callerUnit = 1; callerUnit <= 5; callerUnit += 1) {
      for (let targetUnit = 1; targetUnit <= 5; targetUnit += 1) {
        const response = await server.inject({
          method: 'GET', url: `/api/floors/${floorIds.get(String(targetUnit))}/image`,
          headers: { cookie: unitCookies.get(String(callerUnit))! },
        });
        expect(response.statusCode).toBe(callerUnit === targetUnit ? 200 : 403);
      }
    }

    for (const globalCookie of [techAdminCookie, superAdminCookie]) {
      for (let unitNumber = 1; unitNumber <= 5; unitNumber += 1) {
        const response = await server.inject({
          method: 'GET', url: `/api/floors/${floorIds.get(String(unitNumber))}/image`, headers: { cookie: globalCookie },
        });
        expect(response.statusCode).toBe(200);
      }
    }

    const foreignFloorId = floorIds.get('2')!;
    await prisma.floor.update({ where: { id: foreignFloorId }, data: { imageUrl: imageRefs.get('1') } });
    const forged = await server.inject({
      method: 'GET', url: `/api/floors/${foreignFloorId}/image`, headers: { cookie: unitCookies.get('2')! },
    });
    expect(forged.statusCode).toBe(404);
  });
});
