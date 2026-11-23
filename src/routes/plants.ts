import { FastifyPluginAsync } from 'fastify';
import { CreatePlantRequestSchema, UpdatePlantRequestSchema } from '@seating/shared';
import { logAudit } from '../services/audit.service.js';

function isMissingRecordError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  const message = 'message' in error ? (error as { message?: unknown }).message : undefined;
  return code === 'P2025' || (typeof message === 'string' && /(?:plant not found|record to delete does not exist)/i.test(message));
}

export const plantRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/plants
  fastify.get('/', async (request, reply) => {
    const { unitId } = request.query as { unitId?: string };
    let targetUnitId = unitId;

    if (request.admin?.role === 'UNIT_ADMIN') {
      if (request.admin?.assignedUnitId) {
        targetUnitId = request.admin.assignedUnitId;
      } else {
        return reply.status(200).send([]);
      }
    }

    const plants = await fastify.prisma.plant.findMany({
      where: targetUnitId ? { unitId: targetUnitId } : undefined,
      include: {
        unit: true,
        _count: { select: { buildings: true } }
      },
      orderBy: { name: 'asc' }
    });

    return reply.status(200).send(plants);
  });

  // POST /api/plants
  fastify.post('/', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole === 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage plants within their assigned unit (Plant creation requires Super Admin or Tech Admin role)'
      });
    }
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Tech Admin role to create plants'
      });
    }

    const parseResult = CreatePlantRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const { name, code, unitId } = parseResult.data;
    const codeUpper = code.toUpperCase();

    // Verify unitId exists
    const unit = await fastify.prisma.unit.findUnique({
      where: { id: unitId }
    });
    if (!unit) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Unit not found'
      });
    }

    // Check compound [unitId, code] uniqueness
    const existing = await fastify.prisma.plant.findUnique({
      where: {
        unitId_code: {
          unitId,
          code: codeUpper
        }
      }
    });

    if (existing) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Plant code already exists in this unit'
      });
    }

    const plant = await fastify.prisma.plant.create({
      data: {
        name,
        code: codeUpper,
        unitId
      },
      include: {
        unit: true
      }
    });

    await logAudit(fastify.prisma, request, 'PLANT_CREATED', 'Plant', plant.id, {
      name: plant.name,
      code: plant.code,
      unitId: plant.unitId
    });

    return reply.status(201).send({
      ...plant,
      data: plant
    });
  });

  // GET /api/plants/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plant = await fastify.prisma.plant.findUnique({
      where: { id },
      include: {
        unit: true,
        buildings: {
          include: {
            _count: { select: { floors: true } }
          },
          orderBy: { name: 'asc' }
        },
        _count: { select: { buildings: true } }
      }
    });

    if (!plant) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Plant not found'
      });
    }

    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN' && request.admin?.assignedUnitId && plant.unitId !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage plants within their assigned unit'
      });
    }

    return reply.status(200).send({
      ...plant,
      data: plant
    });
  });

  // PUT /api/plants/:id
  fastify.put('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole === 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage plants within their assigned unit (Plant update requires Super Admin or Tech Admin role)'
      });
    }
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Tech Admin role to update plants'
      });
    }

    const { id } = request.params as { id: string };
    const parseResult = UpdatePlantRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const plant = await fastify.prisma.plant.findUnique({
      where: { id }
    });

    if (!plant) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Plant not found'
      });
    }

    const { name, code, unitId } = parseResult.data;
    const targetUnitId = unitId || plant.unitId;
    const codeUpper = code ? code.toUpperCase() : undefined;

    if (codeUpper && (codeUpper !== plant.code || targetUnitId !== plant.unitId)) {
      const conflict = await fastify.prisma.plant.findUnique({
        where: {
          unitId_code: {
            unitId: targetUnitId,
            code: codeUpper
          }
        }
      });
      if (conflict && conflict.id !== id) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Plant code already exists in this unit'
        });
      }
    }

    const updated = await fastify.prisma.plant.update({
      where: { id },
      data: {
        name: name ?? plant.name,
        code: codeUpper ?? plant.code,
        unitId: targetUnitId
      },
      include: {
        unit: true
      }
    });

    await logAudit(fastify.prisma, request, 'PLANT_UPDATED', 'Plant', id, {
      name: updated.name,
      code: updated.code
    });

    return reply.status(200).send({
      ...updated,
      data: updated
    });
  });

  // DELETE /api/plants/:id
  fastify.delete('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole === 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage plants within their assigned unit (Plant deletion requires Super Admin or Tech Admin role)'
      });
    }
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Tech Admin role to delete plants'
      });
    }

    const { id } = request.params as { id: string };
    const plant = await fastify.prisma.plant.findUnique({
      where: { id }
    });

    if (!plant) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Plant not found'
      });
    }

    // Atomic cascading delete inside transaction
    try {
      await fastify.prisma.$transaction(async (tx) => {
      // Step 1: Find all buildings in plant
      const buildings = await tx.building.findMany({
        where: { plantId: id },
        select: { id: true }
      });
      const buildingIds = buildings.map((b) => b.id);

      if (buildingIds.length > 0) {
        // Step 2: Find all floors in those buildings
        const floors = await tx.floor.findMany({
          where: { buildingId: { in: buildingIds } },
          select: { id: true }
        });
        const floorIds = floors.map((f) => f.id);

        if (floorIds.length > 0) {
          // Step 3 & 4: Unseat employees for occupied seats on those floors
          await tx.seat.updateMany({
            where: { floorId: { in: floorIds } },
            data: { employeeId: { unset: true }, departmentId: null }
          });

          // Step 5: Delete seats
          await tx.seat.deleteMany({
            where: { floorId: { in: floorIds } }
          });

          // Step 5b: Delete floor-scoped departments
          await tx.department.deleteMany({
            where: { floorId: { in: floorIds } }
          });

          // Step 6: Delete floors
          await tx.floor.deleteMany({
            where: { id: { in: floorIds } }
          });
        }

        // Step 7: Delete buildings
        await tx.building.deleteMany({
          where: { id: { in: buildingIds } }
        });
      }

      // Step 8: Delete plant (without deleting parent Unit!)
      await tx.plant.delete({
        where: { id }
      });
      });
    } catch (error) {
      if (isMissingRecordError(error)) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Plant not found'
        });
      }
      throw error;
    }

    await logAudit(fastify.prisma, request, 'PLANT_DELETED', 'Plant', id, {
      name: plant.name
    });

    return reply.status(200).send({
      success: true,
      deletedId: id
    });
  });
};
