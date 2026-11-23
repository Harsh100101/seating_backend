import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { TransferRequestStatus } from '@seating/shared';
import { logAudit } from '../services/audit.service.js';
import { getAvailableSeatCount, getUnitCapacityMap } from '../services/capacity.service.js';
import { runTransactionWithRetry } from '../services/transaction-retry.service.js';
import { classifyTransferUniqueConflict } from '../services/transfer-unique-conflict.service.js';
import { destinationConflict, destinationConflictResponse } from '../services/transfer-destination-conflict.service.js';
import { persistNotification } from '../services/notification.service.js';
import { canCreateTransfer, canDecideTransfer, canViewTransfer, isTransferBusinessAdmin } from '../utils/transfer-policy.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';
import { unitIdFromBuilding } from '../utils/building-unit.js';

interface DestinationSelection {
  targetUnitId: string;
  targetPlantId?: string | null;
  targetBuildingId?: string | null;
  targetFloorId?: string | null;
  areaId?: string | null;
  departmentId?: string | null;
  sectionId?: string | null;
  functionId?: string | null;
  seatId: string;
}

async function notifyUnitAdmins(
  prisma: any,
  unitId: string,
  input: Omit<Parameters<typeof persistNotification>[1], 'recipientAdminId' | 'dedupeKey'> & { dedupePrefix: string }
) {
  const { dedupePrefix, transferRequestId, type, title, message } = input;
  let recipients = await prisma.adminUser.findMany({
    where: { role: 'UNIT_ADMIN', assignedUnitId: unitId },
    select: { id: true, isActive: true, deletedAt: true }
  });
  recipients = recipients.filter((admin: any) => admin.isActive !== false && !admin.deletedAt);

  if (!recipients.length) {
    console.warn(`[transfer-requests] No active Unit Admin recipient exists for Unit ${unitId}. Falling back to active SUPER_ADMIN accounts.`);
    const superAdmins = await prisma.adminUser.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true, isActive: true, deletedAt: true }
    });
    recipients = superAdmins.filter((admin: any) => admin.isActive !== false && !admin.deletedAt);
    if (!recipients.length) {
      console.warn(`[transfer-requests] No active SUPER_ADMIN found to receive fallback notification for Unit ${unitId}.`);
    }
  }

  for (const recipient of recipients) {
    await persistNotification(prisma, {
      transferRequestId,
      type,
      title,
      message,
      recipientAdminId: recipient.id,
      dedupeKey: `${dedupePrefix}:${recipient.id}`
    });
  }
}

async function notifyAdmin(
  prisma: any,
  recipientAdminId: string | null | undefined,
  input: Omit<Parameters<typeof persistNotification>[1], 'recipientAdminId' | 'dedupeKey'> & { dedupePrefix: string }
) {
  if (!recipientAdminId) {
    throw new Error('NOTIFICATION_RECIPIENT_MISSING: Notification recipient is unavailable.');
  }
  const { dedupePrefix, transferRequestId, type, title, message } = input;
  await persistNotification(prisma, {
    transferRequestId,
    type,
    title,
    message,
    recipientAdminId,
    dedupeKey: `${dedupePrefix}:${recipientAdminId}`
  });
}

/** Validate the receiving admin's final hierarchy and return trusted records. */
async function validateDestination(tx: Prisma.TransactionClient, selection: DestinationSelection) {
  const seat = await tx.seat.findUnique({
    where: { id: selection.seatId },
    include: {
      area: true,
      floor: { include: { building: { include: { plant: true } } } }
    }
  });

  if (!seat) throw new Error('DESTINATION_INVALID: Selected destination workstation was not found.');
  if (seat.employeeId) {
    throw destinationConflict('OCCUPIED', `Workstation ${seat.label} is already occupied.`, {
      seatId: seat.id,
      employeeId: seat.employeeId,
      status: seat.status,
      phase: 'validation'
    });
  }
  if (seat.status !== 'AVAILABLE') {
    throw destinationConflict('UNAVAILABLE', `Workstation ${seat.label} is not available (status: ${seat.status}).`, {
      seatId: seat.id,
      employeeId: seat.employeeId,
      status: seat.status,
      phase: 'validation'
    });
  }

  const actualFloor = seat.floor;
  const actualBuilding = actualFloor?.building;
  const actualPlant = actualBuilding?.plant;
  const actualUnitId = actualPlant?.unitId;
  if (!actualFloor || !actualBuilding || !actualPlant || actualFloor.isActive === false || actualBuilding.isActive === false || actualUnitId !== selection.targetUnitId) {
    throw new Error('DESTINATION_INVALID: Workstation does not belong to the target Unit.');
  }
  if (selection.targetPlantId && selection.targetPlantId !== actualPlant.id) {
    throw new Error('DESTINATION_INVALID: Plant does not belong to the target Unit.');
  }
  if (selection.targetBuildingId && selection.targetBuildingId !== actualBuilding.id) {
    throw new Error('DESTINATION_INVALID: Building does not contain the selected workstation.');
  }
  if (selection.targetFloorId && selection.targetFloorId !== actualFloor.id) {
    throw new Error('DESTINATION_INVALID: Floor does not contain the selected workstation.');
  }

  const area = selection.areaId
    ? await tx.area.findUnique({ where: { id: selection.areaId } })
    : null;
  if (selection.areaId && (!area || area.floorId !== actualFloor.id || seat.areaId !== area.id)) {
    throw new Error('DESTINATION_INVALID: Office / Area does not belong to the selected Floor.');
  }

  // The receiving admin must explicitly select an existing target-unit
  // department. Never infer or create a sister department from the source.
  const department = selection.departmentId
    ? await tx.department.findUnique({ where: { id: selection.departmentId } })
    : null;
  if (!department || (department.unitId && department.unitId !== selection.targetUnitId)) {
    throw new Error('DESTINATION_INVALID: An existing Department in the target Unit is required.');
  }

  const section = selection.sectionId
    ? await tx.section.findUnique({ where: { id: selection.sectionId }, include: { department: true } })
    : null;
  if (selection.sectionId && (!section || section.departmentId !== department.id || (section.department?.unitId && section.department.unitId !== selection.targetUnitId))) {
    throw new Error('DESTINATION_INVALID: Section does not belong to the selected Department.');
  }

  const orgFunction = selection.functionId
    ? await tx.orgFunction.findUnique({ where: { id: selection.functionId }, include: { section: { include: { department: true } } } })
    : null;
  if (selection.functionId && (!orgFunction || orgFunction.sectionId !== section?.id || (orgFunction.section?.department?.unitId && orgFunction.section.department.unitId !== selection.targetUnitId))) {
    throw new Error('DESTINATION_INVALID: Function does not belong to the selected Section.');
  }

  return {
    seat,
    area,
    department,
    section,
    orgFunction,
    plantId: actualPlant.id,
    buildingId: actualBuilding.id,
    floorId: actualFloor.id
  };
}

