import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { buildServer } from '../src/server.js';
import sessionPlugin from '../src/plugins/session.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Milestone 1: Security, Auth, CORS & RBAC Boundaries', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let _superAdminCookie: string;
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

    _superAdminCookie = await getSessionCookie('superadmin@shaktiman.com');
    unit1AdminCookie = await getSessionCookie('unit1.admin@shaktiman.com');
    unit2AdminCookie = await getSessionCookie('unit2.admin@shaktiman.com');
    

    // Resolve units
    unit1 = await mockPrisma.unit.findUnique({ where: { code: 'UNIT-1' } });
    unit2 = await mockPrisma.unit.findUnique({ where: { code: 'UNIT-2' } });

    // Seed Unit 1 hierarchy
    plant1UnderU1 = await mockPrisma.plant.create({
      data: { name: 'Unit 1 Main Plant', code: 'PLT-U1-SEC', unitId: unit1.id }
    });
    building1UnderU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Tech Block', code: 'BLD-U1-SEC', plantId: plant1UnderU1.id }
    });
    floor1UnderU1 = await mockPrisma.floor.create({
      data: { name: 'Unit 1 Floor 1', floorNumber: 1, buildingId: building1UnderU1.id }
    });
    seat1UnderU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-SEC-WS-01',
        floorId: floor1UnderU1.id,
        x: 100,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });

    // Resolve existing Unit 2 hierarchy
    plantUnderU2 = await mockPrisma.plant.findFirst({ where: { unitId: unit2.id } });
    buildingUnderU2 = await mockPrisma.building.findFirst({ where: { plantId: plantUnderU2.id } });
    floorUnderU2 = await mockPrisma.floor.findFirst({ where: { buildingId: buildingUnderU2.id } });
    seatUnderU2 = await mockPrisma.seat.findFirst({ where: { floorId: floorUnderU2.id, status: 'AVAILABLE', employeeId: null } });
  }, 35000);

  afterAll(async () => {
    await server.close();
  });

  // =========================================================================
  // Issue 1.1: Production Session Secret Guard
  // =========================================================================
  describe('Issue 1.1: Production Session Secret Guard', () => {
    it('throws fatal error in production if SESSION_SECRET is too short', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const testApp = Fastify();
        await expect(
          testApp.register(sessionPlugin, {
            secret: 'short-secret-less-than-32-chars',
            salt: 'a-valid-16-bytes-salt!!'
          })
        ).rejects.toThrow(/FATAL: In production, SESSION_SECRET must be explicitly set and be at least 32 characters long/);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('throws fatal error in production if SESSION_SALT is too short', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const testApp = Fastify();
        await expect(
          testApp.register(sessionPlugin, {
            secret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
            salt: 'short'
          })
        ).rejects.toThrow(/FATAL: In production, SESSION_SALT must be explicitly set and be at least 16 characters/);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('boots smoothly in development / test with default secrets', async () => {
      const testApp = Fastify();
      await expect(testApp.register(sessionPlugin)).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // Issue 1.2: Strict Role Guards on Hierarchy Routes
  // =========================================================================
  describe('Issue 1.2: Strict Role Guards on Hierarchy Routes', () => {
    it('UNIT_ADMIN attempting DELETE /api/units/:id receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unit1.id}`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('Super Admin');
    });

    it('UNIT_ADMIN of Unit 2 attempting POST /api/plants under Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/plants',
        headers: { cookie: unit2AdminCookie },
        payload: { name: 'Infiltrated Plant', code: 'PLT-INF-01', unitId: unit1.id }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/Unit Admins can only manage plants within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting DELETE /api/plants/:id of Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${plant1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/Unit Admins can only manage plants within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting DELETE /api/buildings/:id of Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/buildings/${building1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/Unit Admins can only manage buildings within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting DELETE /api/floors/:id of Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/floors/${floor1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/Unit Admins can only manage floors within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting PUT /api/floors/:id/layout of Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/floors/${floor1UnderU1.id}/layout`,
        headers: { cookie: unit2AdminCookie },
        payload: {
          seats: [{ x: 50, y: 50, label: 'ROGUE-LAYOUT' }]
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/Unit Admins can only manage floors within their assigned unit/i);
    });
  });

  // =========================================================================
  // Issue 1.3: Cross-Unit BOLA / IDOR on Seats & Floors
  // =========================================================================
  describe('Issue 1.3: Cross-Unit BOLA / IDOR on Seats & Floors', () => {
    it('UNIT_ADMIN of Unit 2 attempting to assign a seat in Unit 1 receives 403 Forbidden', async () => {
      // Find employee to assign
      const emp = await mockPrisma.employee.findFirst();
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/assign`,
        headers: { cookie: unit2AdminCookie },
        payload: { employeeId: emp.id }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within your assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting to unassign a seat in Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within your assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting quick-assign on a seat in Unit 1 receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/quick-assign`,
        headers: { cookie: unit2AdminCookie },
        payload: {
          fullName: 'Unit 2 Intruder',
          employeeCode: 'EMP-INTRUDER-99'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within your assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting cross-unit seat transfer receives 403 Forbidden', async () => {
      // Transfer from Unit 2 seat to Unit 1 seat (or vice versa)
      if (seatUnderU2 && seat1UnderU1) {
        const res = await server.inject({
          method: 'POST',
          url: `/api/seats/${seatUnderU2.id}/transfer`,
          headers: { cookie: unit2AdminCookie },
          payload: { targetSeatId: seat1UnderU1.id }
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().message).toMatch(/within their assigned unit/i);
      }
    });

    it('UNIT_ADMIN of Unit 2 attempting PUT /api/seats/:id on Unit 1 seat receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie },
        payload: { label: 'MODIFIED-LABEL' }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting DELETE /api/seats/:id on Unit 1 seat receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    it('UNIT_ADMIN of Unit 2 attempting POST /api/seats on Unit 1 floor receives 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: unit2AdminCookie },
        payload: {
          floorId: floor1UnderU1.id,
          label: 'ROGUE-SEAT-01'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/within their assigned unit/i);
    });

    // Positive Authorization Controls: UNIT_ADMIN of Unit 1 managing seats in Unit 1
    it('UNIT_ADMIN of Unit 1 CAN update a seat in Unit 1 (returning 200)', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/seats/${seat1UnderU1.id}`,
        headers: { cookie: unit1AdminCookie },
        payload: { label: 'U1-AUTHORIZED-UPDATE' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().label).toBe('U1-AUTHORIZED-UPDATE');
    });

    it('UNIT_ADMIN of Unit 1 CAN assign an employee to a seat in Unit 1 (returning 200)', async () => {
      const dept = await mockPrisma.department.create({
        data: { name: 'Unit 1 Security Department', code: `U1-SEC-${Date.now()}`, unitId: unit1.id }
      });
      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Unit 1 Staff Member',
          employeeCode: 'EMP-U1-POS-01',
          departmentId: dept.id,
          isActive: true
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

    it('UNIT_ADMIN of Unit 1 CAN unassign a seat in Unit 1 (returning 200)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employeeId).toBeNull();
    });

    it('UNIT_ADMIN of Unit 1 CAN create a new seat on Unit 1 floor (returning 201)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/seats',
        headers: { cookie: unit1AdminCookie },
        payload: {
          floorId: floor1UnderU1.id,
          label: 'U1-POS-NEW-01',
          x: 200,
          y: 200
        }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().label).toBe('U1-POS-NEW-01');
    });

    it('UNIT_ADMIN of Unit 1 CAN delete a seat in Unit 1 (returning 200)', async () => {
      const tempSeat = await mockPrisma.seat.create({
        data: {
          floorId: floor1UnderU1.id,
          label: 'U1-POS-DELETE-01',
          x: 400,
          y: 400,
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

  // =========================================================================
  // Issue 1.4: Harden CORS
  // =========================================================================
  describe('Issue 1.4: Harden CORS', () => {
    it('allows localhost origin in dev/test environment with credentials: true', async () => {
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/api/health',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET'
        }
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('enforces ALLOWED_ORIGINS whitelist strictly when configured', async () => {
      const origEnv = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://app.shaktiman.com,https://admin.shaktiman.com';

      try {
        const corsServer = buildServer({
          prisma: mockPrisma,
          sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
        });
        await corsServer.ready();

        // 1. Allowed origin
        const allowedRes = await corsServer.inject({
          method: 'OPTIONS',
          url: '/api/health',
          headers: {
            origin: 'https://app.shaktiman.com',
            'access-control-request-method': 'GET'
          }
        });
        expect(allowedRes.headers['access-control-allow-origin']).toBe('https://app.shaktiman.com');

        // 2. Disallowed origin
        const deniedRes = await corsServer.inject({
          method: 'OPTIONS',
          url: '/api/health',
          headers: {
            origin: 'https://malicious-site.com',
            'access-control-request-method': 'GET'
          }
        });
        expect(deniedRes.headers['access-control-allow-origin']).toBeUndefined();

        await corsServer.close();
      } finally {
        if (origEnv === undefined) {
          delete process.env.ALLOWED_ORIGINS;
        } else {
          process.env.ALLOWED_ORIGINS = origEnv;
        }
      }
    });
  });

  // =========================================================================
  // Issue 1.5: Login Rate Limiting
  // =========================================================================
  describe('Issue 1.5: Login Rate Limiting', () => {
    it('blocks after 10 failed login attempts with 429 Too Many Requests in non-test mode', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const rateLimitServer = buildServer({
          prisma: mockPrisma,
          sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
          sessionSalt: 'mq9hDxBVDbspDR6nLfFT1g=='
        });
        await rateLimitServer.ready();

        const targetEmail = `brute.force.test.${Date.now()}@company.com`;

        // 10 consecutive failed attempts
        for (let i = 0; i < 10; i++) {
          const res = await rateLimitServer.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: targetEmail, password: 'WrongPassword123!' }
          });
          expect(res.statusCode).toBe(401);
        }

        // 11th attempt must be rejected with 429
        const blockedRes = await rateLimitServer.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: targetEmail, password: 'WrongPassword123!' }
        });
        expect(blockedRes.statusCode).toBe(429);
        expect(blockedRes.json().message).toMatch(/too many failed login attempts/i);
        expect(blockedRes.headers['retry-after']).toBeDefined();

        await rateLimitServer.close();
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    }, 30000);

    it('bypasses rate limiting in test environment so automated suites never get throttled', async () => {
      expect(process.env.NODE_ENV).toBe('test');

      const targetEmail = 'unlimited.test@company.com';
      for (let i = 0; i < 12; i++) {
        const res = await server.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: targetEmail, password: 'WrongPassword123!' }
        });
        expect(res.statusCode).toBe(401);
      }
    });
  });
});
