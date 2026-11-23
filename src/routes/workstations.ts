// apps/backend/src/routes/workstations.ts
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { resolveSeatOfficeArea } from '@seating/shared';
import { resolveAuthorizedUnitScope } from '../utils/rbac.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';
import { buildingUnitWhere, resolveBuildingUnitId, unitIdFromBuilding } from '../utils/building-unit.js';
import { currentOperationalRecordWhere } from '../utils/operational-record.js';
import { compareNaturally } from '../utils/natural-sort.js';

interface WorkstationQuery {
  unitId?: string;
  unit?: string;
  plantId?: string;
  plant?: string;
  buildingId?: string;
  building?: string;
  floorId?: string;
  floor?: string;
  officeArea?: string;
  departmentId?: string;
  department?: string;
  section?: string;
  functionName?: string;
  function?: string;
  status?: string;
  employeeStatus?: string;
  isActive?: string;
  wsNo?: string;
  empCode?: string;
  employeeName?: string;
  reportingTo?: string;
  hod?: string;
  search?: string;
  page?: string;
  pageSize?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
}

import { escapeRegexLiteral } from '../utils/regex.js';
export { escapeRegexLiteral };

export const workstationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/workstations
   * Unified, server-side filtered, paginated workstation and seating ledger.
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query as WorkstationQuery) || {};
    const requestedUnit = query.unitId || query.unit;

    // 1. Enforce strict server-side authorization and unit scoping
    const scopeRes = await resolveAuthorizedUnitScope(fastify.prisma, request.admin, requestedUnit);
    if (!scopeRes.authorized) {
      return reply.status(scopeRes.statusCode).send({
        statusCode: scopeRes.statusCode,
        error: scopeRes.statusCode === 403 ? 'Forbidden' : 'Unauthorized',
        message: scopeRes.error
      });
    }

    const { scope } = scopeRes;

    // Keep the global directory aligned with the normal Unit selector. A
    // Super/Tech Admin has unrestricted authority, but the directory's
    // "All Units" view represents classified business Units, not
    // quarantined/synthetic test data. Explicit unit requests still resolve
    // through RBAC above and retain their requested scope.
    const effectiveUnitIds = scope.unitIds.length > 0
      ? scope.unitIds
      : (await fastify.prisma.unit.findMany({
          where: unitSelectorWhere(),
          select: { id: true }
        })).map((unit) => unit.id);

    // Resolve hierarchy and employee filters before querying Seat. Prisma's
    // MongoDB relation filters can compile to aggregation expressions that
    // assume the relation join is an array. Keeping the final Seat where
    // clause on scalar foreign keys avoids that failure mode for legacy data
    // with missing/null relation fields, without weakening unit scoping.
    const scopedBuildingIds = effectiveUnitIds.length > 0
      ? (await fastify.prisma.building.findMany({
          where: buildingUnitWhere(effectiveUnitIds),
          select: { id: true }
        })).map((building) => building.id)
      : undefined;
    const scopedFloorIds = scopedBuildingIds
      ? (await fastify.prisma.floor.findMany({
          where: { buildingId: { in: scopedBuildingIds } },
          select: { id: true }
        })).map((floor) => floor.id)
      : undefined;
    const effectiveDepartmentIds = effectiveUnitIds.length > 0
      ? (await fastify.prisma.department.findMany({
          where: { unitId: { in: effectiveUnitIds } },
          select: { id: true }
        })).map((department) => department.id)
      : undefined;

    // MongoDB omits optional employee_id fields for unassigned seats. Prisma's
    // `employeeId: null` predicate only matches explicit nulls in this data,
    // so status filters and KPI counts must classify seats from the set of
    // seats that actually carry an employee link.
    const occupiedSeatIds = (await fastify.prisma.seat.findMany({
      where: {
        ...(scopedFloorIds ? { floorId: { in: scopedFloorIds } } : {}),
        employeeId: { not: null }
      },
      select: { id: true }
    })).map((seat) => seat.id);

    const employeeIdsFor = async (employeeWhere: Prisma.EmployeeWhereInput) =>
      (await fastify.prisma.employee.findMany({
        where: employeeWhere,
        select: { id: true }
      })).map((employee) => employee.id);

    const employeeIdsForValue = async (
      field: 'employeeCode' | 'fullName' | 'reportingTo' | 'reportingManager' | 'hod',
      value: string
    ) => employeeIdsFor({ [field]: { contains: escapeRegexLiteral(value), mode: 'insensitive' } });

    // 2. Validate dependent foreign keys against authorized units if supplied
    if (scope.isRestricted && scope.unitIds.length > 0) {
      const allowedUnitId = scope.unitIds[0];

      // Validate buildingId if supplied
      if (query.buildingId && query.buildingId !== 'ALL') {
        const buildingUnitId = await resolveBuildingUnitId(fastify.prisma, query.buildingId);
        if (buildingUnitId && buildingUnitId !== allowedUnitId) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Forbidden: The requested building does not belong to your authorized unit.'
          });
        }
      }

      // Validate floorId if supplied
      if (query.floorId && query.floorId !== 'ALL') {
        const floor = await fastify.prisma.floor.findUnique({
          where: { id: query.floorId },
          select: { buildingId: true }
        });
        const floorUnitId = floor ? await resolveBuildingUnitId(fastify.prisma, floor.buildingId) : null;
        if (floorUnitId && floorUnitId !== allowedUnitId) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Forbidden: The requested floor does not belong to your authorized unit.'
          });
        }
      }

      // Validate departmentId if supplied
      if (query.departmentId && query.departmentId !== 'ALL') {
        const department = await fastify.prisma.department.findUnique({
          where: { id: query.departmentId }
        });
        if (department && department.unitId && department.unitId !== allowedUnitId) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Forbidden: The requested department does not belong to your authorized unit.'
          });
        }
      }
    }

    // 3. Assemble server-side AND conditions
    const andConditions: Prisma.SeatWhereInput[] = [currentOperationalRecordWhere() as Prisma.SeatWhereInput];

    // Condition A: Unit Scoping (Enforced BEFORE any client filter)
    if (effectiveUnitIds.length > 0) {
      andConditions.push({
          floorId: { in: scopedFloorIds || [] }
      });
    }

    // Condition A2: Plant Filter
    if (query.plantId && query.plantId !== 'ALL') {
      const plantFloors = await fastify.prisma.floor.findMany({
        where: {
          building: { plantId: query.plantId },
          ...(scopedFloorIds ? { id: { in: scopedFloorIds } } : {})
        },
        select: { id: true }
      });
      andConditions.push({ floorId: { in: plantFloors.map((floor) => floor.id) } });
    } else if (query.plant && query.plant !== 'ALL') {
      const plantName = query.plant.trim();
      const plants = await fastify.prisma.plant.findMany({
        where: {
          OR: [
            { name: plantName },
            { name: { equals: plantName, mode: 'insensitive' } }
          ],
          ...(effectiveUnitIds.length > 0 ? { unitId: { in: effectiveUnitIds } } : {})
        },
        select: { id: true }
      });
      const plantFloors = await fastify.prisma.floor.findMany({
        where: {
          building: { plantId: { in: plants.map((p) => p.id) } },
          ...(scopedFloorIds ? { id: { in: scopedFloorIds } } : {})
        },
        select: { id: true }
      });
      andConditions.push({ floorId: { in: plantFloors.map((floor) => floor.id) } });
    }

    // Condition B: Building Filter
    if (query.buildingId && query.buildingId !== 'ALL') {
      const buildingFloors = await fastify.prisma.floor.findMany({
        where: {
          buildingId: query.buildingId,
          ...(scopedFloorIds ? { id: { in: scopedFloorIds } } : {})
        },
        select: { id: true }
      });
      andConditions.push({ floorId: { in: buildingFloors.map((floor) => floor.id) } });
    } else if (query.building && query.building !== 'ALL') {
      const bldgName = query.building.trim();
      const buildings = await fastify.prisma.building.findMany({
        where: {
          OR: [
            { name: bldgName },
            { name: { equals: bldgName, mode: 'insensitive' } }
          ],
          ...(scopedBuildingIds ? { id: { in: scopedBuildingIds } } : {})
        },
        select: { id: true }
      });
      const buildingIds = buildings.map((building) => building.id);
      const floors = await fastify.prisma.floor.findMany({
        where: { buildingId: { in: buildingIds } },
        select: { id: true }
      });
      andConditions.push({ floorId: { in: floors.map((floor) => floor.id) } });
    }

    // Condition C: Floor Filter
    if (query.floorId && query.floorId !== 'ALL') {
      andConditions.push({ floorId: query.floorId });
    } else if (query.floor && query.floor !== 'ALL') {
      const flName = query.floor.trim();
      const floors = await fastify.prisma.floor.findMany({
        where: {
          OR: [
            { name: flName },
            { name: { equals: flName, mode: 'insensitive' } }
          ],
          ...(scopedFloorIds ? { id: { in: scopedFloorIds } } : {})
        },
        select: { id: true }
      });
      andConditions.push({ floorId: { in: floors.map((floor) => floor.id) } });
    }

    // Condition D: Office / Area Filter
    if (query.officeArea && query.officeArea !== 'ALL' && query.officeArea.trim() !== '') {
      const area = query.officeArea.trim();
      andConditions.push({
        OR: [
          { officeArea: area },
          { officeArea: { equals: area, mode: 'insensitive' } }
        ]
      });
    }

    // Condition E: Department Filter
    if (query.departmentId && query.departmentId !== 'ALL') {
      const selectedDepartment = await fastify.prisma.department.findUnique({
        where: { id: query.departmentId },
        select: { id: true, unitId: true, code: true }
      });
      const matchingDepartmentIds = selectedDepartment
        ? (await fastify.prisma.department.findMany({
            where: {
              unitId: selectedDepartment.unitId,
              code: selectedDepartment.code,
              ...(effectiveDepartmentIds ? { id: { in: effectiveDepartmentIds } } : {})
            },
            select: { id: true }
          })).map((department) => department.id)
        : [];
      andConditions.push({ departmentId: { in: matchingDepartmentIds } });
    } else if (query.department && query.department !== 'ALL') {
      const deptName = query.department.trim();
      const departments = await fastify.prisma.department.findMany({
        where: {
          OR: [
            { name: deptName },
            { name: { equals: deptName, mode: 'insensitive' } }
          ],
          ...(effectiveDepartmentIds ? { id: { in: effectiveDepartmentIds } } : {})
        },
        select: { id: true }
      });
      andConditions.push({ departmentId: { in: departments.map((department) => department.id) } });
    }

    // Condition F: Section Filter
    if (query.section && query.section !== 'ALL' && query.section.trim() !== '') {
      const sec = query.section.trim();
      const normalizedSec = sec.replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
      const sections = await fastify.prisma.section.findMany({
        where: {
          OR: [
            { name: sec },
            { normalizedName: normalizedSec },
            { name: { equals: sec, mode: 'insensitive' } }
          ]
        },
        select: { id: true }
      });
      const matchingEmployeeIds = await employeeIdsFor({
        OR: [
          { section: sec },
          { section: { equals: sec, mode: 'insensitive' } },
          { sectionId: { in: sections.map((section) => section.id) } }
        ]
      });
      andConditions.push({ employeeId: { in: matchingEmployeeIds } });
    }

    // Condition G: Function Filter
    const func = query.functionName || query.function;
    if (func && func !== 'ALL' && func.trim() !== '') {
      const fn = func.trim();
      const normalizedFn = fn.replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
      const functions = await fastify.prisma.orgFunction.findMany({
        where: {
          OR: [
            { name: fn },
            { normalizedName: normalizedFn },
            { name: { equals: fn, mode: 'insensitive' } }
          ]
        },
        select: { id: true }
      });
      const matchingEmployeeIds = await employeeIdsFor({
        OR: [
          { functionName: fn },
          { functionName: { equals: fn, mode: 'insensitive' } },
          { functionId: { in: functions.map((orgFunction) => orgFunction.id) } }
        ]
      });
      andConditions.push({ employeeId: { in: matchingEmployeeIds } });
    }

    // Condition H: Workstation Status Filter
    if (query.status && query.status !== 'ALL') {
      const st = query.status.toUpperCase().trim();
      if (st === 'OCCUPIED') {
        andConditions.push({ employeeId: { not: null } });
      } else if (st === 'AVAILABLE' || st === 'VACANT') {
        andConditions.push({
          status: 'AVAILABLE',
          id: { notIn: occupiedSeatIds }
        });
      } else if (st === 'RESERVED') {
        andConditions.push({ status: 'RESERVED', id: { notIn: occupiedSeatIds } });
      } else if (st === 'MAINTENANCE' || st === 'BLOCKED') {
        andConditions.push({ status: 'MAINTENANCE', id: { notIn: occupiedSeatIds } });
      }
    }

    // Condition H2: Employee Status Filter (Active vs Inactive on occupied seats)
    const empStatusVal = query.employeeStatus || query.isActive;
    if (empStatusVal && empStatusVal !== 'ALL') {
      const isActiveEmp = empStatusVal.toUpperCase() === 'ACTIVE' || empStatusVal === 'true';
      const statusEmployees = await fastify.prisma.employee.findMany({
        where: { isActive: isActiveEmp },
        select: { id: true }
      });
      andConditions.push({ employeeId: { in: statusEmployees.map((e) => e.id) } });
    }

    // Condition I: Direct Search Filters
    if (query.wsNo && query.wsNo.trim() !== '') {
      andConditions.push({
        label: { contains: escapeRegexLiteral(query.wsNo.trim()), mode: 'insensitive' }
      });
    }

    if (query.empCode && query.empCode.trim() !== '') {
      andConditions.push({ employeeId: { in: await employeeIdsForValue('employeeCode', query.empCode.trim()) } });
    }

    if (query.employeeName && query.employeeName.trim() !== '') {
      andConditions.push({ employeeId: { in: await employeeIdsForValue('fullName', query.employeeName.trim()) } });
    }

    if (query.reportingTo && query.reportingTo.trim() !== '') {
      const rep = escapeRegexLiteral(query.reportingTo.trim());
      andConditions.push({ employeeId: { in: await employeeIdsFor({
        OR: [
          { reportingTo: { contains: rep, mode: 'insensitive' } },
          { reportingManager: { contains: rep, mode: 'insensitive' } }
        ]
      }) } });
    }

    if (query.hod && query.hod.trim() !== '') {
      andConditions.push({ employeeId: { in: await employeeIdsForValue('hod', query.hod.trim()) } });
    }

    // Condition J: Global Multi-Column Search
    if (query.search && query.search.trim() !== '') {
      const term = escapeRegexLiteral(query.search.trim());
      const matchingDepartments = await fastify.prisma.department.findMany({
        where: { name: { contains: term, mode: 'insensitive' } },
        select: { id: true }
      });
      const matchingEmployeeIds = await employeeIdsFor({
        OR: [
          { fullName: { contains: term, mode: 'insensitive' } },
          { employeeCode: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { reportingTo: { contains: term, mode: 'insensitive' } },
          { reportingManager: { contains: term, mode: 'insensitive' } },
          { hod: { contains: term, mode: 'insensitive' } }
        ]
      });
      andConditions.push({
        OR: [
          { label: { contains: term, mode: 'insensitive' } },
          { pcNumber: { contains: term, mode: 'insensitive' } },
          { officeArea: { contains: term, mode: 'insensitive' } },
          { departmentId: { in: matchingDepartments.map((department) => department.id) } },
          { employeeId: { in: matchingEmployeeIds } }
        ]
      });
    }

    const where: Prisma.SeatWhereInput = andConditions.length > 0 ? { AND: andConditions } : {};

    // 4. Pagination & Sorting Setup
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const rawPageSize = parseInt(query.pageSize || query.limit || '25', 10) || 25;
    const pageSize = Math.max(5, Math.min(200, rawPageSize));
    const skip = (page - 1) * pageSize;

    const sortField = query.sortBy || 'wsNo';
    const sortDir = (query.sortOrder || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

    // Labels are not globally unique (for example, several Units have WS-03).
    // Use the immutable seat id as a tiebreaker so pagination is stable across
    // repeated requests and cannot move tied rows between pages.
    let orderBy: Prisma.SeatOrderByWithRelationInput[] = [{ label: sortDir }, { id: sortDir }];
    if (sortField === 'wsNo') {
      orderBy = [{ label: sortDir }, { id: sortDir }];
    } else if (sortField === 'status') {
      orderBy = [{ status: sortDir }, { id: sortDir }];
    } else if (sortField === 'department') {
      orderBy = [{ department: { name: sortDir } }, { id: sortDir }];
    } else if (sortField === 'building') {
      orderBy = [{ floor: { building: { name: sortDir } } }, { id: sortDir }];
    } else if (sortField === 'floor') {
      orderBy = [{ floor: { floorNumber: sortDir } }, { id: sortDir }];
    }

    // 5. Query execution (Count, Items, and KPI counts). MongoDB's string
    // ordering is lexicographic, so workstation labels such as WS-10 would
    // otherwise appear before WS-2. Sort the complete filtered result before
    // slicing whenever the UI requests a computed/natural sort.
    const needsInMemorySort = sortField === 'wsNo' || sortField === 'status';
    // Keep these as independent count() operations. Prisma's MongoDB grouped
    // aggregation path can panic on nullable/missing legacy fields.
    const [total, seats, occupiedCount, availableCount, reservedCount, maintenanceCount] = await Promise.all([
      fastify.prisma.seat.count({ where }),
      fastify.prisma.seat.findMany({
        where,
        ...(needsInMemorySort ? {} : { skip, take: pageSize }),
        orderBy,
        include: {
          department: true,
          employee: {
            include: {
              department: true,
              sectionMaster: true,
              functionMaster: true
            }
          },
          area: true,
          floor: {
            include: {
              building: {
                include: {
                  unit: true,
                  plant: {
                    include: {
                      unit: true
                    }
                  }
                }
              }
            }
          }
        }
      }),
      fastify.prisma.seat.count({ where: { AND: [...andConditions, { employeeId: { not: null } }] } }),
      fastify.prisma.seat.count({ where: { AND: [...andConditions, { status: 'AVAILABLE', id: { notIn: occupiedSeatIds } }] } }),
      fastify.prisma.seat.count({ where: { AND: [...andConditions, { status: 'RESERVED', id: { notIn: occupiedSeatIds } }] } }),
      fastify.prisma.seat.count({ where: { AND: [...andConditions, { status: 'MAINTENANCE', id: { notIn: occupiedSeatIds } }] } })
    ]);

    const sortedSeats = needsInMemorySort
      ? [...seats].sort((left, right) => {
          const leftValue = sortField === 'wsNo'
            ? left.label
            : (left.employeeId && left.employee ? 'OCCUPIED' : left.status);
          const rightValue = sortField === 'wsNo'
            ? right.label
            : (right.employeeId && right.employee ? 'OCCUPIED' : right.status);
          const primary = compareNaturally(leftValue, rightValue) * (sortDir === 'desc' ? -1 : 1);
          return primary || compareNaturally(left.id, right.id);
        }).slice(skip, skip + pageSize)
      : seats;

    const otherCount = Math.max(0, total - occupiedCount - availableCount - reservedCount - maintenanceCount);

    // Format into standard 13-column WorkstationRecord objects
    const data = sortedSeats.map((s) => {
      const resolvedArea = s.officeArea || s.area?.name || resolveSeatOfficeArea(s as any) || 'General Bay';
      const isOccupied = Boolean(s.employeeId && s.employee);
      const computedStatus: 'OCCUPIED' | 'AVAILABLE' | 'RESERVED' | 'MAINTENANCE' = isOccupied
        ? 'OCCUPIED'
        : (s.status as any);

      return {
        id: s.id,
        wsNo: s.label,
        unit: {
          id: s.floor?.building?.unit?.id || s.floor?.building?.plant?.unit?.id || '',
          name: s.floor?.building?.unit?.name || s.floor?.building?.plant?.unit?.name || 'Unknown Unit',
          code: s.floor?.building?.unit?.code || s.floor?.building?.plant?.unit?.code || '',
          location: s.floor?.building?.unit?.location || s.floor?.building?.plant?.unit?.location || null
        },
        plant: s.floor?.building?.plant
          ? {
              id: s.floor.building.plant.id,
              name: s.floor.building.plant.name,
              code: s.floor.building.plant.code
            }
          : null,
        building: s.floor?.building
          ? {
              id: s.floor.building.id,
              name: s.floor.building.name,
              code: s.floor.building.code
            }
          : null,
        floor: s.floor
          ? {
              id: s.floor.id,
              name: s.floor.name,
              floorNumber: s.floor.floorNumber
            }
          : null,
        officeArea: resolvedArea,
        department: s.department
          ? {
              id: s.department.id,
              name: s.department.name,
              code: s.department.code,
              colorHex: s.department.colorHex
            }
          : s.employee?.department
            ? {
                id: s.employee.department.id,
                name: s.employee.department.name,
                code: s.employee.department.code,
                colorHex: s.employee.department.colorHex
              }
            : null,
        section: s.employee?.section || s.employee?.sectionMaster?.name || '—',
        functionName: s.employee?.functionName || s.employee?.functionMaster?.name || '—',
        type: s.type,
        status: computedStatus,
        pcNumber: s.pcNumber || s.employee?.pcNumber || null,
        remarks: s.remarks || null,
        employee: s.employee
          ? {
              id: s.employee.id,
              employeeCode: s.employee.employeeCode,
              fullName: s.employee.fullName,
              email: s.employee.email || null,
              designation: s.employee.designation || null,
              grade: s.employee.grade || null,
              reportingTo: s.employee.reportingTo || null,
              reportingManager: s.employee.reportingManager || null,
              hod: s.employee.hod || null,
              phone: s.employee.phone || null,
              ext: s.employee.ext || null,
              isActive: s.employee.isActive
            }
          : null,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        rotation: s.rotation,
        updatedAt: s.updatedAt.toISOString()
      };
    });

    const totalPages = Math.ceil(total / pageSize) || 1;
    const occupancyRate = total > 0 ? Math.round((occupiedCount / total) * 100) : 0;

    return reply.status(200).send({
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      filtersApplied: {
        unitId: query.unitId || query.unit || (scope.isRestricted ? scope.lockedUnitId : 'ALL'),
        buildingId: query.buildingId || query.building || 'ALL',
        floorId: query.floorId || query.floor || 'ALL',
        officeArea: query.officeArea || 'ALL',
        departmentId: query.departmentId || query.department || 'ALL',
        section: query.section || 'ALL',
        functionName: func || 'ALL',
        status: query.status || 'ALL',
        search: query.search || '',
        wsNo: query.wsNo || '',
        empCode: query.empCode || '',
        employeeName: query.employeeName || ''
      },
      kpis: {
        totalWorkstations: total,
        occupiedCount,
        availableCount,
        reservedCount,
        maintenanceCount,
        otherCount,
        occupancyRate
      }
    });
  });

  /**
   * GET /api/workstations/filter-options
   * Dynamically yields valid, distinct options for all cascading filters
   * based on the user's authorized units and currently active parent selections.
   */
  fastify.get('/filter-options', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query as WorkstationQuery) || {};
    const requestedUnit = query.unitId || query.unit;

    // 1. Enforce strict server-side authorization
    const scopeRes = await resolveAuthorizedUnitScope(fastify.prisma, request.admin, requestedUnit);
    if (!scopeRes.authorized) {
      return reply.status(scopeRes.statusCode).send({
        statusCode: scopeRes.statusCode,
        error: scopeRes.statusCode === 403 ? 'Forbidden' : 'Unauthorized',
        message: scopeRes.error
      });
    }

    const { scope } = scopeRes;

    // 2. Fetch Units
    let units: Array<{ id: string; name: string; code: string; location?: string | null }> = [];
    if (scope.isRestricted && scope.unitIds.length > 0) {
      units = await fastify.prisma.unit.findMany({
        where: { id: { in: scope.unitIds } },
        select: { id: true, name: true, code: true, location: true },
        orderBy: { name: 'asc' }
      });
    } else {
      units = await fastify.prisma.unit.findMany({
        where: unitSelectorWhere(),
        select: { id: true, name: true, code: true, location: true },
        orderBy: { name: 'asc' }
      });
    }

    // Resolve the hierarchy from the Units already authorized for this
    // selector. Besides keeping global options in business scope, this avoids
    // traversing orphaned legacy Buildings whose required Plant relation is
    // absent in Atlas (which otherwise makes Prisma reject the whole request).
    const effectiveUnitIds = scope.unitIds.length > 0
      ? scope.unitIds
      : units.map((unit) => unit.id);
    const effectiveBuildingIds = (await fastify.prisma.building.findMany({
      where: buildingUnitWhere(effectiveUnitIds),
      select: { id: true }
    })).map((building) => building.id);
    const effectiveFloorIds = (await fastify.prisma.floor.findMany({
      where: { buildingId: { in: effectiveBuildingIds } },
      select: { id: true }
    })).map((floor) => floor.id);
    const effectiveDepartmentRows = await fastify.prisma.department.findMany({
      where: { unitId: { in: effectiveUnitIds } },
      select: { id: true, unitId: true, code: true }
    });
    const effectiveDepartmentIds = effectiveDepartmentRows.map((department) => department.id);

    const selectedOrgDepartment = query.departmentId && query.departmentId !== 'ALL' ? query.departmentId : undefined;
    const selectedOrgDepartmentRow = effectiveDepartmentRows.find((department) => department.id === selectedOrgDepartment);
    const selectedOrgDepartmentIds = selectedOrgDepartmentRow
      ? effectiveDepartmentRows.filter((department) => department.unitId === selectedOrgDepartmentRow.unitId && department.code === selectedOrgDepartmentRow.code).map((department) => department.id)
      : [];
    const selectedOrgSection = query.section && query.section !== 'ALL' ? query.section.trim() : undefined;
    const selectedOrgFunction = query.functionName && query.functionName !== 'ALL' ? query.functionName.trim() : undefined;
    const hasOrgSelection = Boolean(selectedOrgDepartment || selectedOrgSection || selectedOrgFunction);
    const orgSeats = hasOrgSelection ? await fastify.prisma.seat.findMany({
      where: { floorId: { in: effectiveFloorIds }, employeeId: { not: null } },
      select: { floorId: true, employeeId: true, departmentId: true, areaId: true, officeArea: true }
    }) : [];
    const orgEmployees = hasOrgSelection ? await fastify.prisma.employee.findMany({
      where: { id: { in: orgSeats.map((seat) => seat.employeeId).filter((id): id is string => Boolean(id)) } },
      select: { id: true, section: true, functionName: true }
    }) : [];
    const orgEmployeeById = new Map(orgEmployees.map((employee) => [employee.id, employee]));
    const matchingOrgSeats = orgSeats.filter((seat) => {
      if (!effectiveDepartmentIds.includes(seat.departmentId || '')) return false;
      const employee = seat.employeeId ? orgEmployeeById.get(seat.employeeId) : null;
      return employee && (!selectedOrgDepartment || selectedOrgDepartmentIds.includes(seat.departmentId || '')) &&
        (!selectedOrgSection || employee.section?.trim().toLowerCase() === selectedOrgSection.toLowerCase()) &&
        (!selectedOrgFunction || employee.functionName?.trim().toLowerCase() === selectedOrgFunction.toLowerCase());
    });
    const orgFloorIds = new Set(matchingOrgSeats.map((seat) => seat.floorId));
    const orgBuildingIds = hasOrgSelection ? new Set((await fastify.prisma.floor.findMany({
      where: { id: { in: [...orgFloorIds] } }, select: { buildingId: true }
    })).map((floor) => floor.buildingId)) : null;

    // 3. Fetch Buildings
    const buildings = await fastify.prisma.building.findMany({
      where: {
        isActive: true,
        ...buildingUnitWhere(effectiveUnitIds)
      },
      select: {
        id: true,
        name: true,
        code: true,
        unitId: true,
        unit: { select: { id: true } },
        plant: { select: { unitId: true } }
      },
      orderBy: { name: 'asc' }
    });

    const formattedBuildings = buildings.filter((building) => !orgBuildingIds || orgBuildingIds.has(building.id) || building.id === query.buildingId).map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      unitId: unitIdFromBuilding(b)
    }));

    // 4. Fetch Floors
    const selectedBuildingId = query.buildingId && query.buildingId !== 'ALL' ? query.buildingId : undefined;
    const filterBuildingIds = selectedBuildingId
      ? effectiveBuildingIds.filter((id) => id === selectedBuildingId)
      : effectiveBuildingIds;
    // A floor is a usable workstation filter only when at least one visible
    // seat references it. Legacy Atlas data contains active master floors
    // with no seats (for example Santosh Bhavan's empty "Floor 1"/"Floor 2").
    // Returning those records creates selectable filters that can only produce
    // an unexplained zero result and makes the options contract disagree with
    // the workstation query and the historical seating CSV.
    const visibleFloorIds = Array.from(new Set(
      (await fastify.prisma.seat.findMany({
        where: { floorId: { in: effectiveFloorIds } },
        select: { floorId: true }
      }))
        .map((seat) => seat.floorId)
        .filter((floorId): floorId is string => Boolean(floorId))
    ));
    const visibleFloors = await fastify.prisma.floor.findMany({
      where: {
        isActive: true,
        id: { in: hasOrgSelection ? visibleFloorIds.filter((id) => orgFloorIds.has(id)) : visibleFloorIds },
        buildingId: { in: filterBuildingIds }
      },
      select: {
        id: true,
        name: true,
        floorNumber: true,
        buildingId: true
      },
      orderBy: { floorNumber: 'asc' }
    });
    const buildingById = new Map(buildings.map((b) => [b.id, b]));
    const unitsById = new Map(units.map((u) => [u.id, u.name]));
    const floors = visibleFloors.map((floor) => {
      const building = buildingById.get(floor.buildingId);
      const unitId = building ? unitIdFromBuilding(building) : undefined;
      return {
        ...floor,
        displayName: [unitId && unitsById.get(unitId), building?.name, floor.name]
          .filter(Boolean)
          .join(' → ')
      };
    });

    // 5. Fetch Office Areas (Distinct from seats matching current unit/building/floor)
    const selectedFloorId = query.floorId && query.floorId !== 'ALL' ? query.floorId : undefined;
    const selectedBuildingFloorIds = selectedBuildingId
      ? visibleFloors.map((floor) => floor.id)
      : undefined;
    const availableFloorIds = hasOrgSelection ? visibleFloorIds.filter((id) => orgFloorIds.has(id)) : visibleFloorIds;
    const areaFloorIds = selectedFloorId
      ? availableFloorIds.filter((id) => id === selectedFloorId)
      : selectedBuildingFloorIds
        ? availableFloorIds.filter((id) => selectedBuildingFloorIds.includes(id))
        : availableFloorIds;
    const areaSeats = await fastify.prisma.seat.findMany({
      where: {
        ...(areaFloorIds ? { floorId: { in: areaFloorIds } } : {}),
        officeArea: { not: null },
        ...(hasOrgSelection ? { employeeId: { in: matchingOrgSeats.map((seat) => seat.employeeId).filter((id): id is string => Boolean(id)) } } : {})
      },
      select: { officeArea: true },
      distinct: ['officeArea']
    });

    const officeAreas = Array.from(
      new Set(
        areaSeats
          .map((s) => s.officeArea?.trim())
          .filter((a): a is string => Boolean(a && a.length > 0 && a !== '0' && a !== '#N/A'))
      )
    ).sort((a, b) => a.localeCompare(b));
    const areaRows = await fastify.prisma.area.findMany({
      where: {
        isActive: true,
        ...(areaFloorIds ? { floorId: { in: areaFloorIds } } : {})
      },
      select: { id: true, name: true, floorId: true, isActive: true },
      orderBy: { name: 'asc' }
    });
    const floorInfoById = new Map(visibleFloors.map((floor) => {
      const building = buildingById.get(floor.buildingId);
      const unitId = building ? unitIdFromBuilding(building) : undefined;
      return [floor.id, {
        floorName: floor.name,
        buildingName: building?.name || null,
        unitName: (unitId && unitsById.get(unitId)) || null
      }];
    }));
    const rawAreaOptions = hasOrgSelection ? areaRows.filter((area) => matchingOrgSeats.some((seat) =>
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
    }).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    // Workstation-only options must be derived from visible workstation
    // records, not the broader master-data catalog. Legacy imports contain
    // duplicate Department documents for a single Unit/code, so keep one
    // deterministic display option and let the result query expand it back to
    // every equivalent in-scope Department id.
    const selectedOfficeArea = query.officeArea && query.officeArea !== 'ALL' && query.officeArea.trim() !== ''
      ? query.officeArea.trim()
      : undefined;
    const scopedSeatWhere: Prisma.SeatWhereInput = {
      floorId: { in: areaFloorIds },
      ...(selectedOfficeArea
        ? {
            officeArea: { equals: selectedOfficeArea, mode: 'insensitive' }
          }
        : {})
    };
    const scopedSeatReferences = await fastify.prisma.seat.findMany({
      // Reuse the parent-selected floor scope so a Building/Floor change does
      // not leave Department/Section/Function choices that can never match a
      // displayed workstation row. Office/Area is also a parent of the
      // organizational selectors, so narrow the seat scope with the same
      // literal/case-insensitive semantics as the workstation query.
      where: scopedSeatWhere,
      select: { departmentId: true, employeeId: true }
    });
    const visibleDepartmentIds = Array.from(new Set(
      scopedSeatReferences
        .map((seat) => seat.departmentId)
        .filter((departmentId): departmentId is string => Boolean(departmentId && effectiveDepartmentIds.includes(departmentId)))
    ));
    const visibleDepartmentRows = await fastify.prisma.department.findMany({
      where: {
        isActive: true,
        id: { in: visibleDepartmentIds },
        unitId: { in: effectiveUnitIds }
      },
      select: {
        id: true,
        name: true,
        code: true,
        colorHex: true,
        unitId: true
      },
      orderBy: [{ code: 'asc' }, { name: 'asc' }, { id: 'asc' }]
    });
    const departmentRowsByBusinessKey = new Map<string, typeof visibleDepartmentRows[number]>();
    for (const department of visibleDepartmentRows) {
      const businessKey = `${department.unitId || ''}\u0000${department.code.trim().toUpperCase()}`;
      if (!departmentRowsByBusinessKey.has(businessKey)) departmentRowsByBusinessKey.set(businessKey, department);
    }
    const departments = [...departmentRowsByBusinessKey.values()];

    // 7. Fetch Sections (Distinct from employees on visible workstations)
    const selectedDeptId = query.departmentId && query.departmentId !== 'ALL' ? query.departmentId : undefined;
    const selectedDepartment = selectedDeptId
      ? visibleDepartmentRows.find((department) => department.id === selectedDeptId)
      : undefined;
    const filterDepartmentIds = selectedDepartment
      ? visibleDepartmentRows
          .filter((department) => department.unitId === selectedDepartment.unitId && department.code === selectedDepartment.code)
          .map((department) => department.id)
      : visibleDepartmentIds;
    const scopedEmployeeIds = Array.from(new Set(
      scopedSeatReferences
        .filter((seat) => Boolean(seat.employeeId) && filterDepartmentIds.includes(seat.departmentId || ''))
        .map((seat) => seat.employeeId!)
    ));
    const sectionEmployees = await fastify.prisma.employee.findMany({
      where: {
        id: { in: scopedEmployeeIds },
        section: { not: null }
      },
      select: { section: true },
      distinct: ['section']
    });

    const sections = Array.from(
      new Set(
        sectionEmployees
          .map((e) => e.section?.trim())
          .filter((s): s is string => Boolean(s && s.length > 0 && s !== '0' && s !== '#N/A'))
      )
    ).sort((a, b) => a.localeCompare(b));
    const departmentById = new Map(departments.map((d) => [d.id, d]));
    const rawSectionOptions = await fastify.prisma.section.findMany({
      where: filterDepartmentIds ? { departmentId: { in: filterDepartmentIds } } : {},
      select: { id: true, name: true, departmentId: true, isActive: true },
      orderBy: { name: 'asc' }
    });
    const sectionOptions = rawSectionOptions.map((section) => {
      const dept = departmentById.get(section.departmentId);
      return {
        ...section,
        displayName: [dept?.name, section.name].filter(Boolean).join(' → ')
      };
    }).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    // 8. Fetch Functions (Distinct from employees matching section/department)
    const selectedSection = query.section && query.section !== 'ALL' ? query.section.trim() : undefined;
    const selectedSectionIds = selectedSection
      ? (await fastify.prisma.section.findMany({
          where: {
            OR: [
              { name: selectedSection },
              { normalizedName: selectedSection.replace(/\s+/g, ' ').toLocaleLowerCase('en-IN') },
              { name: { equals: selectedSection, mode: 'insensitive' } }
            ],
            ...(filterDepartmentIds ? { departmentId: { in: filterDepartmentIds } } : {})
          },
          select: { id: true }
        })).map((section) => section.id)
      : undefined;
    const functionEmployees = await fastify.prisma.employee.findMany({
      where: {
        id: { in: scopedEmployeeIds },
        ...(selectedSection
          ? {
              OR: [
                { section: selectedSection },
                { section: { equals: selectedSection, mode: 'insensitive' } },
                ...(selectedSectionIds && selectedSectionIds.length > 0 ? [{ sectionId: { in: selectedSectionIds } }] : [])
              ]
            }
          : {}),
        functionName: { not: null }
      },
      select: { functionName: true },
      distinct: ['functionName']
    });

    const functions = Array.from(
      new Set(
        functionEmployees
          .map((e) => e.functionName?.trim())
          .filter((f): f is string => Boolean(f && f.length > 0 && f !== '0' && f !== '#N/A'))
      )
    ).sort((a, b) => a.localeCompare(b));
    const sectionById = new Map(sectionOptions.map((s) => [s.id, s]));
    const rawFunctionOptions = await fastify.prisma.orgFunction.findMany({
      where: selectedSectionIds ? { sectionId: { in: selectedSectionIds } } : {},
      select: { id: true, name: true, sectionId: true, isActive: true },
      orderBy: { name: 'asc' }
    });
    const functionOptions = rawFunctionOptions.map((fn) => {
      const section = sectionById.get(fn.sectionId);
      const dept = section ? departmentById.get(section.departmentId) : null;
      return {
        ...fn,
        displayName: [dept?.name, section?.name, fn.name].filter(Boolean).join(' → ')
      };
    }).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    // 9. Standard Status Choices
    const statuses = [
      { value: 'ALL', label: 'All Statuses' },
      { value: 'OCCUPIED', label: 'Occupied' },
      { value: 'AVAILABLE', label: 'Vacant / Available' },
      { value: 'RESERVED', label: 'Reserved' },
      { value: 'MAINTENANCE', label: 'Maintenance / Blocked' }
    ];

    return reply.status(200).send({
      units,
      buildings: formattedBuildings,
      floors,
      officeAreas,
      areaOptions,
      departments,
      sections,
      sectionOptions,
      functions,
      functionOptions,
      statuses,
      userScope: {
        role: request.admin?.role || 'UNIT_ADMIN',
        isRestricted: scope.isRestricted,
        lockedUnitId: scope.lockedUnitId,
        assignedUnitName: scope.assignedUnitName
      }
    });
  });
};
