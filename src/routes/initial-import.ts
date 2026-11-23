import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authoritativeImportService, parseAuthoritativeWorkbook } from '../services/authoritative-import.service.js';
import { authoritativeExcelPath } from '../config/feature-flags.js';

const ownerEmails = () => new Set((process.env.INITIAL_IMPORT_OWNER_EMAIL || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));

const requireOwner = (request: FastifyRequest, reply: FastifyReply) => {
  const role = request.admin?.role;
  const emails = ownerEmails();
  if (!request.admin || !['TECH_ADMIN', 'SUPER_ADMIN'].includes(role || '') || emails.size === 0 || !emails.has(String(request.admin.email || '').toLowerCase())) {
    reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Initial authoritative migration is restricted to the configured system owner.' });
    return false;
  }
  return true;
};

export const initialImportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const state = await authoritativeImportService.getState(fastify.prisma);
    const employeeCount = await fastify.prisma.employee.count();
    const seatCount = await fastify.prisma.seat.count();
    return reply.status(200).send({
      status: state?.status || 'NOT_STARTED',
      sourceFilename: state?.sourceFilename || null,
      sourceHash: state?.sourceHash || null,
      startedAt: state?.startedAt || null,
      completedAt: state?.completedAt || null,
      processedRows: state?.processedRows || 0,
      successfulRows: state?.successfulRows || 0,
      blockedRows: state?.blockedRows || 0,
      failedRows: state?.failedRows || 0,
      verification: state?.verification || null,
      databasePopulated: employeeCount > 0 || seatCount > 0,
      mode: employeeCount > 0 || seatCount > 0 ? 'CONTROLLED_EXISTING_DATABASE_ALIGNMENT' : 'INITIAL_EMPTY_DATABASE'
    });
  });

  fastify.post('/dry-run', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    try {
      const plan = await authoritativeImportService.generateDryRunPlan(fastify.prisma, authoritativeExcelPath());
      return reply.status(200).send(plan);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      return reply.status(statusCode).send({ statusCode, error: statusCode >= 500 ? 'Internal Server Error' : 'Conflict', code: error.code, message: statusCode >= 500 ? 'Authoritative migration dry-run failed.' : error.message });
    }
  });

  fastify.get('/issues', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const state = await authoritativeImportService.getState(fastify.prisma);
    const sourceHash = state?.sourceHash || '';
    const overrides = sourceHash ? await authoritativeImportService.listOverrides(fastify.prisma, sourceHash) : [];
    const extraDecisions = sourceHash ? await authoritativeImportService.listExtraDecisions(fastify.prisma, sourceHash) : [];
    return reply.status(200).send({
      runId: state?.id || null,
      status: state?.status || 'NOT_STARTED',
      sourceHash: sourceHash || null,
      blockers: state?.manifest?.blockers || [],
      overrides,
      extraDecisions
    });
  });

  fastify.post('/extra-decisions', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const body = (request.body || {}) as {
      sourceHash?: string;
      entityType?: 'EMPLOYEE' | 'WORKSTATION';
      entityId?: string;
      decision?: 'QUARANTINED' | 'ARCHIVED';
      explanation?: string;
    };
    if (!body.sourceHash || !body.entityType || !body.entityId || !body.decision || !body.explanation) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'sourceHash, entityType, entityId, decision and explanation are required.' });
    }
    try {
      const source = parseAuthoritativeWorkbook(authoritativeExcelPath() || '');
      if (source.hash !== body.sourceHash.toLowerCase()) {
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', code: 'AUTHORITATIVE_SOURCE_CHANGED', message: 'The configured workbook does not match the extra-record decision source hash.' });
      }
      const saved = await authoritativeImportService.saveExtraDecision(fastify.prisma, request.admin!, request, {
        sourceHash: source.hash,
        entityType: body.entityType,
        entityId: body.entityId,
        decision: body.decision,
        explanation: body.explanation
      });
      return reply.status(200).send(saved);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      return reply.status(statusCode).send({ statusCode, error: statusCode >= 500 ? 'Internal Server Error' : 'Conflict', code: error.code, message: statusCode >= 500 ? 'Extra-record decision could not be saved.' : error.message });
    }
  });

  fastify.post('/overrides', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const body = (request.body || {}) as {
      sourceHash?: string;
      sheet?: string;
      rowNumber?: number;
      field?: string;
      originalValue?: unknown;
      correctedValue?: unknown;
      explanation?: string;
    };
    if (!body.sourceHash || !body.field || body.correctedValue === undefined || !body.explanation) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'sourceHash, field, correctedValue and explanation are required.' });
    }
    try {
      const source = parseAuthoritativeWorkbook(authoritativeExcelPath() || '');
      if (source.hash !== body.sourceHash.toLowerCase()) {
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', code: 'AUTHORITATIVE_SOURCE_CHANGED', message: 'The configured workbook does not match the override source hash.' });
      }
      const saved = await authoritativeImportService.saveOverride(fastify.prisma, request.admin!, request, {
        sourceHash: source.hash,
        sheet: body.sheet || 'Sheet1',
        rowNumber: Number(body.rowNumber),
        field: body.field,
        originalValue: body.originalValue,
        correctedValue: body.correctedValue,
        explanation: body.explanation
      });
      return reply.status(200).send(saved);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      return reply.status(statusCode).send({ statusCode, error: statusCode >= 500 ? 'Internal Server Error' : 'Conflict', code: error.code, message: statusCode >= 500 ? 'Migration override could not be saved.' : error.message });
    }
  });

  fastify.post('/recover', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const body = (request.body || {}) as { confirmation?: string };
    try {
      const recovered = await authoritativeImportService.recoverInterruptedRun(fastify.prisma, request.admin!, request, body.confirmation || '');
      return reply.status(200).send(recovered);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      return reply.status(statusCode).send({ statusCode, error: statusCode >= 500 ? 'Internal Server Error' : 'Conflict', code: error.code, message: statusCode >= 500 ? 'Migration recovery failed.' : error.message });
    }
  });

  fastify.post('/plan', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    try {
      const plan = await authoritativeImportService.generatePlan(fastify.prisma, request.admin!.id, authoritativeExcelPath());
      return reply.status(200).send(plan);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      return reply.status(statusCode).send({ statusCode, error: statusCode >= 500 ? 'Internal Server Error' : 'Conflict', code: error.code, message: statusCode >= 500 ? 'Initial authoritative migration planning failed.' : error.message });
    }
  });

  fastify.post('/apply', async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const body = (request.body || {}) as { runId?: string; sourceHash?: string; confirmation?: string };
    if (!body.runId || !body.sourceHash) return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId and sourceHash are required.' });
    try {
      const result = await authoritativeImportService.applyPlan(fastify.prisma, request.admin!, request, body.runId, body.sourceHash, body.confirmation || '');
      return reply.status(200).send(result);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      return reply.status(statusCode).send({ statusCode, error: statusCode >= 500 ? 'Internal Server Error' : 'Conflict', code: error.code, message: statusCode >= 500 ? 'Initial authoritative migration apply failed.' : error.message });
    }
  });
};
