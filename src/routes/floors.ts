import { PrismaClient } from '@prisma/client';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SeatType, SeatStatus } from '@seating/shared';
import { SeatPlacementSource } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { logAudit } from '../services/audit.service.js';
import { resolveSeatOfficeArea } from '../utils/seat-area.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';
import { runTransactionWithRetry, isTransientTransactionConflict } from '../services/transaction-retry.service.js';
import { buildingUnitWhere, unitIdFromBuilding } from '../utils/building-unit.js';
import { currentOperationalRecordWhere } from '../utils/operational-record.js';
import { resolveFloorPlanAssetPaths } from '../utils/floor-plan-storage.js';
import { FloorPlanAssetStore, getGridFsFloorPlanId } from '../services/floor-plan-asset-store.js';

const MAX_FLOOR_PLAN_BYTES = 25 * 1024 * 1024;

class FloorPlanUploadError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

function createFloorPlanValidator(declaredMime: string) {
  let size = 0;
  let prefix = Buffer.alloc(0);
  const buffered: Buffer[] = [];
  let result: { mimeType: string; extension: string; pageCount?: number } | undefined;
  const captureFullFile = declaredMime === 'application/pdf' || declaredMime === 'application/x-pdf'
    || declaredMime === 'application/octet-stream' || declaredMime === 'image/svg+xml';

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_FLOOR_PLAN_BYTES) return callback(new FloorPlanUploadError('Floor plan files must be 25 MB or smaller', 413));
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
      if (captureFullFile) buffered.push(Buffer.from(chunk));
      callback(null, chunk);
    },
    flush(callback) {
      void (async () => {
        const isPng = prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const isJpeg = prefix.length >= 3 && prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
        const isWebp = prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP';
        const isPdf = prefix.length >= 5 && prefix.subarray(0, 5).toString('ascii') === '%PDF-';
        const isSvg = declaredMime === 'image/svg+xml';

        if (declaredMime === 'image/png' && isPng) result = { mimeType: 'image/png', extension: 'png' };
        else if (['image/jpeg', 'image/jpg'].includes(declaredMime) && isJpeg) result = { mimeType: 'image/jpeg', extension: 'jpg' };
        else if (declaredMime === 'image/webp' && isWebp) result = { mimeType: 'image/webp', extension: 'webp' };
        else if (isSvg) {
          const content = Buffer.concat(buffered).toString('utf8');
          const safe = /<svg[\s>]/i.test(content)
            && !/<\/?script\b|\bon\w+\s*=|<\/?foreignObject\b|<\/?iframe\b|<\/?object\b|<\/?embed\b|\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(content);
          if (safe) result = { mimeType: 'image/svg+xml', extension: 'svg' };
        } else if (['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(declaredMime) && isPdf) {
          try {
            const pdf = await PDFDocument.load(Buffer.concat(buffered), { updateMetadata: false, ignoreEncryption: false });
            const pageCount = pdf.getPageCount();
            if (pageCount < 1 || pageCount > 50) throw new FloorPlanUploadError('PDF floor plans must contain between 1 and 50 pages');
            result = { mimeType: 'application/pdf', extension: 'pdf', pageCount };
          } catch (error) {
            if (error instanceof FloorPlanUploadError) throw error;
            throw new FloorPlanUploadError('The uploaded PDF is corrupt or password-protected');
          }
        }

        if (!result) throw new FloorPlanUploadError('The uploaded file signature does not match a supported floor-plan type');
      })().then(() => callback(), callback);
    },
  });

  return { stream, getResult: () => result, getSize: () => size };
}

const supportedImageMime = (mime: string): boolean =>
  ['application/pdf', 'application/x-pdf', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'].includes(mime);

const CreateFloorSchema = z.object({
  name: z.string().trim().min(1, 'Floor name is required').max(100),
  floorNumber: z.number().int('Floor number must be an integer'),
  buildingId: z.string().min(1, 'Building ID is required'),
  canvasWidth: z.number().int().min(100).max(10000).optional().default(1600),
  canvasHeight: z.number().int().min(100).max(10000).optional().default(1000),
  imageUrl: z.string().nullable().optional()
});

const UpdateFloorSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  floorNumber: z.number().int().optional(),
  canvasWidth: z.number().int().min(100).max(10000).optional(),
  canvasHeight: z.number().int().min(100).max(10000).optional(),
  imageUrl: z.string().nullable().optional()
});

