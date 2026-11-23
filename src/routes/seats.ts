import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma, PrismaClient, TransferRequestStatus } from '@prisma/client';
import { logAudit } from '../services/audit.service.js';
import { notificationService } from '../services/notification.service.js';
import { resolveSeatOfficeArea } from '../utils/seat-area.js';
import { isBusinessAdminRole, resolveAuthorizedUnitScope } from '../utils/rbac.js';
import { normalizeEmpCode } from '../utils/employee-code.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';
import { buildingUnitWhere, unitIdFromBuilding } from '../utils/building-unit.js';

/**
 * Checks whether a seat resides on a floor belonging to Unit 2.
 * Resolves Seat -> Floor -> Building -> Unit, with the legacy Plant path as
 * a compatibility fallback while existing records are backfilled.
 */
async function isUnit2Seat(prisma: PrismaClient, seatId: string, floorId?: string): Promise<boolean> {
  let targetFloorId = floorId;
  if (!targetFloorId) {
    const seat = await prisma.seat.findUnique({
      where: { id: seatId },
      select: { floorId: true }
    });
    if (!seat) return false;
    targetFloorId = seat.floorId;
  }

  const floor = await prisma.floor.findUnique({
    where: { id: targetFloorId },
    select: {
      building: {
        select: {
          unit: {
            select: { name: true, code: true }
          },
          plant: {
            select: {
              unit: {
                select: { name: true, code: true }
              }
            }
          }
        }
      }
    }
  });

  const unit = floor?.building?.unit || floor?.building?.plant?.unit;
  if (!unit) return false;
  return unit.name.toLowerCase() === 'unit 2' || unit.code.toUpperCase() === 'UNIT-2';
}

