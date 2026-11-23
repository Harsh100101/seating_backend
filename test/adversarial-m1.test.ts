import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import argon2 from 'argon2';
import { buildServer } from '../src/server.js';
import sessionPlugin from '../src/plugins/session.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Adversarial & Empirical Challenge — Milestone 1 (RBAC, BOLA/IDOR, CORS, Rate Limiting)', () => {
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
      data: { name: 'Unit 1 Plant Alpha', code: 'PLT-U1-ADV', unitId: unit1.id }
    });
    building1UnderU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Tower Alpha', code: 'BLD-U1-ADV', plantId: plant1UnderU1.id }
    });
    floor1UnderU1 = await mockPrisma.floor.create({
      data: { name: 'Unit 1 Floor Alpha', floorNumber: 1, buildingId: building1UnderU1.id }
    });
    seat1UnderU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-ADV-01',
        floorId: floor1UnderU1.id,
        x: 150,
        y: 150,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });

    // Resolve existing Unit 2 hierarchy and ensure dedicated seat
    plantUnderU2 = await mockPrisma.plant.findFirst({ where: { unitId: unit2.id } });
    buildingUnderU2 = await mockPrisma.building.findFirst({ where: { plantId: plantUnderU2.id } });
    floorUnderU2 = await mockPrisma.floor.findFirst({ where: { buildingId: buildingUnderU2.id } });

    seatUnderU2 = await mockPrisma.seat.create({
      data: {
        label: 'U2-ADV-01',
        floorId: floorUnderU2.id,
        x: 100,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });
  }, 35000);

  afterAll(async () => {
    await server.close();
  });

  // =========================================================================
  // Challenge 1: Header Spoofing & Role Bypass on Hierarchy Routes
  // =========================================================================
  describe('Challenge 1: Header Spoofing & Role Bypass on Hierarchy Routes', () => {
    it('rejects UNIT_ADMIN attempting to spoof SUPER_ADMIN via headers on POST /api/units', async () => {
      const spoofHeaders = {
        cookie: unit1AdminCookie,
        'x-role': 'SUPER_ADMIN',
        'x-admin-role': 'SUPER_ADMIN',
        'x-user-role': 'SUPER_ADMIN',
        'x-forwarded-user': 'superadmin@shaktiman.com',
        'x-admin-id': 'spoofed-id'
      };

      const res = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: spoofHeaders,
        payload: { name: 'Spoofed Unit', code: 'UNIT-SPOOF' }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/Super Admin access required/i);
    });

    it('rejects UNIT_ADMIN attempting to spoof SUPER_ADMIN on PUT /api/units/:id', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit1.id}`,
        headers: {
          cookie: unit1AdminCookie,
          'x-role': 'SUPER_ADMIN'
        },
        payload: { name: 'Unit Admin Renamed Unit' }
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects unauthenticated request attempting to spoof SUPER_ADMIN on DELETE /api/units/:id', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unit1.id}`,
        headers: {
          'x-role': 'SUPER_ADMIN',
          'x-admin-id': 'fake-id'
        }
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects UNIT_ADMIN attempting to mutate Units or Offices', async () => {
      const uPost = await server.inject({
        method: 'POST',
        url: '/api/units',
        headers: { cookie: unit1AdminCookie },
        payload: { name: 'Unit Admin Rogue Unit', code: 'UA-ROGUE' }
      });
      expect(uPost.statusCode).toBe(403);

      const uPut = await server.inject({
        method: 'PUT',
        url: `/api/units/${unit1.id}`,
        headers: { cookie: unit1AdminCookie },
        payload: { name: 'Unit 1 Altered' }
      });
      expect(uPut.statusCode).toBe(403);

      const offPut = await server.inject({
        method: 'PUT',
        url: `/api/offices/${unit1.id}`,
        headers: { cookie: unit1AdminCookie },
        payload: { name: 'Office 1 Altered' }
      });
      expect(offPut.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // Challenge 2: Cross-Unit BOLA / IDOR Boundary Testing
  // =========================================================================
  describe('Challenge 2: Cross-Unit BOLA / IDOR Boundary Testing', () => {
    it('UNIT_ADMIN of Unit 2 CANNOT move their plant to Unit 1', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/plants/${plantUnderU2.id}`,
        headers: { cookie: unit2AdminCookie },
        payload: { unitId: unit1.id }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT move their building to a plant in Unit 1', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/buildings/${buildingUnderU2.id}`,
        headers: { cookie: unit2AdminCookie },
        payload: { plantId: plant1UnderU1.id }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
      expect(res.json().message).toMatch(/Unit Admins can only manage buildings/i);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT create a seat on Unit 1 floor', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: unit2AdminCookie },
        payload: {
          floorId: floor1UnderU1.id,
          label: 'INTRUDER-WS-01',
          x: 200,
          y: 200
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT modify a seat in Unit 1', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie },
        payload: {
          label: 'HACKED-LABEL',
          x: 999
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT delete a seat in Unit 1', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT assign / unassign a seat in Unit 1 via PATCH', async () => {
      const emp = await mockPrisma.employee.findFirst();

      const patchAssign = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${seat1UnderU1.id}/assign`,
        headers: { cookie: unit2AdminCookie },
        payload: { employeeId: emp.id }
      });
      expect(patchAssign.statusCode).toBe(403);

      const patchUnassign = await server.inject({
        method: 'PATCH',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(patchUnassign.statusCode).toBe(403);
    });

    it('UNIT_ADMIN of Unit 2 CANNOT quick-assign an employee to a Unit 1 seat', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/quick-assign`,
        headers: { cookie: unit2AdminCookie },
        payload: {
          fullName: 'Malicious Employee',
          employeeCode: 'EMP-MAL-01'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within your assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 1 CAN update their own seat in Unit 1', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit1AdminCookie },
        payload: { label: 'U1-AUTHORIZED-UPDATE' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().label).toBe('U1-AUTHORIZED-UPDATE');
    });

    it('UNIT_ADMIN of Unit 2 CANNOT transfer between two Unit 1 seats', async () => {
      // Create an employee and assign to seat1UnderU1
      const allDepts = await mockPrisma.department.findMany({});
      const firstDept = allDepts[0];
      const occupant = await mockPrisma.employee.create({
        data: {
          fullName: 'Occupant U1',
          employeeCode: 'EMP-OCC-U1',
          departmentId: firstDept.id
        }
      });
      await mockPrisma.seat.update({
        where: { id: seat1UnderU1.id },
        data: { employeeId: occupant.id }
      });

      // Create a second seat in Unit 1
      const seat2UnderU1 = await mockPrisma.seat.create({
        data: {
          label: 'U1-ADV-02',
          floorId: floor1UnderU1.id,
          x: 300,
          y: 300,
          type: 'STANDARD_DESK',
          status: 'AVAILABLE'
        }
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/transfer`,
        headers: { cookie: unit2AdminCookie },
        payload: { targetSeatId: seat2UnderU1.id }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within your assigned unit/i);
    });

    it('handles unexpected and missing parameters gracefully (no 500 error)', async () => {
      // 1. Missing employeeId in assign
      const noEmp = await server.inject({
        method: 'POST',
        url: `/api/seats/${seatUnderU2.id}/assign`,
        headers: { cookie: unit2AdminCookie },
        payload: {}
      });
      expect(noEmp.statusCode).toBe(400);

      // 2. Missing floorId in create seat
      const noFloor = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: unit2AdminCookie },
        payload: { label: 'MISSING-FLOOR' }
      });
      expect(noFloor.statusCode).toBe(400);

      // 3. Non-existent seat ID on assign
      const fakeSeat = await server.inject({
        method: 'POST',
        url: '/api/seats/000000000000000000000000/assign',
        headers: { cookie: unit2AdminCookie },
        payload: { employeeId: '000000000000000000000000' }
      });
      expect(fakeSeat.statusCode).toBe(404);

      // 4. Non-existent seat ID on delete
      const fakeDel = await server.inject({
        method: 'DELETE',
        url: '/api/seats/000000000000000000000000',
        headers: { cookie: unit2AdminCookie }
      });
      expect(fakeDel.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // Challenge 3: CORS Boundary & Bypass Probing
  // =========================================================================
  describe('Challenge 3: CORS Boundary & Bypass Probing', () => {
    it('blocks subdomains trying to abuse localhost regex (e.g. localhost.attacker.com)', async () => {
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/api/health',
        headers: {
          origin: 'http://localhost.attacker.com',
          'access-control-request-method': 'GET'
        }
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('blocks 127.0.0.1 prefix spoofing (e.g. http://127.0.0.1.attacker.com)', async () => {
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/api/health',
        headers: {
          origin: 'http://127.0.0.1.attacker.com',
          'access-control-request-method': 'GET'
        }
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('permits localhost with arbitrary ports in dev/test environment', async () => {
      const ports = [3000, 4173, 5173, 8080, 12345];
      for (const port of ports) {
        const res = await server.inject({
          method: 'OPTIONS',
          url: '/api/health',
          headers: {
            origin: `http://localhost:${port}`,
            'access-control-request-method': 'GET'
          }
        });
        expect(res.headers['access-control-allow-origin']).toBe(`http://localhost:${port}`);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      }
    });

    it('handles requests with no Origin header gracefully (curl/server-to-server)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/health'
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  // =========================================================================
  // Challenge 4: Rate Limiter Boundaries & Reset Mechanics
  // =========================================================================
  describe('Challenge 4: Rate Limiter Boundaries & Reset Mechanics', () => {
    it('resets failed attempt counter upon successful login', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const testServer = buildServer({
          prisma: mockPrisma,
          sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
          sessionSalt: 'mq9hDxBVDbspDR6nLfFT1g=='
        });
        await testServer.ready();

        const testEmail = `reset.test.${Date.now()}@shaktiman.com`;
        const testPassword = 'Password123!';
        const hash = await argon2.hash(testPassword);

        await mockPrisma.adminUser.create({
          data: {
            email: testEmail.toLowerCase(),
            passwordHash: hash,
            name: 'Reset Test User',
            role: 'EMPLOYEE'
          }
        });

        // 8 failed attempts
        for (let i = 0; i < 8; i++) {
          const res = await testServer.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: testEmail, password: 'WrongPassword' }
          });
          expect(res.statusCode).toBe(401);
        }

        // 9th attempt is successful
        const successRes = await testServer.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: testEmail, password: testPassword }
        });
        expect(successRes.statusCode).toBe(200);

        // Counter should have reset! We should now be able to fail 8 more times without getting 429
        for (let i = 0; i < 8; i++) {
          const res = await testServer.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: testEmail, password: 'WrongPassword' }
          });
          expect(res.statusCode).toBe(401);
        }

        await testServer.close();
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    }, 20000);

    it('enforces email case insensitivity in rate limiter', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const testServer = buildServer({
          prisma: mockPrisma,
          sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
          sessionSalt: 'mq9hDxBVDbspDR6nLfFT1g=='
        });
        await testServer.ready();

        const baseEmail = `case.test.${Date.now()}`;

        // Alternate casing across 10 failed attempts
        for (let i = 0; i < 10; i++) {
          const casingEmail = i % 2 === 0
            ? `${baseEmail.toUpperCase()}@COMPANY.COM`
            : `${baseEmail.toLowerCase()}@company.com`;

          const res = await testServer.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: casingEmail, password: 'WrongPassword' }
          });
          expect(res.statusCode).toBe(401);
        }

        // 11th attempt with yet another casing must be throttled
        const blockedRes = await testServer.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: `${baseEmail}@Company.Com`, password: 'WrongPassword' }
        });
        expect(blockedRes.statusCode).toBe(429);

        await testServer.close();
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    }, 20000);
  });
});
