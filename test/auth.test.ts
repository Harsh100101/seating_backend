import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN, TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD } from '../prisma/seed.js';
import { signJwt } from '../src/utils/jwt.js';

describe('Milestone 3 Integration: Auth & Security (Features 7, 8, 9, 10, 11)', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  // Feature 7: Admin Login API
  it('AUTH-01: Admin Login with valid credentials returns 200, user info, and sessionId cookie', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe(DEFAULT_ADMIN.email.toLowerCase());
    expect(body.user.name).toBe(DEFAULT_ADMIN.name);

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies).toContain('sessionId=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
  });

  it('AUTH-01B: inactive administrator accounts cannot authenticate', async () => {
    await mockPrisma.adminUser.update({
      where: { email: DEFAULT_ADMIN.email.toLowerCase() },
      data: { isActive: false }
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/inactive/i);
  });

  it('AUTH-01C: database lookup failure returns a safe service-unavailable response', async () => {
    mockPrisma.adminUser.findUnique = async () => {
      throw new Error('database unavailable');
    };

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Authentication service is temporarily unavailable. Please try again.'
    });
    expect(response.body).not.toContain('database unavailable');
  });

  it('AUTH-01A: Tech Admin login returns TECH_ADMIN and receives global admin access', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: TECH_ADMIN_EMAIL, password: TECH_ADMIN_PASSWORD }
    });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().user.role).toBe('TECH_ADMIN');

    const cookie = loginRes.headers['set-cookie'];
    const auditRes = await server.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: { cookie }
    });

    expect(auditRes.statusCode).toBe(200);
  });

  it('AUTH-01B: persisted role wins over forged role and Unit claims', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: TECH_ADMIN_EMAIL, password: TECH_ADMIN_PASSWORD }
    });

    expect(loginRes.statusCode).toBe(200);
    const techUser = loginRes.json().user;
    const departments = await mockPrisma.department.findMany({});
    const department = departments[0];
    const forgedToken = signJwt({
      adminId: techUser.id,
      email: 'techadmin.assistant@company.com',
      name: techUser.name,
      role: 'UNIT_ADMIN',
      assignedUnitId: 'forged-unit-id'
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { authorization: `Bearer ${forgedToken}` },
      payload: {
        employeeCode: 'E-AUTH-ROLE-1',
        fullName: 'Role Claim Test',
        departmentId: department.id
      }
    });

    expect(response.statusCode).toBe(201);
  });

  it('AUTH-01C: invalid and tampered bearer tokens return 401', async () => {
    const invalid = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-jwt' }
    });
    expect(invalid.statusCode).toBe(401);

    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    const token = loginRes.json().token as string;
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

    const tampered = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${tamperedToken}` }
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('AUTH-02: Admin Login with incorrect password returns 401 Unauthorized', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: 'WrongPassword123!'
      }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid email or password'
    });
  });

  it('AUTH-03: Admin Login with non-existent email returns 401 Unauthorized', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'nobody@company.com',
        password: DEFAULT_ADMIN.password
      }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid email or password'
    });
  });

  it('AUTH-04: Admin Login with missing password returns 400 Bad Request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
  });

  it('AUTH-05: Admin Login with empty body returns 400 Bad Request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
  });

  it('AUTH-06: Boundary: 10,000-char password handled safely without server crash', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: 'A'.repeat(10000)
      }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Invalid email or password');
  });

  it('AUTH-07: Boundary: Whitespace-only password rejected with 401 Unauthorized', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: '     '
      }
    });

    expect(res.statusCode).toBe(401);
  });

  it('AUTH-08: Boundary: SQL injection string in email handled safely', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: "' OR '1'='1' --",
        password: 'Password123!'
      }
    });

    expect([400, 401]).toContain(res.statusCode);
  });

  // Feature 8: HttpOnly Session Management
  it('AUTH-09: Valid session cookie accepted for protected requests', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    const cookie = loginRes.headers['set-cookie'];

    const meRes = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie }
    });

    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().email).toBe(DEFAULT_ADMIN.email.toLowerCase());
  });

  it('AUTH-09A: account changes invalidate an existing bearer session', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    const token = loginRes.json().token as string;

    await mockPrisma.adminUser.update({
      where: { email: DEFAULT_ADMIN.email.toLowerCase() },
      data: { role: 'UNIT_ADMIN' }
    });

    const protectedResponse = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });

    expect(protectedResponse.statusCode).toBe(401);
    expect(protectedResponse.json().message).toMatch(/session expired/i);
  });

  it('AUTH-10: Tampered session cookie is rejected with 401 Unauthorized', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'sessionId=tampered_invalid_data_12345' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Unauthorized');
  });

  it('AUTH-11: Empty session cookie is rejected with 401 Unauthorized', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'sessionId=' }
    });

    expect(res.statusCode).toBe(401);
  });

  it('AUTH-12: Garbage base64 cookie rejected safely without crash', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'sessionId=!!!invalid-base64-&&&%%%' }
    });

    expect(res.statusCode).toBe(401);
  });

  // Feature 9: Admin Logout & Me API
  it('AUTH-13: GET /api/auth/me returns admin user details', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    const cookie = loginRes.headers['set-cookie'];

    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.email).toBe(DEFAULT_ADMIN.email.toLowerCase());
    expect(body.name).toBe(DEFAULT_ADMIN.name);
    expect(body.createdAt).toBeDefined();
  });

  it('AUTH-14: POST /api/auth/logout invalidates session and clears cookie', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    const cookie = loginRes.headers['set-cookie'];

    const logoutRes = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie }
    });

    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().success).toBe(true);
    expect(logoutRes.headers['set-cookie']).toBeDefined();

    // Subsequent access using cleared cookie should fail
    const meRes = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: logoutRes.headers['set-cookie'] }
    });
    expect(meRes.statusCode).toBe(401);
  });

  it('revokes an already issued bearer token when its administrator logs out', async () => {
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    const token = loginRes.json().token;
    expect(loginRes.statusCode).toBe(200);

    const logoutRes = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(logoutRes.statusCode).toBe(200);

    const protectedRes = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(protectedRes.statusCode).toBe(401);
  });

  it('AUTH-15: Consecutive logouts do not throw 500 error', async () => {
    const res1 = await server.inject({
      method: 'POST',
      url: '/api/auth/logout'
    });
    expect([200, 401]).toContain(res1.statusCode);

    const res2 = await server.inject({
      method: 'POST',
      url: '/api/auth/logout'
    });
    expect([200, 401]).toContain(res2.statusCode);
  });

  // Feature 10: Global PreHandler Auth Guard
  it('AUTH-16: PreHandler blocks unauthenticated requests with 401 Unauthorized', async () => {
    const endpoints = [
      { method: 'GET' as const, url: '/api/offices' },
      { method: 'GET' as const, url: '/api/buildings' },
      { method: 'GET' as const, url: '/api/floors' },
      { method: 'GET' as const, url: '/api/departments' },
      { method: 'GET' as const, url: '/api/employees' },
      { method: 'GET' as const, url: '/api/reports/summary' },
      { method: 'GET' as const, url: '/api/audit-logs' }
    ];

    for (const ep of endpoints) {
      const res = await server.inject(ep);
      expect(res.statusCode, `Endpoint ${ep.method} ${ep.url} must return 401 without auth`).toBe(401);
      expect(res.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin authentication required to access this resource. Please provide Bearer token or session.'
      });
    }
  });

  it('AUTH-17: PreHandler whitelists GET /api/health', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/health'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('AUTH-18: PreHandler whitelists POST /api/auth/login', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    expect(res.statusCode).toBe(200);
  });

  // Feature 11: Zero Employee Access Enforcement
  it('AUTH-19: Zero Employee: POST /api/register rejected with 401 or 404', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: 'emp@company.com', password: 'Password123!' }
    });
    expect([401, 404]).toContain(res.statusCode);
  });

  it('AUTH-20: Zero Employee: POST /api/signup rejected with 401 or 404', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/signup',
      payload: { email: 'emp@company.com', password: 'Password123!' }
    });
    expect([401, 404]).toContain(res.statusCode);
  });

  it('AUTH-21: Zero Employee: POST /api/employees/login rejected with 401 or 404', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/login',
      payload: { employeeCode: 'EMP-001', password: 'Password123!' }
    });
    expect([401, 404]).toContain(res.statusCode);
  });

  it('AUTH-22: Zero Employee: POST /api/bookings rejected with 401 or 404', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/bookings',
      payload: { seatId: 'seat-123', date: '2026-10-30' }
    });
    expect([401, 404]).toContain(res.statusCode);
  });

  it('AUTH-23: Zero Employee: Audit logs query requires admin session', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/audit-logs'
    });
    expect(res.statusCode).toBe(401);
  });
});
