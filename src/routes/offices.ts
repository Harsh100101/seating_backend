import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { logAudit } from '../services/audit.service.js';
import { buildingUnitWhere } from '../utils/building-unit.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';

const CreateOfficeSchema = z.object({
  name: z.string().trim().min(1, 'Office name is required').max(255),
  city: z.string().trim().min(1, 'City is required').max(100).optional(),
  address: z.string().trim().max(255).nullable().optional()
});

const UpdateOfficeSchema = CreateOfficeSchema.partial();

/**
 * Backward compatibility office routes adapting to Unit model.
 */
export const officeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/offices (Deprecated: use /api/units)
  fastify.get('/', async (_request, reply) => {
    reply.header('Deprecation', 'true');
    reply.header('Link', '</api/units>; rel="successor-version"');
    const units = await fastify.prisma.unit.findMany({
      where: unitSelectorWhere(),
      include: {
        _count: { select: { plants: true } }
      },
      orderBy: { name: 'asc' }
    });

    const offices = units.map((u) => ({
      id: u.id,
      name: u.name,
      city: u.location || 'Headquarters',
      address: null,
      createdAt: u.createdAt,
      _count: { buildings: u._count.plants }
    }));

    return reply.status(200).send(offices);
  });

  // POST /api/offices
  fastify.post('/', async (request, reply) => {
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Super Admin access required to manage offices'
      });
    }

    const parseResult = CreateOfficeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const { name, city, address } = parseResult.data;

    const existing = await fastify.prisma.unit.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } }
    });

    if (existing) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Office name already exists'
      });
    }

    const slug = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'OFF';
    const code = `UNIT-${slug}-${Date.now().toString().slice(-4)}`;
    const unit = await fastify.prisma.unit.create({
      data: {
        name,
        code,
        location: city || address || null
      }
    });

    await logAudit(fastify.prisma, request, 'OFFICE_CREATED', 'Office', unit.id, {
      name: unit.name
    });

    return reply.status(201).send({
      id: unit.id,
      name: unit.name,
      city: unit.location || 'Headquarters',
      address: null,
      createdAt: unit.createdAt
    });
  });

  // GET /api/offices/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const unit = await fastify.prisma.unit.findUnique({
      where: { id }
    });

    if (!unit) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Office not found'
      });
    }

    return reply.status(200).send({
      id: unit.id,
      name: unit.name,
      city: unit.location || 'Headquarters',
      address: null,
      createdAt: unit.createdAt
    });
  });

  // PUT /api/offices/:id
  fastify.put('/:id', async (request, reply) => {
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Super Admin access required to manage offices'
      });
    }

    const { id } = request.params as { id: string };
    const parseResult = UpdateOfficeSchema.safeParse(request.body);
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
        message: 'Office not found'
      });
    }

    const { name, city, address } = parseResult.data;

    if (name && name.toLowerCase() !== unit.name.toLowerCase()) {
      const conflict = await fastify.prisma.unit.findFirst({
        where: {
          id: { not: id },
          name: { equals: name, mode: 'insensitive' }
        }
      });
      if (conflict) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Office name already exists'
        });
      }
    }

    const updated = await fastify.prisma.unit.update({
      where: { id },
      data: {
        name: name ?? unit.name,
        location: city !== undefined ? city : (address !== undefined ? address : unit.location)
      }
    });

    return reply.status(200).send({
      id: updated.id,
      name: updated.name,
      city: updated.location || 'Headquarters',
      address: null,
      createdAt: updated.createdAt
    });
  });

  // DELETE /api/offices/:id
  fastify.delete('/:id', async (request, reply) => {
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Super Admin access required to manage offices'
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
        message: 'Office not found'
      });
    }

    await fastify.prisma.$transaction(async (tx) => {
      // Step 1: Find all plants belonging to this unit
      const plants = await tx.plant.findMany({
        where: { unitId: id },
        select: { id: true }
      });
      const plantIds = plants.map((p) => p.id);

      {
        // Step 2: Find all buildings in the Unit, retaining the legacy Plant
        // relation only as a fallback for records not yet backfilled.
        const buildings = await tx.building.findMany({
          where: buildingUnitWhere([id]),
          select: { id: true }
        });
        const buildingIds = buildings.map((b) => b.id);

        if (buildingIds.length > 0) {
          // Step 3: Find all floors in those buildings
          const floors = await tx.floor.findMany({
            where: { buildingId: { in: buildingIds } },
            select: { id: true }
          });
          const floorIds = floors.map((f) => f.id);

          if (floorIds.length > 0) {
            // Step 4 & 5: Unseat employees for occupied seats on those floors
            await tx.seat.updateMany({
              where: { floorId: { in: floorIds } },
              data: { employeeId: { unset: true }, departmentId: null }
            });

            // Step 6: Delete seats
            await tx.seat.deleteMany({
              where: { floorId: { in: floorIds } }
            });

            // Step 7: Delete floors
            await tx.floor.deleteMany({
              where: { id: { in: floorIds } }
            });
          }

          // Step 8: Delete buildings
          await tx.building.deleteMany({
            where: { id: { in: buildingIds } }
          });
        }

        // Step 9: Delete plants
        await tx.plant.deleteMany({
          where: { id: { in: plantIds } }
        });
      }

      // Step 10: Delete unit
      await tx.unit.delete({
        where: { id }
      });
    });

    await logAudit(fastify.prisma, request, 'OFFICE_DELETED', 'Office', id, {
      name: unit.name
    });

    return reply.status(200).send({
      success: true,
      deletedId: id
    });
  });
};
