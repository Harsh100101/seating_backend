import { describe, it, expect, beforeAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Empirical Verification: getSeatWithUnit Defensive Fallback & Positive Authorization Controls', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;

  let unit1: any;
  let unit2: any;
  let plant1UnderU1: any;
  let building1UnderU1: any;
  let floor1UnderU1: any;
  let seat1UnderU1: any;
  let seat2UnderU1: any;

  let plantUnderU2: any;
  let buildingUnderU2: any;
  let floorUnderU2: any;
  let seatUnderU2: any;

  beforeAll(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    const getSessionCookie = async (email: string) => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: DEMO_PASSWORD }
      });
      const cookieHeader = res.headers['set-cookie'];
      if (!cookieHeader) throw new Error(`Login failed for ${email}`);
      return Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    };

    superAdminCookie = await getSessionCookie('superadmin@shaktiman.com');
    unit1AdminCookie = await getSessionCookie('unit1.admin@shaktiman.com');
    unit2AdminCookie = await getSessionCookie('unit2.admin@shaktiman.com');

    // Units
    unit1 = await mockPrisma.unit.findUnique({ where: { code: 'UNIT-1' } });
    unit2 = await mockPrisma.unit.findUnique({ where: { code: 'UNIT-2' } });

    // Unit 1 hierarchy
    plant1UnderU1 = await mockPrisma.plant.create({
      data: { name: 'Unit 1 Plant Challenger', code: 'PLT-U1-CHALL', unitId: unit1.id }
    });
    building1UnderU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Tower Challenger', code: 'BLD-U1-CHALL', plantId: plant1UnderU1.id }
    });
    floor1UnderU1 = await mockPrisma.floor.create({
      data: { name: 'Unit 1 Floor Challenger', floorNumber: 1, buildingId: building1UnderU1.id }
    });
    seat1UnderU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-SEAT-01',
        floorId: floor1UnderU1.id,
        x: 100,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });
    seat2UnderU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-SEAT-02',
        floorId: floor1UnderU1.id,
        x: 150,
        y: 150,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });

    // Unit 2 hierarchy
    plantUnderU2 = await mockPrisma.plant.findFirst({ where: { unitId: unit2.id } });
    buildingUnderU2 = await mockPrisma.building.findFirst({ where: { plantId: plantUnderU2.id } });
    floorUnderU2 = await mockPrisma.floor.findFirst({ where: { buildingId: buildingUnderU2.id } });
    seatUnderU2 = await mockPrisma.seat.create({
      data: {
        label: 'U2-SEAT-01',
        floorId: floorUnderU2.id,
        x: 100,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });
  });

  describe('1. getSeatWithUnit Defensive Fallback Stress Verification', () => {
    it('resolves floor hierarchy even when seat.findUnique mock strips nested floor relation', async () => {
      // Temporarily override seat.findUnique to simulate an environment where include.floor returns undefined
      const originalFindUnique = mockPrisma.seat.findUnique;
      mockPrisma.seat.findUnique = async ({ where }: any) => {
        // Return raw seat without floor relation populated
        const s = await originalFindUnique({ where, include: {} });
        if (!s) return null;
        const copy = { ...s };
        delete copy.floor;
        return copy;
      };

      try {
        // Attempt an authorized PUT request as Unit 1 Admin
        const res = await server.inject({
          method: 'PUT',
          url: `/api/seats/${seat1UnderU1.id}`,
          headers: { cookie: unit1AdminCookie },
          payload: { label: 'FALLBACK-TEST-LABEL' }
        });

        // The defensive fallback in getSeatWithUnit should have called getFloorWithUnit
        // and successfully resolved unitId, returning 200 rather than 403!
        expect(res.statusCode).toBe(200);
        expect(res.json().label).toBe('FALLBACK-TEST-LABEL');

        // And verify that Unit 2 Admin is STILL properly rejected with 403
        const resRejection = await server.inject({
          method: 'PUT',
          url: `/api/seats/${seat1UnderU1.id}`,
          headers: { cookie: unit2AdminCookie },
          payload: { label: 'ROGUE-LABEL' }
        });
        expect(resRejection.statusCode).toBe(403);
      } finally {
        mockPrisma.seat.findUnique = originalFindUnique;
      }
    });

    it('safely handles non-existent seat ID with 404 rather than 500 or 403', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: '/api/seats/non-existent-seat-id-999',
        headers: { cookie: unit1AdminCookie },
        payload: { label: 'GHOST-LABEL' }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('2. Positive Authorization Controls: UNIT_ADMIN modifying assigned unit seats', () => {
    it('UNIT_ADMIN can PUT /api/seats/:id (200 OK, never 403)', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit1AdminCookie },
        payload: { label: 'U1-VALID-UPDATE-1' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().label).toBe('U1-VALID-UPDATE-1');
    });

    it('UNIT_ADMIN can POST /api/seats/:id/assign (200 OK, never 403)', async () => {
      const depts = await mockPrisma.department.findMany({});
      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Unit 1 Staff Test A',
          employeeCode: 'EMP-U1-POS-A',
          departmentId: depts[0].id
        }
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/assign`,
        headers: { cookie: unit1AdminCookie },
        payload: { employeeId: emp.id }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBe(emp.id);
    });

    it('UNIT_ADMIN can PATCH /api/seats/:id/assign (200 OK, never 403)', async () => {
      const depts = await mockPrisma.department.findMany({});
      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Unit 1 Staff Test B',
          employeeCode: 'EMP-U1-POS-B',
          departmentId: depts[0].id
        }
      });

      const res = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${seat2UnderU1.id}/assign`,
        headers: { cookie: unit1AdminCookie },
        payload: { employeeId: emp.id }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBe(emp.id);
    });

    it('UNIT_ADMIN can POST /api/seats/:id/unassign (200 OK, never 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBeNull();
    });

    it('UNIT_ADMIN can PATCH /api/seats/:id/unassign (200 OK, never 403)', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${seat2UnderU1.id}/unassign`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBeNull();
    });

    it('UNIT_ADMIN can POST /api/seats/:id/quick-assign (200/201 OK, never 403)', async () => {
      // Create a fresh available seat for quick-assign
      const depts = await mockPrisma.department.findMany({});
      const dept = depts[0];
      const qaSeat = await mockPrisma.seat.create({
        data: {
          floorId: floor1UnderU1.id,
          label: 'U1-QA-DESK-01',
          x: 300,
          y: 300,
          type: 'STANDARD_DESK',
          status: 'AVAILABLE',
          departmentId: dept.id
        }
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${qaSeat.id}/quick-assign`,
        headers: { cookie: unit1AdminCookie },
        payload: {
          fullName: 'Quick Assigned U1',
          employeeCode: 'EMP-U1-QA-01',
          departmentId: dept.id
        }
      });
      if (res.statusCode !== 200 && res.statusCode !== 201) {
        console.error('quick-assign failed:', res.statusCode, res.body);
      }
      expect([200, 201]).toContain(res.statusCode);
      expect(res.json().employeeId).toBeDefined();
    });

    it('UNIT_ADMIN can POST /api/seats/:id/transfer within same unit (200 OK, never 403)', async () => {
      // First ensure seat1UnderU1 has an occupant and seat2UnderU1 is available
      const depts = await mockPrisma.department.findMany({});
      const transferEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Transferring Employee',
          employeeCode: 'EMP-TRANSFER-01',
          departmentId: depts[0].id
        }
      });
      await mockPrisma.seat.update({
        where: { id: seat1UnderU1.id },
        data: { employeeId: transferEmp.id, status: 'AVAILABLE' }
      });
      await mockPrisma.seat.update({
        where: { id: seat2UnderU1.id },
        data: { employeeId: null, status: 'AVAILABLE' }
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/transfer`,
        headers: { cookie: unit1AdminCookie },
        payload: {
          targetSeatId: seat2UnderU1.id
        }
      });
      if (res.statusCode !== 200) {
        console.error('transfer failed:', res.statusCode, res.body);
      }
      expect(res.statusCode).toBe(200);
      expect(res.json().targetSeat.id).toBe(seat2UnderU1.id);
    });

    it('UNIT_ADMIN can POST /api/seats to create a seat in their unit (201 Created, never 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: unit1AdminCookie },
        payload: {
          floorId: floor1UnderU1.id,
          label: 'U1-NEW-DESK-99',
          x: 250,
          y: 250
        }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().label).toBe('U1-NEW-DESK-99');
    });

    it('UNIT_ADMIN can DELETE /api/seats/:id in their unit (200 OK, never 403)', async () => {
      const tempSeat = await mockPrisma.seat.create({
        data: {
          floorId: floor1UnderU1.id,
          label: 'U1-TO-DELETE-99',
          x: 350,
          y: 350,
          type: 'STANDARD_DESK',
          status: 'AVAILABLE'
        }
      });

      const res = await server.inject({
        method: 'DELETE',
        url: `/api/seats/${tempSeat.id}`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  describe('3. Negative Authorization Controls: Cross-unit mutations are strictly rejected (403)', () => {
    it('UNIT_ADMIN of Unit 2 CANNOT PUT seats in Unit 1 (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie },
        payload: { label: 'ATTACKER-LABEL' }
      });
      expect(res.statusCode).toBe(403);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT POST assign seats in Unit 1 (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/assign`,
        headers: { cookie: unit2AdminCookie },
        payload: { employeeId: 'some-emp-id' }
      });
      expect(res.statusCode).toBe(403);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT POST unassign seats in Unit 1 (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT quick-assign seats in Unit 1 (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/quick-assign`,
        headers: { cookie: unit2AdminCookie },
        payload: {
          fullName: 'Malicious Staff',
          employeeCode: 'EMP-MAL-02'
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT create seats in Unit 1 floor (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: unit2AdminCookie },
        payload: {
          floorId: floor1UnderU1.id,
          label: 'INTRUDER-SEAT-01'
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT delete seats in Unit 1 (403 Forbidden)', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
