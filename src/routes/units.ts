import { FastifyPluginAsync } from 'fastify';
import { CreateUnitRequestSchema, UpdateUnitRequestSchema } from '@seating/shared';
import { logAudit } from '../services/audit.service.js';
import { classifyUnit, isBusinessUnit, legacyBusinessUnitCodes, unitSelectorWhere } from '../utils/unit-classification.js';
import { buildingUnitWhere } from '../utils/building-unit.js';

export const unitRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/units
  fastify.get('/', async (request, reply) => {
    const query = request.query as { includeQuarantined?: string };
    const includeQuarantined = request.admin?.role === 'TECH_ADMIN' && query.includeQuarantined === 'true';
    let where: any = includeQuarantined ? undefined : unitSelectorWhere();
    if (request.admin?.role === 'UNIT_ADMIN') {
      if (request.admin?.assignedUnitId) {
        where = { id: request.admin.assignedUnitId };
      } else {
        return reply.status(200).send([]);
      }
    }

    const units = await fastify.prisma.unit.findMany({
      where,
      include: {
        _count: { select: { plants: true } }
      },
      orderBy: { name: 'asc' }
    });

    return reply.status(200).send(units.map((unit) => ({
      ...unit,
      classification: classifyUnit(unit as any),
      isBusinessUnit: isBusinessUnit(unit as any)
    })));
  });

  // POST /api/units
  fastify.post('/', async (request, reply) => {
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Super Admin access required to manage units'
      });
    }

    const parseResult = CreateUnitRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const { name, code, location } = parseResult.data;

    // Check case-insensitive name uniqueness
    const existingName = await fastify.prisma.unit.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } }
    });

    if (existingName) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Unit name already exists'
      });
    }

    // Default code if not provided
    const resolvedCode = (code || name.toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 30)).toUpperCase();

    // Check code uniqueness
    const existingCode = await fastify.prisma.unit.findUnique({
      where: { code: resolvedCode }
    });

    if (existingCode) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Unit code already exists'
      });
    }

    const unit = await fastify.prisma.unit.create({
      data: {
        name,
        code: resolvedCode,
        location: location || null,
        lifecycleStatus: 'ACTIVE'
      }
    });

    await logAudit(fastify.prisma, request, 'UNIT_CREATED', 'Unit', unit.id, {
      name: unit.name,
      code: unit.code
    });

    return reply.status(201).send({
      ...unit,
      data: unit
    });
  });

  // GET /api/units/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN' && request.admin?.assignedUnitId && id !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only view your assigned unit'
      });
    }

    const unit = await fastify.prisma.unit.findUnique({
      where: { id },
      include: {
        plants: {
          include: {
            _count: { select: { buildings: true } }
          },
          orderBy: { name: 'asc' }
        },
        _count: { select: { plants: true } }
      }
    });

    if (!unit) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Unit not found'
      });
    }

    if (!isBusinessUnit(unit as any) && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This Unit is quarantined or not in the authorized business scope.'
      });
    }

    return reply.status(200).send({
      ...unit,
      classification: classifyUnit(unit as any),
      data: unit
    });
  });

  // PUT /api/units/:id
  fastify.put('/:id', async (request, reply) => {
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Super Admin access required to manage units'
      });
    }

    const { id } = request.params as { id: string };
    const parseResult = UpdateUnitRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const unit = await fastify.prisma.unit.findUnique({
      where: { id }
    });

    if (!unit) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Unit not found'
      });
    }

    // The backend may be built against a previously generated shared-package
    // declaration. Keep the runtime-validated lifecycle field explicit at this
    // boundary so stale declarations cannot widen the update payload silently.
    const { name, code, location } = parseResult.data;
    const lifecycleStatus = (parseResult.data as { lifecycleStatus?: 'ACTIVE' | 'INACTIVE' | 'QUARANTINED' }).lifecycleStatus;

    // Check name conflict
    if (name && name.toLowerCase() !== unit.name.toLowerCase()) {
      const conflictName = await fastify.prisma.unit.findFirst({
        where: {
          id: { not: id },
          name: { equals: name, mode: 'insensitive' }
        }
      });
      if (conflictName) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Unit name already exists'
        });
      }
    }

    // Check code conflict
    const codeUpper = code ? code.toUpperCase() : undefined;
    if (codeUpper && codeUpper !== unit.code) {
      const conflictCode = await fastify.prisma.unit.findFirst({
        where: {
          id: { not: id },
          code: codeUpper
        }
      });
      if (conflictCode) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Unit code already exists'
        });
      }
    }

    const updated = await fastify.prisma.unit.update({
      where: { id },
      data: {
        name: name ?? unit.name,
        code: codeUpper ?? unit.code,
        location: location !== undefined ? location : unit.location,
        ...(lifecycleStatus && request.admin?.role === 'TECH_ADMIN' ? { lifecycleStatus } : {})
      }
    });

    await logAudit(fastify.prisma, request, 'UNIT_UPDATED', 'Unit', id, {
      name: updated.name,
      code: updated.code
    });

    return reply.status(200).send({
      ...updated,
      classification: classifyUnit(updated as any),
      data: updated
    });
  });

  // PATCH /api/units/:id/status — safe lifecycle transition. It preserves
  // every child record and is the supported replacement for destructive
  // cleanup of test or retired Units.
  fastify.patch('/:id/status', async (request, reply) => {
    if (request.admin?.role !== 'TECH_ADMIN' && request.admin?.role !== 'SUPER_ADMIN') {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required.' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { lifecycleStatus?: string };
    if (!['ACTIVE', 'INACTIVE', 'QUARANTINED'].includes(body?.lifecycleStatus || '')) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'lifecycleStatus must be ACTIVE, INACTIVE, or QUARANTINED.' });
    }
    const current = await fastify.prisma.unit.findUnique({ where: { id } });
    if (!current) return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Unit not found' });
    if (body.lifecycleStatus !== 'ACTIVE' && legacyBusinessUnitCodes().has(current.code)) {
      return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'The five baseline business Units require an approved migration before deactivation.' });
    }
    const updated = await fastify.prisma.unit.update({ where: { id }, data: { lifecycleStatus: body.lifecycleStatus as any } });
    await logAudit(fastify.prisma, request, `UNIT_${body.lifecycleStatus}`, 'Unit', id, { previousStatus: current.lifecycleStatus || null, lifecycleStatus: body.lifecycleStatus });
    return reply.status(200).send({ ...updated, classification: classifyUnit(updated as any), data: updated });
  });

  // DELETE /api/units/:id
  fastify.delete('/:id', async (request, reply) => {
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Super Admin access required to manage units'
      });
    }

    const { id } = request.params as { id: string };
    const unit = await fastify.prisma.unit.findUnique({
      where: { id }
    });

    if (!unit) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Unit not found'
      });
    }

    // Never cascade-delete a Unit: it would orphan or destroy employees,
    // workstations, floors, transfers, and legacy Plant relations.
    const plants = await fastify.prisma.plant.findMany({ where: { unitId: id }, select: { id: true } });
    const plantIds = plants.map((plant) => plant.id);
    const buildings = await fastify.prisma.building.findMany({
      where: buildingUnitWhere([id]),
      select: { id: true }
    });
    const buildingIds = buildings.map((building) => building.id);
    const floors = buildingIds.length > 0
      ? await fastify.prisma.floor.findMany({ where: { buildingId: { in: buildingIds } }, select: { id: true } })
      : [];
    const floorIds = floors.map((floor) => floor.id);
    const [departmentCount, employeeCount, seatCount, transferCount, adminCount] = await Promise.all([
      fastify.prisma.department.count({ where: { unitId: id } }),
      fastify.prisma.employee.count({ where: { department: { unitId: id } } }),
      floorIds.length > 0 ? fastify.prisma.seat.count({ where: { floorId: { in: floorIds } } }) : 0,
      fastify.prisma.seatTransferRequest.count({ where: { OR: [{ sourceUnitId: id }, { targetUnitId: id }] } }),
      fastify.prisma.adminUser.count({ where: { assignedUnitId: id, deletedAt: null } }),
    ]);
    const dependencies = { plants: plants.length, buildings: buildings.length, floors: floors.length, departments: departmentCount, employees: employeeCount, workstations: seatCount, transfers: transferCount, administrators: adminCount };
    if (Object.values(dependencies).some((count) => count > 0)) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        code: 'DEPENDENCIES_EXIST',
        message: 'Cannot delete this Unit because linked business records exist. Deactivate it instead.',
        dependencies,
      });
    }

    await fastify.prisma.unit.delete({ where: { id } });

    await logAudit(fastify.prisma, request, 'UNIT_DELETED', 'Unit', id, {
      name: unit.name
    });

    return reply.status(200).send({
      success: true,
      deletedId: id
    });
  });
};