/**
 * Admin-Only Visibility Guard
 * - SUPER_ADMIN: sees all requests across all units.
 * - UNIT_ADMIN: sees requests where their assignedUnitId is either sourceUnitId or targetUnitId.
 * - TECH_ADMIN: global business and technical visibility.
 */
export function isRequestVisibleToUser(
  req: any,
  user: { id?: string; role?: string; assignedUnitId?: string | null }
): boolean {
  return canViewTransfer(user, req.sourceUnitId, req.targetUnitId);
}

export const transferRequestRoutes: FastifyPluginAsync = async (fastify) => {
  // Return only unit names and authoritative available-seat counts. Hierarchy
  // records are loaded by the receiving admin through unit-scoped APIs.
  fastify.get('/options', async (request, reply) => {
    if (!request.admin) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }
    if (!isTransferBusinessAdmin(request.admin.role)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Transfer options are restricted to business administrators.' });
    }

    const units = await fastify.prisma.unit.findMany({
      where: unitSelectorWhere(),
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true }
    });
    const capacity = await getUnitCapacityMap(fastify.prisma, units.map((unit: any) => unit.id));
    const eligibleUnits = units.filter((unit: any) => (capacity.get(unit.id)?.totalSeats || 0) > 0);
    const availableSeatCounts = eligibleUnits.map((unit: any) => ({
      unitId: unit.id,
      availableSeats: capacity.get(unit.id)?.availableSeats || 0
    }));

    // Do not return destination hierarchy records or seat/employee identities
    // to the source admin. The receiving admin loads its own hierarchy through
    // the normal unit-scoped APIs during approval.
    return reply.status(200).send({ units: eligibleUnits, availableSeatCounts });
  });

  // GET /api/transfer-requests - Filtered master view for Admins
  fastify.get('/', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const { status, sourceUnitId, targetUnitId, employeeId } = request.query as {
      status?: TransferRequestStatus;
      sourceUnitId?: string;
      targetUnitId?: string;
      employeeId?: string;
      page?: string;
      limit?: string;
    };

    const page = Math.max(1, Number((request.query as any)?.page) || 1);
    const limit = Math.max(1, Math.min(100, Number((request.query as any)?.limit) || 25));
    const skip = (page - 1) * limit;

    const role = user.role;

    if (!isTransferBusinessAdmin(role)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This administrator role does not have transfer workflow access.'
      });
    }

    // Base database filters
    const where: any = {};
    if (status) where.status = status;
    if (sourceUnitId) where.sourceUnitId = sourceUnitId;
    if (targetUnitId) where.targetUnitId = targetUnitId;
    if (employeeId) where.employeeId = employeeId;

    if (role === 'UNIT_ADMIN') {
      if (!user.assignedUnitId) {
        return reply.status(200).send([]);
      }
      where.OR = [
        { sourceUnitId: user.assignedUnitId },
        { targetUnitId: user.assignedUnitId }
      ];
    }

    const [total, requests] = await Promise.all([
      fastify.prisma.seatTransferRequest.count({ where }),
      fastify.prisma.seatTransferRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        // Never load multi-megabyte proof data for a list response.
        select: {
          id: true,
          requestNumber: true,
          employeeId: true,
          sourceUnitId: true,
          sourceFloorId: true,
          sourceSeatId: true,
          targetUnitId: true,
          targetPlantId: true,
          targetBuildingId: true,
          targetFloorId: true,
          targetSeatId: true,
          proofFileName: true,
          reason: true,
          status: true,
          managerApproval: true,
          hodApproval: true,
          sourceAdminApproval: true,
          targetAdminApproval: true,
          rejectedByRole: true,
          rejectionReason: true,
          createdAt: true,
          updatedAt: true,
          employee: { include: { department: true } }
        }
      })
    ]);

    const visibleRequests = requests.filter((req: any) => isRequestVisibleToUser(req, user));

    // Enrich with names for UI consumption via high-performance batch lookup
    const unitIds = new Set<string>();
    const plantIds = new Set<string>();
    const buildingIds = new Set<string>();
    const floorIds = new Set<string>();
    const seatIds = new Set<string>();

    for (const req of visibleRequests) {
      if (req.sourceUnitId) unitIds.add(req.sourceUnitId);
      if (req.targetUnitId) unitIds.add(req.targetUnitId);
      if (req.targetPlantId) plantIds.add(req.targetPlantId);
      if (req.targetBuildingId) buildingIds.add(req.targetBuildingId);
      if (req.sourceFloorId) floorIds.add(req.sourceFloorId);
      if (req.targetFloorId) floorIds.add(req.targetFloorId);
      if (req.sourceSeatId) seatIds.add(req.sourceSeatId);
      if (req.targetSeatId) seatIds.add(req.targetSeatId);
    }

    const [units, plants, buildings, floors, seats] = await Promise.all([
      unitIds.size > 0
        ? fastify.prisma.unit.findMany({ where: { id: { in: Array.from(unitIds) } }, select: { id: true, name: true } })
        : [],
      plantIds.size > 0
        ? fastify.prisma.plant.findMany({ where: { id: { in: Array.from(plantIds) } }, select: { id: true, name: true } })
        : [],
      buildingIds.size > 0
        ? fastify.prisma.building.findMany({ where: { id: { in: Array.from(buildingIds) } }, select: { id: true, name: true } })
        : [],
      floorIds.size > 0
        ? fastify.prisma.floor.findMany({ where: { id: { in: Array.from(floorIds) } }, select: { id: true, name: true } })
        : [],
      seatIds.size > 0
        ? fastify.prisma.seat.findMany({ where: { id: { in: Array.from(seatIds) } }, select: { id: true, label: true } })
        : []
    ]);

    const unitMap = new Map<string, string>(units.map((u: any) => [u.id, u.name]));
    const plantMap = new Map<string, string>(plants.map((p: any) => [p.id, p.name]));
    const buildingMap = new Map<string, string>(buildings.map((b: any) => [b.id, b.name]));
    const floorMap = new Map<string, string>(floors.map((f: any) => [f.id, f.name]));
    const seatMap = new Map<string, string>(seats.map((s: any) => [s.id, s.label]));

    const enriched = visibleRequests.map((req: any) => ({
      ...req,
      employee: req.employee && !(req.status === 'CANCELLED' && req.rejectionReason === 'Employee record was deleted')
        ? req.employee
        : (req.employeeId ? {
        id: req.employeeId,
        fullName: 'Deleted Employee',
        employeeCode: 'N/A',
        email: '',
        department: null
      } : null),
      sourceUnitName: req.sourceUnitId ? unitMap.get(req.sourceUnitId) || null : null,
      sourceFloorName: req.sourceFloorId ? floorMap.get(req.sourceFloorId) || null : null,
      sourceSeatLabel: req.sourceSeatId ? seatMap.get(req.sourceSeatId) || null : null,
      targetUnitName: req.targetUnitId ? unitMap.get(req.targetUnitId) || null : null,
      targetPlantName: req.targetPlantId ? plantMap.get(req.targetPlantId) || null : null,
      targetBuildingName: req.targetBuildingId ? buildingMap.get(req.targetBuildingId) || null : null,
      targetFloorName: req.targetFloorId ? floorMap.get(req.targetFloorId) || null : null,
      targetSeatLabel: req.targetSeatId ? seatMap.get(req.targetSeatId) || null : null
    }));

    // Keep the historical array response for existing clients while exposing
    // pagination metadata through standard response headers.
    reply.header('X-Page', String(page));
    reply.header('X-Page-Size', String(limit));
    reply.header('X-Total-Count', String(total));
    reply.header('X-Total-Pages', String(Math.max(1, Math.ceil(total / limit))));
    return reply.status(200).send(enriched);
  });

  // GET /api/transfer-requests/:id - Single request details
  fastify.get('/:id', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    if (!isTransferBusinessAdmin(user.role)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Technical administrators do not have transfer workflow access.'
      });
    }

    const { id } = request.params as { id: string };

    const reqRecord = await fastify.prisma.seatTransferRequest.findUnique({
      where: { id },
      include: {
        employee: {
          include: {
            department: true
          }
        }
      }
    });

    if (!reqRecord) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Seat transfer request not found' });
    }

    if (!isRequestVisibleToUser(reqRecord, user)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You do not have permission to view this transfer request.'
      });
    }

    const [sourceUnit, targetUnit, targetFloor, sourceSeat, targetSeat] = await Promise.all([
      reqRecord.sourceUnitId ? fastify.prisma.unit.findUnique({ where: { id: reqRecord.sourceUnitId } }) : null,
      fastify.prisma.unit.findUnique({ where: { id: reqRecord.targetUnitId } }),
      reqRecord.targetFloorId
        ? fastify.prisma.floor.findUnique({ where: { id: reqRecord.targetFloorId } })
        : null,
      reqRecord.sourceSeatId ? fastify.prisma.seat.findUnique({ where: { id: reqRecord.sourceSeatId } }) : null,
      reqRecord.targetSeatId ? fastify.prisma.seat.findUnique({ where: { id: reqRecord.targetSeatId } }) : null
    ]);

    return reply.status(200).send({
      ...reqRecord,
      employee: reqRecord.employee && !(reqRecord.status === 'CANCELLED' && reqRecord.rejectionReason === 'Employee record was deleted')
        ? reqRecord.employee
        : (reqRecord.employeeId ? {
        id: reqRecord.employeeId,
        fullName: 'Deleted Employee',
        employeeCode: 'N/A',
        email: '',
        department: null
      } : null),
      sourceUnitName: sourceUnit?.name || null,
      targetUnitName: targetUnit?.name || null,
      targetFloorName: targetFloor?.name || null,
      sourceSeatLabel: sourceSeat?.label || null,
      targetSeatLabel: targetSeat?.label || null
    });
  });

  // POST /api/transfer-requests - Unit Admin or Super Admin submits a cross-Unit request
  fastify.post('/', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const userRole = user.role;
    if (!isTransferBusinessAdmin(userRole)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Only a Unit Admin or Super Admin can initiate a Unit-to-Unit transfer request.'
      });
    }

    const {
      targetUnitId,
      sourceUnitId: requestedSourceUnitId,
      targetFloorId,
      targetSeatId,
      reason,
      employeeId,
      proofImageUrl,
      proofFileName
    } = request.body as {
      targetUnitId: string;
      sourceUnitId?: string;
      targetFloorId?: string;
      targetSeatId?: string;
      reason: string;
      employeeId: string;
      proofImageUrl?: string;
      proofFileName?: string;
    };

    if (!targetUnitId || !reason || !reason.trim() || !employeeId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'targetUnitId, employeeId, and reason are required'
      });
    }

    const targetUnit = await fastify.prisma.unit.findUnique({ where: { id: targetUnitId }, select: { id: true } });
    if (!targetUnit) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Target Unit was not found.' });
    }

    const availableDestinationSeats = await getAvailableSeatCount(fastify.prisma, targetUnitId);
    if (availableDestinationSeats < 1) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'The destination Unit has no available seats.'
      });
    }

    if (proofImageUrl) {
      const isBase64Image = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(proofImageUrl);
      if (!isBase64Image) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'proofImageUrl must be a valid base64 image data URL (e.g. data:image/png;base64,...)'
        });
      }
      const encodedPayload = proofImageUrl.slice(proofImageUrl.indexOf(',') + 1);
      const decodedBytes = Buffer.from(encodedPayload, 'base64').byteLength;
      if (decodedBytes > 1024 * 1024) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'proofImageUrl must not exceed 1 MB'
        });
      }
    }

    const employee = await fastify.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { department: true }
    });

    if (!employee) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Employee with id ${employeeId} not found`
      });
    }

    if (!employee.isActive) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'INACTIVE_EMPLOYEE',
        message: 'Inactive employees cannot be transferred.'
      });
    }

    const requestedSourceUnit = requestedSourceUnitId
      ? await fastify.prisma.unit.findUnique({ where: { id: requestedSourceUnitId }, select: { id: true } })
      : null;
    if (requestedSourceUnitId && !requestedSourceUnit) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'INVALID_SOURCE_UNIT',
        message: 'The selected source Unit was not found.'
      });
    }

    if (userRole === 'SUPER_ADMIN' && !requestedSourceUnitId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'SOURCE_UNIT_REQUIRED',
        message: 'Super Admin transfer requests must specify a source Unit.'
      });
    }

    // Snapshot current seat
    let sourceUnitId: string | null = null;
    let sourceFloorId: string | null = null;
    let sourceSeatId: string | null = null;

    const currentSeat = await fastify.prisma.seat.findFirst({
      where: { employeeId: employee.id },
      include: {
        floor: {
          include: {
            building: {
              include: {
                unit: true,
                plant: true
              }
            }
          }
        }
      }
    });

    if (currentSeat) {
      sourceSeatId = currentSeat.id;
      sourceFloorId = currentSeat.floorId;
      sourceUnitId = unitIdFromBuilding(currentSeat.floor?.building);
    } else {
      sourceUnitId = employee.department?.unitId || null;
    }

    // The source Unit is always derived from trusted seat/department data. A
    // submitted sourceUnitId is only a selection hint and must match it.
    if (!sourceUnitId) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Employee source Unit could not be resolved.' });
    }
    if (requestedSourceUnitId && requestedSourceUnitId !== sourceUnitId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'SOURCE_UNIT_EMPLOYEE_MISMATCH',
        message: 'The selected employee does not belong to the selected source Unit.'
      });
    }
    if (!canCreateTransfer(user, sourceUnitId)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'You are not authorized to initiate a transfer for an employee within their assigned unit.'
      });
    }

    if (sourceUnitId && sourceUnitId === targetUnitId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'SAME_UNIT_TRANSFER_NOT_ALLOWED',
        message: 'Same-Unit seat changes must use the separate seat reassignment workflow.'
      });
    }

    // =========================================================================
    // CASE A: SAME-UNIT TRANSFER (legacy branch retained for compatibility;
    // the guard above routes current requests to seat reassignment instead.)
    // =========================================================================
    if (sourceUnitId && sourceUnitId === targetUnitId) {
      if (!targetSeatId) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Same-unit transfers must specify a targetSeatId for direct allocation.'
        });
      }

      const targetSeat = await fastify.prisma.seat.findUnique({
        where: { id: targetSeatId },
        include: { floor: { include: { building: { include: { unit: true, plant: true } } } } }
      });

      if (!targetSeat || unitIdFromBuilding(targetSeat.floor?.building) !== targetUnitId || (targetFloorId && targetSeat.floorId !== targetFloorId)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Selected target seat does not exist on target floor.'
        });
      }

      if (targetSeat.employeeId && targetSeat.employeeId !== employee.id) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'TRANSFER_DESTINATION_ALREADY_OCCUPIED',
          message: `Target seat ${targetSeat.label} is already occupied.`
        });
      }

      if (targetSeat.status !== 'AVAILABLE') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'TRANSFER_DESTINATION_NOT_AVAILABLE',
          message: `Cannot assign seat with status '${targetSeat.status}'. Only AVAILABLE seats can be allocated.`
        });
      }

      let updatedTargetSeat: any;
      try {
        updatedTargetSeat = await fastify.prisma.$transaction(async (tx) => {
          const freshTarget = await tx.seat.findUnique({ where: { id: targetSeatId } });
          if (!freshTarget) {
            throw new Error('DESTINATION_INVALID: Selected destination workstation was not found.');
          }
          if (freshTarget.employeeId && freshTarget.employeeId !== employee.id) {
            throw destinationConflict('OCCUPIED', `Target workstation ${freshTarget.label} is already occupied.`, {
              seatId: freshTarget.id,
              employeeId: freshTarget.employeeId,
              status: freshTarget.status,
              phase: 'validation'
            });
          }
          if (freshTarget.status !== 'AVAILABLE') {
            throw destinationConflict('UNAVAILABLE', `Target workstation ${freshTarget.label} is no longer available (status: ${freshTarget.status}).`, {
              seatId: freshTarget.id,
              employeeId: freshTarget.employeeId,
              status: freshTarget.status,
              phase: 'validation'
            });
          }
          if (sourceSeatId) {
            const released = await tx.seat.updateMany({
              where: { id: sourceSeatId, employeeId: employee.id },
              data: {
                employeeId: { unset: true },
                departmentId: null,
                status: 'AVAILABLE'
              }
            });
            if (released.count !== 1) {
              throw new Error('STALE_REQUEST: Source workstation occupant changed during same-unit transfer.');
            }
          }

          const claimed = await tx.seat.updateMany({
            // MongoDB distinguishes an explicit null from a missing optional
            // field. Older layout saves omitted employeeId on vacant seats,
            // while released seats may store null, so both are vacant states.
            where: {
              id: targetSeatId,
              status: 'AVAILABLE',
              OR: [{ employeeId: null }, { employeeId: { isSet: false } }]
            },
            data: {
              employeeId: employee.id,
              departmentId: employee.departmentId
            }
          });
          if (claimed.count !== 1) {
            throw destinationConflict('RACE_LOST', 'The destination workstation was allocated by another request.', {
              seatId: targetSeatId,
              employeeId: null,
              status: 'AVAILABLE',
              phase: 'claim',
              claimCount: claimed.count
            });
          }

          return tx.seat.findUnique({
            where: { id: targetSeatId },
            include: {
              department: true,
              employee: true,
              floor: true
            }
          });
        });
      } catch (err: any) {
        const destinationConflictResult = destinationConflictResponse(err);
        if (destinationConflictResult) {
          request.log.warn({
            transferRequestId: null,
            employeeId: employee.id,
            destinationSeatId: targetSeatId,
            requestStatus: 'DIRECT_SAME_UNIT',
            ...err.destinationContext
          }, 'Destination allocation conflict');
          return reply.status(409).send({ statusCode: 409, ...destinationConflictResult });
        }
        if (err?.code === 'P2002') {
          return reply.status(409).send({ statusCode: 409, ...classifyTransferUniqueConflict(err) });
        }
        request.log.error({ err, employeeId: employee.id }, 'Same-unit transfer failed');
        return reply.status(500).send({
          statusCode: 500,
          error: 'TRANSFER_APPROVAL_FAILED',
          message: 'The workstation transfer could not be completed. No workstation change was saved. Please try again or contact an administrator.'
        });
      }

      await logAudit(fastify.prisma, request, 'SEAT_ASSIGNED', 'Seat', targetSeatId, {
        employeeId: employee.id,
        employeeName: employee.fullName,
        previousSeatId: sourceSeatId,
        newSeatId: targetSeatId,
        isSameUnitDirectTransfer: true,
        reason
      });

      return reply.status(200).send({
        success: true,
        message: `Same-unit transfer completed directly: ${employee.fullName} allocated to ${updatedTargetSeat.label}.`,
        isSameUnit: true,
        seat: updatedTargetSeat
      });
    }

    // =========================================================================
    // CASE B: CROSS-UNIT TRANSFER (Source Admin -> Target Admin Approval)
    // =========================================================================
    // Concurrency Lock: Prevent duplicate active requests for same employee
    const existingActiveEmpRequest = await fastify.prisma.seatTransferRequest.findFirst({
      where: {
        employeeId: employee.id,
        status: TransferRequestStatus.PENDING_TARGET_ADMIN
      }
    });

    if (existingActiveEmpRequest) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `Employee ${employee.fullName} already has an active transfer request (${existingActiveEmpRequest.requestNumber}) in progress.`
      });
    }

    // Generate collision-safe sequential requestNumber
    const currentYear = new Date().getFullYear();
    const prefix = `REQ-${currentYear}-`;
    const latestReq = await fastify.prisma.seatTransferRequest.findFirst({
      where: { requestNumber: { startsWith: prefix } },
      orderBy: { requestNumber: 'desc' },
      select: { requestNumber: true }
    });

    let nextSeq = 1;
    if (latestReq?.requestNumber) {
      const match = latestReq.requestNumber.match(/REQ-\d{4}-(\d+)/);
      if (match) {
        nextSeq = parseInt(match[1], 10) + 1;
      }
    } else {
      const totalCount = await fastify.prisma.seatTransferRequest.count();
      nextSeq = totalCount + 1;
    }

    const sourceAdminSignature = {
      approvedById: user.id,
      approverName: user.name,
      action: 'SUBMITTED',
      comment: reason,
      timestamp: new Date().toISOString()
    };

    let newRequest: any = null;
    let attempts = 0;
    while (!newRequest && attempts < 5) {
      attempts++;
      const candidateNumber = `REQ-${currentYear}-${String(nextSeq).padStart(4, '0')}`;
      try {
        newRequest = await fastify.prisma.$transaction(async (tx) => {
          const created = await tx.seatTransferRequest.create({
            data: {
              requestNumber: candidateNumber,
              employeeId: employee.id,
              activeTransferKey: employee.id,
              sourceUnitId,
              sourceFloorId,
              sourceSeatId,
              targetUnitId,
              // The source admin does not choose destination hierarchy for a
              // cross-unit request. The target admin supplies it at approval.
              targetPlantId: null,
              targetBuildingId: null,
              targetFloorId: null,
              targetSeatId: null,
              proofImageUrl: proofImageUrl || null,
              proofFileName: proofFileName || null,
              reason,
              status: TransferRequestStatus.PENDING_TARGET_ADMIN,
              sourceAdminApproval: sourceAdminSignature
            },
            include: {
              employee: {
                include: {
                  department: true
                }
              }
            }
          });

          await notifyUnitAdmins(tx, targetUnitId, {
            transferRequestId: created.id,
            type: 'TRANSFER_PENDING',
            title: 'Incoming transfer request',
            message: `${employee.fullName} is awaiting approval by your Unit Admin team.`,
            dedupePrefix: `transfer:${created.id}:pending`
          });
          return created;
        });
      } catch (err: any) {
        const uniqueTarget = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
        if (err.code === 'P2002' && uniqueTarget.includes('activeTransferKey')) {
          return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: `Employee ${employee.fullName} already has an active transfer request.`
          });
        }
        if (err.code === 'P2002' && attempts < 5) {
          nextSeq++;
          continue;
        }
        throw err;
      }
    }

    await logAudit(fastify.prisma, request, 'TRANSFER_REQUEST_CREATED', 'SeatTransferRequest', newRequest.id, {
      requestNumber: newRequest.requestNumber,
      employeeId: employee.id,
      employeeName: employee.fullName,
      sourceUnitId,
      sourceSeatId,
      targetUnitId,
      reason,
      status: TransferRequestStatus.PENDING_TARGET_ADMIN
    });

    return reply.status(201).send(newRequest);
  });

  // POST /api/transfer-requests/:id/cancel - Source requester cancellation
  fastify.post('/:id/cancel', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }
    if (user.role !== 'UNIT_ADMIN') {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Only the source Unit Admin can cancel a pending transfer.' });
    }

    const { id } = request.params as { id: string };
    const existing = await fastify.prisma.seatTransferRequest.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Seat transfer request not found' });
    if (existing.status !== TransferRequestStatus.PENDING_TARGET_ADMIN) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Only pending transfer requests can be cancelled.' });
    }

    const sourceAdminId = (existing.sourceAdminApproval as any)?.approvedById;
    const isSourceRequester = user.role === 'UNIT_ADMIN' && sourceAdminId === user.id;
    if (!isSourceRequester) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Only the initiating source Unit Admin can cancel this transfer.' });
    }

    const cancellationReason = ((request.body as any)?.reason || 'Transfer request cancelled by source Unit Admin').toString().trim();
    const updated = await fastify.prisma.$transaction(async (tx) => {
      const transitioned = await tx.seatTransferRequest.updateMany({
        where: { id, status: TransferRequestStatus.PENDING_TARGET_ADMIN },
        data: {
          status: TransferRequestStatus.CANCELLED,
          activeTransferKey: { unset: true },
          rejectedByRole: user.role,
          rejectionReason: cancellationReason,
          targetAdminApproval: {
            approvedById: user.id,
            approverName: user.name,
            adminRole: user.role,
            action: 'CANCELLED',
            comment: cancellationReason,
            timestamp: new Date().toISOString()
          }
        }
      });
      if (transitioned.count !== 1) return null;

      // Auto-mark incoming pending notifications for this transfer request as read
      await tx.notification.updateMany({
        where: {
          transferRequestId: id,
          type: { in: ['TRANSFER_PENDING', 'INCOMING_TRANSFER_REQUEST'] },
          OR: [{ readAt: null }, { readAt: { isSet: false } }]
        },
        data: {
          readAt: new Date()
        }
      });

      await notifyUnitAdmins(tx, existing.targetUnitId, {
        transferRequestId: id,
        type: 'TRANSFER_CANCELLED',
        title: 'Transfer request cancelled',
        message: `Transfer request ${existing.requestNumber} was cancelled by the source administrator.`,
        dedupePrefix: `transfer:${id}:cancelled`
      });
      return tx.seatTransferRequest.findUnique({ where: { id } });
    });
    if (!updated) {
      return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'Transfer request changed state; refresh and retry.' });
    }

    await logAudit(fastify.prisma, request, 'TRANSFER_CANCELLED', 'SeatTransferRequest', id, {
      requestNumber: existing.requestNumber,
      action: 'CANCELLED',
      cancelledById: user.id,
      cancelledByName: user.name,
      reason: cancellationReason
    });
    return reply.status(200).send(updated);
  });

  // POST /api/transfer-requests/:id/action - Target Unit Admin or Super Admin decision
  fastify.post('/:id/action', async (request, reply) => {
    const user = request.admin;
    if (!user) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    }

    const { id } = request.params as { id: string };
    const {
      action,
      comment,
      assignedTargetSeatId,
      allocatedSeatId,
      targetPlantId,
      targetBuildingId,
      targetFloorId,
      areaId,
      departmentId,
      sectionId,
      functionId
    } = request.body as {
      action: 'APPROVE' | 'REJECT';
      comment?: string;
      assignedTargetSeatId?: string;
      allocatedSeatId?: string;
      targetPlantId?: string;
      targetBuildingId?: string;
      targetFloorId?: string;
      areaId?: string;
      departmentId?: string;
      sectionId?: string;
      functionId?: string;
    };

    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Valid action (APPROVE or REJECT) is required'
      });
    }

    const reqRecord = await fastify.prisma.seatTransferRequest.findUnique({
      where: { id },
      include: {
        employee: {
          include: {
            department: true
          }
        }
      }
    });

    if (!reqRecord) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Seat transfer request not found'
      });
    }

    if (
      reqRecord.status === TransferRequestStatus.APPROVED ||
      reqRecord.status === TransferRequestStatus.REJECTED ||
      reqRecord.status === TransferRequestStatus.CANCELLED
    ) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Transfer request is already finalized with status: ${reqRecord.status}`
      });
    }

    const role = user.role || 'UNIT_ADMIN';

    // Separation of Duties: An approver cannot approve their own transfer request
    const approverEmail = (user.email || '').trim().toLowerCase();
    const reqEmpEmail = (reqRecord.employee?.email || '').trim().toLowerCase();
    const isSelfApproval = Boolean(
      (user.employeeId && user.employeeId === reqRecord.employeeId) ||
      (approverEmail && reqEmpEmail && approverEmail === reqEmpEmail)
    );

    if (action !== 'REJECT' && isSelfApproval) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Separation of duties violation: Cannot approve your own transfer request'
      });
    }

    // -------------------------------------------------------------------------
    // ACTION: REJECT
    // -------------------------------------------------------------------------
    if (action === 'REJECT') {
      const canReject = canDecideTransfer(user, reqRecord.targetUnitId);

      if (!canReject) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the target Unit Admin or Super Admin can reject this transfer request.'
        });
      }

      // The request may have been approved concurrently after the initial
      // read. Require the state transition itself to still be pending so a
      // late rejection cannot overwrite an already-committed seat migration.
      const rejectionReason = comment || 'Transfer request rejected by Administrator';
      const updated = await fastify.prisma.$transaction(async (tx) => {
        const transitioned = await tx.seatTransferRequest.updateMany({
          where: {
            id: reqRecord.id,
            status: TransferRequestStatus.PENDING_TARGET_ADMIN
          },
          data: {
            status: TransferRequestStatus.REJECTED,
            activeTransferKey: { unset: true },
            rejectedByRole: role,
            rejectionReason,
            targetAdminApproval: {
              approvedById: user.id,
              approverName: user.name,
              adminRole: role,
              action: 'REJECT',
              comment: rejectionReason,
              timestamp: new Date().toISOString()
            }
          }
        });

        if (transitioned.count !== 1) return null;

        // Auto-mark incoming pending notifications for this transfer request as read
        await tx.notification.updateMany({
          where: {
            transferRequestId: reqRecord.id,
            type: { in: ['TRANSFER_PENDING', 'INCOMING_TRANSFER_REQUEST'] },
            OR: [{ readAt: null }, { readAt: { isSet: false } }]
          },
          data: {
            readAt: new Date()
          }
        });

        const sourceAdminId = (reqRecord.sourceAdminApproval as any)?.approvedById;
        await notifyAdmin(tx, sourceAdminId, {
          transferRequestId: reqRecord.id,
          type: 'TRANSFER_REJECTED',
          title: 'Transfer request rejected',
          message: `Transfer request ${reqRecord.requestNumber} was rejected by the destination administrator.`,
          dedupePrefix: `transfer:${reqRecord.id}:rejected`
        });
        return tx.seatTransferRequest.findUnique({
          where: { id: reqRecord.id },
          include: { employee: { include: { department: true } } }
        });
      });

      if (!updated) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Transfer request is no longer pending and cannot be rejected.'
        });
      }

      await logAudit(fastify.prisma, request, 'TRANSFER_REJECTED', 'SeatTransferRequest', reqRecord.id, {
        requestNumber: reqRecord.requestNumber,
        rejectedByRole: role,
        rejectionReason,
        rejectedById: user.id,
        rejectedByName: user.name
      });

      return reply.status(200).send(updated);
    }

    // -------------------------------------------------------------------------
    // ACTION: APPROVE (Target Unit Admin or Super Admin)
    // -------------------------------------------------------------------------
    if (action === 'APPROVE') {
      const isAllowed = canDecideTransfer(user, reqRecord.targetUnitId);
      if (!isAllowed) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the target Unit Admin or Super Admin can approve and allocate the seat.'
        });
      }

      const finalSeatId = allocatedSeatId || assignedTargetSeatId || reqRecord.targetSeatId;
      if (reqRecord.employee?.isActive === false) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'INACTIVE_EMPLOYEE',
          message: 'Inactive employees cannot complete a transfer.'
        });
      }
      if (!finalSeatId) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'A vacant desk on the target floor must be selected to finalize allocation.'
        });
      }

      const approvalPayload = {
        approvedById: user.id,
        approverName: user.name,
        adminRole: role,
        action: 'APPROVE',
        comment: comment || '',
        timestamp: new Date().toISOString()
      };

      try {
        const result = await runTransactionWithRetry(fastify.prisma, async (tx) => {
          const freshRequest = await tx.seatTransferRequest.findUnique({
            where: { id: reqRecord.id },
            include: { employee: { include: { department: true } } }
          });
          if (!freshRequest || freshRequest.status !== TransferRequestStatus.PENDING_TARGET_ADMIN) {
            throw new Error('STALE_REQUEST: Transfer request is no longer pending.');
          }
          if (freshRequest.employee?.isActive === false) {
            throw new Error('INACTIVE_EMPLOYEE: Inactive employees cannot complete a transfer.');
          }

          const currentSourceSeat = await tx.seat.findFirst({ where: { employeeId: freshRequest.employeeId } });
          if (
            (freshRequest.sourceSeatId && (!currentSourceSeat || currentSourceSeat.id !== freshRequest.sourceSeatId)) ||
            (!freshRequest.sourceSeatId && currentSourceSeat)
          ) {
            throw new Error('STALE_REQUEST: Employee workstation changed after the request was created.');
          }

          const destination = await validateDestination(tx, {
            targetUnitId: freshRequest.targetUnitId,
            targetPlantId: targetPlantId || freshRequest.targetPlantId,
            targetBuildingId: targetBuildingId || freshRequest.targetBuildingId,
            targetFloorId: targetFloorId || freshRequest.targetFloorId,
            areaId: areaId || null,
            departmentId: departmentId || null,
            sectionId: sectionId || null,
            functionId: functionId || null,
            seatId: finalSeatId
          });

          if (currentSourceSeat) {
            const released = await tx.seat.updateMany({
              where: { id: currentSourceSeat.id, employeeId: freshRequest.employeeId },
              data: {
                employeeId: { unset: true },
                departmentId: null,
                status: 'AVAILABLE'
              }
            });
            if (released.count !== 1) {
              throw new Error('STALE_REQUEST: Source workstation occupant changed during approval.');
            }
          }

          const claimed = await tx.seat.updateMany({
            // See the same missing-vs-null MongoDB distinction in the
            // same-unit allocation path above.
            where: {
              id: finalSeatId,
              status: 'AVAILABLE',
              OR: [{ employeeId: null }, { employeeId: { isSet: false } }]
            },
            data: {
              employeeId: freshRequest.employeeId,
              departmentId: destination.department.id,
              areaId: destination.area?.id || null,
              officeArea: destination.area?.name || destination.seat.officeArea || null
            }
          });
          if (claimed.count !== 1) {
            throw destinationConflict('RACE_LOST', 'The destination workstation was allocated by another request.', {
              seatId: finalSeatId,
              employeeId: null,
              status: 'AVAILABLE',
              phase: 'claim',
              claimCount: claimed.count
            });
          }

          if (!freshRequest.employeeId) {
            throw destinationConflict('RACE_LOST', 'The employee record is no longer available.', { phase: 'claim' });
          }

          await tx.employee.update({
            where: { id: freshRequest.employeeId },
            data: {
              departmentId: destination.department.id,
              sectionId: destination.section?.id || null,
              section: destination.section?.name || null,
              functionId: destination.orgFunction?.id || null,
              functionName: destination.orgFunction?.name || null,
              officeArea: destination.area?.name || destination.seat.officeArea || null
            }
          });

          const approvedRequest = await tx.seatTransferRequest.update({
            where: { id: freshRequest.id },
            data: {
              status: TransferRequestStatus.APPROVED,
              activeTransferKey: { unset: true },
              targetSeatId: finalSeatId,
              targetPlantId: destination.plantId,
              targetBuildingId: destination.buildingId,
              targetFloorId: destination.floorId,
              targetAdminApproval: approvalPayload
            },
            include: {
              employee: {
                include: { department: true, sectionMaster: true, functionMaster: true }
              }
            }
          });

          // Auto-mark incoming pending notifications for this transfer request as read
          await tx.notification.updateMany({
            where: {
              transferRequestId: freshRequest.id,
              type: { in: ['TRANSFER_PENDING', 'INCOMING_TRANSFER_REQUEST'] },
              OR: [{ readAt: null }, { readAt: { isSet: false } }]
            },
            data: {
              readAt: new Date()
            }
          });

          const sourceAdminId = (freshRequest.sourceAdminApproval as any)?.approvedById;
          await notifyAdmin(tx, sourceAdminId, {
            transferRequestId: freshRequest.id,
            type: 'TRANSFER_APPROVED',
            title: 'Transfer request approved',
            message: `Transfer request ${freshRequest.requestNumber} was approved and the employee was allocated a destination workstation.`,
            dedupePrefix: `transfer:${freshRequest.id}:approved`
          });

          return approvedRequest;
        });

        await logAudit(fastify.prisma, request, 'TARGET_ADMIN_APPROVED', 'SeatTransferRequest', reqRecord.id, {
          requestNumber: reqRecord.requestNumber,
          allocatedSeatId: finalSeatId,
          comment: comment || ''
        });

        return reply.status(200).send(result);
      } catch (err: any) {
        if (err?.code === 'P2034' || /write.?conflict|transient.?transaction|transaction.*conflict|unknowntransactioncommitresult/i.test(String(err?.message || ''))) {
          return reply.status(409).send({
            statusCode: 409,
            error: 'TRANSFER_TRANSACTION_CONFLICT',
            message: 'The transfer approval conflicted with another transaction. The latest workstation state must be loaded before retrying.'
          });
        }
        if (err?.code === 'P2002') {
          return reply.status(409).send({ statusCode: 409, ...classifyTransferUniqueConflict(err) });
        }
        if (err.message?.startsWith('CONCURRENT_CONFLICT')) {
          return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: err.message });
        }
        if (err.message?.startsWith('INVALID_STATUS')) {
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: err.message });
        }
        if (err.message?.startsWith('INACTIVE_EMPLOYEE')) {
          return reply.status(400).send({ statusCode: 400, error: 'INACTIVE_EMPLOYEE', message: err.message.replace(/^INACTIVE_EMPLOYEE:\s*/, '') });
        }
        if (err.message?.startsWith('DESTINATION_INVALID')) {
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: err.message.replace(/^DESTINATION_INVALID:\s*/, '') });
        }
        const destinationConflictResult = destinationConflictResponse(err);
        if (destinationConflictResult) {
          request.log.warn({
            transferRequestId: reqRecord.id,
            employeeId: reqRecord.employeeId,
            destinationSeatId: finalSeatId,
            requestStatus: reqRecord.status,
            ...err.destinationContext
          }, 'Destination allocation conflict');
          return reply.status(409).send({ statusCode: 409, ...destinationConflictResult });
        }
        if (err.message?.startsWith('STALE_REQUEST')) {
          return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: err.message.replace(/^STALE_REQUEST:\s*/, '') });
        }
        request.log.error({ err, transferRequestId: reqRecord.id }, 'Transfer approval failed');
        return reply.status(500).send({
          statusCode: 500,
          error: 'TRANSFER_APPROVAL_FAILED',
          message: 'Approval could not be completed. No workstation change was saved. Please try again or contact an administrator.'
        });
      }
    }
  });
};
