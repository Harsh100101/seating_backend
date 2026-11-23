import { FastifyPluginAsync } from 'fastify';
import argon2 from 'argon2';
import { logAudit } from '../services/audit.service.js';

const managedRoles = new Set(['SUPER_ADMIN', 'UNIT_ADMIN']);

function deny(reply: any) {
  return reply.status(403).send({
    statusCode: 403,
    error: 'Forbidden',
    message: 'Only TECH_ADMIN can manage administrator accounts.'
  });
}

function publicAdmin(admin: any) {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    assignedUnitId: admin.assignedUnitId || null,
    departmentId: admin.departmentId || null,
    employeeId: admin.employeeId || null,
    isActive: admin.isActive !== false,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt
  };
}

async function protectLastTechAdmin(prisma: any, target: any, nextRole?: string, nextActive?: boolean) {
  const wouldRemainActiveTech = (nextRole ?? target.role) === 'TECH_ADMIN' && (nextActive ?? target.isActive !== false);
  if (target.role !== 'TECH_ADMIN' || wouldRemainActiveTech) return null;
  // MongoDB does not match documents where is_active is omitted when using
  // `{ not: false }`. Legacy TECH_ADMIN records may omit that field, while
  // Prisma still exposes the schema default as true, so count from the
  // records and treat only explicit false/deleted accounts as inactive.
  const techAdmins = await prisma.adminUser.findMany({
    where: { role: 'TECH_ADMIN' },
    select: { isActive: true, deletedAt: true }
  });
  const activeTechCount = techAdmins.filter((admin: any) => admin.isActive !== false && !admin.deletedAt).length;
  if (activeTechCount <= 1) return 'The last active TECH_ADMIN cannot be disabled or demoted.';
  return null;
}

