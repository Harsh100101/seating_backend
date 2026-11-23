import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { logAudit } from '../services/audit.service.js';
import { buildingUnitWhere, unitIdFromBuilding } from '../utils/building-unit.js';

const nameSchema = z.string().trim().min(1, 'Name is required').max(100);
const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
const canManage = (role?: string) => role === 'SUPER_ADMIN' || role === 'TECH_ADMIN';

function deny(reply: any) {
  return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'You cannot manage categories outside your assigned unit' });
}

function badRequest(reply: any, message: string) {
  return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message });
}

function notFound(reply: any, message: string) {
  return reply.status(404).send({ statusCode: 404, error: 'Not Found', message });
}

async function floorUnitId(prisma: any, floorId: string) {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, include: { building: { include: { unit: true, plant: true } } } });
  return { record: floor, unitId: unitIdFromBuilding(floor?.building) || undefined };
}

async function departmentUnitId(prisma: any, departmentId: string) {
  const department = await prisma.department.findUnique({ where: { id: departmentId } });
  return { record: department, unitId: department?.unitId as string | undefined };
}

async function sectionUnitId(prisma: any, sectionId: string) {
  const section = await prisma.section.findUnique({ where: { id: sectionId }, include: { department: true } });
  return { record: section, unitId: section?.department?.unitId as string | undefined };
}

function unitAllowed(request: any, unitId?: string | null) {
  return request.admin?.role !== 'UNIT_ADMIN' || Boolean(unitId && unitId === request.admin?.assignedUnitId);
}

export const areaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const query = request.query as { floorId?: string; unitId?: string; includeInactive?: string };
    const effectiveUnitId = request.admin?.role === 'UNIT_ADMIN' ? request.admin.assignedUnitId : query.unitId;
    return fastify.prisma.area.findMany({
      where: {
        ...(query.includeInactive === 'true' ? {} : { isActive: true }),
        ...(query.floorId && query.floorId !== 'ALL' ? { floorId: query.floorId } : {}),
        ...(effectiveUnitId ? { floor: { building: buildingUnitWhere([effectiveUnitId]) } } : {})
      },
      include: { floor: { include: { building: true } }, _count: { select: { seats: true } } },
      orderBy: { name: 'asc' }
    });
  });

  fastify.post('/', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const parsed = z.object({ name: nameSchema, floorId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((e) => e.message).join(', '));
    const parent = await floorUnitId(fastify.prisma, parsed.data.floorId);
    if (!parent.record) return notFound(reply, 'Floor not found');
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const area = await fastify.prisma.area.create({ data: { ...parsed.data, name: parsed.data.name.trim().replace(/\s+/g, ' '), normalizedName: normalizeName(parsed.data.name) } });
    await logAudit(fastify.prisma, request, 'AREA_CREATED', 'Area', area.id, { name: area.name, floorId: area.floorId });
    return reply.status(201).send(area);
  });

  fastify.put('/:id', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const parsed = z.object({ name: nameSchema }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, 'Valid area name is required');
    const current = await fastify.prisma.area.findUnique({ where: { id } });
    if (!current) return notFound(reply, 'Area not found');
    const parent = await floorUnitId(fastify.prisma, current.floorId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const area = await fastify.prisma.area.update({ where: { id }, data: { name: parsed.data.name.trim().replace(/\s+/g, ' '), normalizedName: normalizeName(parsed.data.name) } });
    await logAudit(fastify.prisma, request, 'AREA_UPDATED', 'Area', id, { name: area.name });
    return area;
  });

  fastify.patch('/:id/status', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const parsed = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, 'isActive is required');
    const current = await fastify.prisma.area.findUnique({ where: { id } });
    if (!current) return notFound(reply, 'Area not found');
    const parent = await floorUnitId(fastify.prisma, current.floorId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const area = await fastify.prisma.area.update({ where: { id }, data: { isActive: parsed.data.isActive } });
    await logAudit(fastify.prisma, request, parsed.data.isActive ? 'AREA_REACTIVATED' : 'AREA_ARCHIVED', 'Area', id, {});
    return area;
  });

  fastify.delete('/:id', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const current = await fastify.prisma.area.findUnique({ where: { id }, include: { _count: { select: { seats: true } } } });
    if (!current) return notFound(reply, 'Area not found');
    const parent = await floorUnitId(fastify.prisma, current.floorId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    if (current._count.seats > 0) {
      await fastify.prisma.area.update({ where: { id }, data: { isActive: false } });
      return { archived: true, reason: 'Area is used by workstations' };
    }
    await fastify.prisma.area.delete({ where: { id } });
    return { deleted: true };
  });
};

