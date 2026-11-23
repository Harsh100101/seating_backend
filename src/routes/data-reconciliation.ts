import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import {
  ReconciliationClassification,
  RECONCILIATION_CLASSIFICATIONS
} from '@seating/shared';
import {
  dataReconciliationService,
  ReconciliationConflictError,
  ReconciliationBlockedError
} from '../services/data-reconciliation.service.js';

export const dataReconciliationRoutes: FastifyPluginAsync<{ enabled?: boolean }> = async (fastify, options) => {
  if (options.enabled === false) {
    fastify.addHook('onRequest', async (_request, reply) => {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Data reconciliation is disabled.'
      });
    });
  }

  // Pre-handler guard to enforce base module RBAC
  const enforceModuleAccess = (request: FastifyRequest, reply: FastifyReply) => {
    const role = request.admin?.role;
    if (role === 'UNIT_ADMIN') {
      reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Data reconciliation is restricted to Super Admin and Tech Admin.'
      });
      return false;
    }
    if (role !== 'SUPER_ADMIN' && role !== 'TECH_ADMIN') {
      reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Access restricted to authorized administrators.'
      });
      return false;
    }
    return true;
  };

  // Pre-handler guard to enforce Super Admin write-permission
  const enforceMutationAccess = (request: FastifyRequest, reply: FastifyReply) => {
    if (!enforceModuleAccess(request, reply)) return false;
    const role = request.admin?.role;
    if (role === 'TECH_ADMIN') {
      reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Tech Admin has read-only access to Data Reconciliation.'
      });
      return false;
    }
    if (role !== 'SUPER_ADMIN') {
      reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Forbidden: Action requires Super Admin privileges.'
      });
      return false;
    }
    return true;
  };

  // GET /api/data-reconciliation/summary - Dashboard Metric Cards
  fastify.get('/summary', async (request, reply) => {
    if (!enforceModuleAccess(request, reply)) return;
    try {
      const metrics = await dataReconciliationService.getSummaryMetrics(fastify.prisma);
      return reply.status(200).send(metrics);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to retrieve reconciliation summary'
      });
    }
  });

  // GET /api/data-reconciliation/cases - Filtered List with Pagination
  fastify.get('/cases', async (request, reply) => {
    if (!enforceModuleAccess(request, reply)) return;
    const query = request.query as {
      status?: string;
      classification?: string;
      unitId?: string;
      unit?: string;
      departmentId?: string;
      department?: string;
      mismatchField?: string;
      search?: string;
      page?: string;
      limit?: string;
    };

    try {
      const result = await dataReconciliationService.getCases(fastify.prisma, {
        status: query.status,
        classification: query.classification,
        unitId: query.unitId,
        unit: query.unit,
        departmentId: query.departmentId,
        department: query.department,
        mismatchField: query.mismatchField,
        search: query.search,
        page: query.page ? Number(query.page) : undefined,
        limit: query.limit ? Number(query.limit) : undefined
      });
      return reply.status(200).send(result);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to retrieve reconciliation cases'
      });
    }
  });

  // GET /api/data-reconciliation/cases/:id - Case Details & Evidence
  fastify.get('/cases/:id', async (request, reply) => {
    if (!enforceModuleAccess(request, reply)) return;
    const { id } = request.params as { id: string };

    try {
      const caseDetail = await dataReconciliationService.getCaseDetail(fastify.prisma, id);
      if (!caseDetail) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Reconciliation case '${id}' not found`
        });
      }
      return reply.status(200).send(caseDetail);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to retrieve reconciliation case details'
      });
    }
  });

  // POST /api/data-reconciliation/cases/:id/preview - Read-only Validation Preview (TECH_ADMIN allowed)
  fastify.post('/cases/:id/preview', async (request, reply) => {
    if (!enforceModuleAccess(request, reply)) return;
    const { id } = request.params as { id: string };

    try {
      const preview = await dataReconciliationService.previewCorrection(fastify.prisma, id);
      return reply.status(200).send(preview);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err.message
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to preview reconciliation correction'
      });
    }
  });

  // POST /api/data-reconciliation/bulk-plan - read-only authoritative workbook plan
  fastify.post('/bulk-plan', async (request, reply) => {
    if (!enforceModuleAccess(request, reply)) return;
    try {
      const plan = await dataReconciliationService.generateBulkPlan(fastify.prisma);
      return reply.status(200).send(plan);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to generate reconciliation plan'
      });
    }
  });

  // POST /api/data-reconciliation/bulk-apply - SUPER_ADMIN-only explicit apply
  fastify.post('/bulk-apply', async (request, reply) => {
    if (!enforceMutationAccess(request, reply)) return;
    const body = (request.body as { runId?: string }) || {};
    if (!body.runId) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId is required.' });
    }
    try {
      const result = await dataReconciliationService.applyBulkPlan(fastify.prisma, body.runId, request.admin!, request);
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: err.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to apply reconciliation plan'
      });
    }
  });

  // POST /api/data-reconciliation/cases/:id/apply - Apply System Correction (SUPER_ADMIN only)
  fastify.post('/cases/:id/apply', async (request, reply) => {
    if (!enforceMutationAccess(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body as { snapshotUpdatedAt?: string; expectedSeatId?: string | null; notes?: string }) || {};

    try {
      const result = await dataReconciliationService.applyCorrection(
        fastify.prisma,
        id,
        {
          snapshotUpdatedAt: body.snapshotUpdatedAt,
          expectedSeatId: body.expectedSeatId,
          notes: body.notes
        },
        request.admin!,
        request
      );
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err instanceof ReconciliationConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          code: 'RECONCILIATION_STALE',
          message: err.message
        });
      }
      if (err instanceof ReconciliationBlockedError) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          code: 'RECONCILIATION_BLOCKED',
          message: err.message
        });
      }
      if (err.message?.includes('not found')) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err.message
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to apply reconciliation correction'
      });
    }
  });

  // POST /api/data-reconciliation/cases/:id/classify - Set Classification (SUPER_ADMIN only)
  fastify.post('/cases/:id/classify', async (request, reply) => {
    if (!enforceMutationAccess(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body as { classification?: ReconciliationClassification; notes?: string }) || {};

    if (!body.classification || !RECONCILIATION_CLASSIFICATIONS.includes(body.classification)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Invalid classification '${body.classification}'. Allowed: ${RECONCILIATION_CLASSIFICATIONS.join(', ')}`
      });
    }

    try {
      const updatedCase = await dataReconciliationService.classifyCase(
        fastify.prisma,
        id,
        body.classification,
        body.notes,
        request.admin!,
        request
      );
      return reply.status(200).send(updatedCase);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err.message
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to classify reconciliation case'
      });
    }
  });

  // POST /api/data-reconciliation/cases/:id/resolve - Resolve Case (SUPER_ADMIN only)
  fastify.post('/cases/:id/resolve', async (request, reply) => {
    if (!enforceMutationAccess(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body as { resolutionType?: 'KEEP_CURRENT' | 'FORMATTING_ONLY'; notes?: string }) || {};

    if (body.resolutionType !== 'KEEP_CURRENT' && body.resolutionType !== 'FORMATTING_ONLY') {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: "resolutionType must be 'KEEP_CURRENT' or 'FORMATTING_ONLY'"
      });
    }

    try {
      const updatedCase = await dataReconciliationService.resolveCase(
        fastify.prisma,
        id,
        body.resolutionType,
        body.notes,
        request.admin!,
        request
      );
      return reply.status(200).send(updatedCase);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err.message
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to resolve reconciliation case'
      });
    }
  });

  // POST /api/data-reconciliation/cases/:id/needs-review - Flag Case (SUPER_ADMIN only)
  fastify.post('/cases/:id/needs-review', async (request, reply) => {
    if (!enforceMutationAccess(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body as { notes?: string }) || {};

    try {
      const updatedCase = await dataReconciliationService.markNeedsReview(
        fastify.prisma,
        id,
        body.notes,
        request.admin!,
        request
      );
      return reply.status(200).send(updatedCase);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err.message
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to flag reconciliation case'
      });
    }
  });

  // POST /api/data-reconciliation/cases/:id/reopen - Reopen Case (SUPER_ADMIN only)
  fastify.post('/cases/:id/reopen', async (request, reply) => {
    if (!enforceMutationAccess(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body as { notes?: string }) || {};

    try {
      const updatedCase = await dataReconciliationService.reopenCase(
        fastify.prisma,
        id,
        body.notes,
        request.admin!,
        request
      );
      return reply.status(200).send(updatedCase);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err.message
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to reopen reconciliation case'
      });
    }
  });
};