export const adminUserRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    if (request.admin?.role !== 'TECH_ADMIN') return deny(reply);
    const admins = await fastify.prisma.adminUser.findMany({ orderBy: { email: 'asc' } });
    return reply.status(200).send({ admins: admins.filter((admin: any) => !admin.deletedAt).map(publicAdmin) });
  });

  fastify.post('/', async (request, reply) => {
    if (request.admin?.role !== 'TECH_ADMIN') return deny(reply);
    const body = request.body as { email?: string; name?: string; password?: string; role?: string; assignedUnitId?: string | null; departmentId?: string | null; employeeId?: string | null };
    const email = body?.email?.trim().toLowerCase();
    const name = body?.name?.trim();
    if (!email || !name || !body?.password || body.password.length < 12 || !managedRoles.has(body.role || '')) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'email, name, role, and a password of at least 12 characters are required.' });
    }
    if (body.role === 'UNIT_ADMIN' && !body.assignedUnitId) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'UNIT_ADMIN accounts require assignedUnitId.' });
    }
    if (body.assignedUnitId) {
      const unit = await fastify.prisma.unit.findUnique({ where: { id: body.assignedUnitId }, select: { id: true } });
      if (!unit) return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'assignedUnitId does not identify a Unit.' });
    }
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });

    const existing = await fastify.prisma.adminUser.findUnique({ where: { email } });
    if (existing) {
      if (!existing.deletedAt) {
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'An administrator with this email already exists.' });
      }

      // Tombstoned/deleted admin with that email exists (deletedAt != null).
      // Allow controlled reactivation and update while preserving auditability and TECH_ADMIN RBAC.
      const reactivated = await fastify.prisma.adminUser.update({
        where: { id: existing.id },
        data: {
          name,
          passwordHash,
          role: body.role as any,
          assignedUnitId: body.role === 'UNIT_ADMIN' ? body.assignedUnitId : null,
          departmentId: body.departmentId || null,
          employeeId: body.employeeId || null,
          isActive: true,
          deletedAt: null
        }
      });
      await logAudit(fastify.prisma, request, 'ADMIN_ACCOUNT_REACTIVATED', 'AdminUser', reactivated.id, {
        email: reactivated.email,
        role: reactivated.role,
        assignedUnitId: reactivated.assignedUnitId,
        reactivatedFromDeletedAt: existing.deletedAt
      });
      return reply.status(201).send(publicAdmin(reactivated));
    }

    try {
      const created = await fastify.prisma.adminUser.create({
        data: {
          email,
          name,
          passwordHash,
          role: body.role as any,
          assignedUnitId: body.role === 'UNIT_ADMIN' ? body.assignedUnitId : null,
          departmentId: body.departmentId || null,
          employeeId: body.employeeId || null,
          isActive: true
        }
      });
      await logAudit(fastify.prisma, request, 'ADMIN_ACCOUNT_CREATED', 'AdminUser', created.id, { email: created.email, role: created.role, assignedUnitId: created.assignedUnitId });
      return reply.status(201).send(publicAdmin(created));
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'An administrator with this email already exists.' });
      throw error;
    }
  });

  fastify.patch('/:id', async (request, reply) => {
    if (request.admin?.role !== 'TECH_ADMIN') return deny(reply);
    const { id } = request.params as { id: string };
    const target = await fastify.prisma.adminUser.findUnique({ where: { id } });
    if (!target) return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Administrator account not found.' });
    if (target.deletedAt) return reply.status(410).send({ statusCode: 410, error: 'Gone', message: 'Administrator account has been deleted.' });
    const body = request.body as { email?: string; name?: string; role?: string; assignedUnitId?: string | null; departmentId?: string | null; employeeId?: string | null; isActive?: boolean };
    if (body.role && !managedRoles.has(body.role) && body.role !== 'TECH_ADMIN') return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Unsupported administrator role.' });
    if (body.role === 'UNIT_ADMIN' && !(body.assignedUnitId ?? target.assignedUnitId)) return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'UNIT_ADMIN accounts require assignedUnitId.' });
    const protectionError = await protectLastTechAdmin(fastify.prisma, target, body.role, body.isActive);
    if (protectionError) return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: protectionError });
    if (body.assignedUnitId) {
      const unit = await fastify.prisma.unit.findUnique({ where: { id: body.assignedUnitId }, select: { id: true } });
      if (!unit) return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'assignedUnitId does not identify a Unit.' });
    }
    const updated = await fastify.prisma.adminUser.update({
      where: { id },
      data: {
        ...(body.email ? { email: body.email.trim().toLowerCase() } : {}),
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.role ? { role: body.role as any } : {}),
        ...(body.assignedUnitId !== undefined ? { assignedUnitId: body.assignedUnitId } : {}),
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
        ...(body.employeeId !== undefined ? { employeeId: body.employeeId } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });
    await logAudit(fastify.prisma, request, 'ADMIN_ACCOUNT_UPDATED', 'AdminUser', id, { changedFields: Object.keys(body).filter((key) => key !== 'password'), role: updated.role, assignedUnitId: updated.assignedUnitId, isActive: updated.isActive });
    return reply.status(200).send(publicAdmin(updated));
  });

  fastify.delete('/:id', async (request, reply) => {
    if (request.admin?.role !== 'TECH_ADMIN') return deny(reply);
    const { id } = request.params as { id: string };
    const target = await fastify.prisma.adminUser.findUnique({ where: { id } });
    if (!target || target.deletedAt) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Administrator account not found.' });
    }

    const protectionError = await protectLastTechAdmin(fastify.prisma, target, undefined, false);
    if (protectionError) return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: protectionError });

    // Preserve immutable audit history. The account is removed from all admin
    // listings and authentication, while its identity remains available to
    // historical audit records through the deletedAt tombstone.
    const deleted = await fastify.prisma.adminUser.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() }
    });
    await logAudit(fastify.prisma, request, 'ADMIN_ACCOUNT_DELETED', 'AdminUser', id, {
      email: target.email,
      role: target.role,
      wasActive: target.isActive !== false
    });
    return reply.status(200).send({ success: true, id: deleted.id });
  });

  fastify.post('/:id/reset-password', async (request, reply) => {
    if (request.admin?.role !== 'TECH_ADMIN') return deny(reply);
    const { id } = request.params as { id: string };
    const body = request.body as { password?: string };
    if (!body?.password || body.password.length < 12) return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'A password of at least 12 characters is required.' });
    const target = await fastify.prisma.adminUser.findUnique({ where: { id }, select: { id: true, email: true, deletedAt: true } });
    if (!target) return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Administrator account not found.' });
    if (target.deletedAt) return reply.status(410).send({ statusCode: 410, error: 'Gone', message: 'Administrator account has been deleted.' });
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    await fastify.prisma.adminUser.update({ where: { id }, data: { passwordHash } });
    await logAudit(fastify.prisma, request, 'ADMIN_PASSWORD_RESET', 'AdminUser', id, { email: target.email });
    return reply.status(200).send({ success: true });
  });
};
