import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import xlsx from 'xlsx';
import { logAudit } from '../services/audit.service.js';
import { normalizeEmpCode, isVacantOrPlaceholder } from '../utils/employee-code.js';
import { isBusinessUnit, unitSelectorWhere } from '../utils/unit-classification.js';
import { escapeRegexLiteral } from '../utils/regex.js';
import { buildingUnitWhere, resolveBuildingUnitId, unitIdFromBuilding } from '../utils/building-unit.js';
import { currentOperationalRecordWhere, operationalRecordClassification } from '../utils/operational-record.js';
import { persistNotification } from '../services/notification.service.js';

const phoneField = z.string().trim().max(30).refine((value) => {
  if (!value) return true;
  return /^\d{10}$/.test(value);
}, 'Phone number must be exactly 10 digits and contain numbers only').nullable().optional();

const extField = z.string().trim().max(30).refine((value) => {
  if (!value) return true;
  return /^\d+$/.test(value);
}, 'Intercom extension must contain digits only').nullable().optional();

const fullNameField = z.string().trim().min(1, 'Full name is required').max(100).refine((value) => {
  if (/<[^>]*script/i.test(value) || value.includes('<') || value.includes('>')) return false;
  return /^[\p{L}\p{M}\p{N}\s.,'"()-]+$/u.test(value);
}, 'Full name may contain letters, numbers, spaces, and standard name punctuation only (no HTML or special symbols)');

const CreateEmployeeSchema = z.object({
  employeeCode: z.string().trim().min(1, 'Employee code is required').max(50),
  fullName: fullNameField,
  // New clients send the explicit hierarchy Unit. Legacy API clients may omit
  // it; in that case it is safely derived from the selected Department.
  unitId: z.string().trim().min(1).optional(),
  buildingId: z.string().trim().min(1).optional(),
  floorId: z.string().trim().min(1).optional(),
  areaId: z.string().trim().min(1).optional(),
  email: z.string().trim().email('Invalid email address').nullable().optional().or(z.literal('')),
  departmentId: z.string().min(1, 'Department ID is required'),
  designation: z.string().trim().max(100).nullable().optional(),
  grade: z.string().trim().max(30).nullable().optional(),
  phone: phoneField,
  ext: z.string().trim().max(30).nullable().optional(),
  section: z.string().trim().max(100).nullable().optional(),
  sectionId: z.string().nullable().optional(),
  functionName: z.string().trim().max(100).nullable().optional(),
  functionId: z.string().nullable().optional(),
  reportingManager: z.string().trim().max(100).nullable().optional(),
  reportingTo: z.string().trim().max(100).nullable().optional(),
  hod: z.string().trim().max(100).nullable().optional(),
  remarks: z.string().trim().max(500).nullable().optional(),
  pcNumber: z.string().trim().max(100).nullable().optional(),
  officeArea: z.string().trim().max(150).nullable().optional(),
  subLocation: z.string().trim().max(150).nullable().optional(),
  seatId: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true)
});

const UpdateEmployeeSchema = z.object({
  employeeCode: z.string().trim().min(1).max(50).optional(),
  fullName: fullNameField.optional(),
  unitId: z.string().trim().min(1).optional(),
  buildingId: z.string().trim().min(1).optional(),
  floorId: z.string().trim().min(1).optional(),
  areaId: z.string().trim().min(1).optional(),
  email: z.string().trim().email('Invalid email address').nullable().optional().or(z.literal('')),
  departmentId: z.string().min(1).optional(),
  designation: z.string().trim().max(100).nullable().optional(),
  grade: z.string().trim().max(30).nullable().optional(),
  phone: phoneField,
  ext: extField,
  section: z.string().trim().max(100).nullable().optional(),
  sectionId: z.string().nullable().optional(),
  functionName: z.string().trim().max(100).nullable().optional(),
  functionId: z.string().nullable().optional(),
  reportingManager: z.string().trim().max(100).nullable().optional(),
  reportingTo: z.string().trim().max(100).nullable().optional(),
  hod: z.string().trim().max(100).nullable().optional(),
  remarks: z.string().trim().max(500).nullable().optional(),
  pcNumber: z.string().trim().max(100).nullable().optional(),
  officeArea: z.string().trim().max(150).nullable().optional(),
  subLocation: z.string().trim().max(150).nullable().optional(),
  seatId: z.string().nullable().optional(),
  isActive: z.boolean().optional()
});

type EmployeeHierarchyInput = {
  unitId?: string | null;
  buildingId?: string | null;
  floorId?: string | null;
  areaId?: string | null;
  departmentId?: string | null;
  sectionId?: string | null;
  functionId?: string | null;
  officeArea?: string | null;
  seatId?: string | null;
  currentEmployeeId?: string | null;
};

type HierarchyValidation =
  | { valid: true }
  | { valid: false; statusCode: 400 | 403 | 409; message: string };

/**
 * Validates the same master IDs used by the workstation hierarchy. Every
 * relationship is checked through scalar foreign keys so employee create/edit
 * does not reintroduce nested MongoDB relation filters.
 */
async function validateEmployeeHierarchy(
  prisma: PrismaClient,
  admin: any,
  input: EmployeeHierarchyInput
): Promise<HierarchyValidation> {
  const unitId = input.unitId?.trim();
  const departmentId = input.departmentId?.trim();
  if (!unitId || unitId === 'ALL' || !departmentId || departmentId === 'ALL') {
    return { valid: false, statusCode: 400, message: 'A specific Unit and Department are required.' };
  }

  const unit = await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true } });
  if (!unit) return { valid: false, statusCode: 400, message: 'Invalid Unit.' };

  if (admin?.role === 'UNIT_ADMIN' && admin.assignedUnitId !== unitId) {
    return { valid: false, statusCode: 403, message: 'You can only manage employees within your assigned Unit.' };
  }

  const validatedFloorId = input.floorId?.trim() || null;
  if (input.buildingId) {
    const buildingUnitId = await resolveBuildingUnitId(prisma, input.buildingId);
    if (!buildingUnitId) return { valid: false, statusCode: 400, message: 'Invalid Building.' };
    if (buildingUnitId !== unitId) {
      return { valid: false, statusCode: admin?.role === 'UNIT_ADMIN' ? 403 : 400, message: 'Building does not belong to the selected Unit.' };
    }
  }

  if (validatedFloorId) {
    const floor = await prisma.floor.findUnique({ where: { id: validatedFloorId }, select: { buildingId: true } });
    if (!floor) return { valid: false, statusCode: 400, message: 'Invalid Floor.' };
    const buildingUnitId = await resolveBuildingUnitId(prisma, floor.buildingId);
    if (!buildingUnitId || buildingUnitId !== unitId) {
      return { valid: false, statusCode: admin?.role === 'UNIT_ADMIN' ? 403 : 400, message: 'Floor does not belong to the selected Unit.' };
    }
    if (input.buildingId && floor.buildingId !== input.buildingId) {
      return { valid: false, statusCode: 400, message: 'Floor does not belong to the selected Building.' };
    }
  }

  const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { unitId: true } });
  if (!department) return { valid: false, statusCode: 400, message: 'Invalid Department.' };
  if (department.unitId && department.unitId !== unitId) {
    return { valid: false, statusCode: admin?.role === 'UNIT_ADMIN' ? 403 : 400, message: 'Department does not belong to the selected Unit.' };
  }

  if (input.sectionId) {
    const section = await prisma.section.findUnique({ where: { id: input.sectionId }, select: { departmentId: true } });
    if (!section) return { valid: false, statusCode: 400, message: 'Invalid Section.' };
    if (section.departmentId !== departmentId) return { valid: false, statusCode: 400, message: 'Section does not belong to the selected Department.' };
  }

  if (input.functionId) {
    const fn = await prisma.orgFunction.findUnique({ where: { id: input.functionId }, select: { sectionId: true } });
    if (!fn) return { valid: false, statusCode: 400, message: 'Invalid Function.' };
    if (input.sectionId && fn.sectionId !== input.sectionId) return { valid: false, statusCode: 400, message: 'Function does not belong to the selected Section.' };
  }

  if (input.areaId) {
    const area = await prisma.area.findUnique({ where: { id: input.areaId }, select: { floorId: true } });
    if (!area) return { valid: false, statusCode: 400, message: 'Invalid Office / Area.' };
    if (validatedFloorId && area.floorId !== validatedFloorId) return { valid: false, statusCode: 400, message: 'Office / Area does not belong to the selected Floor.' };
  }

  if (input.officeArea?.trim() && validatedFloorId) {
    const areaName = input.officeArea.trim();
    const namedArea = await prisma.area.findFirst({
      where: { floorId: validatedFloorId, name: { equals: areaName, mode: 'insensitive' } },
      select: { id: true }
    });
    const namedSeatArea = namedArea ? null : await prisma.seat.findFirst({
      where: { floorId: validatedFloorId, officeArea: { equals: areaName, mode: 'insensitive' } },
      select: { id: true }
    });
    if (!namedArea && !namedSeatArea) {
      return { valid: false, statusCode: 400, message: 'Office / Area does not belong to the selected Floor.' };
    }
  }

  if (input.seatId) {
    const seat = await prisma.seat.findUnique({ where: { id: input.seatId }, select: { floorId: true, employeeId: true, status: true } });
    if (!seat) return { valid: false, statusCode: 400, message: 'Workstation not found.' };
    if (validatedFloorId && seat.floorId !== validatedFloorId) return { valid: false, statusCode: 400, message: 'Workstation does not belong to the selected Floor.' };
    if (seat.employeeId && seat.employeeId !== input.currentEmployeeId) return { valid: false, statusCode: 409, message: 'Workstation is already occupied.' };
    if (seat.status !== 'AVAILABLE') return { valid: false, statusCode: 409, message: `Workstation is not available (status: ${seat.status}).` };
  }

  return { valid: true };
}