async function getFloorWithUnit(prisma: any, floorId: string) {
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

const canManageMasterData = (role?: string) => role === 'SUPER_ADMIN' || role === 'TECH_ADMIN';

export interface FloorRoutesOptions { floorPlanAssetStore: FloorPlanAssetStore }

export const floorRoutes: FastifyPluginAsync<FloorRoutesOptions> = async (fastify, { floorPlanAssetStore }) => {
  // GET /api/floors
  fastify.get('/', async (request, reply) => {
    const { buildingId, plantId, unitId, includeInactive } = request.query as { buildingId?: string; plantId?: string; unitId?: string; includeInactive?: string };
    const safeBuildingId = buildingId && buildingId !== 'ALL' ? buildingId : undefined;
    const safePlantId = plantId && plantId !== 'ALL' ? plantId : undefined;
    const safeUnitId = unitId && unitId !== 'ALL' ? unitId : undefined;
    let effectiveUnitId = safeUnitId;

    if (request.admin?.role === 'UNIT_ADMIN') {
      if (request.admin?.assignedUnitId) {
        effectiveUnitId = request.admin.assignedUnitId;
      } else {
        return reply.status(200).send([]);
      }
    }

    const where: any = {};
    if (includeInactive !== 'true') where.isActive = true;
    if (safeBuildingId) {
      where.buildingId = safeBuildingId;
    } else if (safePlantId) {
      where.building = { plantId: safePlantId };
    }
    if (effectiveUnitId) {
      const unitScope = buildingUnitWhere([effectiveUnitId]);
      where.building = where.building
        ? { AND: [where.building, unitScope] }
        : unitScope;
    }

    const floors = await fastify.prisma.floor.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      include: {
        _count: { select: { seats: true } }
      },
      orderBy: { floorNumber: 'asc' }
    });

    return reply.status(200).send(floors);
  });

  // POST /api/floors
  fastify.post('/', async (request, reply) => {
    const userRole = request.admin?.role;
    if (!canManageMasterData(userRole)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage floors; Unit Admins can only manage floors within their assigned unit through operational workflows.' });
    }
    const parseResult = CreateFloorSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const { name, floorNumber, buildingId, canvasWidth, canvasHeight, imageUrl } = parseResult.data;

    const building = await fastify.prisma.building.findUnique({
      where: { id: buildingId },
      include: { unit: true, plant: true }
    });
    if (!building) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Building not found'
      });
    }

    const existing = await fastify.prisma.floor.findUnique({
      where: {
        buildingId_floorNumber: {
          buildingId,
          floorNumber
        }
      }
    });

    if (existing) {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Floor number already exists in this building'
      });
    }

    const floor = await fastify.prisma.floor.create({
      data: {
        name,
        floorNumber,
        buildingId,
        canvasWidth,
        canvasHeight,
        imageUrl: imageUrl ?? null
      }
    });

    await logAudit(fastify.prisma, request, 'FLOOR_CREATED', 'Floor', floor.id, {
      name: floor.name,
      floorNumber: floor.floorNumber
    });

    return reply.status(201).send(floor);
  });

  // GET /api/floors/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const floor = await fastify.prisma.floor.findUnique({
      where: { id },
      include: {
        building: {
          include: { unit: true, plant: { include: { unit: true } } }
        },
        departments: {
          include: {
            _count: { select: { employees: true, seats: true } }
          },
          orderBy: { name: 'asc' }
        },
        seats: {
          where: currentOperationalRecordWhere() as any,
          include: {
            department: true,
            employee: {
              include: { department: true }
            }
          }
        }
      }
    });

    if (!floor) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Floor not found'
      });
    }

    if (request.admin?.role === 'UNIT_ADMIN' && (!request.admin.assignedUnitId || unitIdFromBuilding(floor.building) !== request.admin.assignedUnitId)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage floors within their assigned unit'
      });
    }

    const enrichedFloor = {
      ...floor,
      seats: (floor.seats || []).map((s: any) => ({
        ...s,
        officeArea: s.officeArea || resolveSeatOfficeArea({ ...s, floor } as any),
        floor: {
          id: floor.id,
          name: floor.name,
          floorNumber: floor.floorNumber,
          building: floor.building
        }
      }))
    };

    return reply.status(200).send(enrichedFloor);
  });

  // GET /api/floors/:id/image - authenticated access to uploaded floor assets.
  // Seeded/public assets remain served by the frontend; uploaded assets are
  // never exposed through an unchecked filesystem path.
  fastify.get('/:id/image', async (request, reply) => {
    const user = request.admin;
    if (!user || !['SUPER_ADMIN', 'TECH_ADMIN', 'UNIT_ADMIN'].includes(user.role || '')) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin, Tech Admin, or Unit Admin role'
      });
    }

    const { id } = request.params as { id: string };
    const floor = await getFloorWithUnit(fastify.prisma, id);
    if (!floor) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Floor not found' });
    }
    if (user.role === 'UNIT_ADMIN' && unitIdFromBuilding(floor.building) !== user.assignedUnitId) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only view floor plans within their assigned unit'
      });
    }

    const storedUrl = floor.imageUrl || '';
    const gridFsReference = getGridFsFloorPlanId(storedUrl);
    if (gridFsReference) {
      const asset = await floorPlanAssetStore.open(gridFsReference.id);
      const expectedUnitId = unitIdFromBuilding(floor.building);
      const storedMime = asset?.metadata.mimeType;
      const metadataMatches = asset
        && asset.metadata.floorId === floor.id
        && asset.metadata.buildingId === floor.buildingId
        && asset.metadata.unitId === expectedUnitId
        && typeof storedMime === 'string'
        && supportedImageMime(storedMime)
        && typeof asset.metadata.sha256 === 'string'
        && /^[a-f\d]{64}$/i.test(asset.metadata.sha256)
        && typeof asset.metadata.originalFilename === 'string';
      if (!asset || !metadataMatches) {
        asset?.stream.destroy();
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Floor plan asset is unavailable' });
      }
      reply
        .header('Cache-Control', 'private, max-age=300')
        .header('Content-Length', String(asset.length))
        .header('ETag', `"${asset.metadata.sha256}"`)
        .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(String(asset.metadata.originalFilename))}`)
        .header('X-Content-Type-Options', 'nosniff');
      if (storedMime === 'image/svg+xml') {
        reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      return reply.type(storedMime!).send(asset.stream);
    }

    const uploadPrefix = '/uploads/floors/';
    if (!storedUrl.startsWith(uploadPrefix)) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'No uploaded floor plan exists for this floor' });
    }

    const filename = storedUrl.slice(uploadPrefix.length).split('#')[0];
    if (!filename || filename !== path.basename(filename)) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Invalid floor plan asset path' });
    }

    const candidatePaths = resolveFloorPlanAssetPaths(filename);
    if (candidatePaths.length === 0) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Invalid floor plan asset path' });
    }

    let filePath: string | null = null;
    for (const candidate of candidatePaths) {
      try {
        await fs.promises.access(candidate, fs.constants.R_OK);
        filePath = candidate;
        break;
      } catch {
        // Try the next approved legacy location.
      }
    }
    if (!filePath) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Floor plan asset is unavailable' });
    }

    const contentType = filename.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : filename.toLowerCase().endsWith('.png')
      ? 'image/png'
      : filename.toLowerCase().endsWith('.webp')
        ? 'image/webp'
        : filename.toLowerCase().endsWith('.svg')
          ? 'image/svg+xml'
          : 'image/jpeg';
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.type(contentType).send(fs.createReadStream(filePath));
  });

  // POST /api/floors/:id/image
  fastify.post('/:id/image', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Forbidden: Requires an authorized floor-plan administrator role' });
    }
    const { id } = request.params as { id: string };
    const floor = await getFloorWithUnit(fastify.prisma, id);

    if (!floor) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Floor not found'
      });
    }

    if (userRole === 'UNIT_ADMIN' && (!request.admin?.assignedUnitId || unitIdFromBuilding(floor.building) !== request.admin.assignedUnitId)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Unit Admins can only manage floor maps within their assigned unit' });
    }

    if (!request.isMultipart()) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Expected multipart/form-data'
      });
    }

    const file = await request.file();
    if (!file) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Image file required'
      });
    }

    if (!supportedImageMime(file.mimetype)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Only PNG, JPG, WebP, safe SVG images, and PDF floor plans are supported'
      });
    }

    const validator = createFloorPlanValidator(file.mimetype);
    const originalFilename = path.posix.basename(String(file.filename || '').replace(/\\/g, '/')).replace(/[\r\n\0]/g, '').slice(0, 255) || 'floor-plan';
    const unitId = unitIdFromBuilding(floor.building);
    if (!unitId) return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'The floor is not linked to a Unit.' });

    let uploaded: Awaited<ReturnType<FloorPlanAssetStore['upload']>> | undefined;
    try {
      const validatedStream = new PassThrough();
      const validationPipeline = pipeline(file.file, validator.stream, validatedStream).catch((error) => {
        validatedStream.destroy(error);
        throw error;
      });
      const uploadPromise = floorPlanAssetStore.upload(validatedStream, originalFilename, {
        floorId: floor.id,
        buildingId: floor.buildingId,
        unitId,
        originalFilename,
        mimeType: file.mimetype,
      });
      [uploaded] = await Promise.all([uploadPromise, validationPipeline]);
      const validation = validator.getResult();
      if (!validation) throw new FloorPlanUploadError('The uploaded file could not be validated.');
      const imageUrl = `/uploads/floors/${uploaded.id}.${validation.extension}`;
      try {
        await fastify.prisma.floor.update({ where: { id }, data: { imageUrl } });
      } catch (error) {
        await floorPlanAssetStore.delete(uploaded.id).catch((cleanupError) =>
          fastify.log.error({ cleanupError, floorId: id }, 'Failed to clean up an unreferenced GridFS floor plan'),
        );
        throw error;
      }
      return reply.status(200).send({
        imageUrl,
        floorId: floor.id,
        ...(validation.pageCount ? { pageCount: validation.pageCount } : {}),
      });
    } catch (error: any) {
      const statusCode = error instanceof FloorPlanUploadError ? error.statusCode : error?.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 500;
      if (statusCode === 500) fastify.log.error({ error, floorId: id }, 'Floor plan GridFS upload failed');
      return reply.status(statusCode).send({
        statusCode,
        error: statusCode === 413 ? 'Payload Too Large' : statusCode === 500 ? 'Internal Server Error' : 'Bad Request',
        message: statusCode === 500 ? 'Floor plan upload failed. No floor metadata was changed.' : error.message,
      });
    }
  });

  // PUT /api/floors/:id/layout (Batch layout persistence)
  fastify.put('/:id/layout', async (request, reply) => {
    const userRole = request.admin?.role;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'TECH_ADMIN' && userRole !== 'UNIT_ADMIN') {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Requires Super Admin or Unit Admin role'
      });
    }

    const { id } = request.params as { id: string };
    const floor = await getFloorWithUnit(fastify.prisma, id);

    if (!floor) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Floor not found'
      });
    }

    if (userRole === 'UNIT_ADMIN' && (!request.admin?.assignedUnitId || unitIdFromBuilding(floor.building) !== request.admin.assignedUnitId)) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Unit Admins can only manage floors within their assigned unit'
      });
    }

    const body = (request.body as {
      seats?: Array<{
        id?: string;
        label: string;
        x: number;
        y: number;
        rotation?: number;
        width?: number;
        height?: number;
        type?: SeatType;
        status?: SeatStatus;
        placementSource?: SeatPlacementSource | null;
      }>;
      deletedSeatIds?: string[];
      unplacedSeatIds?: string[];
    }) || {};

    const rawSeatsInput = Array.isArray(body.seats) ? body.seats : [];
    const rawDeletedSeatIds = Array.isArray(body.deletedSeatIds) ? body.deletedSeatIds : [];
    const rawUnplacedSeatIds = Array.isArray(body.unplacedSeatIds) ? body.unplacedSeatIds : [];

    // Deduplicate seat IDs in unplacedSeatIds and deletedSeatIds
    const unplacedSeatIds = [...new Set(rawUnplacedSeatIds.filter((sId): sId is string => typeof sId === 'string' && sId.trim().length > 0))];
    const deletedSeatIds = [...new Set(rawDeletedSeatIds.filter((sId): sId is string => typeof sId === 'string' && sId.trim().length > 0))];

    // Deduplicate seats in seatsInput by ID (if ID is present)
    const seenSeatIds = new Set<string>();
    const seatsInput: typeof rawSeatsInput = [];
    for (const seat of rawSeatsInput) {
      if (seat.id) {
        if (seenSeatIds.has(seat.id)) {
          continue;
        }
        seenSeatIds.add(seat.id);
      }
      seatsInput.push(seat);
    }

    // Strictly disjoint sets enforcement (Requirement 4)
    const unplacedSet = new Set(unplacedSeatIds);
    const deletedSet = new Set(deletedSeatIds);

    for (const seat of seatsInput) {
      if (seat.id && unplacedSet.has(seat.id)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Workstation '${seat.label || seat.id}' cannot appear in both placements and unplacedSeatIds`
        });
      }
      if (seat.id && deletedSet.has(seat.id)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Workstation '${seat.label || seat.id}' cannot appear in both placements and deletedSeatIds`
        });
      }
    }

    for (const uId of unplacedSeatIds) {
      if (deletedSet.has(uId)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Workstation '${uId}' cannot appear in both unplacedSeatIds and deletedSeatIds`
        });
      }
    }

    // 1. Validate duplicate seat labels in input
    const seenLabels = new Set<string>();
    for (const s of seatsInput) {
      if (s.label) {
        const lower = s.label.trim().toLowerCase();
        if (seenLabels.has(lower)) {
          return reply.status(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: `Duplicate seat label '${s.label}' on floor`
          });
        }
        seenLabels.add(lower);
      }
    }

    // 2. Validate coordinates within canvas bounds
    for (const s of seatsInput) {
      if (typeof s.x !== 'number' || typeof s.y !== 'number' || Number.isNaN(s.x) || Number.isNaN(s.y) || s.x < 0 || s.y < 0 || s.x > floor.canvasWidth || s.y > floor.canvasHeight) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Seat '${s.label}' coordinates out of canvas bounds`
        });
      }
    }

    // 3. Execute batch upsert inside bounded retry transaction
    try {
      const updatedSeats = await runTransactionWithRetry(
        fastify.prisma,
        async (tx) => {
          // Process deletions safely with audit preservation
          if (deletedSeatIds.length > 0) {
            const occupiedSeats = await tx.seat.findMany({
              where: {
                id: { in: deletedSeatIds },
                floorId: id,
                employeeId: { not: null }
              }
            });
            for (const occ of occupiedSeats) {
              await logAudit(tx as any, request, 'SEAT_UNASSIGNED', 'Seat', occ.id, {
                seatLabel: occ.label,
                previousEmployeeId: occ.employeeId,
                reason: 'Floor layout seat deletion'
              });
            }
            await tx.seat.deleteMany({
              where: {
                id: { in: deletedSeatIds },
                floorId: id
              }
            });
          }

          // Fetch all existing layout seats once inside the transaction
          const seatIdsToFetch = [
            ...seatsInput.map((s) => s.id).filter((value): value is string => Boolean(value)),
            ...unplacedSeatIds
          ];
          const existingSeats = seatIdsToFetch.length > 0
            ? await tx.seat.findMany({ where: { id: { in: seatIdsToFetch }, floorId: id } })
            : [];
          const existingById = new Map(existingSeats.map((seat) => [seat.id, seat]));

          // Process unplaced seats (clearing placementSource while strictly preserving
          // seat document, coordinates, department, and employee assignment)
          // Delta: only update seats whose placementSource is currently NOT null
          const unplacedSeatsToUpdate = unplacedSeatIds
            .map((uId) => existingById.get(uId))
            .filter((seat): seat is NonNullable<typeof seat> => Boolean(seat && seat.placementSource !== null));

          if (unplacedSeatsToUpdate.length > 0) {
            const idsToUnplace = unplacedSeatsToUpdate.map((s) => s.id);
            await tx.seat.updateMany({
              where: {
                id: { in: idsToUnplace },
                floorId: id,
                placementSource: { not: null }
              },
              data: {
                placementSource: null
              }
            });
          }

          const results = [];
          for (const s of seatsInput) {
            if (s.id) {
              const existing = existingById.get(s.id);

              if (existing) {
                // Compute target layout fields
                const targetLabel = s.label !== undefined ? s.label.trim() : existing.label;
                const targetX = s.x;
                const targetY = s.y;
                const targetPlacementSource = s.placementSource !== undefined ? s.placementSource : existing.placementSource;
                const targetRotation = s.rotation !== undefined ? s.rotation : (existing.rotation ?? 0);
                const targetWidth = s.width !== undefined ? s.width : (existing.width ?? 64);
                const targetHeight = s.height !== undefined ? s.height : (existing.height ?? 48);
                const targetType = s.type !== undefined ? s.type : existing.type;
                const targetStatus = existing.employeeId ? existing.status : (s.status !== undefined ? s.status : existing.status);

                // Delta check: only write if something actually changed
                const hasChanges =
                  targetLabel !== existing.label ||
                  targetX !== existing.x ||
                  targetY !== existing.y ||
                  targetPlacementSource !== existing.placementSource ||
                  targetRotation !== (existing.rotation ?? 0) ||
                  targetWidth !== (existing.width ?? 64) ||
                  targetHeight !== (existing.height ?? 48) ||
                  targetType !== existing.type ||
                  targetStatus !== existing.status;

                if (hasChanges) {
                  const updated = await tx.seat.update({
                    where: { id: s.id },
                    data: {
                      label: targetLabel,
                      x: targetX,
                      y: targetY,
                      placementSource: targetPlacementSource,
                      rotation: targetRotation,
                      width: targetWidth,
                      height: targetHeight,
                      type: targetType,
                      status: targetStatus
                    }
                  });
                  results.push(updated);
                } else {
                  results.push(existing);
                }
                continue;
              }
            }

            // Create new seat
            const created = await tx.seat.create({
              data: {
                ...(s.id && s.id.length > 10 ? { id: s.id } : {}),
                label: s.label.trim(),
                floorId: id,
                x: s.x,
                y: s.y,
                placementSource: s.placementSource ?? SeatPlacementSource.MANUAL,
                rotation: s.rotation ?? 0,
                width: s.width ?? 64,
                height: s.height ?? 48,
                type: s.type ?? SeatType.STANDARD_DESK,
                status: s.status ?? SeatStatus.AVAILABLE,
                // Persist vacant fields explicitly so MongoDB reads and atomic
                // claim predicates have one canonical representation going
                // forward. The claim paths also accept legacy missing fields.
                departmentId: null
              }
            });
            results.push(created);
          }

          await logAudit(tx as unknown as PrismaClient, request, 'LAYOUT_SAVED', 'Floor', id, {
            seatCount: results.length,
            deletedCount: deletedSeatIds.length,
            unplacedCount: unplacedSeatIds.length
          });

          return results;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 25,
          transactionOptions: { timeout: 30000, maxWait: 10000 }
        }
      );

      return reply.status(200).send({
        success: true,
        seats: updatedSeats
      });
    } catch (error: any) {
      request.log.error(error, 'Failed to save floor layout');

      // Controlled 409 Conflict for transient transaction conflicts or retry exhaustion
      if (isTransientTransactionConflict(error) || error?.message?.includes('retry exhausted') || error?.code === 'P2034') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Could not save layout due to concurrent modifications. Please retry.'
        });
      }

      // Controlled 409 for unique constraints (e.g. duplicate label in DB)
      if (error?.code === 'P2002') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'A workstation with this label already exists on the floor.'
        });
      }

      // Sanitized 500: Never expose raw Prisma/MongoDB invocation errors to client
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while saving floor layout.'
      });
    }
  });

  // PUT /api/floors/:id
  fastify.put('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (!canManageMasterData(userRole)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage floors; Unit Admins can only manage floors within their assigned unit through operational workflows.' });
    }
    const { id } = request.params as { id: string };
    const parseResult = UpdateFloorSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues.map((e) => e.message).join(', ')
      });
    }

    const floor = await getFloorWithUnit(fastify.prisma, id);

    if (!floor) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Floor not found'
      });
    }

    const { name, floorNumber, canvasWidth, canvasHeight, imageUrl } = parseResult.data;

    if (floorNumber !== undefined && floorNumber !== floor.floorNumber) {
      const conflict = await fastify.prisma.floor.findUnique({
        where: {
          buildingId_floorNumber: {
            buildingId: floor.buildingId,
            floorNumber
          }
        }
      });
      if (conflict) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Floor number already exists in this building'
        });
      }
    }

    const updated = await fastify.prisma.floor.update({
      where: { id },
      data: {
        name: name ?? floor.name,
        floorNumber: floorNumber ?? floor.floorNumber,
        canvasWidth: canvasWidth ?? floor.canvasWidth,
        canvasHeight: canvasHeight ?? floor.canvasHeight,
        imageUrl: imageUrl !== undefined ? imageUrl : floor.imageUrl
      }
    });

    await logAudit(fastify.prisma, request, 'FLOOR_UPDATED', 'Floor', id, {
      name: updated.name,
      floorNumber: updated.floorNumber
    });

    return reply.status(200).send(updated);
  });

  fastify.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!canManageMasterData(request.admin?.role)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage floors; Unit Admins can only manage floors within their assigned unit through operational workflows.' });
    }
    const parsed = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'isActive is required'
      });
    }
    const floor = await getFloorWithUnit(fastify.prisma, id);
    if (!floor) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Floor not found'
      });
    }
    return fastify.prisma.floor.update({ where: { id }, data: { isActive: parsed.data.isActive } });
  });

  // DELETE /api/floors/:id
  fastify.delete('/:id', async (request, reply) => {
    const userRole = request.admin?.role;
    if (!canManageMasterData(userRole)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tech Admin or Super Admin access required to manage floors; Unit Admins can only manage floors within their assigned unit through operational workflows.' });
    }
    const { id } = request.params as { id: string };

    const floor = await getFloorWithUnit(fastify.prisma, id);

    if (!floor) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Floor not found'
      });
    }

    const [seatCount, departmentCount, areaCount] = await Promise.all([
      fastify.prisma.seat.count({ where: { floorId: id } }),
      fastify.prisma.department.count({ where: { floorId: id } }),
      fastify.prisma.area.count({ where: { floorId: id } })
    ]);
    if (seatCount > 0 || departmentCount > 0 || areaCount > 0 || Boolean(floor.imageUrl)) {
      await fastify.prisma.floor.update({ where: { id }, data: { isActive: false } });
      await logAudit(fastify.prisma, request, 'FLOOR_ARCHIVED', 'Floor', id, { name: floor.name });
      return reply.status(200).send({ archived: true, reason: 'Floor is in use' });
    }

    await fastify.prisma.floor.delete({
      where: { id }
    });

    await logAudit(fastify.prisma, request, 'FLOOR_DELETED', 'Floor', id, {
      name: floor.name
    });

    return reply.status(200).send({ success: true, deletedId: id });
  });
};
