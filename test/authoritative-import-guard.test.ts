import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('authoritative migration and hidden reconciliation guards', () => {
  let server: FastifyInstance;
  let cookie: string;
  let previousOwnerEmail: string | undefined;

  beforeEach(async () => {
    previousOwnerEmail = process.env.INITIAL_IMPORT_OWNER_EMAIL;
    process.env.INITIAL_IMPORT_OWNER_EMAIL = DEFAULT_ADMIN.email;
    server = buildServer({
      prisma: await createMockPrisma(),
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
      enableReconciliation: false,
      enableLegacyEmployeeBulkImport: false
    });
    await server.ready();
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    expect(login.statusCode).toBe(200);
    cookie = login.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
    if (previousOwnerEmail === undefined) delete process.env.INITIAL_IMPORT_OWNER_EMAIL;
    else process.env.INITIAL_IMPORT_OWNER_EMAIL = previousOwnerEmail;
  });

  it('disables reconciliation APIs without deleting their implementation', async () => {
    const requests = [
      { method: 'GET', url: '/api/data-reconciliation/summary' },
      { method: 'GET', url: '/api/data-reconciliation/cases' },
      { method: 'POST', url: '/api/data-reconciliation/bulk-plan' },
      { method: 'POST', url: '/api/data-reconciliation/bulk-apply', payload: { runId: 'disabled' } },
      { method: 'POST', url: '/api/data-reconciliation/cases/disabled/apply', payload: {} }
    ] as const;

    for (const request of requests) {
      const response = await server.inject({ ...request, headers: { cookie } });
      expect(response.statusCode).toBe(404);
      expect(response.json().message).toMatch(/disabled/i);
    }
  });

  it('rejects the legacy employee bulk-import route when the controlled workflow is active', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/employees/import-csv',
      headers: { cookie, 'content-type': 'multipart/form-data; boundary=guard' },
      payload: '--guard--\r\n'
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('BULK_IMPORT_DISABLED');
  });

  it('permanently rejects the legacy bulk route after the initial import is completed', async () => {
    const completedPrisma = await createMockPrisma();
    const unit = await completedPrisma.unit.create({ data: { name: 'Manual Lock Unit', code: 'MLU' } });
    const department = await completedPrisma.department.create({ data: { name: 'Manual Lock Test', code: 'MLT', unitId: unit.id } });
    (completedPrisma as any).initialImportRun = {
      findUnique: async () => ({ key: 'AUTHORITATIVE_WORKBOOK', status: 'COMPLETED' })
    };
    const completedServer = buildServer({
      prisma: completedPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
      enableLegacyEmployeeBulkImport: true
    });
    await completedServer.ready();
    try {
      const login = await completedServer.inject({ method: 'POST', url: '/api/auth/login', payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password } });
      const response = await completedServer.inject({
        method: 'POST',
        url: '/api/employees/import-csv',
        headers: { cookie: login.headers['set-cookie'] as string, 'content-type': 'multipart/form-data; boundary=completed' },
        payload: '--completed--\r\n'
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('INITIAL_IMPORT_COMPLETED');

      const createResponse = await completedServer.inject({
        method: 'POST',
        url: '/api/employees',
        headers: { cookie: login.headers['set-cookie'] as string },
        payload: { employeeCode: 'MANUAL-AFTER-LOCK', fullName: 'Manual Employee', departmentId: department.id, unitId: unit.id }
      });
      expect(createResponse.statusCode).toBe(201);
      const created = createResponse.json();
      const editResponse = await completedServer.inject({
        method: 'PUT',
        url: `/api/employees/${created.id}`,
        headers: { cookie: login.headers['set-cookie'] as string },
        payload: { fullName: 'Manual Employee Edited', departmentId: department.id, unitId: unit.id }
      });
      expect(editResponse.statusCode).toBe(200);
      expect(editResponse.json().fullName).toBe('Manual Employee Edited');
    } finally {
      await completedServer.close();
    }
  });

  it('exposes a persistent status endpoint only to the configured owner', async () => {
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/initial-import/status',
      headers: { cookie }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe('NOT_STARTED');
    expect(allowed.json().mode).toMatch(/DATABASE/);

    process.env.INITIAL_IMPORT_OWNER_EMAIL = 'different-owner@company.com';
    const denied = await server.inject({
      method: 'GET',
      url: '/api/initial-import/status',
      headers: { cookie }
    });
    expect(denied.statusCode).toBe(403);
  });

  it('keeps live apply disabled until the separate owner approval gate is enabled', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/initial-import/apply',
      headers: { cookie },
      payload: { runId: 'not-a-live-run', sourceHash: 'not-a-source-hash', confirmation: 'APPLY_AUTHORITATIVE_WORKBOOK' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('INITIAL_IMPORT_APPLY_DISABLED');
  });
});