export const employeeRoutes: FastifyPluginAsync<{ enableLegacyEmployeeBulkImport?: boolean }> = async (fastify, options) => {
  // GET /api/employees
  fastify.get('/', async (request, reply) => {
    const query = request.query as {
      search?: string;
      empCode?: string;
      name?: string;
      departmentId?: string;
      departmentName?: string;
      section?: string;
      functionName?: string;
      reportingManager?: string;
      reportingTo?: string;
      ext?: string;
      hod?: string;
      active?: string;
      isActive?: string;
      wsNo?: string;
      pcNumber?: string;
      officeArea?: string;
      areaId?: string;
      subLocation?: string;
      unitId?: string;
      plantId?: string;
      buildingId?: string;
      buildingName?: string;
      floorId?: string;
      floorName?: string;
      sectionId?: string;
      functionId?: string;
      status?: string;
      assigned?: string;
      seatEligible?: string;
      page?: string;
      limit?: string;
      pageSize?: string;
      sortBy?: string;
      sortOrder?: string;
      includeSummary?: string;
    };

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(2000, Number(query.pageSize || query.limit) || 50));
    const skip = (page - 1) * limit;

    const sortDirection = query.sortOrder === 'desc' ? 'desc' : 'asc';
    const sortBy = query.sortBy || 'employeeName';
    const orderBy: Prisma.EmployeeOrderByWithRelationInput = sortBy === 'employeeCode'
      ? { employeeCode: sortDirection }
      : sortBy === 'active'
        ? { isActive: sortDirection }
        : { fullName: sortDirection };

    let effectiveUnitId = query.unitId;

    if (request.admin?.role === 'UNIT_ADMIN') {
      if (request.admin?.assignedUnitId) {
        effectiveUnitId = request.admin.assignedUnitId;
      } else {
        return reply.status(200).send({
          employees: [],
          total: 0,
          page,
          limit
        });
      }
    }

    const conditions: Prisma.EmployeeWhereInput[] = [currentOperationalRecordWhere() as Prisma.EmployeeWhereInput];

    if (query.departmentName) {
      const depts = await fastify.prisma.department.findMany({
        where: {
          name: { equals: query.departmentName.trim(), mode: 'insensitive' },
          ...(effectiveUnitId ? { unitId: effectiveUnitId } : {})
        },
        select: { id: true }
      });
      conditions.push({ departmentId: { in: depts.map((d) => d.id) } });
    } else if (query.departmentId) {
      const targetDept = await fastify.prisma.department.findUnique({
        where: { id: query.departmentId },
        select: { name: true, unitId: true }
      });

      if (!targetDept) {
        conditions.push({ departmentId: query.departmentId });
      } else if (!effectiveUnitId) {
        // Across All Units, match all sister departments with the same name
        const sisterDepts = await fastify.prisma.department.findMany({
          where: { name: { equals: targetDept.name, mode: 'insensitive' } },
          select: { id: true }
        });
        conditions.push({ departmentId: { in: sisterDepts.map((d) => d.id) } });
      } else if (targetDept.unitId === effectiveUnitId) {
        conditions.push({ departmentId: query.departmentId });
      } else {
        // Department belongs to another unit; match the sister department in the requested unit if one exists
        const matchingSister = await fastify.prisma.department.findFirst({
          where: {
            name: { equals: targetDept.name, mode: 'insensitive' },
            unitId: effectiveUnitId
          },
          select: { id: true }
        });
        conditions.push({ departmentId: matchingSister ? matchingSister.id : query.departmentId });
      }
    }

    const normalizedSearch = query.search?.trim();
    if (normalizedSearch) {
      const term = escapeRegexLiteral(normalizedSearch);
      // Workstation labels live on Seat rather than Employee. Resolve them
      // server-side so text search stays within the complete filter/RBAC scope.
      const matchingSearchSeats = await fastify.prisma.seat.findMany({
        where: {
          employeeId: { not: null },
          label: { contains: term, mode: 'insensitive' }
        },
        select: { employeeId: true }
      });
      const searchSeatEmployeeIds = matchingSearchSeats
        .map((seat) => seat.employeeId)
        .filter(Boolean) as string[];
      conditions.push({
        OR: [
          { fullName: { contains: term, mode: 'insensitive' } },
          { employeeCode: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { designation: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term, mode: 'insensitive' } },
          { pcNumber: { contains: term, mode: 'insensitive' } },
          { reportingTo: { contains: term, mode: 'insensitive' } },
          { reportingManager: { contains: term, mode: 'insensitive' } },
          { ext: { contains: term, mode: 'insensitive' } },
          { section: { contains: term, mode: 'insensitive' } },
          { id: { in: searchSeatEmployeeIds } }
        ]
      });
    }

    // ---------------------------------------------------------------------------
    // Resolve location & workstation filters via pre-queries to prevent MongoDB
    // aggregation $lookup/$size null errors on virtual 1:1 relation
    // ---------------------------------------------------------------------------
    if (effectiveUnitId) {
      const unitDepts = await fastify.prisma.department.findMany({
        where: { unitId: effectiveUnitId },
        select: { id: true }
      });
      const unitDeptIds = unitDepts.map((d) => d.id);
      // Department ownership is authoritative for employee tenancy. A seat
      // can temporarily be located in another Unit during a transfer or
      // because of legacy data; using seat location as an alternative here
      // leaks a foreign employee through search/list endpoints. Employees
      // without a department are intentionally not exposed to Unit Admins.
      conditions.push({
        departmentId: { in: unitDeptIds }
      });
    } else {
      // Global operational reads are scoped by authoritative Department -> Unit
      // ownership. This excludes orphan/synthetic records without relying on
      // employee-code prefixes, while keeping Plant optional for seating.
      const businessUnits = (await fastify.prisma.unit.findMany({ select: { id: true, code: true, lifecycleStatus: true } }))
        .filter((unit) => isBusinessUnit(unit));
      const businessDepartments = await fastify.prisma.department.findMany({
        where: {
          OR: [
            { unitId: { in: businessUnits.map((unit) => unit.id) } },
            { unitId: null },
            { unitId: { isSet: false } }
          ]
        },
        select: { id: true }
      });
      conditions.push({ departmentId: { in: businessDepartments.map((department) => department.id) } });
    }

    const hasLocationFilter = Boolean(
      query.plantId ||
      query.areaId ||
      query.buildingId ||
      (query.buildingName && query.buildingName.trim() !== '' && query.buildingName.trim() !== 'ALL') ||
      query.floorId ||
      (query.floorName && query.floorName.trim() !== '' && query.floorName.trim() !== 'ALL')
    );

    let locationFloorIds: string[] | null = null;
    let selectedArea: { floorId: string; name: string } | null = null;
    if (hasLocationFilter) {
      if (query.areaId) {
        const area = await fastify.prisma.area.findUnique({
          where: { id: query.areaId },
          select: { floorId: true, name: true }
        });
        selectedArea = area;
        const areaFloor = area ? await fastify.prisma.floor.findUnique({
          where: { id: area.floorId }, select: { buildingId: true }
        }) : null;
        locationFloorIds = areaFloor &&
          (!query.floorId || query.floorId === area!.floorId) &&
          (!query.buildingId || query.buildingId === areaFloor.buildingId)
          ? [area!.floorId] : [];
      } else if (query.floorId) {
        const floor = await fastify.prisma.floor.findUnique({
          where: { id: query.floorId }, select: { buildingId: true }
        });
        locationFloorIds = floor && (!query.buildingId || floor.buildingId === query.buildingId) ? [query.floorId] : [];
      } else {
        const floorWhere: Prisma.FloorWhereInput = {};
        if (query.floorName && query.floorName.trim() !== '' && query.floorName.trim() !== 'ALL') {
          const fn = query.floorName.trim();
          floorWhere.OR = [
            { name: fn },
            { name: { equals: fn, mode: 'insensitive' } }
          ];
        }
        if (query.buildingId) {
          floorWhere.buildingId = query.buildingId;
        }
        if (query.buildingName && query.buildingName.trim() !== '' && query.buildingName.trim() !== 'ALL') {
          const bn = query.buildingName.trim();
          floorWhere.building = {
            OR: [
              { name: bn },
              { name: { equals: bn, mode: 'insensitive' } }
            ]
          };
        }
        if (query.plantId) {
          floorWhere.building = { ...(floorWhere.building as any), plantId: query.plantId };
        }
        const matchingFloors = await fastify.prisma.floor.findMany({
          where: floorWhere,
          select: { id: true }
        });
        locationFloorIds = matchingFloors.map((f) => f.id);
      }
    }

    const hasSeatFilters = Boolean(locationFloorIds !== null || query.wsNo);
    if (hasSeatFilters) {
      const seatWhere: Prisma.SeatWhereInput = {
        employeeId: { not: null }
      };
      if (locationFloorIds !== null) {
        seatWhere.floorId = { in: locationFloorIds };
      }
      if (query.wsNo) {
        seatWhere.label = { contains: escapeRegexLiteral(query.wsNo.trim()), mode: 'insensitive' };
      }
      if (query.areaId) {
        // A master Area ID is authoritative. Legacy seats may retain only the
        // exact officeArea name, which is safe to use on this Area's own floor.
        // Employee.officeArea is intentionally not used here: it has no
        // reliable building/floor relation.
        seatWhere.OR = selectedArea
          ? [
              { areaId: query.areaId },
              { officeArea: { equals: selectedArea.name, mode: 'insensitive' } }
            ]
          : [{ areaId: query.areaId }];
      }
      const matchingSeats = await fastify.prisma.seat.findMany({
        where: seatWhere,
        select: { employeeId: true }
      });
      const seatedEmployeeIds = matchingSeats.map((s) => s.employeeId).filter(Boolean) as string[];
      conditions.push({ id: { in: seatedEmployeeIds } });
    }

    if (query.empCode) {
      conditions.push({
        employeeCode: { contains: escapeRegexLiteral(query.empCode.trim()), mode: 'insensitive' }
      });
    }

    if (query.name) {
      conditions.push({
        fullName: { contains: escapeRegexLiteral(query.name.trim()), mode: 'insensitive' }
      });
    }

    if (query.section && query.section.trim() !== '' && query.section.trim() !== 'ALL') {
      const sec = query.section.trim();
      conditions.push({
        OR: [
          { section: sec },
          { section: { equals: sec, mode: 'insensitive' } }
        ]
      });
    }

    if (query.sectionId && query.sectionId !== 'ALL') {
      const selectedSection = await fastify.prisma.section.findUnique({
        where: { id: query.sectionId },
        select: { id: true, name: true, departmentId: true }
      });
      if (!selectedSection) {
        conditions.push({ sectionId: query.sectionId });
      } else {
        conditions.push({
          OR: [
            { sectionId: selectedSection.id },
            { section: { equals: selectedSection.name, mode: 'insensitive' } }
          ]
        });
        conditions.push({ departmentId: selectedSection.departmentId });
      }
    }

    if (query.functionName && query.functionName.trim() !== '' && query.functionName.trim() !== 'ALL') {
      const fn = query.functionName.trim();
      conditions.push({
        OR: [
          { functionName: fn },
          { functionName: { equals: fn, mode: 'insensitive' } }
        ]
      });
    }

    if (query.functionId && query.functionId !== 'ALL') {
      const selectedFunction = await fastify.prisma.orgFunction.findUnique({
        where: { id: query.functionId },
        select: { id: true, name: true, sectionId: true, section: { select: { name: true } } }
      });
      if (!selectedFunction) {
        conditions.push({ functionId: query.functionId });
      } else {
        conditions.push({
          OR: [
            { functionId: selectedFunction.id },
            { functionName: { equals: selectedFunction.name, mode: 'insensitive' } }
          ]
        });
        conditions.push({
          OR: [
            { sectionId: selectedFunction.sectionId },
            { section: { equals: selectedFunction.section.name, mode: 'insensitive' } }
          ]
        });
      }
    }

    if (
      (query.reportingManager && query.reportingManager.trim() !== '' && query.reportingManager.trim() !== 'ALL') ||
      (query.reportingTo && query.reportingTo.trim() !== '' && query.reportingTo.trim() !== 'ALL')
    ) {
      const rep = (query.reportingManager || query.reportingTo)!.trim();
      conditions.push({
        OR: [
          { reportingTo: rep },
          { reportingTo: { equals: rep, mode: 'insensitive' } },
          { reportingManager: rep },
          { reportingManager: { equals: rep, mode: 'insensitive' } }
        ]
      });
    }

    if (query.hod && query.hod.trim() !== '' && query.hod.trim() !== 'ALL') {
      const h = query.hod.trim();
      conditions.push({
        OR: [
          { hod: h },
          { hod: { equals: h, mode: 'insensitive' } }
        ]
      });
    }

    if (query.ext && query.ext.trim() !== '' && query.ext.trim() !== 'ALL') {
      conditions.push({
        ext: { equals: query.ext.trim(), mode: 'insensitive' }
      });
    }

    const activeVal = query.isActive ?? query.active;
    if (activeVal !== undefined && activeVal !== '' && activeVal !== 'ALL') {
      const isActive = activeVal === 'true' || activeVal === 'active';
      conditions.push({ isActive });
    }

    if (query.officeArea && query.officeArea.trim() !== '' && query.officeArea.trim() !== 'ALL') {
      const area = query.officeArea.trim();
      const matchingSeats = await fastify.prisma.seat.findMany({
        where: {
          OR: [
            { officeArea: area },
            { officeArea: { equals: area, mode: 'insensitive' } }
          ],
          employeeId: { not: null }
        },
        select: { employeeId: true }
      });
      const seatedIds = matchingSeats.map((s) => s.employeeId).filter(Boolean) as string[];
      conditions.push({
        OR: [
          { officeArea: area },
          { officeArea: { equals: area, mode: 'insensitive' } },
          { id: { in: seatedIds } }
        ]
      });
    }

    if (query.subLocation) {
      conditions.push({
        subLocation: { equals: query.subLocation.trim(), mode: 'insensitive' }
      });
    }

    if (query.pcNumber) {
      const escapedPcNumber = escapeRegexLiteral(query.pcNumber.trim());
      const pcSeats = await fastify.prisma.seat.findMany({
        where: {
          pcNumber: { contains: escapedPcNumber, mode: 'insensitive' },
          employeeId: { not: null }
        },
        select: { employeeId: true }
      });
      const seatedPcIds = pcSeats.map((s) => s.employeeId).filter(Boolean) as string[];
      conditions.push({
        OR: [
          { pcNumber: { contains: escapedPcNumber, mode: 'insensitive' } },
          { id: { in: seatedPcIds } }
        ]
      });
    }

    const normalizedStatus = query.status ? query.status.toLowerCase() : undefined;
    const isAssigned = normalizedStatus === 'assigned' || query.assigned === 'true';
    const isUnassigned = normalizedStatus === 'unassigned' || query.assigned === 'false';
    if (isAssigned && !hasSeatFilters) {
      const allSeated = await fastify.prisma.seat.findMany({
        where: { employeeId: { not: null } },
        select: { employeeId: true }
      });
      const seatedIds = allSeated.map((s) => s.employeeId).filter(Boolean) as string[];
      conditions.push({ id: { in: seatedIds } });
    } else if (isUnassigned) {
      if (hasSeatFilters) {
        // Physical filters describe an occupied workstation. Unassigned
        // employees have no physical seat relation, so this is a legitimate
        // empty intersection rather than competing in/notIn predicates.
        conditions.push({ id: { in: [] } });
      } else {
        const allSeated = await fastify.prisma.seat.findMany({
          where: { employeeId: { not: null } },
          select: { employeeId: true }
        });
        const seatedIds = allSeated.map((s) => s.employeeId).filter(Boolean) as string[];
        conditions.push({ id: { notIn: seatedIds } });
      }
    }

    // The Floor Plan's assignment picker must not offer employees currently
    // in the transfer workflow.  Keep this opt-in so existing employee lists
    // retain their current reporting semantics.
    if (query.seatEligible === 'true') {
      const pendingTransfers = await fastify.prisma.seatTransferRequest.findMany({
        where: { status: 'PENDING_TARGET_ADMIN' },
        select: { employeeId: true }
      });
      conditions.push({
        id: { notIn: pendingTransfers.map((request) => request.employeeId) }
      });
      conditions.push({ isActive: true });
    }

    const where: Prisma.EmployeeWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    const [total, employees] = await Promise.all([
      fastify.prisma.employee.count({ where }),
      fastify.prisma.employee.findMany({
        where,
        skip,
        take: limit,
        include: {
          department: {
            include: {
              unit: { select: { id: true, name: true, code: true } }
            }
          },
          seat: {
            select: {
              id: true,
              label: true,
              pcNumber: true,
              officeArea: true,
              floorId: true,
              floor: {
                select: {
                  id: true,
                  name: true,
                  floorNumber: true,
                  buildingId: true,
                  building: {
                    select: {
                      id: true,
                      name: true,
                      code: true,
                      unitId: true,
                      plantId: true,
                    }
                  }
                }
              }
            }
          }
        },
        orderBy
      })
    ]);

    const plantIds = [...new Set(employees.map((emp) => emp.seat?.floor?.building?.plantId).filter(Boolean))] as string[];
    const optionalPlants = plantIds.length > 0
      ? await fastify.prisma.plant.findMany({ where: { id: { in: plantIds } }, select: { id: true, name: true, code: true } })
      : [];
    const plantById = new Map(optionalPlants.map((plant) => [plant.id, plant]));

    const resolvedEmployees = employees.map((emp) => {
      const seatFloor = emp.seat?.floor;
      const seatBuilding = seatFloor?.building;
      const seatPlant = seatBuilding?.plantId ? plantById.get(seatBuilding.plantId) || null : null;
      const deptUnit = emp.department?.unit;

      const resolvedUnit = deptUnit || null;
      const resolvedPlant = seatPlant ? { id: seatPlant.id, name: seatPlant.name, code: seatPlant.code } : null;
      const resolvedBuilding = seatBuilding ? { id: seatBuilding.id, name: seatBuilding.name, code: seatBuilding.code } : null;
      const resolvedFloor = seatFloor ? { id: seatFloor.id, name: seatFloor.name, floorNumber: seatFloor.floorNumber } : null;

      return {
        ...emp,
        ext: emp.ext || null,
        section: emp.section || null,
        functionName: emp.functionName || null,
        grade: emp.grade || null,
        reportingManager: emp.reportingManager ?? emp.reportingTo ?? null,
        reportingTo: emp.reportingTo ?? emp.reportingManager ?? null,
        hod: emp.hod || null,
        officeArea: emp.officeArea || emp.seat?.officeArea || null,
        operationalState: operationalRecordClassification(emp.operationalState),
        unit: resolvedUnit,
        plant: resolvedPlant,
        building: resolvedBuilding,
        floor: resolvedFloor
      };
    });

    let summary: { total: number; active: number; seated: number; unseated: number } | undefined;
    if (query.includeSummary === 'true') {
      const [active, matchingEmployees] = await Promise.all([
        fastify.prisma.employee.count({ where: { AND: [...conditions, { isActive: true }] } }),
        fastify.prisma.employee.findMany({ where, select: { id: true } })
      ]);
      const matchingIds = matchingEmployees.map((employee) => employee.id);
      const seated = matchingIds.length === 0
        ? 0
        : (await fastify.prisma.seat.findMany({
            where: { employeeId: { in: matchingIds } },
            select: { employeeId: true }
          })).length;
      summary = { total, active, seated, unseated: Math.max(0, total - seated) };
    }

    return reply.status(200).send({
      employees: resolvedEmployees,
      total,
      page,
      limit,
      ...(summary ? { summary } : {})
    });
  });

  // GET /api/employees/filter-options
  fastify.get('/filter-options', async (request, reply) => {
    const query = (request.query as any) || {};
    let effectiveUnitId: string | undefined = query.unitId && query.unitId !== 'ALL' ? query.unitId : undefined;

    // Keep the existing safe Unit Admin behavior: a manually supplied foreign
    // unit is ignored and the response remains inside the assigned Unit.
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      if (request.admin?.assignedUnitId) effectiveUnitId = request.admin.assignedUnitId;
      else {
        return reply.status(200).send({
          units: [],
          buildings: [],
          floors: [],
          officeAreas: [],
          areaOptions: [],
          departments: [],
          sections: [],
          sectionOptions: [],
          functions: [],
          functionOptions: [],
          reportingToList: [],
          hods: [],
          subLocations: [],
          userScope: {
            role: request.admin?.role || 'UNIT_ADMIN',
            isRestricted: true,
            lockedUnitId: null,
            assignedUnitName: null
          }
        });
      }
    }

    const units = await fastify.prisma.unit.findMany({
      where: effectiveUnitId ? { id: effectiveUnitId } : unitSelectorWhere(),
      select: { id: true, name: true, code: true, location: true },
      orderBy: { name: 'asc' }
    });
    const authorizedUnitIds = effectiveUnitId ? [effectiveUnitId] : units.map((unit) => unit.id);

    if (authorizedUnitIds.length === 0) {
      return reply.status(200).send({
        units,
        buildings: [],
        floors: [],
        officeAreas: [],
        areaOptions: [],
        departments: [],
        sections: [],
        sectionOptions: [],
        functions: [],
        functionOptions: [],
        reportingToList: [],
        hods: [],
        subLocations: [],
        userScope: {
          role: request.admin?.role || 'UNIT_ADMIN',
          isRestricted: request.admin?.role === 'UNIT_ADMIN',
          lockedUnitId: request.admin?.assignedUnitId || null,
          assignedUnitName: null
        }
      });
    }

    const selectedOrgDepartment = query.departmentId && query.departmentId !== 'ALL' ? query.departmentId : undefined;
    const selectedOrgSectionId = query.sectionId && query.sectionId !== 'ALL' ? query.sectionId : undefined;
    const selectedOrgFunctionId = query.functionId && query.functionId !== 'ALL' ? query.functionId : undefined;
    const selectedOrgSection = selectedOrgSectionId
      ? await fastify.prisma.section.findUnique({ where: { id: selectedOrgSectionId }, select: { name: true } }) : null;
    const selectedOrgFunction = selectedOrgFunctionId
      ? await fastify.prisma.orgFunction.findUnique({ where: { id: selectedOrgFunctionId }, select: { name: true } }) : null;
    const hasOrgSelection = Boolean(selectedOrgDepartment || selectedOrgSectionId || selectedOrgFunctionId);
    const orgDepartmentRows = hasOrgSelection ? await fastify.prisma.department.findMany({
      where: { unitId: { in: authorizedUnitIds } }, select: { id: true, name: true, unitId: true }
    }) : [];
    const selectedOrgDepartmentRow = selectedOrgDepartment
      ? await fastify.prisma.department.findUnique({ where: { id: selectedOrgDepartment }, select: { name: true, unitId: true } }) : null;
    const matchingOrgDepartmentIds = selectedOrgDepartmentRow && !effectiveUnitId
      ? orgDepartmentRows.filter((department) => department.name.trim().toLowerCase() === selectedOrgDepartmentRow.name.trim().toLowerCase()).map((department) => department.id)
      : selectedOrgDepartmentRow && selectedOrgDepartmentRow.unitId !== effectiveUnitId
        ? orgDepartmentRows.filter((department) => department.unitId === effectiveUnitId && department.name.trim().toLowerCase() === selectedOrgDepartmentRow.name.trim().toLowerCase()).map((department) => department.id)
        : selectedOrgDepartment ? [selectedOrgDepartment] : [];
    const orgEmployees = hasOrgSelection ? await fastify.prisma.employee.findMany({
      where: {
        departmentId: { in: orgDepartmentRows.map((department) => department.id) },
        ...currentOperationalRecordWhere()
      },
      select: { id: true, departmentId: true, sectionId: true, section: true, functionId: true, functionName: true }
    }) : [];
    const matchingOrgEmployeeIds = new Set(orgEmployees.filter((employee) =>
      (!selectedOrgDepartment || matchingOrgDepartmentIds.includes(employee.departmentId)) &&
      (!selectedOrgSectionId || employee.sectionId === selectedOrgSectionId || Boolean(selectedOrgSection && employee.section?.trim().toLowerCase() === selectedOrgSection.name.trim().toLowerCase())) &&
      (!selectedOrgFunctionId || employee.functionId === selectedOrgFunctionId || Boolean(selectedOrgFunction && employee.functionName?.trim().toLowerCase() === selectedOrgFunction.name.trim().toLowerCase()))
    ).map((employee) => employee.id));
    const orgSeats = hasOrgSelection ? await fastify.prisma.seat.findMany({
      where: { employeeId: { in: [...matchingOrgEmployeeIds] } }, select: { floorId: true, areaId: true, officeArea: true }
    }) : [];
    const orgFloorIds = new Set(orgSeats.map((seat) => seat.floorId));
    const orgBuildingIds = hasOrgSelection ? new Set((await fastify.prisma.floor.findMany({
      where: { id: { in: [...orgFloorIds] } }, select: { buildingId: true }
    })).map((floor) => floor.buildingId)) : null;

    const buildings = await fastify.prisma.building.findMany({
      where: {
        isActive: true,
        ...buildingUnitWhere(authorizedUnitIds),
        ...(orgBuildingIds ? { id: { in: [...orgBuildingIds, ...(query.buildingId ? [query.buildingId] : [])] } } : {})
      },
      select: { id: true, name: true, code: true, unitId: true, plantId: true, plant: { select: { unitId: true } } },
      orderBy: { name: 'asc' }
    });
    const allBuildingIds = buildings.map((building) => building.id);
    const selectedBuildingId = query.buildingId && query.buildingId !== 'ALL' ? query.buildingId : undefined;
    const filterBuildingIds = selectedBuildingId ? allBuildingIds.filter((id) => id === selectedBuildingId) : allBuildingIds;

    const allFloors = await fastify.prisma.floor.findMany({
      where: {
        isActive: true,
        buildingId: { in: filterBuildingIds },
        ...(hasOrgSelection ? { id: { in: [...orgFloorIds, ...(query.floorId ? [query.floorId] : [])] } } : {})
      },
      select: { id: true, name: true, floorNumber: true, buildingId: true },
      orderBy: { floorNumber: 'asc' }
    });
    const visibleFloorIds = Array.from(new Set(
      (await fastify.prisma.seat.findMany({
        where: { floorId: { in: allBuildingIds.length > 0 ? allFloors.map((floor) => floor.id) : [] } },
        select: { floorId: true }
      })).map((seat) => seat.floorId).filter(Boolean)
    ));
    const buildingPlantIds = [...new Set(buildings.map((building) => building.plantId).filter(Boolean))] as string[];
    const plantUnitById = new Map((await fastify.prisma.plant.findMany({
      where: { id: { in: buildingPlantIds } },
      select: { id: true, unitId: true }
    })).map((plant) => [plant.id, plant.unitId]));
    const unitsById = new Map(units.map((unit) => [unit.id, unit.name]));
    const fallbackUnitId = authorizedUnitIds.length === 1 ? authorizedUnitIds[0] : undefined;
    const buildingById = new Map(buildings.map((building) => [building.id, building]));
    const floors = allFloors
      .filter((floor) => visibleFloorIds.includes(floor.id))
      .map((floor) => {
        const building = buildingById.get(floor.buildingId);
        const unitId = building?.unitId || (building?.plantId && plantUnitById.get(building.plantId)) || fallbackUnitId;
        return {
        ...floor,
        buildingName: building?.name || null,
        unitName: (unitId && unitsById.get(unitId)) || null,
        displayName: [unitId && unitsById.get(unitId), building?.name, floor.name]
          .filter(Boolean)
          .join(' → ')
        };
      });
    const selectedFloorId = query.floorId && query.floorId !== 'ALL' ? query.floorId : undefined;
    const areaFloorIds = selectedFloorId
      ? floors.map((floor) => floor.id).filter((id) => id === selectedFloorId)
      : floors.map((floor) => floor.id);

    const areaRows = await fastify.prisma.area.findMany({
      where: { isActive: true, floorId: { in: areaFloorIds } },
      select: { id: true, name: true, floorId: true, isActive: true },
      orderBy: { name: 'asc' }
    });
    const floorInfoById = new Map(allFloors.map((floor) => {
      const building = buildingById.get(floor.buildingId);
      const unitId = building?.unitId || (building?.plantId && plantUnitById.get(building.plantId)) || fallbackUnitId;
      return [floor.id, {
        floorName: floor.name,
        buildingName: building?.name || null,
        unitName: (unitId && unitsById.get(unitId)) || null
      }];
    }));
    const rawAreaOptions = hasOrgSelection ? areaRows.filter((area) => orgSeats.some((seat) =>
      seat.floorId === area.floorId && (seat.areaId === area.id || seat.officeArea?.trim().toLowerCase() === area.name.trim().toLowerCase()))) : areaRows;
    const areaOptions = rawAreaOptions.map((area) => {
      const floorInfo = floorInfoById.get(area.floorId);
      return {
        ...area,
        displayName: [
          floorInfo?.unitName,
          floorInfo?.buildingName,
          floorInfo?.floorName,
          area.name
        ].filter(Boolean).join(' → ')
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const areaSeats = await fastify.prisma.seat.findMany({
      where: { floorId: { in: areaFloorIds }, officeArea: { not: null },
        ...(hasOrgSelection ? { employeeId: { in: [...matchingOrgEmployeeIds] } } : {}) },
      select: { officeArea: true },
      distinct: ['officeArea']
    });

    // A physical selection can only represent employees assigned to matching
    // seats. Keep unseated employees in the Unit-only scope.
    const hasPhysicalSelection = Boolean(selectedBuildingId || selectedFloorId || query.areaId || query.officeArea);
    const selectedArea = query.areaId && query.areaId !== 'ALL'
      ? await fastify.prisma.area.findUnique({ where: { id: query.areaId }, select: { floorId: true, name: true } })
      : null;
    const physicalSeats = hasPhysicalSelection ? await fastify.prisma.seat.findMany({
      where: {
        floorId: { in: selectedArea ? areaFloorIds.filter((id) => id === selectedArea.floorId) : areaFloorIds },
        employeeId: { not: null },
        ...(query.areaId ? { OR: selectedArea ? [
          { areaId: query.areaId },
          { officeArea: { equals: selectedArea.name, mode: 'insensitive' } }
        ] : [{ areaId: query.areaId }] } : {}),
        ...(query.officeArea && query.officeArea !== 'ALL'
          ? { officeArea: { equals: query.officeArea, mode: 'insensitive' } } : {})
      },
      select: { employeeId: true }
    }) : [];
    const physicalEmployeeIds = physicalSeats.map((seat) => seat.employeeId).filter((id): id is string => Boolean(id));
    const authorizedDepartments = await fastify.prisma.department.findMany({
      where: {
        isActive: true,
        unitId: { in: authorizedUnitIds }
      },
      select: { id: true, name: true, code: true, colorHex: true, unitId: true, isActive: true },
      orderBy: [{ code: 'asc' }, { name: 'asc' }]
    });
    const authorizedDepartmentIds = authorizedDepartments.map((department) => department.id);
    const representedEmployees = await fastify.prisma.employee.findMany({
      where: {
        departmentId: { in: authorizedDepartmentIds },
        ...currentOperationalRecordWhere(),
        ...(hasPhysicalSelection ? { id: { in: physicalEmployeeIds } } : {})
      },
      select: { departmentId: true, sectionId: true, functionId: true, section: true, functionName: true,
        reportingTo: true, reportingManager: true, hod: true, officeArea: true, subLocation: true,
        seat: { select: { officeArea: true } } }
    });
    const representedDepartmentIds = new Set(representedEmployees.map((employee) => employee.departmentId));
    const departments = authorizedDepartments.filter((department) => representedDepartmentIds.has(department.id));
    const departmentIds = departments.map((department) => department.id);
    const selectedDepartmentId = query.departmentId && query.departmentId !== 'ALL' ? query.departmentId : undefined;
    const filterDepartmentIds = selectedDepartmentId
      ? (departmentIds.includes(selectedDepartmentId) ? [selectedDepartmentId] : [])
      : departmentIds;

    const matchingEmployees = representedEmployees.filter((employee) => filterDepartmentIds.includes(employee.departmentId));
    const sectionIds = matchingEmployees.map((employee) => employee.sectionId).filter((id): id is string => Boolean(id));
    const sectionNames = matchingEmployees.map((employee) => employee.section?.trim().toLowerCase()).filter(Boolean);
    const departmentById = new Map(authorizedDepartments.map((department) => [department.id, department]));
    const rawSectionOptions = (await fastify.prisma.section.findMany({
      where: { isActive: true, departmentId: { in: filterDepartmentIds } },
      select: { id: true, name: true, departmentId: true, isActive: true },
      orderBy: { name: 'asc' }
    })).filter((section) => sectionIds.includes(section.id) || sectionNames.includes(section.name.trim().toLowerCase()));
    const sectionOptions = rawSectionOptions.map((section) => {
      const dept = departmentById.get(section.departmentId);
      return {
        ...section,
        displayName: [dept?.name, section.name].filter(Boolean).join(' → ')
      };
    }).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    const selectedSectionId = query.sectionId && query.sectionId !== 'ALL' ? query.sectionId : undefined;
    const selectedSectionName = sectionOptions.find((section) => section.id === selectedSectionId)?.name.trim().toLowerCase();
    const matchingFunctionEmployees = selectedSectionId
      ? matchingEmployees.filter((employee) => employee.sectionId === selectedSectionId ||
          Boolean(selectedSectionName && employee.section?.trim().toLowerCase() === selectedSectionName))
      : matchingEmployees;
    const functionIds = matchingFunctionEmployees.map((employee) => employee.functionId).filter((id): id is string => Boolean(id));
    const functionNames = matchingFunctionEmployees.map((employee) => employee.functionName?.trim().toLowerCase()).filter(Boolean);
    const sectionById = new Map(sectionOptions.map((section) => [section.id, section]));
    const rawFunctionOptions = (await fastify.prisma.orgFunction.findMany({
      where: {
        isActive: true,
        sectionId: selectedSectionId
          ? { in: [selectedSectionId] }
          : { in: sectionOptions.map((section) => section.id) }
      },
      select: { id: true, name: true, sectionId: true, isActive: true },
      orderBy: { name: 'asc' }
    })).filter((fn) => functionIds.includes(fn.id) || functionNames.includes(fn.name.trim().toLowerCase()));
    const functionOptions = rawFunctionOptions.map((fn) => {
      const section = sectionById.get(fn.sectionId);
      const dept = section ? departmentById.get(section.departmentId) : null;
      return {
        ...fn,
        displayName: [dept?.name, section?.name, fn.name].filter(Boolean).join(' → ')
      };
    }).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    const employees = matchingEmployees.filter((employee) => !selectedSectionId ||
      employee.sectionId === selectedSectionId ||
      Boolean(selectedSectionName && employee.section?.trim().toLowerCase() === selectedSectionName));
    // Office/Area has both normalized workstation values and legacy employee
    // values.  The latter is still authoritative for unseated employees, so
    // returning only Seat.officeArea made a valid organizational selection
    // disappear whenever it had no occupied workstation.  Keep both sources
    // distinct in storage but expose their de-duplicated, human-readable union.
    const officeAreas = Array.from(new Set([
      ...areaSeats.map((seat) => seat.officeArea),
      ...employees.flatMap((employee) => hasPhysicalSelection
        ? [employee.seat?.officeArea]
        : [employee.officeArea, employee.seat?.officeArea])
    ].map((area) => area?.trim()).filter((area): area is string => Boolean(area && area !== '0' && area !== '#N/A'))
    )).sort((a, b) => a.localeCompare(b));
    const sections = Array.from(new Set(employees.map((employee) => employee.section?.trim()).filter(Boolean))).sort();
    const functions = Array.from(new Set(employees.map((employee) => employee.functionName?.trim()).filter(Boolean))).sort();
    const reportingToList = Array.from(new Set(employees.map((employee) => (employee.reportingManager || employee.reportingTo)?.trim()).filter(Boolean))).sort();
    const hods = Array.from(new Set(employees.map((employee) => employee.hod?.trim()).filter(Boolean))).sort();
    const subLocations = Array.from(new Set(employees.map((employee) => employee.subLocation?.trim()).filter(Boolean))).sort();
    const assignedUnitName = effectiveUnitId ? units.find((unit) => unit.id === effectiveUnitId)?.name || null : null;

    return reply.status(200).send({
      units,
      buildings: buildings.map((building) => ({
        id: building.id,
        name: building.name,
        code: building.code,
        unitId: unitIdFromBuilding(building) || ''
      })),
      floors,
      officeAreas,
      areaOptions,
      departments,
      sections,
      sectionOptions,
      functions,
      functionOptions,
      reportingToList,
      hods,
      subLocations,
      userScope: {
        role: request.admin?.role || 'UNIT_ADMIN',
        isRestricted: request.admin?.role === 'UNIT_ADMIN',
        lockedUnitId: request.admin?.assignedUnitId || null,
        assignedUnitName
      }
    });
  });

  // POST /api/employees
  fastify.post('/', async (request, reply) => {
    const parseResult = CreateEmployeeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;

    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Only Super Admin or Unit Admin can create employees'
      });
    }

    const { fullName, email, departmentId, buildingId, floorId, areaId, isActive } = parseResult.data;
    const employeeCode = normalizeEmpCode(parseResult.data.employeeCode);
    const emailVal = email && email.trim().length > 0 ? email.trim().toLowerCase() : null;

    const repManager = parseResult.data.reportingManager || parseResult.data.reportingTo;
    if (repManager && fullName && repManager.trim().toLowerCase() === fullName.trim().toLowerCase()) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'An employee cannot be their own Reporting Manager'
      });
    }

    if (parseResult.data.hod && fullName && parseResult.data.hod.trim().toLowerCase() === fullName.trim().toLowerCase()) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'An employee cannot be their own Department Head (HOD)'
      });
    }

    // Employee-code uniqueness is global and intentionally checked before
    // location authorization. Do not reveal the existing employee's scope.
    const existingCode = await fastify.prisma.employee.findFirst({
      where: { employeeCode: { equals: employeeCode, mode: 'insensitive' } },
      select: { id: true }
    });
    if (existingCode) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Employee code already exists'
      });
    }

    const dept = await fastify.prisma.department.findUnique({
      where: { id: departmentId }
    });
    if (!dept) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Department not found'
      });
    }

    // Strict Unit-Level Multi-Tenancy Isolation
    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN') {
      if (!userUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Admin is not assigned to any Unit'
        });
      }
      if (!dept.unitId || dept.unitId !== userUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You can only create employees within your assigned Unit'
        });
      }
    }

    const effectiveUnitId = parseResult.data.unitId || dept.unitId || undefined;
    // Older super-admin API clients did not send a Unit and may target legacy
    // departments without a unitId. New UI requests always send the explicit
    // Unit, while Unit Admin requests must remain strictly unit-scoped.
    if (effectiveUnitId || userRole === 'UNIT_ADMIN') {
      const hierarchy = await validateEmployeeHierarchy(fastify.prisma, request.admin, {
        unitId: effectiveUnitId,
        buildingId,
        floorId,
        areaId,
        departmentId,
        sectionId: parseResult.data.sectionId,
        functionId: parseResult.data.functionId,
        officeArea: parseResult.data.officeArea,
        seatId: parseResult.data.seatId
      });
      if (!hierarchy.valid) {
        return reply.status(hierarchy.statusCode).send({
          statusCode: hierarchy.statusCode,
          error: hierarchy.statusCode === 403 ? 'Forbidden' : hierarchy.statusCode === 409 ? 'Conflict' : 'Bad Request',
          message: hierarchy.message
        });
      }
    }

    if (emailVal) {
      const existingEmail = await fastify.prisma.employee.findUnique({
        where: { email: emailVal }
      });
      if (existingEmail) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Employee email already exists'
        });
      }
    }

    const {
      designation,
      grade,
      phone,
      ext,
      section,
      sectionId,
      functionName,
      functionId,
      reportingManager,
      reportingTo,
      hod,
      remarks,
      pcNumber,
      officeArea,
      subLocation,
      seatId
    } = parseResult.data;

    let employee: any;
    try {
      employee = await fastify.prisma.$transaction(async (tx) => {
        const created = await tx.employee.create({
          data: {
            employeeCode,
            fullName,
            email: emailVal,
            departmentId,
            designation: designation ? designation.trim() : null,
            grade: grade ? grade.trim() : null,
            phone: phone ? phone.trim() : null,
            ext: ext ? ext.trim() : null,
            section: section ? section.trim() : null,
            sectionId: sectionId || null,
            functionName: functionName ? functionName.trim() : null,
            functionId: functionId || null,
            reportingManager: reportingManager ? reportingManager.trim() : (reportingTo ? reportingTo.trim() : null),
            reportingTo: reportingTo ? reportingTo.trim() : (reportingManager ? reportingManager.trim() : null),
            hod: hod ? hod.trim() : null,
            remarks: remarks ? remarks.trim() : null,
            pcNumber: pcNumber ? pcNumber.trim() : null,
            officeArea: officeArea ? officeArea.trim() : null,
            subLocation: subLocation ? subLocation.trim() : null,
            isActive: isActive !== undefined ? isActive : true
          },
          include: { department: true }
        });

        if (seatId) {
          const seat = await tx.seat.findUnique({
            where: { id: seatId },
            include: { floor: { include: { building: { include: { unit: true, plant: true } } } } }
          });
          if (!seat) {
            throw new Error('NOT_FOUND: Workstation not found');
          }
          if (seat.employeeId) {
            throw new Error('CONFLICT: Workstation is already occupied');
          }
          if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN') {
            const seatUnitId = unitIdFromBuilding(seat.floor?.building);
            if (seatUnitId && seatUnitId !== userUnitId) {
              throw new Error('FORBIDDEN: You cannot assign workstations outside your assigned Unit');
            }
          }
          await tx.seat.update({
            where: { id: seatId },
            data: {
              employeeId: created.id,
              departmentId: created.departmentId,
              pcNumber: created.pcNumber || seat.pcNumber,
              status: 'AVAILABLE'
            }
          });
        }

        return created;
      });
    } catch (err: any) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        const metaTarget = String((err as any).meta?.target || '');
        const isCode = metaTarget.includes('employeeCode') || metaTarget.includes('employee_code') || err.message?.includes('employeeCode') || err.message?.includes('employee_code');
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: isCode ? 'Employee code already exists' : 'Employee email already exists'
        });
      }
      if (err.message?.startsWith('NOT_FOUND')) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: err.message });
      }
      if (err.message?.startsWith('CONFLICT')) {
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: err.message });
      }
      if (err.message?.startsWith('FORBIDDEN')) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: err.message });
      }
      throw err;
    }

    await logAudit(fastify.prisma, request, 'EMPLOYEE_CREATED', 'Employee', employee.id, {
      employeeCode: employee.employeeCode,
      fullName: employee.fullName,
      email: employee.email,
      departmentId: employee.departmentId,
      pcNumber: employee.pcNumber,
      seatId: seatId || null
    });

    return reply.status(201).send(employee);
  });

  // GET /api/employees/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const emp = await fastify.prisma.employee.findUnique({
      where: { id },
      include: {
        department: true,
        seat: {
          select: {
            id: true,
            label: true,
            pcNumber: true,
            officeArea: true,
            floor: {
              select: {
                id: true,
                name: true,
                building: {
                  select: {
                    name: true,
                          unit: { select: { id: true, name: true } },
                          plant: { select: { name: true, unit: { select: { id: true, name: true } } } }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!emp) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Employee not found'
      });
    }

    if (request.admin?.role === 'UNIT_ADMIN') {
      const employeeUnitId = emp.department?.unitId || unitIdFromBuilding(emp.seat?.floor?.building) || null;
      if (!employeeUnitId || employeeUnitId !== request.admin.assignedUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Unit Admins can only view employees within their assigned unit'
        });
      }
    }

    return reply.status(200).send(emp);
  });

  // PUT /api/employees/:id
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = UpdateEmployeeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;

    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Only Super Admin or Unit Admin can edit employees'
      });
    }

    const emp = await fastify.prisma.employee.findUnique({
      where: { id },
      include: {
        department: true,
        seat: { include: { floor: { include: { building: { include: { unit: true, plant: true } } } } } }
      }
    });
    if (!emp) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Employee not found'
      });
    }

    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN') {
      const currentEmpUnit = unitIdFromBuilding(emp.seat?.floor?.building) || emp.department?.unitId;
      if (!currentEmpUnit || currentEmpUnit !== userUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You can only edit employees within your assigned Unit'
        });
      }
    }

    const { fullName, email, departmentId, isActive } = parseResult.data;
    const employeeCode = parseResult.data.employeeCode ? normalizeEmpCode(parseResult.data.employeeCode) : undefined;

    const effectiveFullName = fullName || emp.fullName;
    const repManager = parseResult.data.reportingManager || parseResult.data.reportingTo;
    if (repManager && effectiveFullName && repManager.trim().toLowerCase() === effectiveFullName.trim().toLowerCase()) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'An employee cannot be their own Reporting Manager'
      });
    }

    if (parseResult.data.hod && effectiveFullName && parseResult.data.hod.trim().toLowerCase() === effectiveFullName.trim().toLowerCase()) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'An employee cannot be their own Department Head (HOD)'
      });
    }

    if (employeeCode && employeeCode !== normalizeEmpCode(emp.employeeCode)) {
      const codeConflict = await fastify.prisma.employee.findFirst({
        where: { employeeCode: { equals: employeeCode, mode: 'insensitive' }, id: { not: id } },
        select: { id: true }
      });
      if (codeConflict) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Employee code already exists'
        });
      }
    }

    if (departmentId) {
      const dept = await fastify.prisma.department.findUnique({
        where: { id: departmentId }
      });
      if (!dept) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Department not found'
        });
      }
      if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN' && (!dept.unitId || dept.unitId !== userUnitId)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You can only assign departments within your assigned Unit'
        });
      }
    }

    const emailVal = email !== undefined ? (email && email.trim().length > 0 ? email.trim().toLowerCase() : null) : undefined;

    if (emailVal !== undefined && emailVal !== null && emailVal !== emp.email) {
      const emailConflict = await fastify.prisma.employee.findUnique({
        where: { email: emailVal }
      });
      if (emailConflict) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Employee email already exists'
        });
      }
    }

    const {
      designation,
      grade,
      phone,
      ext,
      section,
      sectionId,
      functionName,
      functionId,
      reportingManager,
      reportingTo,
      hod,
      remarks,
      pcNumber,
      officeArea,
      subLocation,
      seatId
    } = parseResult.data;

    const hierarchy = await validateEmployeeHierarchy(fastify.prisma, request.admin, {
      unitId: parseResult.data.unitId || emp.department?.unitId || null,
      buildingId: parseResult.data.buildingId || emp.seat?.floor?.building?.id || null,
      floorId: parseResult.data.floorId || emp.seat?.floorId || null,
      areaId: parseResult.data.areaId || null,
      departmentId: departmentId || emp.departmentId,
      sectionId: sectionId !== undefined ? sectionId : emp.sectionId,
      functionId: functionId !== undefined ? functionId : emp.functionId,
      officeArea: officeArea !== undefined ? officeArea : emp.officeArea,
      seatId: seatId !== undefined ? seatId : emp.seat?.id,
      currentEmployeeId: id
    });
    if (!hierarchy.valid) {
      return reply.status(hierarchy.statusCode).send({
        statusCode: hierarchy.statusCode,
        error: hierarchy.statusCode === 403 ? 'Forbidden' : hierarchy.statusCode === 409 ? 'Conflict' : 'Bad Request',
        message: hierarchy.message
      });
    }

    let updated: any;
    try {
      updated = await fastify.prisma.$transaction(async (tx) => {
        const deactivating = emp.isActive !== false && isActive === false;
        const updateData: any = {
          employeeCode: employeeCode ?? emp.employeeCode,
          fullName: fullName ?? emp.fullName,
          email: emailVal !== undefined ? emailVal : emp.email,
          departmentId: departmentId ?? emp.departmentId,
          isActive: isActive !== undefined ? isActive : emp.isActive
        };

        if (designation !== undefined) updateData.designation = designation ? designation.trim() : null;
        if (grade !== undefined) updateData.grade = grade ? grade.trim() : null;
        if (phone !== undefined) updateData.phone = phone ? phone.trim() : null;
        if (ext !== undefined) updateData.ext = ext ? ext.trim() : null;
        if (section !== undefined) updateData.section = section ? section.trim() : null;
        if (sectionId !== undefined) updateData.sectionId = sectionId || null;
        if (functionName !== undefined) updateData.functionName = functionName ? functionName.trim() : null;
        if (functionId !== undefined) updateData.functionId = functionId || null;
        if (reportingManager !== undefined) {
          updateData.reportingManager = reportingManager ? reportingManager.trim() : null;
          if (reportingTo === undefined) updateData.reportingTo = updateData.reportingManager;
        }
        if (reportingTo !== undefined) {
          updateData.reportingTo = reportingTo ? reportingTo.trim() : null;
          if (reportingManager === undefined) updateData.reportingManager = updateData.reportingTo;
        }
        if (hod !== undefined) updateData.hod = hod ? hod.trim() : null;
        if (remarks !== undefined) updateData.remarks = remarks ? remarks.trim() : null;
        if (pcNumber !== undefined) updateData.pcNumber = pcNumber ? pcNumber.trim() : null;
        if (officeArea !== undefined) updateData.officeArea = officeArea ? officeArea.trim() : null;
        if (subLocation !== undefined) updateData.subLocation = subLocation ? subLocation.trim() : null;

        const empUpdated = await tx.employee.update({
          where: { id },
          data: updateData,
          include: { department: true }
        });

        let autoRejectedTransferIds: string[] = [];
        let autoRejectionReason: string | null = null;

        // Deactivation must not leave an occupied workstation attached to an
        // employee who can no longer participate in seating workflows.
        // It must also automatically reject any active/pending transfer requests.
        if (deactivating) {
          const pendingTransfers = await tx.seatTransferRequest.findMany({
            where: {
              employeeId: id,
              status: { in: ['PENDING_TARGET_ADMIN'] }
            },
            select: { id: true, requestNumber: true, sourceAdminApproval: true }
          });

          if (pendingTransfers.length > 0) {
            autoRejectedTransferIds = pendingTransfers.map((r) => r.id);
            const adminIdentifier = request.admin?.name || request.admin?.email || 'Admin';
            autoRejectionReason = `Employee was inactivated during transfer by ${adminIdentifier}`;

            await tx.seatTransferRequest.updateMany({
              where: {
                employeeId: id,
                status: { in: ['PENDING_TARGET_ADMIN'] }
              },
              data: {
                status: 'REJECTED',
                activeTransferKey: { unset: true },
                rejectedByRole: userRole || 'ADMIN',
                rejectionReason: autoRejectionReason,
                targetAdminApproval: {
                  approvedById: request.admin?.id || null,
                  approverName: adminIdentifier,
                  adminRole: userRole || 'ADMIN',
                  action: 'REJECT',
                  comment: autoRejectionReason,
                  timestamp: new Date().toISOString()
                }
              }
            });

            // Auto-mark incoming pending notifications for this transfer request as read
            await tx.notification.updateMany({
              where: {
                transferRequestId: { in: autoRejectedTransferIds },
                type: { in: ['TRANSFER_PENDING', 'INCOMING_TRANSFER_REQUEST'] },
                OR: [{ readAt: null }, { readAt: { isSet: false } }]
              },
              data: {
                readAt: new Date()
              }
            });

            for (const pt of pendingTransfers) {
              const sourceAdminId = (pt.sourceAdminApproval as any)?.approvedById;
              if (sourceAdminId) {
                try {
                  await persistNotification(tx, {
                    transferRequestId: pt.id,
                    type: 'TRANSFER_REJECTED',
                    title: 'Transfer request rejected',
                    message: `Transfer request ${pt.requestNumber} was automatically rejected because the employee was deactivated.`,
                    recipientAdminId: sourceAdminId,
                    dedupeKey: `transfer:${pt.id}:rejected:${sourceAdminId}`
                  });
                } catch {
                  // Notification failure should not fail the deactivation transaction
                }
              }
            }
          }

          await tx.seat.updateMany({
            where: { employeeId: id },
            data: {
              employeeId: { unset: true },
              departmentId: null,
              status: 'AVAILABLE',
              pcNumber: null
            }
          });
        }

        // Handle seat allocation / reassignment
        if (seatId !== undefined && !deactivating) {
          if (!seatId) {
            // Release current seat
            await tx.seat.updateMany({
              where: { employeeId: id },
              data: {
                employeeId: { unset: true },
                departmentId: null,
                status: 'AVAILABLE',
                pcNumber: null
              }
            });
          } else {
            const currentSeat = await tx.seat.findFirst({ where: { employeeId: id } });
            if (currentSeat && currentSeat.id !== seatId) {
              await tx.seat.update({
                where: { id: currentSeat.id },
                data: { employeeId: { unset: true }, departmentId: null, status: 'AVAILABLE', pcNumber: null }
              });
            }

            const targetSeat = await tx.seat.findUnique({
              where: { id: seatId },
              include: { floor: { include: { building: { include: { unit: true, plant: true } } } } }
            });
            if (!targetSeat) throw new Error('NOT_FOUND: Workstation not found');
            if (targetSeat.employeeId && targetSeat.employeeId !== id) {
              throw new Error('CONFLICT: Workstation is already occupied');
            }
            if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN') {
              const seatUnitId = unitIdFromBuilding(targetSeat.floor?.building);
              if (seatUnitId && seatUnitId !== userUnitId) {
                throw new Error('FORBIDDEN: You cannot assign workstations outside your assigned Unit');
              }
            }

            await tx.seat.update({
              where: { id: seatId },
              data: {
                employeeId: id,
                departmentId: empUpdated.departmentId,
                pcNumber: empUpdated.pcNumber || targetSeat.pcNumber,
                status: 'AVAILABLE'
              }
            });
          }
        } else if (pcNumber !== undefined && !deactivating) {
          // If PC number was updated and employee occupies a seat, sync to seat
          await tx.seat.updateMany({
            where: { employeeId: id },
            data: { pcNumber: updateData.pcNumber }
          });
        }

        return {
          empUpdated,
          autoRejectedTransferIds,
          autoRejectionReason
        };
      });
    } catch (err: any) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        const metaTarget = String((err as any).meta?.target || '');
        const isCode = metaTarget.includes('employeeCode') || metaTarget.includes('employee_code') || err.message?.includes('employeeCode') || err.message?.includes('employee_code');
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: isCode ? 'Employee code already exists' : 'Employee email already exists'
        });
      }
      if (err.message?.startsWith('NOT_FOUND')) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: err.message });
      }
      if (err.message?.startsWith('CONFLICT')) {
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: err.message });
      }
      if (err.message?.startsWith('FORBIDDEN')) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: err.message });
      }
      throw err;
    }

    const auditMetadata: any = {
      employeeCode: updated.empUpdated.employeeCode,
      fullName: updated.empUpdated.fullName,
      email: updated.empUpdated.email,
      departmentId: updated.empUpdated.departmentId,
      pcNumber: updated.empUpdated.pcNumber,
      seatId: seatId !== undefined ? seatId : undefined
    };

    if (isActive !== undefined) {
      auditMetadata.isActive = updated.empUpdated.isActive;
    }

    if (updated.autoRejectedTransferIds && updated.autoRejectedTransferIds.length > 0) {
      auditMetadata.autoRejectedTransferIds = updated.autoRejectedTransferIds;
      auditMetadata.autoRejectedCount = updated.autoRejectedTransferIds.length;
    }

    await logAudit(fastify.prisma, request, 'EMPLOYEE_UPDATED', 'Employee', id, auditMetadata);

    if (updated.autoRejectedTransferIds && updated.autoRejectedTransferIds.length > 0) {
      for (const transferId of updated.autoRejectedTransferIds) {
        await logAudit(fastify.prisma, request, 'TRANSFER_REJECTED', 'SeatTransferRequest', transferId, {
          rejectionReason: updated.autoRejectionReason,
          rejectedByRole: userRole || 'ADMIN',
          autoRejectedDueToEmployeeDeactivation: true,
          employeeId: id
        });
      }
    }

    return reply.status(200).send(updated.empUpdated);
  });

  // DELETE /api/employees/:id
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;

    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Only Super Admin or Unit Admin can delete employees'
      });
    }

    const emp = await fastify.prisma.employee.findUnique({
      where: { id },
      include: {
        department: true,
        seat: { include: { floor: { include: { building: { include: { unit: true, plant: true } } } } } }
      }
    });
    if (!emp) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Employee not found'
      });
    }

    if (userRole !== 'TECH_ADMIN' && userRole !== 'SUPER_ADMIN') {
      const currentEmpUnit = unitIdFromBuilding(emp.seat?.floor?.building) || emp.department?.unitId;
      if (!currentEmpUnit || currentEmpUnit !== userUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You can only delete employees within your assigned Unit'
        });
      }
    }

    let cancelledTransferIds: string[] = [];
    await fastify.prisma.$transaction(async (tx) => {
      // 1. Cancel any active pending transfer requests for this employee
      const pendingTransfers = await tx.seatTransferRequest.findMany({
        where: {
          employeeId: id,
          status: {
            in: [
              'PENDING_TARGET_ADMIN'
            ]
          }
        },
        select: { id: true }
      });

      if (pendingTransfers.length > 0) {
        cancelledTransferIds = pendingTransfers.map((r) => r.id);
        await tx.seatTransferRequest.updateMany({
          where: {
            employeeId: id,
            status: {
              in: [
                'PENDING_TARGET_ADMIN'
              ]
            }
          },
          data: {
            status: 'CANCELLED',
            activeTransferKey: { unset: true },
            rejectionReason: 'Employee record was deleted'
          }
        });

        // Auto-mark incoming pending notifications for cancelled transfer requests as read
        await tx.notification.updateMany({
          where: {
            transferRequestId: { in: cancelledTransferIds },
            type: { in: ['TRANSFER_PENDING', 'INCOMING_TRANSFER_REQUEST'] },
            OR: [{ readAt: null }, { readAt: { isSet: false } }]
          },
          data: {
            readAt: new Date()
          }
        });
      }

      // 2. Unseat employee, release seat to AVAILABLE
      await tx.seat.updateMany({
        where: { employeeId: id },
        data: {
          employeeId: { unset: true },
          departmentId: null,
          status: 'AVAILABLE',
          pcNumber: null
        }
      });

      // 3. Retain the employee record as an inactive historical shell. A
      // physical delete would cascade to transfer history in MongoDB and make
      // the audit trail incomplete. The existing DELETE contract remains
      // idempotent while deactivation preserves the employee/transfer link.
      await tx.employee.update({
        where: { id },
        data: { isActive: false }
      });
    });

    await logAudit(fastify.prisma, request, 'EMPLOYEE_DELETED', 'Employee', id, {
      employeeCode: emp.employeeCode,
      fullName: emp.fullName,
      ...(cancelledTransferIds.length > 0 ? { cancelledTransferIds, cancelledCount: cancelledTransferIds.length } : {})
    });

    return reply.status(200).send({ success: true, deactivated: true });
  });

  function normalizeCol(h: string): string {
    return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function normalizeKey(k: string): string {
    return String(k || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  interface IngestItem {
    rowNum: number;
    code: string;
    name: string;
    email: string | null;
    dept: string;
    unit?: string;
    section?: string;
    func?: string;
    wsNo?: string;
    repTo?: string;
    hod?: string;
    status?: string;
    building?: string;
    floor?: string;
    area?: string;
  }

  // POST /api/employees/import-csv and /api/employees/import
  const bulkImportHandler = async (request: any, reply: any) => {
    const initialImportModel = (fastify.prisma as any).initialImportRun;
    const initialImportState = initialImportModel?.findUnique
      ? await initialImportModel.findUnique({ where: { key: 'AUTHORITATIVE_WORKBOOK' }, select: { status: true } })
      : null;
    if (initialImportState?.status === 'COMPLETED') {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        code: 'INITIAL_IMPORT_COMPLETED',
        message: 'The one-time authoritative import is complete. Employee records must now be managed through approved manual workflows.'
      });
    }
    if (options.enableLegacyEmployeeBulkImport !== true) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        code: 'BULK_IMPORT_DISABLED',
        message: 'Bulk employee import is disabled. Use the controlled one-time authoritative migration or manual employee management.'
      });
    }
    let csvContent = '';
    const rawItems: IngestItem[] = [];

    if (request.isMultipart()) {
      const file = await request.file();
      if (file) {
        const buffer = await file.toBuffer();
        const fname = file.filename?.toLowerCase() || '';
        const isPkZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
        const isBiff = buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf;
        const isExcelExt = fname.endsWith('.xlsx') || fname.endsWith('.xls');
        const isExcelMime = file.mimetype?.includes('sheet') || file.mimetype?.includes('excel');

        if (isExcelExt || isExcelMime || isPkZip || isBiff) {
          if (fname.endsWith('.xlsx') && !isPkZip) {
            return reply.status(400).send({
              statusCode: 400,
              error: 'Bad Request',
              message: 'Invalid or corrupted Excel (.xlsx) file: missing ZIP container signature',
            });
          }
          if (fname.endsWith('.xls') && !isBiff && !isPkZip) {
            return reply.status(400).send({
              statusCode: 400,
              error: 'Bad Request',
              message: 'Invalid or corrupted Excel (.xls) file: missing binary container signature',
            });
          }
          try {
            const wb = xlsx.read(buffer, { type: 'buffer' });
            if (!wb.SheetNames || wb.SheetNames.length === 0) {
              return reply.status(400).send({
                statusCode: 400,
                error: 'Bad Request',
                message: 'Uploaded Excel file contains no worksheets',
              });
            }
            const sheetName = wb.SheetNames[0];
            const sheet = wb.Sheets[sheetName];
            if (!sheet) {
              return reply.status(400).send({
                statusCode: 400,
                error: 'Bad Request',
                message: `Worksheet "${sheetName}" is empty or invalid`,
              });
            }
            const rawSheetData: any[] = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            if (rawSheetData.length > 0) {
              const headers: string[] = rawSheetData[0] || [];

              const cIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'employeecode' || norm === 'empcode' || norm === 'empno' || norm === 'userempno' || (norm.includes('code') && !norm.includes('dept')) || norm === 'id';
              });
              const nIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'fullname' || norm === 'employeename' || norm === 'empname' || norm === 'ename' || norm === 'username' || (norm.includes('name') && !norm.includes('dept') && !norm.includes('code') && !norm.includes('unit') && !norm.includes('building') && !norm.includes('floor'));
              });
              const eIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm.includes('email') || norm.includes('mail');
              });
              const dIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'department' || norm === 'dept' || norm === 'departmentname' || norm === 'deptname' || norm === 'deptcode' || norm === 'departmentcode';
              });
              const uIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'unit' || norm === 'unitid' || norm === 'unitcode' || norm === 'unitname';
              });
              const secIdx = headers.findIndex((h) => normalizeCol(h) === 'section');
              const fnIdx = headers.findIndex((h) => normalizeCol(h) === 'function' || normalizeCol(h) === 'functionname');
              const wsIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'wsno' || norm === 'workstation' || norm === 'seat' || norm === 'seatno';
              });
              const repIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'reportingto' || norm === 'reportingmanager' || norm === 'reportto' || norm === 'manager';
              });
              const hodIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'hod' || norm === 'departmenthead' || norm === 'headofdepartment';
              });
              const stIdx = headers.findIndex((h) => normalizeCol(h) === 'status');
              const bldIdx = headers.findIndex((h) => normalizeCol(h) === 'building');
              const flrIdx = headers.findIndex((h) => normalizeCol(h) === 'floor');
              const areaIdx = headers.findIndex((h) => {
                const norm = normalizeCol(h);
                return norm === 'officearea' || norm === 'office' || norm === 'area' || norm === 'sublocation';
              });

              for (let r = 1; r < rawSheetData.length; r++) {
                const row = rawSheetData[r];
                if (!row || row.every((c: any) => String(c).trim() === '')) continue;

                const code = cIdx !== -1 ? String(row[cIdx] || '').trim() : '';
                const name = nIdx !== -1 ? String(row[nIdx] || '').trim() : '';
                const email = (eIdx !== -1 && row[eIdx]) ? String(row[eIdx]).trim().toLowerCase() : null;
                const dept = dIdx !== -1 ? String(row[dIdx] || '').trim() : '';
                const unit = uIdx !== -1 ? String(row[uIdx] || '').trim() : undefined;
                const section = secIdx !== -1 ? String(row[secIdx] || '').trim() : undefined;
                const func = fnIdx !== -1 ? String(row[fnIdx] || '').trim() : undefined;
                const wsNo = wsIdx !== -1 ? String(row[wsIdx] || '').trim() : undefined;
                const repTo = repIdx !== -1 ? String(row[repIdx] || '').trim() : undefined;
                const rawHod = hodIdx !== -1 ? String(row[hodIdx] || '').trim() : undefined;
                const hod = rawHod && rawHod !== '0' ? rawHod : undefined;
                const status = stIdx !== -1 ? String(row[stIdx] || '').trim() : undefined;
                const building = bldIdx !== -1 ? String(row[bldIdx] || '').trim() : undefined;
                const floor = flrIdx !== -1 ? String(row[flrIdx] || '').trim() : undefined;
                const area = areaIdx !== -1 ? String(row[areaIdx] || '').trim() : undefined;

                rawItems.push({
                  rowNum: r + 1,
                  code,
                  name,
                  email,
                  dept,
                  unit,
                  section,
                  func,
                  wsNo,
                  repTo,
                  hod,
                  status,
                  building,
                  floor,
                  area
                });
              }
            }
          } catch (e: any) {
            return reply.status(400).send({
              statusCode: 400,
              error: 'Bad Request',
              message: `Failed to parse Excel workbook: ${e.message}`,
            });
          }
        } else {
          csvContent = buffer.toString('utf-8');
        }
      }
    } else {
      csvContent = typeof request.body === 'string' ? request.body : '';
    }

    if (csvContent) {
      if (csvContent.includes('Content-Disposition') || csvContent.includes('Content-Type')) {
        const doubleNewline = csvContent.indexOf('\r\n\r\n');
        if (doubleNewline !== -1) {
          csvContent = csvContent.substring(doubleNewline + 4);
          const lastBoundary = csvContent.lastIndexOf('\r\n------');
          if (lastBoundary !== -1) {
            csvContent = csvContent.substring(0, lastBoundary);
          }
        } else {
          const doubleN = csvContent.indexOf('\n\n');
          if (doubleN !== -1) {
            csvContent = csvContent.substring(doubleN + 2);
            const lastB = csvContent.lastIndexOf('\n------');
            if (lastB !== -1) {
              csvContent = csvContent.substring(0, lastB);
            }
          }
        }
      }

      csvContent = csvContent.replace(/^\uFEFF/, '').trim();
      const lines = csvContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('--') && !l.startsWith('Content-Disposition') && !l.startsWith('Content-Type'));

      if (lines.length > 1) {
        const headerParts = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
        const cIdx = headerParts.findIndex((h) => {
          const norm = normalizeCol(h);
          return norm === 'employeecode' || norm === 'empcode' || norm === 'empno' || norm === 'userempno' || (norm.includes('code') && !norm.includes('dept')) || norm === 'id';
        });
        const nIdx = headerParts.findIndex((h) => {
          const norm = normalizeCol(h);
          return norm === 'fullname' || norm === 'employeename' || norm === 'empname' || norm === 'ename' || norm === 'username' || (norm.includes('name') && !norm.includes('dept') && !norm.includes('code'));
        });
        const eIdx = headerParts.findIndex((h) => {
          const norm = normalizeCol(h);
          return norm.includes('email') || norm.includes('mail');
        });
        const dIdx = headerParts.findIndex((h) => {
          const norm = normalizeCol(h);
          return norm === 'department' || norm === 'dept' || norm === 'departmentname' || norm === 'deptname' || norm === 'deptcode' || norm === 'departmentcode';
        });
        const uIdx = headerParts.findIndex((h) => {
          const norm = normalizeCol(h);
          return norm === 'unit' || norm === 'unitid' || norm === 'unitcode' || norm === 'unitname';
        });

        for (let i = 1; i < lines.length; i++) {
          const row = lines[i];
          const parts: string[] = [];
          let current = '';
          let inQuotes = false;
          for (let j = 0; j < row.length; j++) {
            const char = row[j];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              parts.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          parts.push(current.trim());
          const cleaned = parts.map((p) => p.replace(/^"|"$/g, '').trim());

          const code = cIdx !== -1 ? cleaned[cIdx] : cleaned[0];
          const name = nIdx !== -1 ? cleaned[nIdx] : cleaned[1];
          const email = eIdx !== -1 && cleaned[eIdx] ? cleaned[eIdx].toLowerCase() : (cleaned[2] && cleaned[2].includes('@') ? cleaned[2].toLowerCase() : null);
          const dept = dIdx !== -1 ? cleaned[dIdx] : cleaned[3];
          const unit = uIdx !== -1 ? cleaned[uIdx] : cleaned[4];

          rawItems.push({
            rowNum: i + 1,
            code: code || '',
            name: name || '',
            email: email || null,
            dept: dept || '',
            unit
          });
        }
      }
    }

    if (rawItems.length === 0) {
      return reply.status(200).send({ imported: 0, failed: 0, errors: [] });
    }

    // Pre-fetch reference collections
    const [units, existingDepts, existingEmployees, existingSeats] = await Promise.all([
      fastify.prisma.unit.findMany({ where: unitSelectorWhere(), select: { id: true, code: true, name: true } }),
      fastify.prisma.department.findMany({ select: { id: true, code: true, name: true, unitId: true } }),
      fastify.prisma.employee.findMany({ select: { id: true, employeeCode: true, email: true } }),
      fastify.prisma.seat.findMany({ select: { id: true, label: true, floorId: true, employeeId: true } }),
    ]);

    // Build unit map with normalized keys
    const unitMap = new Map<string, string>();
    for (const u of units) {
      unitMap.set(u.id, u.id);
      unitMap.set(normalizeKey(u.code), u.id);
      unitMap.set(normalizeKey(u.name), u.id);
    }

    const isScopedAdmin = request.admin?.role === 'UNIT_ADMIN';
    const queryUnitId = (request.query as any)?.unitId;
    const defaultUnitId = isScopedAdmin
      ? request.admin?.assignedUnitId
      : (queryUnitId ? (unitMap.get(normalizeKey(String(queryUnitId))) || queryUnitId) : (units[0]?.id || null));

    // Department lookup caches
    const unitScopedDepts = new Map<string, Map<string, string>>();
    const globalDepts = new Map<string, string>();

    for (const d of existingDepts) {
      const codeKey = normalizeKey(d.code);
      const nameKey = normalizeKey(d.name);
      if (d.unitId) {
        if (!unitScopedDepts.has(d.unitId)) {
          unitScopedDepts.set(d.unitId, new Map());
        }
        const scoped = unitScopedDepts.get(d.unitId)!;
        if (codeKey) scoped.set(codeKey, d.id);
        if (nameKey) scoped.set(nameKey, d.id);
      }
      // Only explicitly global departments may be used as a cross-unit
      // fallback. A department belonging to another unit must never leak into
      // an import for the selected unit.
      if (!d.unitId) {
        if (codeKey) globalDepts.set(codeKey, d.id);
        if (nameKey) globalDepts.set(nameKey, d.id);
      }
    }

    // Existing employee map by employeeCode (uppercase)
    const empByCode = new Map<string, { id: string; email: string | null }>();
    const usedEmails = new Set<string>();
    for (const emp of existingEmployees) {
      empByCode.set(normalizeEmpCode(emp.employeeCode), { id: emp.id, email: emp.email });
      if (emp.email) usedEmails.add(emp.email.toLowerCase());
    }

    // Seat lookup by label (uppercase)
    const seatByLabel = new Map<string, { id: string; floorId: string; employeeId: string | null }>();
    for (const s of existingSeats) {
      seatByLabel.set(s.label.toUpperCase(), s);
    }

    let imported = 0;
    let failed = 0;
    const errors: Array<{ row: number; code?: string; email?: string; error: string }> = [];
    const seenCodesInFile = new Set<string>();

    for (const item of rawItems) {
      const { rowNum, dept, unit, wsNo, area } = item;
      let code = item.code;
      const name = item.name;
      const email = item.email;

      // Handle vacant / placeholder desks
      if (isVacantOrPlaceholder(code, name)) {
        if (wsNo) {
          const seat = seatByLabel.get(wsNo.toUpperCase());
          if (seat && seat.employeeId) {
            await fastify.prisma.seat.update({
              where: { id: seat.id },
              data: {
                employeeId: { unset: true },
                status: 'AVAILABLE',
                ...(area ? { officeArea: area } : {})
              }
            });
            seat.employeeId = null;
          }
        }
        imported++;
        continue;
      }

      if (!name) {
        failed++;
        errors.push({ row: rowNum, code, error: 'Missing employee name' });
        continue;
      }

      // Generate a deterministic code only for missing/non-employee
      // placeholders. Duplicate detection is exclusively by normalized
      // employeeCode; descriptive fields must never alter that key.
      if (!code || ['UP COMING', 'NOT COMING', 'CONTRACTOR'].includes(normalizeEmpCode(code))) {
        code = `TEMP-${rowNum}`;
      }
      code = normalizeEmpCode(String(code).replace(/^[=+\-@\t\r]+/, ''));

      if (seenCodesInFile.has(code)) {
        failed++;
        errors.push({ row: rowNum, code, error: 'Duplicate employeeCode in file' });
        continue;
      }
      seenCodesInFile.add(code);

      if (empByCode.has(code)) {
        failed++;
        errors.push({ row: rowNum, code, error: 'Employee code already exists in system' });
        continue;
      }

      // Resolve unit
      let targetUnitId: string | null = null;
      if (isScopedAdmin) {
        targetUnitId = request.admin?.assignedUnitId || null;
      } else if (unit) {
        targetUnitId = unitMap.get(normalizeKey(unit)) || null;
        if (!targetUnitId) {
          failed++;
          errors.push({
            row: rowNum,
            code,
            error: `Department code '${dept}' does not exist in target unit (Unit '${unit}' does not exist)`
          });
          continue;
        }
      } else {
        targetUnitId = defaultUnitId;
      }

      // Resolve department
      let deptId: string | undefined;
      const deptKey = normalizeKey(dept);
      if (targetUnitId && unitScopedDepts.has(targetUnitId)) {
        deptId = unitScopedDepts.get(targetUnitId)!.get(deptKey);
      }
      if (!deptId) {
        deptId = globalDepts.get(deptKey);
      }
      if (!deptId) {
        failed++;
        errors.push({
          row: rowNum,
          code,
          error: dept
            ? `Department code '${dept}' does not exist in target unit`
            : 'Department is required'
        });
        continue;
      }

      // Handle email collision gracefully
      let cleanEmail = email && email.includes('@') ? email.trim().toLowerCase() : null;
      const existingEmp = empByCode.get(normalizeEmpCode(code));
      if (cleanEmail) {
        if (usedEmails.has(cleanEmail) && existingEmp?.email !== cleanEmail) {
          cleanEmail = null;
        } else {
          usedEmails.add(cleanEmail);
        }
      }

      const cleanCode = normalizeEmpCode(code.replace(/^[=+\-@\t\r]+/, ''));
      const cleanName = name.replace(/^[=+\-@\t\r]+/, '').trim();
      const isActive = item.status ? item.status.toLowerCase() !== 'inactive' : true;
      const rep = item.repTo && item.repTo !== '0' ? item.repTo : null;
      const hod = item.hod && item.hod !== '0' ? item.hod : null;

      let empId: string;
      if (existingEmp) {
        const updated = await fastify.prisma.employee.update({
          where: { id: existingEmp.id },
          data: {
            fullName: cleanName,
            departmentId: deptId,
            ...(cleanEmail ? { email: cleanEmail } : {}),
            section: item.section || undefined,
            functionName: item.func || undefined,
            reportingTo: rep || undefined,
            reportingManager: rep || undefined,
            hod: hod || undefined,
            isActive
          }
        });
        empId = updated.id;
      } else {
        const created = await fastify.prisma.employee.create({
          data: {
            employeeCode: cleanCode,
            fullName: cleanName,
            email: cleanEmail,
            departmentId: deptId,
            section: item.section || null,
            functionName: item.func || null,
            reportingTo: rep,
            reportingManager: rep,
            hod,
            isActive
          }
        });
        empId = created.id;
        empByCode.set(normalizeEmpCode(cleanCode), { id: empId, email: cleanEmail });
      }

      // Link workstation seat if provided
      if (wsNo) {
        const seat = seatByLabel.get(wsNo.toUpperCase());
        if (seat) {
          try {
            // 1. Release any prior seat held by this employee to prevent seats_employee_id_key conflict
            await fastify.prisma.seat.updateMany({
              where: { employeeId: empId },
              data: { employeeId: { unset: true } }
            });

            // 2. Assign employee to the designated seat
            await fastify.prisma.seat.update({
              where: { id: seat.id },
              data: {
                employeeId: empId,
                status: 'AVAILABLE',
                ...(area ? { officeArea: area } : {})
              }
            });
            seat.employeeId = empId;
          } catch (seatErr: any) {
            fastify.log.warn(`Seat allocation skipped for ${wsNo}: ${seatErr.message}`);
          }
        }
      }

      imported++;
    }

    await logAudit(fastify.prisma, request, 'EMPLOYEE_ROSTER_IMPORTED', 'Employee', 'bulk', {
      importedCount: imported,
      failedCount: failed,
      errors: errors.slice(0, 100),
    });

    return reply.status(200).send({ imported, failed, errors });
  };

  // POST /api/employees/import-csv
  fastify.post('/import-csv', bulkImportHandler);

  // POST /api/employees/import (alias)
  fastify.post('/import', bulkImportHandler);
};
