import { FastifyPluginAsync } from 'fastify';
import argon2 from 'argon2';
import { AdminLoginRequestSchema } from '@seating/shared';
import { logAudit } from '../services/audit.service.js';
import { signJwt } from '../utils/jwt.js';
import { normalizeUserRole } from '../utils/rbac.js';
import { unitIdFromBuilding } from '../utils/building-unit.js';

interface LoginAttemptRecord {
  count: number;
  resetAt: number;
}

const loginAttempts = new Map<string, LoginAttemptRecord>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 10;

// Static valid Argon2id hash used to mitigate user enumeration timing attacks.
// When an administrator email does not exist in the database, verifying against
// this pre-computed hash ensures login response time remains consistent with
// existing-user password verification without revealing account existence.
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$mHCJQxgPrYu9CvPZvJGbAw$Ce5T5IJdkPQmV/e5cyRt+dc79EXOl+vODUfED9jFZJw';

export function resetLoginRateLimits() {
  loginAttempts.clear();
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/auth/login
  fastify.post('/login', async (request, reply) => {
    const parseResult = AdminLoginRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid email or password format',
        issues: parseResult.error.issues
      });
    }

    const { email, password } = parseResult.data;
    const clientIp = request.ip || 'unknown';
    const rateLimitKey = `${clientIp}:${email.toLowerCase()}`;
    const now = Date.now();

    // In-memory rate limiting check (skip in test env)
    // Keep the bypass tied to the application environment. Some security tests
    // deliberately switch NODE_ENV to production while running under Vitest so
    // the production limiter itself is exercised.
    const isTestEnv = process.env.NODE_ENV === 'test';
    if (!isTestEnv) {
      const attempt = loginAttempts.get(rateLimitKey);
      if (attempt) {
        if (now < attempt.resetAt && attempt.count >= MAX_FAILED_ATTEMPTS) {
          const retryAfterSec = Math.ceil((attempt.resetAt - now) / 1000);
          reply.header('Retry-After', String(retryAfterSec));
          return reply.status(429).send({
            statusCode: 429,
            error: 'Too Many Requests',
            message: `Too many failed login attempts. Account temporarily locked; please try again in ${Math.ceil(retryAfterSec / 60)} minutes.`
          });
        }
      }
    }

    const recordFailedAttempt = () => {
      if (isTestEnv) return;
      const record = loginAttempts.get(rateLimitKey);
      if (!record || now > record.resetAt) {
        loginAttempts.set(rateLimitKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      } else {
        record.count += 1;
      }
      if (loginAttempts.size > 10000) {
        for (const [key, val] of loginAttempts.entries()) {
          if (now > val.resetAt) loginAttempts.delete(key);
        }
      }
    };

    let admin: any;
    try {
      admin = await fastify.prisma.adminUser.findUnique({
        where: { email: email.toLowerCase() }
      });
    } catch {
      request.log.error('Authentication account lookup failed');
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Authentication service is temporarily unavailable. Please try again.'
      });
    }

    if (!admin) {
      await argon2.verify(DUMMY_ARGON2_HASH, password).catch(() => false);
      recordFailedAttempt();
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid email or password'
      });
    }

    if ((admin as any).isActive === false) {
      recordFailedAttempt();
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'This administrator account is inactive.' });
    }

    let isValid = false;
    try {
      isValid = await argon2.verify(admin.passwordHash, password);
    } catch {
      // A malformed legacy hash must not turn an authentication failure into a
      // 500 response or disclose account internals.
      request.log.warn('Administrator password verification failed');
    }
    if (!isValid) {
      recordFailedAttempt();
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid email or password'
      });
    }

    if (!isTestEnv) {
      loginAttempts.delete(rateLimitKey);
    }

    // Authorization comes only from the persisted role. Email addresses are
    // identifiers, never permission grants.
    const resolvedRole = normalizeUserRole((admin as any).role || 'UNIT_ADMIN');

    let userAssignedUnitId = (admin as any).assignedUnitId || null;
    let userDeptId = (admin as any).departmentId || null;
    let userEmpId = (admin as any).employeeId || null;

    if (!userAssignedUnitId || !userEmpId) {
      try {
        const emp = await fastify.prisma.employee.findFirst({
          where: userEmpId ? { id: userEmpId } : { email: { equals: admin.email, mode: 'insensitive' } },
          include: {
            department: true,
            seat: { include: { floor: { include: { building: { include: { unit: true, plant: true } } } } } }
          }
        });
        if (emp) {
          userEmpId = userEmpId || emp.id;
          userDeptId = userDeptId || emp.departmentId || null;
          userAssignedUnitId = userAssignedUnitId || unitIdFromBuilding(emp.seat?.floor?.building) || emp.department?.unitId || null;
        }
      } catch {
        // The persisted session remains authoritative when employee enrichment is unavailable.
      }
    }

    const authTimeMs = Date.now();

    // Generate signed JWT Bearer Token (Valid for 7 days)
    const token = signJwt({
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      role: resolvedRole,
      assignedUnitId: userAssignedUnitId,
      departmentId: userDeptId,
      employeeId: userEmpId,
      authTimeMs
    });

    // Set session cookie for dual-auth compatibility
    request.session.set('adminId', admin.id);
    request.session.set('email', admin.email);
    request.session.set('name', admin.name);
    request.session.set('role', resolvedRole);
    request.session.set('actualRole', resolvedRole);
    request.session.set('assignedUnitId', userAssignedUnitId);
    request.session.set('departmentId', userDeptId);
    request.session.set('employeeId', userEmpId);
    request.session.set('authenticatedAt', authTimeMs);

    // Record audit log
    try {
      await logAudit(fastify.prisma, request, 'USER_LOGIN', 'AdminUser', admin.id, {
        email: admin.email,
        role: resolvedRole
      });
    } catch {
      // Audit persistence is important, but an ancillary audit outage must not
      // leave a successfully authenticated administrator with an ambiguous
      // login result.
      request.log.warn('Authentication audit event could not be recorded');
    }

    const userPayload = {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: resolvedRole,
      assignedUnitId: userAssignedUnitId,
      departmentId: userDeptId,
      employeeId: userEmpId
    };

    return reply.status(200).send({
      token,
      tokenType: 'Bearer',
      ...userPayload,
      user: {
        ...userPayload,
        token
      }
    });
  });

  // POST /api/auth/logout
  fastify.post('/logout', async (request, reply) => {
    const adminId = request.admin?.id || request.session?.get('adminId');
    if (adminId) {
      try {
        // Cookies are cleared client-side, but a copied seven-day bearer token
        // would otherwise remain valid. AdminUser.updatedAt is already checked
        // by authGuard, so advance it past this session's authentication time
        // to revoke all tokens and cookies issued before logout.
        const revokeAt = new Date(Math.max(Date.now(), request.admin?.authenticatedAtMs || 0) + 1);
        await fastify.prisma.adminUser.update({
          where: { id: String(adminId) },
          data: { updatedAt: revokeAt }
        });
      } catch {
        request.log.error('Administrator session revocation could not be persisted');
        return reply.status(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Logout could not revoke the server session. Please retry.'
        });
      }

      try {
        await logAudit(fastify.prisma, request, 'USER_LOGOUT', 'AdminUser', String(adminId), {});
      } catch {
        request.log.warn('Logout audit event could not be recorded');
      }
    }

    request.session.delete();
    reply.clearCookie(fastify.sessionCookieName, { path: '/' });

    return reply.status(200).send({
      success: true,
      message: 'Logged out successfully'
    });
  });

  // GET /api/auth/me
  fastify.get('/me', async (request, reply) => {
    const adminId = request.admin?.id || request.session?.get('adminId');
    if (!adminId || typeof adminId !== 'string') {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin authentication required to access this resource.'
      });
    }

    let admin: any;
    try {
      admin = await fastify.prisma.adminUser.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          assignedUnitId: true,
          departmentId: true,
          employeeId: true,
          createdAt: true
        }
      });
    } catch {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin authentication could not be validated.'
      });
    }

    if (!admin) {
      request.session.delete();
      reply.clearCookie(fastify.sessionCookieName, { path: '/' });
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin account not found'
      });
    }

    if (admin.isActive === false) {
      request.session.delete();
      reply.clearCookie(fastify.sessionCookieName, { path: '/' });
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This administrator account is inactive.'
      });
    }

    // Refresh the role from the persisted account. Email addresses and stale
    // session/token claims must never grant or elevate privileges.
    const resolvedRole = normalizeUserRole((admin as any).role || 'UNIT_ADMIN');

    const userPayload = {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: resolvedRole,
      assignedUnitId: admin.assignedUnitId || request.admin?.assignedUnitId || null,
      departmentId: admin.departmentId || request.admin?.departmentId || null,
      employeeId: admin.employeeId || request.admin?.employeeId || null,
      createdAt: admin.createdAt
    };

    return reply.status(200).send({
      ...userPayload,
      user: userPayload
    });
  });
};
