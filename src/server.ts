import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient, Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { SEAT_TYPES, SEAT_STATUSES } from '@seating/shared';

import prismaPlugin from './plugins/prisma.js';
import sessionPlugin from './plugins/session.js';
import authGuardPlugin from './plugins/auth.js';
import multipartPlugin from './plugins/multipart.js';

import { authRoutes } from './routes/auth.js';
import { unitRoutes } from './routes/units.js';
import { plantRoutes } from './routes/plants.js';
import { officeRoutes } from './routes/offices.js';
import { buildingRoutes } from './routes/buildings.js';
import { floorRoutes } from './routes/floors.js';
import { departmentRoutes } from './routes/departments.js';
import { employeeRoutes } from './routes/employees.js';
import { seatRoutes } from './routes/seats.js';
import { reportRoutes } from './routes/reports.js';
import { auditLogRoutes } from './routes/audit-logs.js';
import { transferRequestRoutes } from './routes/transfer-requests.js';
import { areaRoutes, sectionRoutes, functionRoutes } from './routes/master-categories.js';
import { workstationRoutes } from './routes/workstations.js';
import { notificationRoutes } from './routes/notifications.js';
import { adminUserRoutes } from './routes/admin-users.js';
import { dataReconciliationRoutes } from './routes/data-reconciliation.js';
import { isLegacyEmployeeBulkImportEnabled, isReconciliationEnabled } from './config/feature-flags.js';
import { initialImportRoutes } from './routes/initial-import.js';
import { pendingCorrectionsRoutes } from './routes/pending-corrections.js';
import {
  FloorPlanAssetStore,
  MemoryFloorPlanAssetStore,
  MongoGridFsFloorPlanAssetStore,
} from './services/floor-plan-asset-store.js';

export interface ServerBuildOptions extends FastifyServerOptions {
  prisma?: PrismaClient;
  sessionSecret?: string;
  sessionSalt?: string;
  cookieName?: string;
  enableReconciliation?: boolean;
  enableLegacyEmployeeBulkImport?: boolean;
  floorPlanAssetStore?: FloorPlanAssetStore;
}

export type ServerOptions = ServerBuildOptions;

export function buildServer(opts: ServerBuildOptions = {}): FastifyInstance {
  const isTest = process.env.NODE_ENV === 'test';

  const server = Fastify({
    logger: opts.logger ?? (isTest ? false : true),
    ...opts
  });
  const floorPlanAssetStore = opts.floorPlanAssetStore
    ?? (isTest ? new MemoryFloorPlanAssetStore() : new MongoGridFsFloorPlanAssetStore());
  server.addHook('onClose', async () => floorPlanAssetStore.close());

  // 1. Hardened CORS Configuration
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  const explicitAllowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  server.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. fastify.inject, curl, server-to-server)
      if (!origin) {
        return cb(null, true);
      }

      // If explicit ALLOWED_ORIGINS configured, enforce it strictly
      if (explicitAllowedOrigins.length > 0) {
        if (explicitAllowedOrigins.includes(origin)) {
          return cb(null, true);
        }
        return cb(null, false);
      }

      // In dev or test environments, permit localhost and 127.0.0.1 origins
      if (process.env.NODE_ENV !== 'production') {
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        if (isLocalhost) {
          return cb(null, true);
        }
      }

      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });

  // Support empty JSON bodies gracefully for DELETE or body-less requests
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string | Buffer, done) => {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, undefined);
      return;
    }
    try {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      done(null, JSON.parse(raw));
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // 2. Central Error Handler
  server.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    // Zod validation error
    if (error instanceof ZodError) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: error.issues.map((e) => e.message).join(', ')
      });
    }

    // Prisma Unique Constraint Error
    const isP2002 =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
      (error as any)?.code === 'P2002';

    if (isP2002) {
      const meta = (error as any).meta;
      let target = 'field';
      if (Array.isArray(meta?.target) && meta.target.length > 0) {
        target = meta.target.join(', ');
      } else if (typeof meta?.target === 'string' && meta.target.trim().length > 0) {
        target = meta.target.trim();
      }
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `Duplicate value on unique constraint: ${target}`
      });
    }

    // Prisma Foreign Key Constraint Error
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Referential integrity constraint failed'
      });
    }

    // Prisma Record Not Found Error or Malformed ObjectID
    if (
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') ||
      error.message?.includes('Malformed ObjectID')
    ) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Resource not found'
      });
    }

    // Explicit statusCode or fallback 500
    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      statusCode,
      error: error.name || (statusCode >= 500 ? 'Internal Server Error' : 'Error'),
      message: (statusCode >= 500 && process.env.NODE_ENV === 'production')
        ? 'An internal server error occurred'
        : (error.message || 'An unexpected error occurred')
    });
  });

  // 3. Plugins
  server.register(prismaPlugin, { prisma: opts.prisma });
  server.register(sessionPlugin, {
    secret: opts.sessionSecret,
    salt: opts.sessionSalt,
    cookieName: opts.cookieName
  });
  server.register(authGuardPlugin);
  server.register(multipartPlugin);

  // 4. Whitelisted healthcheck route
  server.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      supportedSeatTypes: SEAT_TYPES,
      supportedSeatStatuses: SEAT_STATUSES
    };
  });

  // 5. REST API Routes (Strict Admin-Only Static Assignment)
  server.register(authRoutes, { prefix: '/api/auth' });
  server.register(adminUserRoutes, { prefix: '/api/admin-users' });
  server.register(unitRoutes, { prefix: '/api/units' });
  server.register(plantRoutes, { prefix: '/api/plants' });
  server.register(officeRoutes, { prefix: '/api/offices' });
  server.register(buildingRoutes, { prefix: '/api/buildings' });
  server.register(floorRoutes, { prefix: '/api/floors', floorPlanAssetStore });
  server.register(departmentRoutes, { prefix: '/api/departments' });
  server.register(areaRoutes, { prefix: '/api/areas' });
  server.register(sectionRoutes, { prefix: '/api/sections' });
  server.register(functionRoutes, { prefix: '/api/functions' });
  server.register(employeeRoutes, {
    prefix: '/api/employees',
    enableLegacyEmployeeBulkImport: opts.enableLegacyEmployeeBulkImport ?? isLegacyEmployeeBulkImportEnabled()
  });
  server.register(seatRoutes, { prefix: '/api/seats' });
  server.register(reportRoutes, { prefix: '/api/reports' });
  server.register(auditLogRoutes, { prefix: '/api/audit-logs' });
  server.register(transferRequestRoutes, { prefix: '/api/transfer-requests' });
  server.register(workstationRoutes, { prefix: '/api/workstations' });
  server.register(notificationRoutes, { prefix: '/api/notifications' });
  server.register(dataReconciliationRoutes, {
    prefix: '/api/data-reconciliation',
    enabled: opts.enableReconciliation ?? isReconciliationEnabled()
  });
  server.register(initialImportRoutes, { prefix: '/api/initial-import' });
  server.register(pendingCorrectionsRoutes, { prefix: '/api/data-quality/pending-corrections' });
  server.register(pendingCorrectionsRoutes, { prefix: '/api/pending-corrections' });

  return server;
}

