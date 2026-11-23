import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { logAudit } from '../services/audit.service.js';
import { buildingUnitWhere, unitIdFromBuilding } from '../utils/building-unit.js';

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

const CreateDepartmentSchema = z.object({
  name: z.string().trim().min(1, 'Department name is required').max(100),
  code: z.string().trim().min(1, 'Department code is required').max(30),
  colorHex: z.string().trim().regex(HEX_COLOR_REGEX, 'Color must be a valid 6-char hex code (#RRGGBB)'),
  unitId: z.string().trim().optional().nullable(),
  floorId: z.string().trim().optional().nullable()
});

const UpdateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  code: z.string().trim().min(1).max(30).optional(),
  colorHex: z.string().trim().regex(HEX_COLOR_REGEX, 'Color must be a valid 6-char hex code (#RRGGBB)').optional()
});

export const departmentRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/departments
  fastify.get('/', async (request, reply) => {
    const query = request.query as {
      floorId?: string;
      buildingId?: string;
      plantId?: string;
      unitId?: string;
      scope?: string;
      includeInactive?: string;
    };

    const safeFloorId = query.floorId && query.floorId !== 'ALL' ? query.floorId : undefined;
    const safeBuildingId = query.buildingId && query.buildingId !== 'ALL' ? query.buildingId : undefined;
    const safePlantId = query.plantId && query.plantId !== 'ALL' ? query.plantId : undefined;
    const safeUnitId = query.unitId && query.unitId !== 'ALL' ? query.unitId : undefined;

    let effectiveUnitId = safeUnitId;
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      if (request.admin?.assignedUnitId) {
        effectiveUnitId = request.admin.assignedUnitId;
      } else {
        return reply.status(200).send([]);
      }
    } else if (!effectiveUnitId && safeFloorId && query.scope === 'unit') {
      const floor = await fastify.prisma.floor.findUnique({
        where: { id: safeFloorId },
        include: {
          building: {
            include: {
              unit: true,
              plant: true
            }
          }
        }
      });
      const floorUnitId = unitIdFromBuilding(floor?.building);
      if (floorUnitId) {
        effectiveUnitId = floorUnitId;
      }
    }

    const conditions: any[] = [];
    let unitDeptIds: string[] = [];

    if (effectiveUnitId) {
      const unitBuildings = await fastify.prisma.building.findMany({
        where: buildingUnitWhere([effectiveUnitId]),
        select: { id: true }
      });
      const buildingIds = unitBuildings.map((b) => b.id);

      const unitFloors = buildingIds.length > 0
        ? await fastify.prisma.floor.findMany({
            where: { buildingId: { in: buildingIds } },
            select: { id: true }
          })
        : [];
      const floorIds = unitFloors.map((f) => f.id);

      const unitSeats = floorIds.length > 0
        ? await fastify.prisma.seat.findMany({
            where: { floorId: { in: floorIds } },
            select: { departmentId: true }
          })
        : [];

      unitDeptIds = Array.from(new Set(unitSeats.map((s) => s.departmentId).filter(Boolean))) as string[];
      conditions.push({
        OR: [
          { unitId: effectiveUnitId },
          { id: { in: unitDeptIds } }
        ]
      });
    }

    if (safePlantId) {
      const plantSeats = await fastify.prisma.seat.findMany({
        where: { floor: { building: { plantId: safePlantId } } },
        select: { departmentId: true }
      });
      const plantDeptIds = Array.from(new Set(plantSeats.map((s) => s.departmentId).filter(Boolean))) as string[];
      conditions.push({
        id: { in: plantDeptIds }
      });
    }

    if (safeBuildingId) {
      const bldSeats = await fastify.prisma.seat.findMany({
        where: { floor: { buildingId: safeBuildingId } },
        select: { departmentId: true }
      });
      const bldDeptIds = Array.from(new Set(bldSeats.map((s) => s.departmentId).filter(Boolean))) as string[];
      conditions.push({
        id: { in: bldDeptIds }
      });
    }

    const isFloorFilter = Boolean(safeFloorId && query.scope !== 'unit');
    if (isFloorFilter && safeFloorId) {
      const floorSeats = await fastify.prisma.seat.findMany({
        where: { floorId: safeFloorId },
        select: { departmentId: true }
      });
      const floorDeptIds = Array.from(new Set(floorSeats.map((s) => s.departmentId).filter(Boolean))) as string[];
      conditions.push({
        OR: [
          { id: { in: floorDeptIds } },
          { floorId: safeFloorId }
        ]
      });
    }

    const where: any = conditions.length > 0 ? (conditions.length === 1 ? conditions[0] : { AND: conditions }) : {};

    let departments = await fastify.prisma.department.findMany({
      where,
      include: {
        _count: { select: { employees: true, seats: true } },
        unit: { select: { id: true, name: true, code: true } },
        floor: { select: { id: true, name: true, floorNumber: true } }
      },
      orderBy: { name: 'asc' }
    });
    if (request.admin?.role === 'UNIT_ADMIN' && effectiveUnitId) {
      departments = departments.filter((department) => !department.unitId || department.unitId === effectiveUnitId);
    }
    // An explicit unit filter must never return a department owned by another
    // unit. Global departments may still be included when they are actually
    // referenced by seats in the selected unit.
    if (effectiveUnitId) {
      departments = departments.filter(
        (department) => department.unitId === effectiveUnitId || (!department.unitId && unitDeptIds.includes(department.id))
      );
    }
    if (query.includeInactive !== 'true') departments = departments.filter((department) => department.isActive !== false);

    if (isFloorFilter && query.floorId) {
      const floorSeats = await fastify.prisma.seat.findMany({
        where: { floorId: query.floorId },
        select: { id: true, departmentId: true, employeeId: true }
      });

      const enriched = departments
        .filter((dept: any) => {
          const deptSeats = floorSeats.filter((s: any) => s.departmentId === dept.id);
          return deptSeats.length > 0 || dept.floorId === query.floorId;
        })
        .map((dept) => {
        const deptSeats = floorSeats.filter((s: any) => s.departmentId === dept.id);
        const occupiedSeats = deptSeats.filter((s: any) => Boolean(s.employeeId)).length;
        return {
          ...dept,
          _count: {
            ...dept._count,
            seats: deptSeats.length,
            employees: occupiedSeats
          },
          floorAllocatedSeats: deptSeats.length,
          floorOccupiedSeats: occupiedSeats
        };
      });
      return reply.status(200).send(enriched);
    }

    return reply.status(200).send(departments);
  });

  // POST /api/departments
  fastify.post('/', async (request, reply) => {
    const parseResult = CreateDepartmentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const { name, code, colorHex, floorId, unitId } = parseResult.data;
    const codeUpper = code.toUpperCase();
    let targetUnitId = unitId || null;
    const targetFloorId = floorId || null;

    // Multi-Tenancy Enforcement: Non-Super Admins can only create departments within their assigned unit
    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      if (!userUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Admin is not assigned to any Unit'
        });
      }
      if (targetUnitId && targetUnitId !== userUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Forbidden: You can only create departments within your assigned unit'
        });
      }
      targetUnitId = userUnitId;
    }

    if (targetUnitId) {
      const unit = await fastify.prisma.unit.findUnique({
        where: { id: targetUnitId }
      });
      if (!unit) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Target unit not found'
        });
      }
    } else if (targetFloorId) {
      const floor = await fastify.prisma.floor.findUnique({
        where: { id: targetFloorId },
        include: { building: { include: { unit: true, plant: true } } }
      });
      if (!floor) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Target floor not found'
        });
      }
      const floorUnitId = unitIdFromBuilding(floor.building);
      if (floorUnitId) {
        targetUnitId = floorUnitId;
      }
    }

    // Uniqueness check: scoped to unitId if available, or floorId as fallback
    const conflictWhere: any = {
      OR: [
        { name: { equals: name, mode: 'insensitive' } },
        { code: { equals: codeUpper, mode: 'insensitive' } }
      ]
    };
    if (targetUnitId) {
      conflictWhere.unitId = targetUnitId;
    } else if (targetFloorId) {
      conflictWhere.floorId = targetFloorId;
    }

    const existing = await fastify.prisma.department.findFirst({
      where: conflictWhere
    });

    if (existing) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: targetUnitId
          ? 'Department name or code already exists in this unit'
          : 'Department name or code already exists on this floor'
      });
    }

    try {
      const dept = await fastify.prisma.department.create({
        data: {
          name,
          code: codeUpper,
          colorHex,
          unitId: targetUnitId,
          floorId: targetFloorId
        },
        include: {
          _count: { select: { employees: true, seats: true } },
          unit: { select: { id: true, name: true, code: true } }
        }
      });

      await logAudit(fastify.prisma, request, 'DEPARTMENT_CREATED', 'Department', dept.id, {
        name: dept.name,
        code: dept.code,
        colorHex: dept.colorHex,
        unitId: dept.unitId,
        floorId: dept.floorId
      });

      return reply.status(201).send(dept);
    } catch (err: any) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: targetUnitId
            ? 'Department name or code already exists in this unit'
            : 'Department name or code already exists on this floor'
        });
      }
      throw err;
    }
  });

  // GET /api/departments/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const dept = await fastify.prisma.department.findUnique({
      where: { id },
      include: {
        _count: { select: { employees: true, seats: true } },
        unit: { select: { id: true, name: true, code: true } },
        floor: true
      }
    });

    if (!dept) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Department not found'
      });
    }

    return reply.status(200).send(dept);
  });

  // PUT /api/departments/:id
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = UpdateDepartmentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const dept = await fastify.prisma.department.findUnique({
      where: { id }
    });

    if (!dept) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Department not found'
      });
    }

    // Multi-Tenancy Enforcement: Non-Super Admins can only modify departments within their assigned unit
    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      if (!userUnitId || (dept.unitId && dept.unitId !== userUnitId)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Forbidden: You can only modify departments within your assigned unit'
        });
      }
    }

    const { name, code, colorHex } = parseResult.data;
    const codeUpper = code ? code.toUpperCase() : undefined;

    if (name || codeUpper) {
      const conflictWhere: any = {
        id: { not: id },
        OR: [
          ...(name ? [{ name: { equals: name, mode: 'insensitive' as const } }] : []),
          ...(codeUpper ? [{ code: { equals: codeUpper, mode: 'insensitive' as const } }] : [])
        ]
      };
      if (dept.unitId) {
        conflictWhere.unitId = dept.unitId;
      } else if (dept.floorId) {
        conflictWhere.floorId = dept.floorId;
      }

      const conflict = await fastify.prisma.department.findFirst({
        where: conflictWhere
      });

      if (conflict) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: dept.unitId
            ? 'Department name or code already exists in this unit'
            : 'Department name or code already exists on this floor'
        });
      }
    }

    try {
      const updated = await fastify.prisma.department.update({
        where: { id },
        data: {
          name: name ?? dept.name,
          code: codeUpper ?? dept.code,
          colorHex: colorHex ?? dept.colorHex
        },
        include: {
          _count: { select: { employees: true, seats: true } },
          unit: { select: { id: true, name: true, code: true } }
        }
      });

      await logAudit(fastify.prisma, request, 'DEPARTMENT_UPDATED', 'Department', dept.id, {
        name: updated.name,
        code: updated.code,
        colorHex: updated.colorHex,
        unitId: dept.unitId
      });

      return reply.status(200).send(updated);
    } catch (err: any) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: dept.unitId
            ? 'Department name or code already exists in this unit'
            : 'Department name or code already exists on this floor'
        });
      }
      throw err;
    }
  });

  fastify.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'isActive is required'
      });
    }
    const department = await fastify.prisma.department.findUnique({ where: { id } });
    if (!department) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Department not found'
      });
    }
    if (request.admin?.role === 'UNIT_ADMIN' && department.unitId !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'You can only manage departments in your assigned unit'
      });
    }
    return fastify.prisma.department.update({ where: { id }, data: { isActive: parsed.data.isActive } });
  });

  // DELETE /api/departments/:id
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const archiveRequested = String((request.query as { archive?: string })?.archive || '').toLowerCase() === 'true';
    const dept = await fastify.prisma.department.findUnique({
      where: { id }
    });

    if (!dept) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Department not found'
      });
    }

    // Multi-Tenancy Enforcement: Non-Super Admins can only modify departments within their assigned unit
    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN') {
      if (!userUnitId || (dept.unitId && dept.unitId !== userUnitId)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Forbidden: You can only modify departments within your assigned unit'
        });
      }
    }

    if (archiveRequested) {
      const archived = await fastify.prisma.department.update({
        where: { id },
        data: { isActive: false }
      });
      return reply.status(200).send({ archived: true, department: archived });
    }

    // Enforce onDelete: Restrict
    const activeEmployees = await fastify.prisma.employee.count({
      where: { departmentId: id }
    });

    if (activeEmployees > 0) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Cannot delete department with active employees or seats'
      });
    }

    const activeSeats = await fastify.prisma.seat.count({
      where: { departmentId: id }
    });

    if (activeSeats > 0) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Cannot delete department with active employees or seats'
      });
    }

    const sectionCount = await fastify.prisma.section.count({ where: { departmentId: id } });
    if (sectionCount > 0) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Cannot delete department with active sections'
      });
    }

    await fastify.prisma.department.delete({
      where: { id }
    });

    await logAudit(fastify.prisma, request, 'DEPARTMENT_DELETED', 'Department', id, {
      name: dept.name,
      code: dept.code
    });

    return reply.status(200).send({ success: true });
  });
};
