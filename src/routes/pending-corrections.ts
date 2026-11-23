import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { logAudit } from '../services/audit.service.js';

const QuerySchema = z.object({
  status: z.enum(['PENDING', 'NEEDS_MANUAL_INPUT', 'READY_TO_VALIDATE', 'RESOLVED', 'APPLIED', 'BLOCKED']).optional(),
  problem: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const ResolveSchema = z.object({
  decision: z.string().min(1, 'Resolution decision is required'),
  selectedRow: z.number().int().optional(),
  correctedValues: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional().default(''),
});

export const pendingCorrectionsRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. List pending corrections with summary KPIs
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = request.admin;
    if (!admin) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const query = QuerySchema.parse(request.query || {});
    const where: any = {};

    // RBAC Scope:
    // SUPER_ADMIN and TECH_ADMIN have global read visibility.
    // UNIT_ADMIN is strictly scoped to their assigned unit.
    if (admin.role === 'UNIT_ADMIN') {
      if (!admin.assignedUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Unit Admin is not assigned to any Unit facility'
        });
      }
      // Find the unit name for the assigned unit ID
      const assignedUnit = await fastify.prisma.unit.findUnique({
        where: { id: admin.assignedUnitId },
        select: { id: true, name: true, code: true }
      });
      where.OR = [
        { unitId: admin.assignedUnitId },
        ...(assignedUnit?.name ? [{ unit: { equals: assignedUnit.name, mode: 'insensitive' } }] : []),
        ...(assignedUnit?.code ? [{ unit: { equals: assignedUnit.code, mode: 'insensitive' } }] : [])
      ];
    } else if (query.unit) {
      where.unit = { contains: query.unit, mode: 'insensitive' };
    }

    if (query.status) {
      where.status = query.status;
    }
    if (query.problem) {
      where.problem = query.problem;
    }
    if (query.category) {
      where.category = query.category;
    }
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        ...(where.OR || []),
        { employeeCode: { contains: s, mode: 'insensitive' } },
        { employeeName: { contains: s, mode: 'insensitive' } },
        { workstation: { contains: s, mode: 'insensitive' } },
        { department: { contains: s, mode: 'insensitive' } },
        { officeArea: { contains: s, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.limit;

    const [total, records, allRecordsForKpis] = await Promise.all([
      (fastify.prisma as any).initialImportPendingRecord.count({ where }),
      (fastify.prisma as any).initialImportPendingRecord.findMany({
        where,
        orderBy: [{ excelRow: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: query.limit,
      }),
      (fastify.prisma as any).initialImportPendingRecord.findMany({
        where: admin.role === 'UNIT_ADMIN' ? where : {},
        select: { status: true, problem: true, category: true }
      })
    ]);

    // Calculate KPIs
    const kpis = {
      total: allRecordsForKpis.length,
      pending: allRecordsForKpis.filter((r: any) => r.status === 'PENDING').length,
      needsManualInput: allRecordsForKpis.filter((r: any) => r.status === 'NEEDS_MANUAL_INPUT').length,
      readyToValidate: allRecordsForKpis.filter((r: any) => r.status === 'READY_TO_VALIDATE').length,
      resolved: allRecordsForKpis.filter((r: any) => r.status === 'RESOLVED' || r.status === 'APPLIED').length,
      duplicateEmployeeGroups: allRecordsForKpis.filter((r: any) => r.problem === 'DUPLICATE_EMPLOYEE_ID').length,
      duplicateWorkstationGroups: allRecordsForKpis.filter((r: any) => r.problem === 'DUPLICATE_WORKSTATION').length,
      hierarchyConflicts: allRecordsForKpis.filter((r: any) => ['MISSING_HIERARCHY', 'AMBIGUOUS_HIERARCHY'].includes(r.problem)).length,
      extraRecords: allRecordsForKpis.filter((r: any) => r.problem === 'EXTRA_MONGO_RECORD').length
    };

    return reply.status(200).send({
      records,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
      kpis,
      viewer: {
        role: admin.role,
        isReadOnly: admin.role === 'TECH_ADMIN',
        unitScope: admin.role === 'UNIT_ADMIN' ? admin.assignedUnitId : null
      }
    });
  });

  // 2. Get single record detail
  fastify.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const admin = request.admin;
    if (!admin) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const { id } = request.params;
    const record = await (fastify.prisma as any).initialImportPendingRecord.findUnique({
      where: { id }
    });

    if (!record) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Pending correction record not found' });
    }

    // RBAC Check for UNIT_ADMIN
    if (admin.role === 'UNIT_ADMIN') {
      if (record.unitId && record.unitId !== admin.assignedUnitId) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Unit Admin cannot access records outside assigned unit' });
      }
    }

    return reply.status(200).send(record);
  });

  // 3. Resolve a pending correction record
  fastify.post('/:id/resolve', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const admin = request.admin;
    if (!admin) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    // RBAC: TECH_ADMIN is read-only
    if (admin.role === 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Technical Administrators have read-only audit access to pending corrections. Only Super Admins and Unit Admins can resolve corrections.'
      });
    }

    const { id } = request.params;
    const body = ResolveSchema.parse(request.body || {});

    const record = await (fastify.prisma as any).initialImportPendingRecord.findUnique({
      where: { id }
    });

    if (!record) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Pending correction record not found' });
    }

    // RBAC: UNIT_ADMIN scoped check
    if (admin.role === 'UNIT_ADMIN') {
      if (record.unitId && record.unitId !== admin.assignedUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Unit Admin cannot resolve corrections outside assigned unit'
        });
      }
    }

    const updated = await (fastify.prisma as any).initialImportPendingRecord.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolutionDecision: body.decision,
        resolutionNotes: body.notes || `Resolved by ${admin.name} (${admin.role}) via Decision: ${body.decision}`,
        resolvedById: admin.id,
        resolvedAt: new Date(),
        ...(body.correctedValues ? { conflictingValue: { ...(record.conflictingValue as object || {}), resolution: body.correctedValues } } : {})
      }
    });

    // Audit log
    await logAudit(fastify.prisma, request, 'PENDING_CORRECTION_RESOLVED', 'InitialImportPendingRecord', id, {
      recordId: id,
      excelRow: record.excelRow,
      employeeCode: record.employeeCode,
      workstation: record.workstation,
      problem: record.problem,
      decision: body.decision,
      selectedRow: body.selectedRow,
      notes: body.notes,
      adminEmail: admin.email,
      adminRole: admin.role
    });

    return reply.status(200).send({
      success: true,
      record: updated,
      message: `Pending correction for row ${record.excelRow} successfully resolved.`
    });
  });
};