export const sectionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const query = request.query as { departmentId?: string; unitId?: string; includeInactive?: string };
    const effectiveUnitId = request.admin?.role === 'UNIT_ADMIN' ? request.admin.assignedUnitId : query.unitId;
    return fastify.prisma.section.findMany({
      where: {
        ...(query.includeInactive === 'true' ? {} : { isActive: true }),
        ...(query.departmentId && query.departmentId !== 'ALL' ? { departmentId: query.departmentId } : {}),
        ...(effectiveUnitId ? { department: { unitId: effectiveUnitId } } : {})
      },
      include: { department: true, _count: { select: { employees: true, functions: true } } }, orderBy: { name: 'asc' }
    });
  });

  fastify.post('/', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const parsed = z.object({ name: nameSchema, departmentId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((e) => e.message).join(', '));
    const parent = await departmentUnitId(fastify.prisma, parsed.data.departmentId);
    if (!parent.record) return notFound(reply, 'Department not found');
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const section = await fastify.prisma.section.create({ data: { ...parsed.data, name: parsed.data.name.trim().replace(/\s+/g, ' '), normalizedName: normalizeName(parsed.data.name) } });
    await logAudit(fastify.prisma, request, 'SECTION_CREATED', 'Section', section.id, { name: section.name, departmentId: section.departmentId });
    return reply.status(201).send(section);
  });

  fastify.put('/:id', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const parsed = z.object({ name: nameSchema }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, 'Valid section name is required');
    const current = await fastify.prisma.section.findUnique({ where: { id } });
    if (!current) return notFound(reply, 'Section not found');
    const parent = await departmentUnitId(fastify.prisma, current.departmentId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const section = await fastify.prisma.section.update({ where: { id }, data: { name: parsed.data.name.trim().replace(/\s+/g, ' '), normalizedName: normalizeName(parsed.data.name) } });
    await logAudit(fastify.prisma, request, 'SECTION_UPDATED', 'Section', id, { name: section.name });
    return section;
  });

  fastify.patch('/:id/status', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const parsed = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, 'isActive is required');
    const current = await fastify.prisma.section.findUnique({ where: { id } });
    if (!current) return notFound(reply, 'Section not found');
    const parent = await departmentUnitId(fastify.prisma, current.departmentId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    return fastify.prisma.section.update({ where: { id }, data: { isActive: parsed.data.isActive } });
  });

  fastify.delete('/:id', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const current = await fastify.prisma.section.findUnique({ where: { id }, include: { _count: { select: { employees: true, functions: true } } } });
    if (!current) return notFound(reply, 'Section not found');
    const parent = await departmentUnitId(fastify.prisma, current.departmentId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    if (current._count.employees > 0 || current._count.functions > 0) {
      await fastify.prisma.section.update({ where: { id }, data: { isActive: false } });
      return { archived: true, reason: 'Section is in use' };
    }
    await fastify.prisma.section.delete({ where: { id } });
    return { deleted: true };
  });
};

export const functionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const query = request.query as { sectionId?: string; departmentId?: string; unitId?: string; includeInactive?: string };
    const effectiveUnitId = request.admin?.role === 'UNIT_ADMIN' ? request.admin.assignedUnitId : query.unitId;
    return fastify.prisma.orgFunction.findMany({
      where: {
        ...(query.includeInactive === 'true' ? {} : { isActive: true }),
        ...(query.sectionId && query.sectionId !== 'ALL' ? { sectionId: query.sectionId } : {}),
        ...(query.departmentId && query.departmentId !== 'ALL' ? { section: { departmentId: query.departmentId } } : {}),
        ...(effectiveUnitId ? { section: { department: { unitId: effectiveUnitId } } } : {})
      },
      include: { section: { include: { department: true } }, _count: { select: { employees: true } } }, orderBy: { name: 'asc' }
    });
  });

  fastify.post('/', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const parsed = z.object({ name: nameSchema, sectionId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((e) => e.message).join(', '));
    const parent = await sectionUnitId(fastify.prisma, parsed.data.sectionId);
    if (!parent.record) return notFound(reply, 'Section not found');
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const fn = await fastify.prisma.orgFunction.create({ data: { ...parsed.data, name: parsed.data.name.trim().replace(/\s+/g, ' '), normalizedName: normalizeName(parsed.data.name) } });
    await logAudit(fastify.prisma, request, 'FUNCTION_CREATED', 'Function', fn.id, { name: fn.name, sectionId: fn.sectionId });
    return reply.status(201).send(fn);
  });

  fastify.put('/:id', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const parsed = z.object({ name: nameSchema }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, 'Valid function name is required');
    const current = await fastify.prisma.orgFunction.findUnique({ where: { id } });
    if (!current) return notFound(reply, 'Function not found');
    const parent = await sectionUnitId(fastify.prisma, current.sectionId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    const fn = await fastify.prisma.orgFunction.update({ where: { id }, data: { name: parsed.data.name.trim().replace(/\s+/g, ' '), normalizedName: normalizeName(parsed.data.name) } });
    await logAudit(fastify.prisma, request, 'FUNCTION_UPDATED', 'Function', id, { name: fn.name });
    return fn;
  });

  fastify.patch('/:id/status', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const parsed = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return badRequest(reply, 'isActive is required');
    const current = await fastify.prisma.orgFunction.findUnique({ where: { id } });
    if (!current) return notFound(reply, 'Function not found');
    const parent = await sectionUnitId(fastify.prisma, current.sectionId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    return fastify.prisma.orgFunction.update({ where: { id }, data: { isActive: parsed.data.isActive } });
  });

  fastify.delete('/:id', async (request, reply) => {
    if (!canManage(request.admin?.role)) return deny(reply);
    const { id } = request.params as { id: string };
    const current = await fastify.prisma.orgFunction.findUnique({ where: { id }, include: { _count: { select: { employees: true } } } });
    if (!current) return notFound(reply, 'Function not found');
    const parent = await sectionUnitId(fastify.prisma, current.sectionId);
    if (!unitAllowed(request, parent.unitId)) return deny(reply);
    if (current._count.employees > 0) {
      await fastify.prisma.orgFunction.update({ where: { id }, data: { isActive: false } });
      return { archived: true, reason: 'Function is used by employees' };
    }
    await fastify.prisma.orgFunction.delete({ where: { id } });
    return { deleted: true };
  });
};