async function getSeatWithUnit(prisma: PrismaClient, seatId: string) {
  const seat = await prisma.seat.findUnique({
    where: { id: seatId },
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
  if (!seat) return null;
  if (!seat.floor && seat.floorId) {
    const floor = await getFloorWithUnit(prisma, seat.floorId);
    return { ...seat, floor };
  }
  return seat;
}

async function getFloorWithUnit(prisma: PrismaClient, floorId: string) {
  return prisma.floor.findUnique({
    where: { id: floorId },
    include: {
      building: {
        include: {
          unit: true,
          plant: true
        }
      }
    }
  });
}

export const seatRoutes: FastifyPluginAsync = async (fastify) => {
  // Handler for seat assignment (POST & PATCH /api/seats/:id/assign)
  const assignHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: seatId } = request.params as { id: string };
    const body = (request.body as { employeeId?: string }) || {};
    const targetEmpId = body.employeeId;

    if (!targetEmpId || typeof targetEmpId !== 'string' || targetEmpId.trim().length === 0) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'employeeId required'
      });
    }

    const seat = await getSeatWithUnit(fastify.prisma, seatId);
    if (!seat) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Seat not found'
      });
    }

    const seatUnitId = unitIdFromBuilding(seat.floor?.building);
    const userRole = request.admin?.role;
    if (!isBusinessAdminRole(userRole) || (userRole === 'UNIT_ADMIN' && seatUnitId !== request.admin?.assignedUnitId)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only assign seats within your assigned unit.'
      });
    }

    // Static Assignment Integrity Guard: Unit 2 seat assignments are strictly Admin-controlled
    if (!request.admin || !request.admin.id) {
      const isU2 = await isUnit2Seat(fastify.prisma, seatId, seat.floorId);
      if (isU2) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Unit 2 seat assignments are strictly static and require an authenticated Admin session.'
        });
      }
    }

    const employee = await fastify.prisma.employee.findUnique({
      where: { id: targetEmpId },
      include: { department: true }
    });
    if (!employee) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Employee not found'
      });
    }

    if (!employee.isActive) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Inactive employees cannot be assigned to a workstation'
      });
    }

    // A Unit Admin may only allocate employees owned by that same Unit.  The
    // seat check above alone is insufficient: an ID from another Unit could
    // otherwise be supplied directly to this endpoint.
    if (
      userRole === 'UNIT_ADMIN' &&
      (employee.department?.unitId && employee.department.unitId !== request.admin?.assignedUnitId)
    ) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only assign employees within your assigned unit.'
      });
    }

    const pendingTransfer = await fastify.prisma.seatTransferRequest.findFirst({
      where: {
        employeeId: targetEmpId,
        status: TransferRequestStatus.PENDING_TARGET_ADMIN
      },
      select: { id: true, requestNumber: true }
    });
    if (pendingTransfer) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'TRANSFER_PENDING',
        message: `Employee has a pending transfer request (${pendingTransfer.requestNumber}) and cannot be assigned here.`
      });
    }

    // Check if seat already assigned to someone else
    if (seat.employeeId && seat.employeeId !== targetEmpId) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Seat is already assigned to another employee'
      });
    }

    if (seat.status !== 'AVAILABLE') {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Cannot assign seat with status '${seat.status}'`
      });
    }

    // Idempotent assignment to self
    if (seat.employeeId === targetEmpId) {
      return reply.status(200).send({
        ...seat,
        employee
      });
    }

    try {
      const updatedSeat = await fastify.prisma.$transaction(async (tx) => {
        // Re-check inside the transaction so an assignment cannot race a
        // just-created transfer request.
        const activeTransfer = await tx.seatTransferRequest.findFirst({
          where: {
            employeeId: targetEmpId,
            status: TransferRequestStatus.PENDING_TARGET_ADMIN
          },
          select: { id: true }
        });
        if (activeTransfer) {
          throw new ConflictError('Employee has a pending transfer request')
        }

        // Re-read the seat and claim it with a conditional write. The initial
        // read is only for authorization/response shaping; it must not decide
        // the winner of a concurrent assignment.
        const currentSeat = await tx.seat.findUnique({ where: { id: seatId } });
        if (!currentSeat) throw new ConflictError('Seat no longer exists');
        if (currentSeat.employeeId === targetEmpId) {
          return tx.seat.findUnique({
            where: { id: seatId },
            include: { employee: { include: { department: true } } }
          });
        }
        if (currentSeat.employeeId || currentSeat.status !== 'AVAILABLE') {
          throw new ConflictError('Seat is already assigned to another employee');
        }

        // Strict 1:1 Invariant: check if employee holds any other seat
        const existingAssignment = await tx.seat.findFirst({
          where: {
            employeeId: targetEmpId,
            id: { not: seatId }
          }
        });

        if (existingAssignment) {
          throw new ConflictError(`Employee is already assigned to seat ${existingAssignment.label}`);
        }

        const claim = await tx.seat.updateMany({
          where: {
            id: seatId,
            status: 'AVAILABLE',
            OR: [{ employeeId: null }, { employeeId: { isSet: false } }]
          },
          data: {
            employeeId: targetEmpId,
            departmentId: employee.departmentId
          }
        });
        if (claim.count !== 1) {
          throw new ConflictError('Seat is already assigned to another employee');
        }

        const assigned = await tx.seat.findUnique({
          where: { id: seatId },
          include: {
            employee: {
              include: { department: true }
            }
          }
        });

        await logAudit(tx as unknown as PrismaClient, request, 'SEAT_ASSIGNED', 'Seat', seatId, {
          seatLabel: seat.label,
          floorId: seat.floorId,
          employeeId: targetEmpId,
          employeeName: employee.fullName
        });

        return assigned;
      });

      // Dispatch async notification
      notificationService.notify({
        employeeId: employee.id,
        employeeName: employee.fullName,
        employeeEmail: employee.email || '',
        seatId: seat.id,
        seatLabel: seat.label,
        action: 'ASSIGNED'
      }).catch((e) => fastify.log.error(e));

      return reply.status(200).send(updatedSeat);
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          error: err.message.startsWith('Employee is already assigned') ? 'EMPLOYEE_ALREADY_ASSIGNED' : 'Conflict',
          message: err.message
        });
      }
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Employee is already assigned to another seat'
        });
      }
      throw err;
    }
  };

  // Handler for seat unassignment (POST & PATCH /api/seats/:id/unassign)
  const unassignHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: seatId } = request.params as { id: string };
    const seat = await getSeatWithUnit(fastify.prisma, seatId);

    if (!seat) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Seat not found'
      });
    }

    const seatUnitId = unitIdFromBuilding(seat.floor?.building);
    const userRole = request.admin?.role;
    if (!isBusinessAdminRole(userRole) || (userRole === 'UNIT_ADMIN' && seatUnitId !== request.admin?.assignedUnitId)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only unassign seats within your assigned unit.'
      });
    }

    // Static Assignment Integrity Guard for Unit 2:
    // Workstations on Unit 2's floors are permanent, dedicated operator and staff desks.
    // They must remain 100% static Admin-controlled assignments.
    // Specifically, prevent any background jobs, QR check-in flows, or unauthenticated / non-admin routines
    // from releasing seats under Unit 2 floors.
    const isAutoReleaseAttempt =
      request.headers['x-auto-release'] === 'true' ||
      request.headers['x-cron'] === 'true' ||
      (request.body as any)?.isAutoRelease === true ||
      (request.body as any)?.automated === true;

    if (isAutoReleaseAttempt) {
      const isU2 = await isUnit2Seat(fastify.prisma, seatId, seat.floorId);
      if (isU2) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Seats under Unit 2 floors are 100% static Admin-controlled assignments and cannot be released by automated routines or check-in timeouts.'
        });
      }
    }

    // Enforce active authenticated Admin session for releasing Unit 2 seats
    if (!request.admin || !request.admin.id) {
      const isU2 = await isUnit2Seat(fastify.prisma, seatId, seat.floorId);
      if (isU2) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Unit 2 seat assignments are strictly static and require an authenticated Admin session to release.'
        });
      }
    }

    // Boundary rule T2-ASGN-01: unassigning an already vacant seat is 200 without audit log
    if (!seat.employeeId) {
      return reply.status(200).send({
        ...seat,
        employeeId: null,
        departmentId: null,
        employee: null
      });
    }

    const prevEmployeeId = seat.employeeId;

    const updated = await fastify.prisma.$transaction(async (tx) => {
      const result = await tx.seat.update({
        where: { id: seatId },
        data: {
          employeeId: { unset: true },
          departmentId: null,
          status: 'AVAILABLE'
        }
      });

      await logAudit(tx as unknown as PrismaClient, request, 'SEAT_UNASSIGNED', 'Seat', seatId, {
        seatLabel: seat.label,
        previousEmployeeId: prevEmployeeId,
        floorId: seat.floorId
      });

      return result;
    });

    // Dispatch async notification
    notificationService.notify({
      employeeId: prevEmployeeId,
      employeeName: 'Employee',
      employeeEmail: '',
      seatId: seat.id,
      seatLabel: seat.label,
      action: 'RELEASED'
    }).catch((e) => fastify.log.error(e));

    return reply.status(200).send({
      ...updated,
      employeeId: null,
      departmentId: null,
      employee: null
    });
  };

  // Register both POST and PATCH for assign & unassign
  fastify.post('/:id/assign', assignHandler);
  fastify.patch('/:id/assign', assignHandler);

  fastify.post('/:id/unassign', unassignHandler);
  fastify.patch('/:id/unassign', unassignHandler);

  // POST /api/seats/:id/quick-assign (Atomic Quick-Create Employee + Assign to Seat)
  fastify.post('/:id/quick-assign', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: seatId } = request.params as { id: string };
    const body = (request.body as {
      fullName?: string;
      employeeCode?: string;
      email?: string;
      departmentId?: string;
      section?: string;
      functionName?: string;
      reportingTo?: string;
      reportingManager?: string;
      hod?: string;
      ext?: string;
      grade?: string;
      designation?: string;
    }) || {};

    if (!body.fullName?.trim() || !body.employeeCode?.trim()) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'fullName and employeeCode are required'
      });
    }

    const seat = await getSeatWithUnit(fastify.prisma, seatId);
    if (!seat) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Seat not found'
      });
    }

    const seatUnitId = unitIdFromBuilding(seat.floor?.building);
    const userRole = request.admin?.role;
    if (!isBusinessAdminRole(userRole) || (userRole === 'UNIT_ADMIN' && seatUnitId !== request.admin?.assignedUnitId)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only assign seats within your assigned unit.'
      });
    }

    const seatStatus = seat.status || 'AVAILABLE';
    if (seatStatus !== 'AVAILABLE' || seat.employeeId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Cannot assign seat with status '${seat.status || 'AVAILABLE'}' or already occupied`
      });
    }

    // Static Assignment Guard for Unit 2
    if (!request.admin || !request.admin.id) {
      const isU2 = await isUnit2Seat(fastify.prisma, seatId, seat.floorId);
      if (isU2) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Unit 2 seat assignments require an authenticated Admin session.'
        });
      }
    }

    const empCode = normalizeEmpCode(body.employeeCode);

    try {
      const updatedSeat = await fastify.prisma.$transaction(async (tx) => {
        const existingEmp = await tx.employee.findFirst({
          where: { employeeCode: { equals: empCode, mode: 'insensitive' } },
          select: { id: true }
        });
        if (existingEmp) {
          throw new ConflictError('Employee code already exists');
        }

        let deptId = body.departmentId || seat.departmentId;
        if (!deptId) {
          const firstDept = await tx.department.findFirst({ orderBy: { createdAt: 'asc' } });
          if (!firstDept) {
            throw new Error('No departments found in the system');
          }
          deptId = firstDept.id;
        }

        const newEmployee = await tx.employee.create({
          data: {
            fullName: body.fullName!.trim(),
            employeeCode: empCode,
            email: body.email?.trim() || null,
            departmentId: deptId,
            section: body.section?.trim() || null,
            functionName: body.functionName?.trim() || null,
            reportingTo: body.reportingTo?.trim() || body.reportingManager?.trim() || null,
            reportingManager: body.reportingManager?.trim() || body.reportingTo?.trim() || null,
            hod: body.hod?.trim() || null,
            ext: body.ext?.trim() || null,
            grade: body.grade?.trim() || null,
            designation: body.designation?.trim() || null,
            isActive: true
          },
          include: { department: true }
        });

        const assigned = await tx.seat.update({
          where: { id: seatId },
          data: {
            employeeId: newEmployee.id,
            departmentId: newEmployee.departmentId
          },
          include: {
            employee: { include: { department: true } },
            department: true
          }
        });

        await logAudit(tx as unknown as PrismaClient, request, 'SEAT_QUICK_ASSIGNED', 'Seat', seatId, {
          seatLabel: seat.label,
          floorId: seat.floorId,
          employeeId: newEmployee.id,
          employeeName: newEmployee.fullName,
          quickRegistered: true
        });

        return assigned;
      });

      notificationService.notify({
        employeeId: updatedSeat.employee!.id,
        employeeName: updatedSeat.employee!.fullName,
        employeeEmail: updatedSeat.employee!.email || '',
        seatId: seat.id,
        seatLabel: seat.label,
        action: 'ASSIGNED'
      }).catch((e) => fastify.log.error(e));

      return reply.status(200).send(updatedSeat);
    } catch (err: unknown) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        const metaTarget = String((err as any).meta?.target || '');
        const isLabel = metaTarget.includes('label') || metaTarget.includes('floorId') || (err as any).message?.includes('label');
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: isLabel
            ? 'A workstation with this label already exists on this floor'
            : 'Workstation or employee already has an active assignment'
        });
      }
      if (err instanceof ConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: err.message
        });
      }
      throw err;
    }
  });

  // POST /api/seats/:id/transfer (Atomic Desk-to-Desk Relocation)
  fastify.post('/:id/transfer', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: sourceSeatId } = request.params as { id: string };
    const { targetSeatId } = (request.body as { targetSeatId?: string }) || {};

    if (!targetSeatId || typeof targetSeatId !== 'string') {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'targetSeatId is required'
      });
    }

    if (sourceSeatId === targetSeatId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Source and target seats cannot be identical'
      });
    }

    const sourceSeat = await fastify.prisma.seat.findUnique({
      where: { id: sourceSeatId },
      include: {
        employee: true,
        floor: {
          include: {
            building: {
              include: {
                plant: true
              }
            }
          }
        }
      }
    });
    if (!sourceSeat) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Source seat not found'
      });
    }

    if (!sourceSeat.employeeId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Source seat has no occupant to transfer'
      });
    }

    const employeeToMove = sourceSeat.employee || await fastify.prisma.employee.findUnique({
      where: { id: sourceSeat.employeeId }
    });
    if (!employeeToMove) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Occupant employee not found'
      });
    }

    const targetSeat = await getSeatWithUnit(fastify.prisma, targetSeatId);
    if (!targetSeat) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Target seat not found'
      });
    }

    const userRole = request.admin?.role;
    const sourceUnitId = unitIdFromBuilding(sourceSeat.floor?.building);
    const targetUnitId = unitIdFromBuilding(targetSeat.floor?.building);
    if (!isBusinessAdminRole(userRole) || (userRole === 'UNIT_ADMIN' && (sourceUnitId !== request.admin?.assignedUnitId || targetUnitId !== request.admin?.assignedUnitId))) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only transfer seats within your assigned unit.'
      });
    }

    const targetStatus = targetSeat.status || 'AVAILABLE';
    if (targetStatus !== 'AVAILABLE' || targetSeat.employeeId) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `Target seat '${targetSeat.label}' is not available for transfer`
      });
    }

    // Static Guard: check admin session if source or target resides in Unit 2
    if (!request.admin || !request.admin.id) {
      const isSourceU2 = await isUnit2Seat(fastify.prisma, sourceSeatId, sourceSeat.floorId);
      const isTargetU2 = await isUnit2Seat(fastify.prisma, targetSeatId, targetSeat.floorId);
      if (isSourceU2 || isTargetU2) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Seat relocation involving Unit 2 requires an authenticated Admin session.'
        });
      }
    }

    const result = await fastify.prisma.$transaction(async (tx) => {
      // Re-verify both sides inside tx. In particular, never release a source
      // seat unless the expected employee still occupies it.
      const freshSource = await tx.seat.findUnique({ where: { id: sourceSeatId } });
      const freshTarget = await tx.seat.findUnique({ where: { id: targetSeatId } });
      const freshStatus = freshTarget?.status || 'AVAILABLE';
      if (!freshSource || freshSource.employeeId !== employeeToMove.id) {
        throw new ConflictError('Source seat occupant changed; refresh and retry the transfer');
      }
      if (!freshTarget || freshStatus !== 'AVAILABLE' || freshTarget.employeeId) {
        throw new ConflictError(`Target seat '${targetSeat.label}' is no longer available`);
      }

      // Step 1: Release source seat
      const released = await tx.seat.updateMany({
        where: { id: sourceSeatId, employeeId: employeeToMove.id },
        data: {
          employeeId: { unset: true },
          departmentId: null
        }
      });
      if (released.count !== 1) {
        throw new ConflictError('Source seat occupant changed; refresh and retry the transfer');
      }
      const claimed = await tx.seat.updateMany({
        where: {
          id: targetSeatId,
          status: 'AVAILABLE',
          OR: [{ employeeId: null }, { employeeId: { isSet: false } }]
        },
        data: {
          employeeId: employeeToMove.id,
          departmentId: employeeToMove.departmentId
        }
      });
      if (claimed.count !== 1) throw new ConflictError(`Target seat '${targetSeat.label}' is no longer available`);

      const updatedSource = await tx.seat.findUnique({ where: { id: sourceSeatId } });
      const updatedTarget = await tx.seat.findUnique({
        where: { id: targetSeatId },
        include: {
          employee: { include: { department: true } },
          department: true
        }
      });

      await logAudit(tx as unknown as PrismaClient, request, 'SEAT_TRANSFERRED', 'Seat', sourceSeatId, {
        sourceSeatLabel: sourceSeat.label,
        targetSeatLabel: targetSeat.label,
        sourceSeatId,
        targetSeatId,
        employeeId: employeeToMove.id,
        employeeName: employeeToMove.fullName
      });

      return { sourceSeat: updatedSource, targetSeat: updatedTarget };
    });

    notificationService.notify({
      employeeId: employeeToMove.id,
      employeeName: employeeToMove.fullName,
      employeeEmail: employeeToMove.email || '',
      seatId: targetSeat.id,
      seatLabel: targetSeat.label,
      action: 'ASSIGNED'
    }).catch((e) => fastify.log.error(e));

    return reply.status(200).send(result);
  });

  // POST /api/seats/swap (Atomic 2-Person Mutual Desk Exchange)
  fastify.post('/swap', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as { seatAId?: string; seatBId?: string; reason?: string }) || {};
    const { seatAId, seatBId, reason } = body;

    if (!seatAId || !seatBId || seatAId === seatBId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Two distinct seat IDs (seatAId and seatBId) are required for a desk swap.'
      });
    }

    const [seatA, seatB] = await Promise.all([
      getSeatWithUnit(fastify.prisma, seatAId),
      getSeatWithUnit(fastify.prisma, seatBId)
    ]);

    if (!seatA) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `Seat ${seatAId} not found` });
    }
    if (!seatB) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `Seat ${seatBId} not found` });
    }

    const userRole = request.admin?.role;
    const userUnitId = request.admin?.assignedUnitId;
    const unitA = unitIdFromBuilding(seatA.floor?.building);
    const unitB = unitIdFromBuilding(seatB.floor?.building);

    if (!isBusinessAdminRole(userRole) || (userRole === 'UNIT_ADMIN' && ((unitA && unitA !== userUnitId) || (unitB && unitB !== userUnitId)))) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only swap seats within your assigned unit.'
      });
    }

    if (!seatA.employeeId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Seat '${seatA.label}' is vacant and cannot be swapped.`
      });
    }
    if (!seatB.employeeId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Seat '${seatB.label}' is vacant and cannot be swapped.`
      });
    }

    const empA = await fastify.prisma.employee.findUnique({ where: { id: seatA.employeeId }, include: { department: true } });
    const empB = await fastify.prisma.employee.findUnique({ where: { id: seatB.employeeId }, include: { department: true } });

    if (!empA || !empB) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Assigned employee record not found' });
    }

    const result = await fastify.prisma.$transaction(async (tx: any) => {
      // Validate both occupants again inside the transaction. The request may
      // have been delayed after the authorization reads above.
      const freshSeats = await tx.seat.findMany({ where: { id: { in: [seatAId, seatBId] } } });
      const freshA = freshSeats.find((s: any) => s.id === seatAId);
      const freshB = freshSeats.find((s: any) => s.id === seatBId);
      if (!freshA || !freshB || freshA.employeeId !== empA.id || freshB.employeeId !== empB.id) {
        throw new ConflictError('Seat occupants changed; refresh and retry the swap');
      }

      // Clear A with an expected-occupant predicate before assigning B. If a
      // release/reassignment races this request, the conditional write fails
      // and the transaction rolls back rather than overwriting it.
      const clearedA = await tx.seat.updateMany({
        where: { id: seatAId, employeeId: empA.id },
        data: { employeeId: { unset: true } }
      });
      if (clearedA.count !== 1) throw new ConflictError('Seat occupants changed; refresh and retry the swap');

      // 2. Assign empA to seatB
      const claimedB = await tx.seat.updateMany({
        where: { id: seatBId, employeeId: empB.id },
        data: {
          employeeId: empA.id,
          departmentId: empA.departmentId
        }
      });
      if (claimedB.count !== 1) throw new ConflictError('Seat occupants changed; refresh and retry the swap');
      const updatedSeatB = await tx.seat.findUnique({
        where: { id: seatBId },
        include: { employee: true, department: true }
      });

      // 3. Assign empB to A only if it remained vacant after our clear.
      const claimedA = await tx.seat.updateMany({
        where: { id: seatAId, OR: [{ employeeId: null }, { employeeId: { isSet: false } }] },
        data: {
          employeeId: empB.id,
          departmentId: empB.departmentId || seatA.departmentId
        }
      });
      if (claimedA.count !== 1) throw new ConflictError('Seat occupants changed; refresh and retry the swap');
      const updatedSeatA = await tx.seat.findUnique({
        where: { id: seatAId },
        include: { employee: true, department: true }
      });

      await logAudit(tx as unknown as PrismaClient, request, 'SEAT_SWAPPED', 'Seat', seatAId, {
        seatAId,
        seatBId,
        seatALabel: seatA.label,
        seatBLabel: seatB.label,
        employeeAId: empA.id,
        employeeAName: empA.fullName,
        employeeBId: empB.id,
        employeeBName: empB.fullName,
        reason: reason || 'Mutual desk exchange'
      });

      return { seatA: updatedSeatA, seatB: updatedSeatB };
    });

    notificationService.notify({
      employeeId: empA.id,
      employeeName: empA.fullName,
      employeeEmail: empA.email || '',
      seatId: seatB.id,
      seatLabel: seatB.label,
      action: 'ASSIGNED'
    }).catch((e) => fastify.log.error(e));

    notificationService.notify({
      employeeId: empB.id,
      employeeName: empB.fullName,
      employeeEmail: empB.email || '',
      seatId: seatA.id,
      seatLabel: seatA.label,
      action: 'ASSIGNED'
    }).catch((e) => fastify.log.error(e));

    return reply.status(200).send({
      success: true,
      message: `Successfully swapped ${empA.fullName} (${seatA.label} -> ${seatB.label}) and ${empB.fullName} (${seatB.label} -> ${seatA.label})`,
      ...result
    });
  });

  // GET /api/seats (List workstations with query filters)
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query as {
      floorId?: string;
      buildingId?: string;
      plantId?: string;
      unitId?: string;
      departmentId?: string;
      status?: string;
      assigned?: string;
      employeeId?: string;
      type?: string;
      officeArea?: string;
      search?: string;
      forTransfer?: string;
    }) || {};

    // 1. Enforce strict server-side authorization and unit scoping
    const scopeRes = await resolveAuthorizedUnitScope(fastify.prisma, request.admin, query.unitId);
    if (!scopeRes.authorized) {
      return reply.status(scopeRes.statusCode).send({
        statusCode: scopeRes.statusCode,
        error: scopeRes.statusCode === 403 ? 'Forbidden' : 'Unauthorized',
        message: scopeRes.error
      });
    }

    const { scope } = scopeRes;
    const effectiveUnitId = scope.unitIds.length > 0 ? scope.unitIds[0] : undefined;

    const safeFloorId = query.floorId && query.floorId !== 'ALL' ? query.floorId : undefined;

    // Cross-unit floor access guard: If floorId is passed by Unit Admin, ensure floor belongs to their unit
    if (safeFloorId && scope.isRestricted && effectiveUnitId) {
      const floorRecord = await fastify.prisma.floor.findUnique({
        where: { id: safeFloorId },
        include: { building: { include: { unit: true, plant: true } } }
      });
      if (!floorRecord || unitIdFromBuilding(floorRecord.building) !== effectiveUnitId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Forbidden: You are not authorized to view workstations on this floor.'
        });
      }
    }

    const safeDepartmentId = query.departmentId && query.departmentId !== 'ALL' ? query.departmentId : undefined;
    const safeType = query.type && query.type !== 'ALL' ? query.type : undefined;
    const safeEmployeeId = query.employeeId && query.employeeId !== 'ALL' ? query.employeeId : undefined;
    const safePlantId = query.plantId && query.plantId !== 'ALL' ? query.plantId : undefined;
    const safeBuildingId = query.buildingId && query.buildingId !== 'ALL' ? query.buildingId : undefined;

    const scopedBuildingIds = (effectiveUnitId || safePlantId)
      ? (await fastify.prisma.building.findMany({
          where: effectiveUnitId && safePlantId
            ? { AND: [{ plantId: safePlantId }, buildingUnitWhere([effectiveUnitId])] }
            : effectiveUnitId
              ? buildingUnitWhere([effectiveUnitId])
              : { plantId: safePlantId },
          select: { id: true }
        })).map((building) => building.id)
      : undefined;

    const where: Prisma.SeatWhereInput = {};
    if (safeFloorId) where.floorId = safeFloorId;
    if (safeDepartmentId) where.departmentId = safeDepartmentId;
    if (safeType) where.type = safeType as any;
    if (safeEmployeeId) where.employeeId = safeEmployeeId;

    if (query.status && query.status !== 'ALL') {
      if (query.status === 'AVAILABLE') {
        where.status = 'AVAILABLE';
        where.employee = null;
      } else if (query.status === 'OCCUPIED') {
        where.employee = { isNot: null };
      } else {
        where.status = query.status as any;
      }
    } else if (query.forTransfer === 'true') {
      where.status = 'AVAILABLE';
      where.employee = null;
    } else if (query.assigned === 'true') {
      where.employee = { isNot: null };
    } else if (query.assigned === 'false') {
      where.employee = null;
    }

    if (!safeFloorId && (effectiveUnitId || safePlantId || safeBuildingId)) {
      const floorFilter: Prisma.FloorWhereInput = {};
      if (safeBuildingId) {
        floorFilter.buildingId = safeBuildingId;
      }
      if (scopedBuildingIds) {
        floorFilter.buildingId = safeBuildingId
          ? { in: scopedBuildingIds.filter((buildingId) => buildingId === safeBuildingId) }
          : { in: scopedBuildingIds };
      }
      where.floor = {
        ...((where.floor as any) || {}),
        ...floorFilter
      };
    } else if (safeFloorId && effectiveUnitId) {
      // The explicit floor authorization guard above already resolved this
      // floor through direct Unit ownership with legacy Plant fallback.
    } else if (!safeFloorId && !effectiveUnitId && !safePlantId && !safeBuildingId) {
      const authorizedUnits = await fastify.prisma.unit.findMany({
        where: unitSelectorWhere(),
        select: { id: true }
      });
      const authorizedBuildings = await fastify.prisma.building.findMany({
        where: buildingUnitWhere(authorizedUnits.map((u) => u.id)),
        select: { id: true }
      });
      const authorizedFloors = await fastify.prisma.floor.findMany({
        where: { buildingId: { in: authorizedBuildings.map((building) => building.id) } },
        select: { id: true }
      });
      where.floorId = { in: authorizedFloors.map((floor) => floor.id) };
    }

    const seats = await fastify.prisma.seat.findMany({
      where,
      include: {
        department: true,
        employee: {
          include: { department: true }
        },
        floor: {
          include: {
            building: {
              include: {
                plant: {
                  include: {
                    unit: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { label: 'asc' }
    });

    let enrichedSeats = seats.map((s) => {
      const resolvedArea = resolveSeatOfficeArea(s as any);
      return {
        ...s,
        officeArea: s.officeArea || resolvedArea,
      };
    });

    if (query.officeArea && query.officeArea.trim() && query.officeArea.trim().toUpperCase() !== 'ALL') {
      const targetArea = query.officeArea.trim().toLowerCase();
      enrichedSeats = enrichedSeats.filter(
        (s) => s.officeArea && s.officeArea.toLowerCase() === targetArea
      );
    }

    if (query.search && query.search.trim()) {
      const q = query.search.trim().toLowerCase();
      enrichedSeats = enrichedSeats.filter((s) => {
        const matchLabel = s.label.toLowerCase().includes(q);
        const matchPc = s.pcNumber ? s.pcNumber.toLowerCase().includes(q) : false;
        const matchArea = s.officeArea ? s.officeArea.toLowerCase().includes(q) : false;
        const matchDept = s.department?.name ? s.department.name.toLowerCase().includes(q) : false;
        const matchEmpName = s.employee?.fullName ? s.employee.fullName.toLowerCase().includes(q) : false;
        const matchEmpCode = s.employee?.employeeCode ? s.employee.employeeCode.toLowerCase().includes(q) : false;
        return matchLabel || matchPc || matchArea || matchDept || matchEmpName || matchEmpCode;
      });
    }

    return reply.status(200).send(enrichedSeats);
  });

  // GET /api/seats/:id (Get single workstation)
  fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const seat = await fastify.prisma.seat.findUnique({
      where: { id },
      include: {
        department: true,
        employee: {
          include: { department: true }
        },
        floor: {
          include: {
            building: {
              include: {
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
    });

    if (!seat) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Seat not found'
      });
    }

    const seatUnitId = unitIdFromBuilding(seat.floor?.building);
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN' && request.admin?.assignedUnitId && seatUnitId && seatUnitId !== request.admin.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: You can only view workstations within your assigned unit.'
      });
    }

    const resolvedArea = resolveSeatOfficeArea(seat as any);
    return reply.status(200).send({
      ...seat,
      officeArea: seat.officeArea || resolvedArea,
    });
  });

  // PUT /api/seats/:id (Update seat details/coordinates)
  fastify.put('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Unit Admin role'
      });
    }

    const { id } = request.params as { id: string };
    const body = (request.body as {
      label?: string;
      type?: any;
      status?: any;
      departmentId?: string | null;
      x?: number;
      y?: number;
      rotation?: number;
      pcNumber?: string | null;
      officeArea?: string | null;
      zone?: string | null;
      remarks?: string | null;
    }) || {};

    const seat = await getSeatWithUnit(fastify.prisma, id);
    if (!seat) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Seat not found' });
    }

    const seatUnitId = unitIdFromBuilding(seat.floor?.building);
    if (userRole === 'UNIT_ADMIN' && seatUnitId !== request.admin?.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only modify seats within their assigned unit.'
      });
    }

    try {
      const updated = await fastify.prisma.seat.update({
        where: { id },
        data: {
          label: body.label !== undefined ? body.label.trim() : undefined,
          type: body.type !== undefined ? body.type : undefined,
          status: body.status !== undefined ? body.status : undefined,
          departmentId: body.departmentId !== undefined ? body.departmentId : undefined,
          x: body.x !== undefined ? Number(body.x) : undefined,
          y: body.y !== undefined ? Number(body.y) : undefined,
          rotation: body.rotation !== undefined ? Number(body.rotation) : undefined,
          pcNumber: body.pcNumber !== undefined ? (body.pcNumber ? String(body.pcNumber).trim() : null) : undefined,
          officeArea: body.officeArea !== undefined ? (body.officeArea ? String(body.officeArea).trim() : null) : undefined,
          zone: body.zone !== undefined ? (body.zone ? String(body.zone).trim() : null) : undefined,
          remarks: body.remarks !== undefined ? (body.remarks ? String(body.remarks).trim() : null) : undefined,
        },
        include: {
          department: true,
          employee: true,
          floor: {
            include: {
              building: {
                include: {
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
      });

      await logAudit(fastify.prisma, request, 'SEAT_UPDATED', 'Seat', id, {
        label: updated.label,
        x: updated.x,
        y: updated.y
      });

      return reply.status(200).send(updated);
    } catch (err: any) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        const metaTarget = String((err as any).meta?.target || '');
        const isLabel = metaTarget.includes('label') || metaTarget.includes('floorId') || err.message?.includes('label');
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: isLabel
            ? 'A workstation with this label already exists on this floor'
            : 'Workstation or employee already has an active assignment'
        });
      }
      throw err;
    }
  });

  // DELETE /api/seats/:id (Delete workstation)
  fastify.delete('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Unit Admin role'
      });
    }

    const { id } = request.params as { id: string };
    const seat = await getSeatWithUnit(fastify.prisma, id);
    if (!seat) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Seat not found' });
    }

    const seatUnitId = unitIdFromBuilding(seat.floor?.building);
    if (userRole === 'UNIT_ADMIN' && seatUnitId !== request.admin?.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only delete seats within their assigned unit.'
      });
    }

    await fastify.prisma.seat.delete({ where: { id } });
    await logAudit(fastify.prisma, request, 'SEAT_DELETED', 'Seat', id, {
      label: seat.label,
      floorId: seat.floorId
    });

    return reply.status(200).send({ success: true, message: 'Seat deleted successfully' });
  });

  // POST /api/seats (Create new workstation)
  fastify.post('/', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Unit Admin role'
      });
    }

    const body = (request.body as {
      floorId: string;
      label: string;
      x?: number;
      y?: number;
      rotation?: number;
      width?: number;
      height?: number;
      type?: any;
      status?: any;
      departmentId?: string | null;
      pcNumber?: string | null;
      officeArea?: string | null;
      zone?: string | null;
      remarks?: string | null;
    });

    if (!body.floorId || !body.label) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'floorId and label are required' });
    }

    const floor = await getFloorWithUnit(fastify.prisma, body.floorId);
    if (!floor) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Floor not found' });
    }

    const floorUnitId = unitIdFromBuilding(floor.building);
    if (userRole === 'UNIT_ADMIN' && floorUnitId !== request.admin?.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only create seats within their assigned unit.'
      });
    }

    try {
      const created = await fastify.prisma.seat.create({
        data: {
          floorId: body.floorId,
          label: body.label.trim(),
          // A business seat exists before it has an architectural position.
          // 0/0 is the unplaced sentinel; the layout save flow records manual
          // placement provenance when an administrator positions it on a map.
          x: body.x !== undefined ? Number(body.x) : 0,
          y: body.y !== undefined ? Number(body.y) : 0,
          rotation: body.rotation !== undefined ? Number(body.rotation) : 0,
          width: body.width !== undefined ? Number(body.width) : undefined,
          height: body.height !== undefined ? Number(body.height) : undefined,
          type: body.type || 'STANDARD_DESK',
          status: body.status || 'AVAILABLE',
          departmentId: body.departmentId || null,
          pcNumber: body.pcNumber ? String(body.pcNumber).trim() : null,
          officeArea: body.officeArea ? String(body.officeArea).trim() : null,
          zone: body.zone ? String(body.zone).trim() : null,
          remarks: body.remarks ? String(body.remarks).trim() : null,
        },
        include: {
          department: true,
          employee: true,
          floor: {
            include: {
              building: {
                include: {
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
      });

      await logAudit(fastify.prisma, request, 'SEAT_CREATED', 'Seat', created.id, {
        label: created.label,
        floorId: created.floorId
      });

      return reply.status(201).send(created);
    } catch (err: any) {
      if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || (err as any)?.code === 'P2002') {
        const metaTarget = String((err as any).meta?.target || '');
        const isLabel = metaTarget.includes('label') || metaTarget.includes('floorId') || err.message?.includes('label');
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: isLabel
            ? 'A workstation with this label already exists on this floor'
            : 'Workstation or employee already has an active assignment'
        });
      }
      throw err;
    }
  });
};

class ConflictError extends Error {
  statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
