import { PrismaClient, Prisma } from '@prisma/client';
import { FastifyRequest } from 'fastify';

export async function logAudit(
  prisma: PrismaClient,
  request: FastifyRequest,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const adminId = request.admin?.id || request.session?.get('adminId');
  if (!adminId || typeof adminId !== 'string') {
    return;
  }

  const actorName = request.admin?.name || request.session?.get('name') || 'Admin';
  const actorRole = request.admin?.actualRole || request.admin?.role || request.session?.get('actualRole') || request.session?.get('role') || 'EMPLOYEE';
  const actorEmail = request.admin?.email || request.session?.get('email') || '';
  const ipAddress = request.ip || (request.headers['x-forwarded-for'] as string) || '127.0.0.1';

  const enrichedMetadata: Record<string, unknown> = {
    actorName,
    actorRole,
    actorEmail,
    ipAddress,
    ...metadata
  };

  try {
    await prisma.auditLog.create({
      data: {
        adminId,
        action,
        entityType,
        entityId,
        metadata: enrichedMetadata as Prisma.InputJsonValue
      }
    });
  } catch (err) {
    // Audit logging failure should not abort main operation in test environments
    request.log.warn({ err, action, entityId }, 'Failed to record audit log');
  }
}
