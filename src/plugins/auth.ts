import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { verifyJwt } from '../utils/jwt.js';
import { normalizeUserRole } from '../utils/rbac.js';

const authGuardPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    // 1. Whitelist CORS OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return;
    }

    // 2. Normalize paths
    const rawPath = request.url.split('?')[0]?.replace(/\/+$/, '') || '/';
    const routerPath = request.routeOptions?.url || (request as any).routerPath;

    const isHealth = rawPath === '/api/health' || routerPath === '/api/health';
    const isLogin = (rawPath === '/api/auth/login' || routerPath === '/api/auth/login') && request.method === 'POST';

    if (isHealth || isLogin) {
      return;
    }

    // 3. Check for Bearer Token in Authorization header first
    const authHeader = request.headers.authorization;
    let tokenAdminContext: any = null;

    if (authHeader && typeof authHeader === 'string' && authHeader.trim().length > 0) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) {
        const tokenStr = match[1].trim();
        const verification = verifyJwt(tokenStr);
        if (verification.valid && verification.payload) {
          tokenAdminContext = {
            // The bearer token identifies the account only. Authorization
            // data is reloaded from the persisted AdminUser record below.
            id: verification.payload.adminId,
            issuedAt: verification.payload.iat,
            authTimeMs: verification.payload.authTimeMs
          };
        } else {
          return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: `Invalid or expired Bearer token: ${verification.error || 'Verification failed'}`
          });
        }
      }
    }

    // 4. Fallback to session cookie if no Bearer token was supplied. The
    // token/session identifies the account, but authorization-critical role
    // and Unit scope are always refreshed from the persisted AdminUser record.
    // This prevents stale or tampered claims from changing business access.
    const adminId = tokenAdminContext?.id || request.session?.get('adminId');
    const sessionAuthAt = Number(request.session?.get('authenticatedAt') || 0);
    const tokenAuthTimeMs = tokenAdminContext?.authTimeMs ? Number(tokenAdminContext.authTimeMs) : null;
    const tokenIssuedAtSec = tokenAdminContext?.issuedAt ? Number(tokenAdminContext.issuedAt) : null;

    if (!adminId || typeof adminId !== 'string') {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin authentication required to access this resource. Please provide Bearer token or session.'
      });
    }

    let persistedAdmin: any;
    try {
      persistedAdmin = await fastify.prisma.adminUser.findUnique({
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
          updatedAt: true
        }
      });
    } catch (err: any) {
      // Invalid/stale ObjectIds or database query errors in a bearer claim must not become 500s.
      request.log?.warn?.({ err, adminId }, 'Admin authentication findUnique failure');
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin authentication could not be validated.'
      });
    }

    if (!persistedAdmin) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Admin account not found.'
      });
    }

    // Account edits (role, Unit assignment, disable, password reset) update
    // AdminUser.updatedAt. Bind every newly issued token/session to that
    // timestamp so privilege changes invalidate existing authentication.
    // Ensure seconds vs milliseconds rounding does not reject legitimate tokens
    // while strictly rejecting tokens issued before a security-sensitive update.
    if (persistedAdmin.updatedAt instanceof Date) {
      const updatedAtMs = persistedAdmin.updatedAt.getTime();
      let isSessionExpired = false;

      if (tokenAuthTimeMs !== null) {
        // A timestamp can legitimately equal the authentication time when an
        // account was created or saved immediately before login. The timestamp
        // alone cannot establish ordering in that case, so only a later
        // persisted change invalidates the token. A security event that must
        // revoke same-millisecond sessions needs a versioned revocation field,
        // not an ambiguous wall-clock comparison.
        isSessionExpired = updatedAtMs > tokenAuthTimeMs;
      } else if (tokenIssuedAtSec !== null) {
        // Fallback for legacy tokens with only seconds-precision iat
        const updatedAtSec = Math.floor(updatedAtMs / 1000);
        isSessionExpired = updatedAtSec > tokenIssuedAtSec;
      } else if (sessionAuthAt > 0) {
        // Cookie session auth (milliseconds)
        isSessionExpired = updatedAtMs > sessionAuthAt;
      }

      if (isSessionExpired) {
        request.session?.delete?.();
        reply.clearCookie(fastify.sessionCookieName, { path: '/' });
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Administrator session expired after an account security change. Please sign in again.'
        });
      }
    }

    if (persistedAdmin.isActive === false) {
      request.session?.delete?.();
      reply.clearCookie(fastify.sessionCookieName, { path: '/' });
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This administrator account is inactive.'
      });
    }

    const actualRole = normalizeUserRole(persistedAdmin.role || 'UNIT_ADMIN');
    const userRole = actualRole;

    // 5. Allowed roles: TECH_ADMIN, SUPER_ADMIN, UNIT_ADMIN
    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Access restricted to authorized administrators.'
      });
    }

    request.admin = {
      id: persistedAdmin.id,
      email: persistedAdmin.email,
      name: persistedAdmin.name,
      role: userRole,
      actualRole,
      assignedUnitId: persistedAdmin.assignedUnitId || null,
      departmentId: persistedAdmin.departmentId || null,
      employeeId: persistedAdmin.employeeId || null,
      authenticatedAtMs: tokenAuthTimeMs ?? (tokenIssuedAtSec ? tokenIssuedAtSec * 1000 : sessionAuthAt)
    };
  });
};

export default fp(authGuardPlugin, {
  name: 'auth-guard-plugin',
  dependencies: ['session-plugin']
});
