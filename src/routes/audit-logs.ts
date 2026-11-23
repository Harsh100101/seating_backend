import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { escapeRegexLiteral } from '../utils/regex.js';

export const auditLogRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/audit-logs - Super Admin Only
  fastify.get('/', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        // Preserve the established client/test contract while making the
        // explicitly permitted Tech Admin role clear.
        message: 'Audit logs are restricted to Super Admin only (Tech Admin access is also permitted)'
      });
    }

    const query = request.query as {
      page?: string;
      limit?: string;
      action?: string;
      entityType?: string;
      performedBy?: string;
      q?: string;
    };

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {};

    if (query.action) {
      const act = query.action.toUpperCase();
      if (act === 'ASSIGN_SEAT' || act === 'SEAT_ASSIGNED') {
        where.action = { in: ['SEAT_ASSIGNED', 'ASSIGN_SEAT'] };
      } else if (act === 'UNASSIGN_SEAT' || act === 'SEAT_UNASSIGNED') {
        where.action = { in: ['SEAT_UNASSIGNED', 'UNASSIGN_SEAT'] };
      } else if (act === 'SAVE_LAYOUT' || act === 'LAYOUT_SAVED') {
        where.action = { in: ['LAYOUT_SAVED', 'SAVE_LAYOUT'] };
      } else if (act === 'IMPORT_EMPLOYEES' || act === 'EMP_IMPORTED') {
        where.action = { in: ['EMP_IMPORTED', 'IMPORT_EMPLOYEES', 'EMPLOYEE_CSV_IMPORTED'] };
      } else {
        where.action = query.action;
      }
    }

    if (query.entityType) {
      const entityTypeMapping: Record<string, string[]> = {
        AUTH: ['AUTH', 'AdminUser', 'AUTH_SESSION'],
        UNIT: ['UNIT', 'Unit'],
        PLANT: ['PLANT', 'Plant'],
        BUILDING: ['BUILDING', 'Building'],
        FLOOR: ['FLOOR', 'Floor'],
        DEPARTMENT: ['DEPARTMENT', 'Department'],
        SEAT: ['SEAT', 'Seat'],
        EMPLOYEE: ['EMPLOYEE', 'Employee'],
        TRANSFER_REQUEST: ['TRANSFER_REQUEST', 'SeatTransferRequest', 'TransferRequest']
      };
      const upper = query.entityType.toUpperCase();
      const matched = entityTypeMapping[upper];
      if (matched) {
        where.entityType = { in: matched };
      } else {
        where.entityType = query.entityType;
      }
    }

    if (query.performedBy) {
      const term = escapeRegexLiteral(query.performedBy.trim());
      const matchingAdmins = await fastify.prisma.adminUser.findMany({
        where: {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } }
          ]
        },
        select: { id: true }
      });
      where.adminId = { in: matchingAdmins.map((a) => a.id) };
    }

    if (query.q) {
      const term = escapeRegexLiteral(query.q.trim());
      const matchingAdmins = await fastify.prisma.adminUser.findMany({
        where: {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } }
          ]
        },
        select: { id: true }
      });
      const adminIds = matchingAdmins.map((a) => a.id);

      where.OR = [
        { action: { contains: term, mode: 'insensitive' } },
        { entityType: { contains: term, mode: 'insensitive' } },
        { entityId: { contains: term, mode: 'insensitive' } },
        ...(adminIds.length > 0 ? [{ adminId: { in: adminIds } }] : [])
      ];
    }

    const [total, rawLogs] = await Promise.all([
      fastify.prisma.auditLog.count({ where }),
      fastify.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      })
    ]);

    // Historical audit rows can outlive the administrator record that created
    // them. Avoid a required Prisma relation include here: on MongoDB, a
    // dangling adminId otherwise raises an inconsistent-query-result error and
    // makes the entire audit log page unreadable. The actor is nullable only
    // in the response; the immutable adminId reference is preserved.
    const adminIds = [...new Set(rawLogs.map((log) => log.adminId))];
    const admins = adminIds.length > 0
      ? await fastify.prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, name: true, email: true }
        })
      : [];
    const adminById = new Map(admins.map((admin) => [admin.id, admin]));
    const logs = rawLogs.map((log) => ({
      ...log,
      admin: adminById.get(log.adminId) ?? null
    }));

    return reply.status(200).send({
      logs,
      total,
      page,
      limit
    });
  });
};
