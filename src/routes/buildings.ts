import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { logAudit } from '../services/audit.service.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';
import { buildingUnitWhere, unitIdFromBuilding } from '../utils/building-unit.js';

const CreateBuildingSchema = z.object({
  name: z.string().trim().min(1, 'Building name is required').max(100),
  code: z.string().trim().min(1, 'Building code is required').max(30),
  plantId: z.string().trim().min(1, 'Plant ID is required').optional(),
  unitId: z.string().trim().min(1).optional(),
  officeId: z.string().trim().min(1).optional()
}).refine((data) => Boolean(data.unitId || data.officeId || data.plantId), {
  message: 'Unit ID is required',
  path: ['unitId']
});

const UpdateBuildingSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  code: z.string().trim().min(1).max(30).optional(),
  plantId: z.string().trim().min(1).optional(),
  unitId: z.string().trim().min(1).optional()
});

const canManageMasterData = (role?: string) => role === 'SUPER_ADMIN' || role === 'TECH_ADMIN';

export const buildingRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/buildings
  fastify.get('/', async (request, reply) => {
    const { plantId, unitId, officeId, includeInactive } = request.query as { plantId?: string; unitId?: string; officeId?: string; includeInactive?: string };
    let effectiveUnitId = unitId || officeId;

    if (request.admin?.role === 'UNIT_ADMIN') {
      if (request.admin?.assignedUnitId) {
        effectiveUnitId = request.admin.assignedUnitId;
      } else {
        return reply.status(200).send([]);
      }
    }

    let whereClause: any = undefined;
    if (plantId) {
      if (effectiveUnitId) {
        whereClause = { AND: [{ plantId }, buildingUnitWhere([effectiveUnitId])] };
      } else {
        whereClause = { plantId };
      }
    } else if (effectiveUnitId) {
      whereClause = buildingUnitWhere([effectiveUnitId]);
    } else {
      // In global scope, restrict to authorized business units so orphaned
      // test buildings without plants do not crash Prisma or leak into views.
      const authorizedUnits = await fastify.prisma.unit.findMany({
        where: unitSelectorWhere(),
        select: { id: true }
      });
      const authorizedPlants = await fastify.prisma.plant.findMany({
        where: { unitId: { in: authorizedUnits.map((u) => u.id) } },
        select: { id: true }
      });
      whereClause = {
        OR: [
          { unitId: { in: authorizedUnits.map((unit) => unit.id) } },
          { AND: [{ unitId: { isSet: false } }, { plantId: { in: authorizedPlants.map((plant) => plant.id) } }] },
          { AND: [{ unitId: null }, { plantId: { in: authorizedPlants.map((plant) => plant.id) } }] }
        ]
      };
    }

    const buildings = await fastify.prisma.building.findMany({
      where: { ...(whereClause || {}), ...(includeInactive === 'true' ? {} : { isActive: true }) },
      include: {
        unit: true,
        plant: {
          include: { unit: true }
        },
        _count: { select: { floors: true } }
      },
      orderBy: { name: 'asc' }
    });

    return reply.status(200).send(buildings);
  });

  // POST /api/buildings
  fastify.post('/', async (request, reply) => {
    const userRole = request.admin?.role;
    if (!canManageMasterData(userRole)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage buildings; Unit Admins can only manage buildings within their assigned unit through operational workflows.' });
    }
    const parseResult = CreateBuildingSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const { name, code, plantId, unitId, officeId } = parseResult.data;
    const requestedUnitId = unitId || officeId;
    const codeUpper = code.toUpperCase();
    const legacyPlant = plantId ? await fastify.prisma.plant.findUnique({ where: { id: plantId } }) : null;
    const resolvedUnitId = requestedUnitId || legacyPlant?.unitId;
    const unit = resolvedUnitId ? await fastify.prisma.unit.findUnique({ where: { id: resolvedUnitId } }) : null;
    if (!unit) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Unit not found'
      });
    }
    if (legacyPlant && legacyPlant.unitId !== unit.id) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Legacy Plant does not belong to the selected Unit' });
    }

    const existing = await fastify.prisma.building.findFirst({
      where: {
        AND: [
          { code: codeUpper },
          buildingUnitWhere([unit.id])
        ]
      }
    });

    if (existing) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Building code already exists in this unit'
      });
    }

    const building = await fastify.prisma.building.create({
      data: {
        name,
        code: codeUpper,
        unitId: unit.id,
        ...(legacyPlant ? { plantId: legacyPlant.id } : {})
      },
      include: {
        unit: true,
        plant: {
          include: { unit: true }
        }
      }
    });

    await logAudit(fastify.prisma, request, 'BUILDING_CREATED', 'Building', building.id, {
      name: building.name,
      code: building.code,
      unitId: building.unitId,
      plantId: building.plantId
    });

    return reply.status(201).send({
      ...building,
      data: building
    });
  });

  // GET /api/buildings/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const building = await fastify.prisma.building.findUnique({
      where: { id },
      include: {
        unit: true,
        plant: {
          include: { unit: true }
        },
        floors: {
          orderBy: { floorNumber: 'asc' },
          include: {
            _count: { select: { seats: true } }
          }
        },
        _count: { select: { floors: true } }
      }
    });

    if (!building) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Building not found'
      });
    }

    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN' && request.admin?.assignedUnitId && unitIdFromBuilding(building) !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage buildings within their assigned unit'
      });
    }

    return reply.status(200).send({
      ...building,
      data: building
    });
  });

  // PUT /api/buildings/:id
  fastify.put('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (!canManageMasterData(userRole)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage buildings; Unit Admins can only manage buildings within their assigned unit through operational workflows.' });
    }
    const { id } = request.params as { id: string };

    const parseResult = UpdateBuildingSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const building = await fastify.prisma.building.findUnique({
      where: { id },
      include: { unit: true, plant: true }
    });

    if (!building) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Building not found'
      });
    }

    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN' && request.admin?.assignedUnitId && unitIdFromBuilding(building) !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage buildings within their assigned unit'
      });
    }

    const { name, code, plantId, unitId } = parseResult.data;
    const targetPlant = plantId ? await fastify.prisma.plant.findUnique({ where: { id: plantId } }) : null;
    const targetUnitId = unitId || targetPlant?.unitId || building.unitId || building.plant?.unitId;
    if (!targetUnitId || !(await fastify.prisma.unit.findUnique({ where: { id: targetUnitId } }))) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'A valid Unit is required.' });
    }
    if (targetPlant && targetPlant.unitId !== targetUnitId) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Legacy Plant does not belong to the selected Unit.' });
    }

    const codeUpper = code ? code.toUpperCase() : undefined;

    if (codeUpper && (codeUpper !== building.code || targetUnitId !== unitIdFromBuilding(building))) {
      const conflict = await fastify.prisma.building.findFirst({
        where: {
          AND: [
            { code: codeUpper },
            buildingUnitWhere([targetUnitId])
          ]
        }
      });
      if (conflict && conflict.id !== id) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Building code already exists in this unit'
        });
      }
    }

    const updated = await fastify.prisma.building.update({
      where: { id },
      data: {
        name: name ?? building.name,
        code: codeUpper ?? building.code,
        unitId: targetUnitId,
        ...(plantId ? { plantId } : {})
      },
      include: {
        unit: true,
        plant: {
          include: { unit: true }
        }
      }
    });

    await logAudit(fastify.prisma, request, 'BUILDING_UPDATED', 'Building', id, {
      name: updated.name,
      code: updated.code
    });

    return reply.status(200).send({
      ...updated,
      data: updated
    });
  });

  fastify.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!canManageMasterData(request.admin?.role)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage buildings; Unit Admins can only manage buildings within their assigned unit through operational workflows.' });
    }
    const parsed = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'isActive is required'
      });
    }
    const building = await fastify.prisma.building.findUnique({ where: { id }, include: { unit: true, plant: true } });
    if (!building) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Building not found'
      });
    }
    return fastify.prisma.building.update({ where: { id }, data: { isActive: parsed.data.isActive } });
  });

  // DELETE /api/buildings/:id
  fastify.delete('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (!canManageMasterData(userRole)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage buildings; Unit Admins can only manage buildings within their assigned unit through operational workflows.' });
    }
    const { id } = request.params as { id: string };

    const building = await fastify.prisma.building.findUnique({
      where: { id },
      include: { unit: true, plant: true }
    });

    if (!building) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Building not found'
      });
    }

    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN' && request.admin?.assignedUnitId && unitIdFromBuilding(building) !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage buildings within their assigned unit'
      });
    }

    // Cascade delete child floors, departments, seats, and unseat employees
    const floors = await fastify.prisma.floor.findMany({
      where: { buildingId: id },
      select: { id: true }
    });
    const floorIds = floors.map((f) => f.id);

    // A used building is only hidden. Existing floors, seats and assignments must remain intact.
    if (floorIds.length > 0) {
      await fastify.prisma.building.update({ where: { id }, data: { isActive: false } });
      await logAudit(fastify.prisma, request, 'BUILDING_ARCHIVED', 'Building', id, { name: building.name });
      return reply.status(200).send({ archived: true, reason: 'Building contains floors' });
    }

    await fastify.prisma.building.delete({
      where: { id }
    });

    await logAudit(fastify.prisma, request, 'BUILDING_DELETED', 'Building', id, {
      name: building.name
    });

    return reply.status(200).send({ success: true, deletedId: id });
  });
};
