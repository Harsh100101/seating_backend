import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import xlsx from 'xlsx';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD, TECH_ADMIN_PASSWORD, TECH_ADMIN_EMAIL } from '../prisma/seed.js';
import { dataReconciliationService } from '../src/services/data-reconciliation.service.js';
import { ReconciliationStatus, ReconciliationClassification } from '@seating/shared';

describe('Data Reconciliation Module (Backend)', () => {
  let server: FastifyInstance;
  let prisma: any;
  let superAdminCookie: string;
  let techAdminCookie: string;
  let unitAdminCookie: string;
  let tempExcelPath: string;
  let tempStateStorePath: string;

  // Fixture references
  let unit1: any;
  let unit2: any;
  let bldAdmin: any;
  let bldSantosh: any;
  let floor1: any;
  let floor2: any;
  let deptEng: any;
  let deptIt: any;
  let empMohit: any;
  let empGunjan: any;
  let empOccupant: any;
  let seatWs01: any;
  let seatWs02: any;
  let seatOccupied: any;

  async function login(email: string, password = DEMO_PASSWORD): Promise<string> {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password }
    });
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie'] as string;
  }

  function createTestExcelFile(filePath: string, rows: any[]) {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    xlsx.writeFile(wb, filePath);
  }

  beforeEach(async () => {
    prisma = await createMockPrisma();
    await seed(prisma, { includeDemoAccounts: true });

    // Temp directories for isolated test runs
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
    tempExcelPath = path.join(tempDir, 'test-workstations.xlsx');
    tempStateStorePath = path.join(tempDir, 'reconcile-store.json');

    dataReconciliationService.resetState();
    dataReconciliationService.setStateStorePath(tempStateStorePath);

    // Setup hierarchy fixtures in mock Prisma
    const units = await prisma.unit.findMany();
    unit1 = units.find((u: any) => u.code === 'UNIT-1');
    unit2 = units.find((u: any) => u.code === 'UNIT-2');

    const u1Plant = await prisma.plant.create({
      data: { name: 'Unit 1 Plant 1', code: `PLT-U1-01`, unitId: unit1.id }
    });
    bldAdmin = await prisma.building.create({
      data: { name: 'ADMIN', code: `BLD-ADMIN`, plantId: u1Plant.id }
    });
    floor1 = await prisma.floor.create({
      data: { name: 'GF', floorNumber: 1, buildingId: bldAdmin.id }
    });

    const u2Plant = await prisma.plant.findFirst({ where: { unitId: unit2.id } });
    bldSantosh = await prisma.building.findFirst({ where: { plantId: u2Plant.id } });
    floor2 = await prisma.floor.findFirst({ where: { buildingId: bldSantosh.id, floorNumber: 2 } });

    deptEng = await prisma.department.findFirst({ where: { code: 'ENG' } });
    deptIt = await prisma.department.create({
      data: { name: 'IT & Infrastructure', code: 'IT-INFRA', unitId: unit1.id }
    });
    const sectionIt = await prisma.section.create({
      data: { name: 'Central Admin & Travel Desk', normalizedName: 'central admin & travel desk', departmentId: deptIt.id }
    });
    await prisma.orgFunction.create({
      data: { name: 'IT & Infrastructure', normalizedName: 'it & infrastructure', sectionId: sectionIt.id }
    });

    // Employee 1: MOHIT PARMAR (SS3362) -> currently seated in Unit 2 Santosh Bhavan, Excel says ADMIN GF
    empMohit = await prisma.employee.create({
      data: {
        employeeCode: 'SS3362',
        fullName: 'MOHIT PARMAR',
        email: 'mohit@example.com',
        departmentId: deptIt.id,
        officeArea: 'Admin IT office',
        section: 'Central Admin & Travel Desk',
        functionName: 'IT & Infrastructure',
        isActive: true
      }
    });

    seatWs01 = await prisma.seat.create({
      data: {
        label: 'WS-01',
        floorId: floor1.id,
        status: 'AVAILABLE'
      }
    });

    seatWs02 = await prisma.seat.create({
      data: {
        label: 'WS-02',
        floorId: floor2.id,
        status: 'AVAILABLE',
        employeeId: empMohit.id,
        departmentId: deptIt.id
      }
    });

    // Employee 2: Occupant on occupied seat
    empOccupant = await prisma.employee.create({
      data: {
        employeeCode: 'OCC001',
        fullName: 'Seat Occupant',
        email: 'occupant@example.com',
        departmentId: deptEng.id,
        isActive: true
      }
    });

    seatOccupied = await prisma.seat.create({
      data: {
        label: 'WS-OCCUPIED',
        floorId: floor1.id,
        status: 'AVAILABLE',
        employeeId: empOccupant.id,
        departmentId: deptEng.id
      }
    });

    // Employee 3: Gunjan Sharma (22287) -> has duplicate rows in Excel
    empGunjan = await prisma.employee.create({
      data: {
        employeeCode: '22287',
        fullName: 'Gunjan Sharma',
        email: 'gunjan@example.com',
        departmentId: deptEng.id,
        isActive: true
      }
    });

    // Write test excel rows
    const testExcelRows = [
      {
        'Sr.No.': 1,
        Unit: 'Unit-1',
        Building: 'ADMIN',
        Floor: 'GF',
        'Office / Area': 'Admin IT office',
        Department: 'IT & Infrastructure',
        Section: 'Central Admin & Travel Desk',
        Function: 'IT & Infrastructure',
        'WS NO': 'WS-01',
        'Emp Code': 'SS3362',
        'E. Name': 'MOHIT PARMAR',
        'Reporting to': 'Rajesh Ravrani',
        HOD: 0,
        Status: 'Active'
      },
      {
        'Sr.No.': 2,
        Unit: 'Unit-1',
        Building: 'ADMIN',
        Floor: 'GF',
        'Office / Area': 'Admin IT office',
        Department: 'IT & Infrastructure',
        Section: 'Central Admin',
        Function: 'IT',
        'WS NO': 'WS-OCCUPIED',
        'Emp Code': 'EMP-BLOCKED',
        'E. Name': 'Blocked Employee',
        Status: 'Active'
      },
      {
        'Sr.No.': 3,
        Unit: 'Unit-1',
        Building: 'ADMIN',
        Floor: 'GF',
        'Office / Area': 'R&D',
        Department: 'Engineering',
        Section: 'Design',
        Function: 'Design',
        'WS NO': 'WS-47',
        'Emp Code': '22287',
        'E. Name': 'Gunjan Sharma',
        Status: 'Active'
      },
      {
        'Sr.No.': 4,
        Unit: 'Unit-2',
        Building: 'Santosh Bhavan',
        Floor: 'Floor 2',
        'Office / Area': 'Design',
        Department: 'Engineering',
        Section: 'Design',
        Function: 'Design',
        'WS NO': 'WS-12',
        'Emp Code': '22287',
        'E. Name': 'Gunjan Sharma',
        Status: 'Active'
      }
    ];

    // Create blocked employee in prisma
    await prisma.employee.create({
      data: {
        employeeCode: 'EMP-BLOCKED',
        fullName: 'Blocked Employee',
        email: 'blocked@example.com',
        departmentId: deptIt.id,
        isActive: true
      }
    });

    createTestExcelFile(tempExcelPath, testExcelRows);
    process.env.RECONCILIATION_EXCEL_PATH = tempExcelPath;

    server = buildServer({
      prisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
      enableReconciliation: true
    });

    superAdminCookie = await login('superadmin@shaktiman.com');
    techAdminCookie = await login(TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD);
    unitAdminCookie = await login('unit1.admin@shaktiman.com');
  });

  afterEach(async () => {
    delete process.env.RECONCILIATION_EXCEL_PATH;
    try {
      if (fs.existsSync(tempExcelPath)) fs.unlinkSync(tempExcelPath);
      if (fs.existsSync(tempStateStorePath)) fs.unlinkSync(tempStateStorePath);
    } catch {}
  });

  // =========================================================================
  // 1. Strict Module RBAC Matrix Tests
  // =========================================================================
  describe('RBAC Matrix Enforcement', () => {
    it('UNIT_ADMIN is denied with 403 on ALL reconciliation endpoints', async () => {
      const endpoints: Array<{ method: 'GET' | 'POST'; url: string; payload?: any }> = [
        { method: 'GET', url: '/api/data-reconciliation/summary' },
        { method: 'GET', url: '/api/data-reconciliation/cases' },
        { method: 'GET', url: '/api/data-reconciliation/cases/SS3362' },
        { method: 'POST', url: '/api/data-reconciliation/cases/SS3362/preview' },
        { method: 'POST', url: '/api/data-reconciliation/bulk-plan' },
        { method: 'POST', url: '/api/data-reconciliation/cases/SS3362/apply', payload: {} },
        { method: 'POST', url: '/api/data-reconciliation/bulk-apply', payload: { runId: 'not-for-unit-admin' } },
        { method: 'POST', url: '/api/data-reconciliation/cases/SS3362/classify', payload: { classification: 'SYSTEM_WRONG' } },
        { method: 'POST', url: '/api/data-reconciliation/cases/SS3362/resolve', payload: { resolutionType: 'KEEP_CURRENT' } },
        { method: 'POST', url: '/api/data-reconciliation/cases/SS3362/needs-review', payload: {} },
        { method: 'POST', url: '/api/data-reconciliation/cases/SS3362/reopen', payload: {} }
      ];

      for (const ep of endpoints) {
        const res = await server.inject({
          method: ep.method,
          url: ep.url,
          headers: { cookie: unitAdminCookie },
          payload: ep.payload
        });
        expect(res.statusCode, `Expected 403 on ${ep.method} ${ep.url}`).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Forbidden');
      }
    });

    it('TECH_ADMIN is allowed 200 on read/preview, but strictly rejected with 403 on mutations', async () => {
      // 1. Read operations: ALLOWED (200)
      const summaryRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/summary',
        headers: { cookie: techAdminCookie }
      });
      expect(summaryRes.statusCode).toBe(200);

      const casesRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases',
        headers: { cookie: techAdminCookie }
      });
      expect(casesRes.statusCode).toBe(200);

      const caseDetailRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases/SS3362',
        headers: { cookie: techAdminCookie }
      });
      expect(caseDetailRes.statusCode).toBe(200);

      const previewRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/preview',
        headers: { cookie: techAdminCookie }
      });
      expect(previewRes.statusCode).toBe(200);

      const bulkPlanRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-plan',
        headers: { cookie: techAdminCookie }
      });
      expect(bulkPlanRes.statusCode).toBe(200);
      const bulkApplyRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-apply',
        headers: { cookie: techAdminCookie },
        payload: { runId: JSON.parse(bulkPlanRes.body).runId }
      });
      expect(bulkApplyRes.statusCode).toBe(403);

      // 2. Mutation operations: FORBIDDEN (403)
      const mutations: Array<{ url: string; payload: any }> = [
        { url: '/api/data-reconciliation/cases/SS3362/apply', payload: {} },
        { url: '/api/data-reconciliation/cases/SS3362/classify', payload: { classification: 'SYSTEM_WRONG' } },
        { url: '/api/data-reconciliation/cases/SS3362/resolve', payload: { resolutionType: 'KEEP_CURRENT' } },
        { url: '/api/data-reconciliation/cases/SS3362/needs-review', payload: { notes: 'test' } },
        { url: '/api/data-reconciliation/cases/SS3362/reopen', payload: {} }
      ];

      for (const m of mutations) {
        const res = await server.inject({
          method: 'POST',
          url: m.url,
          headers: { cookie: techAdminCookie },
          payload: m.payload
        });
        expect(res.statusCode, `Expected 403 on mutation ${m.url}`).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Forbidden');
        expect(body.message).toContain('read-only access');
      }
    });

    it('SUPER_ADMIN has full authority across read, preview, and mutation routes', async () => {
      const summaryRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/summary',
        headers: { cookie: superAdminCookie }
      });
      expect(summaryRes.statusCode).toBe(200);

      const previewRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/preview',
        headers: { cookie: superAdminCookie }
      });
      expect(previewRes.statusCode).toBe(200);

      const classifyRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/classify',
        headers: { cookie: superAdminCookie },
        payload: { classification: 'SYSTEM_WRONG', notes: 'System has outdated seat' }
      });
      expect(classifyRes.statusCode).toBe(200);
      const classifiedBody = JSON.parse(classifyRes.body);
      expect(classifiedBody.classification).toBe('SYSTEM_WRONG');
      expect(classifiedBody.notes).toBe('System has outdated seat');
    });
  });

  // =========================================================================
  // 2. Diff Computation & Evidence Gathering
  // =========================================================================
  describe('Diff Computation & Evidence Gathering', () => {
    it('accurately computes authoritative field differences and identifies duplicate Excel conflict', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases/SS3362',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.employeeCode).toBe('SS3362');
      expect(data.employeeName).toBe('MOHIT PARMAR');
      expect(data.diff).toBeInstanceOf(Array);
      expect(data.diff.length).toBe(11);
      expect(data.mismatchCount).toBe(4);
      expect(data.allFieldsMatch).toBe(false);
      expect(data.mismatchCount).toBe(
        data.diff.filter((field: any) => field.status === 'MISMATCH').length
      );

      // Verify individual field diffs
      const buildingDiff = data.diff.find((d: any) => d.field === 'Building');
      expect(buildingDiff.excelValue).toBe('ADMIN');
      expect(buildingDiff.systemValue).toBe(bldSantosh.name);
      expect(buildingDiff.status).toBe('MISMATCH');

      const floorDiff = data.diff.find((d: any) => d.field === 'Floor');
      expect(floorDiff.excelValue).toBe('GF');
      expect(floorDiff.systemValue).toBe(floor2.name);
      expect(floorDiff.status).toBe('MISMATCH');

      const wsDiff = data.diff.find((d: any) => d.field === 'Workstation');
      expect(wsDiff.excelValue).toBe('WS-01');
      expect(wsDiff.systemValue).toBe('WS-02');
      expect(wsDiff.status).toBe('MISMATCH');

      // Evidence structure check
      expect(data.evidence).toBeDefined();
      expect(data.evidence.currentRecord).toBeDefined();
      expect(data.evidence.currentSeat).toBeDefined();
      expect(data.evidence.currentSeat.label).toBe('WS-02');
      expect(data.evidence.hierarchy.unit.name).toBe('Unit 2');
      expect(data.evidence.excelRowDetails.sheet).toBe('Sheet1');
      expect(data.evidence.excelRowDetails.row).toBe(2);
    });

    it('identifies duplicate Excel ID groups and flags DUPLICATE_EXCEL_CONFLICT', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases/22287',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.classification).toBe(ReconciliationClassification.DUPLICATE_EXCEL_CONFLICT);
      expect(data.evidence.duplicateExcelRows.length).toBe(2);
    });

    it('flags EXPECTED_LIVE_CHANGE when approved transfer explains difference', async () => {
      // Create approved transfer request for MOHIT
      await prisma.seatTransferRequest.create({
        data: {
          requestNumber: 'REQ-TR-001',
          employeeId: empMohit.id,
          sourceUnitId: unit1.id,
          targetUnitId: unit2.id,
          sourceFloorId: floor1.id,
          targetFloorId: floor2.id,
          sourceSeatId: seatWs01.id,
          targetSeatId: seatWs02.id,
          reason: 'Transferred to Santosh Bhavan',
          status: 'APPROVED'
        }
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases/SS3362',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.evidence.hasApprovedTransfer).toBe(true);
      expect(data.evidence.explainsMismatch).toBe(true);
      expect(data.classification).toBe(ReconciliationClassification.EXPECTED_LIVE_CHANGE);
    });
  });

  // =========================================================================
  // 3. Preview Validation & Conflict Detection
  // =========================================================================
  describe('Correction Preview & Conflict Detection', () => {
    it('previews valid correction with proposed field changes when seat is available', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/preview',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.valid).toBe(true);
      expect(data.canApply).toBe(true);
      expect(data.seatConflict).toBeNull();
      expect(data.diffs.length).toBeGreaterThan(0);

      const bldChange = data.diffs.find((d: any) => d.field === 'Building');
      expect(bldChange.current).toBe(bldSantosh.name);
      expect(bldChange.proposed).toBe('ADMIN');

      const wsChange = data.diffs.find((d: any) => d.field === 'Workstation');
      expect(wsChange.current).toBe('WS-02');
      expect(wsChange.proposed).toBe('WS-01');
    });

    it('detects occupied seat conflict and blocks correction (canApply: false)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/EMP-BLOCKED/preview',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.canApply).toBe(false);
      expect(data.seatConflict).not.toBeNull();
      expect(data.seatConflict.hasConflict).toBe(true);
      expect(data.seatConflict.seatLabel).toBe('WS-OCCUPIED');
      expect(data.seatConflict.occupiedBy.employeeCode).toBe('OCC001');
      expect(data.seatConflict.message).toContain('already occupied');
    });
  });

  // =========================================================================
  // 4. Safe Apply & Optimistic Concurrency
  // =========================================================================
  describe('Safe Correction Apply Engine', () => {
    it('applies correction safely, reassigns seat, updates employee, and writes AuditLog', async () => {
      // 1. Get initial case detail to capture snapshot timestamp
      const detailRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases/SS3362',
        headers: { cookie: superAdminCookie }
      });
      const initialDetail = JSON.parse(detailRes.body);
      const snapshotUpdatedAt = initialDetail.snapshotUpdatedAt;

      // 2. Apply correction
      const applyRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/apply',
        headers: { cookie: superAdminCookie },
        payload: {
          snapshotUpdatedAt,
          notes: 'Admin approved Excel correction'
        }
      });
      expect(applyRes.statusCode).toBe(200);
      const applyBody = JSON.parse(applyRes.body);
      expect(applyBody.success).toBe(true);
      expect(applyBody.case.status).toBe(ReconciliationStatus.RESOLVED);

      // 3. Verify in database: seat WS-01 is assigned to MOHIT, old seat WS-02 is unassigned
      const updatedSeat1 = await prisma.seat.findUnique({ where: { id: seatWs01.id } });
      expect(updatedSeat1.employeeId).toBe(empMohit.id);

      const updatedSeat2 = await prisma.seat.findUnique({ where: { id: seatWs02.id } });
      expect(updatedSeat2.employeeId).toBeNull();

      // 4. Verify AuditLog recorded
      const logs = await prisma.auditLog.findMany({
        where: { action: 'RECONCILIATION_CORRECTION_APPLIED', entityId: empMohit.id }
      });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].metadata.employeeCode).toBe('SS3362');
    });

    it('rejects apply with HTTP 409 RECONCILIATION_STALE if employee was modified after review began', async () => {
      const staleTimestamp = new Date(Date.now() - 60000).toISOString();

      const applyRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/apply',
        headers: { cookie: superAdminCookie },
        payload: {
          snapshotUpdatedAt: staleTimestamp,
          notes: 'Applying with stale snapshot'
        }
      });

      expect(applyRes.statusCode).toBe(409);
      const body = JSON.parse(applyRes.body);
      expect(body.error).toBe('Conflict');
      expect(body.code).toBe('RECONCILIATION_STALE');
      expect(body.message).toContain('Employee data changed after review began');
    });

    it('rejects apply with HTTP 400 RECONCILIATION_BLOCKED if target seat is occupied', async () => {
      const applyRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/EMP-BLOCKED/apply',
        headers: { cookie: superAdminCookie },
        payload: {
          notes: 'Attempting to apply to occupied seat'
        }
      });

      expect(applyRes.statusCode).toBe(400);
      const body = JSON.parse(applyRes.body);
      expect(body.error).toBe('Bad Request');
      expect(body.code).toBe('RECONCILIATION_BLOCKED');
      expect(body.message).toContain('already occupied');
    });
  });

  // =========================================================================
  // 5. Actions: Classify, Resolve, Needs-Review, Reopen
  // =========================================================================
  describe('Case Workflow Lifecycle', () => {
    it('resolves as KEEP_CURRENT and sets status to EXCEL_STALE with AuditLog', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/resolve',
        headers: { cookie: superAdminCookie },
        payload: {
          resolutionType: 'KEEP_CURRENT',
          notes: 'Current system record is accurate; Excel is obsolete.'
        }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe(ReconciliationStatus.EXCEL_STALE);
      expect(body.classification).toBe(ReconciliationClassification.EXCEL_STALE);
      expect(body.notes).toContain('Current system record is accurate');

      const logs = await prisma.auditLog.findMany({
        where: { action: 'RECONCILIATION_CASE_RESOLVED', entityId: 'SS3362' }
      });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('marks case as NEEDS_REVIEW with notes', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/needs-review',
        headers: { cookie: superAdminCookie },
        payload: {
          notes: 'Requires verification with department HOD'
        }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe(ReconciliationStatus.NEEDS_REVIEW);
      expect(body.notes).toBe('Requires verification with department HOD');
    });

    it('reopens a resolved case and logs RECONCILIATION_CASE_REOPENED', async () => {
      // First resolve
      await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/resolve',
        headers: { cookie: superAdminCookie },
        payload: { resolutionType: 'KEEP_CURRENT' }
      });

      // Now reopen
      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/cases/SS3362/reopen',
        headers: { cookie: superAdminCookie },
        payload: { notes: 'Reopened following owner audit' }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe(ReconciliationStatus.REOPENED);

      const logs = await prisma.auditLog.findMany({
        where: { action: 'RECONCILIATION_CASE_REOPENED', entityId: 'SS3362' }
      });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 6. Filtering, Search & Dashboard Totals
  // =========================================================================
  describe('Filtering, Search & Dashboard Metrics', () => {
    it('returns accurate summary counts on GET /summary', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/summary',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const metrics = JSON.parse(res.body);

      expect(metrics.totalCases).toBeGreaterThan(0);
      expect(metrics.totalExcelEmployees).toBeGreaterThan(0);
      expect(metrics.openMismatches).toBeGreaterThanOrEqual(0);
      expect(metrics.resolvedMismatches).toBeGreaterThanOrEqual(0);
    });

    it('filters cases by status, classification, mismatchField, and search term', async () => {
      // Search by employee code
      const searchRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases?search=SS3362',
        headers: { cookie: superAdminCookie }
      });
      expect(searchRes.statusCode).toBe(200);
      const searchBody = JSON.parse(searchRes.body);
      expect(searchBody.cases.length).toBe(1);
      expect(searchBody.cases[0].employeeCode).toBe('SS3362');

      // Search by name
      const nameRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases?search=MOHIT',
        headers: { cookie: superAdminCookie }
      });
      expect(nameRes.statusCode).toBe(200);
      const nameBody = JSON.parse(nameRes.body);
      expect(nameBody.cases.length).toBe(1);

      // Filter by mismatch field
      const fieldRes = await server.inject({
        method: 'GET',
        url: '/api/data-reconciliation/cases?mismatchField=Building',
        headers: { cookie: superAdminCookie }
      });
      expect(fieldRes.statusCode).toBe(200);
      const fieldBody = JSON.parse(fieldRes.body);
      expect(fieldBody.cases.some((c: any) => c.mismatchedFields.includes('Building'))).toBe(true);
    });
  });

  describe('Authoritative Workbook Bulk Plan', () => {
    it('generates a read-only source-hashed plan with safe and blocked classifications', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-plan',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const plan = JSON.parse(res.body);

      expect(plan.sourceFilename).toBe('test-workstations.xlsx');
      expect(plan.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.counts.TOTAL).toBe(3);
      expect(plan.counts.SAFE_SEAT_MOVE).toBe(1);
      expect(plan.counts.BLOCKED_OCCUPIED_TARGET_SEAT).toBe(1);
      expect(plan.counts.BLOCKED_DUPLICATE_EXCEL).toBe(1);
      expect(plan.items.find((item: any) => item.employeeCode === 'SS3362').status).toBe('SAFE_SEAT_MOVE');
    });

    it('applies only the safe subset in a mock database and is idempotent on rerun', async () => {
      const planRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-plan',
        headers: { cookie: superAdminCookie }
      });
      const plan = JSON.parse(planRes.body);

      const applyRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-apply',
        headers: { cookie: superAdminCookie },
        payload: { runId: plan.runId }
      });
      expect(applyRes.statusCode).toBe(200);
      expect(JSON.parse(applyRes.body).applied).toBe(1);

      const rerunRes = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-plan',
        headers: { cookie: superAdminCookie }
      });
      expect(rerunRes.statusCode).toBe(200);
      const rerun = JSON.parse(rerunRes.body);
      expect(rerun.counts.SAFE_FIELD_UPDATE + rerun.counts.SAFE_SEAT_ASSIGNMENT + rerun.counts.SAFE_SEAT_MOVE).toBe(0);
      expect(rerun.items.find((item: any) => item.employeeCode === 'SS3362').status).toBe('NO_CHANGE');

      const assigned = await prisma.seat.findMany({ where: { employeeId: empMohit.id } });
      expect(assigned).toHaveLength(1);
      expect(assigned[0].label).toBe('WS-01');
    });

    it('blocks true same-location duplicate workstations without conflating labels across floors', async () => {
      await prisma.employee.create({
        data: {
          employeeCode: 'DUP-WS-A',
          fullName: 'Duplicate Workstation A',
          email: 'duplicate-a@example.com',
          departmentId: deptIt.id,
          isActive: true
        }
      });
      await prisma.employee.create({
        data: {
          employeeCode: 'DUP-WS-B',
          fullName: 'Duplicate Workstation B',
          email: 'duplicate-b@example.com',
          departmentId: deptIt.id,
          isActive: true
        }
      });

      createTestExcelFile(tempExcelPath, [
        {
          Unit: 'Unit-1', Building: 'ADMIN', Floor: 'GF', 'Office / Area': 'Admin IT office',
          'WS NO': 'WS-DUP', 'Emp Code': 'DUP-WS-A', 'E. Name': 'Duplicate Workstation A', Status: 'Active'
        },
        {
          Unit: 'Unit-1', Building: 'ADMIN', Floor: 'GF', 'Office / Area': 'Admin IT office',
          'WS NO': 'WS-DUP', 'Emp Code': 'DUP-WS-B', 'E. Name': 'Duplicate Workstation B', Status: 'Active'
        }
      ]);
      dataReconciliationService.resetState();
      dataReconciliationService.setStateStorePath(tempStateStorePath);

      const res = await server.inject({
        method: 'POST',
        url: '/api/data-reconciliation/bulk-plan',
        headers: { cookie: superAdminCookie }
      });
      expect(res.statusCode).toBe(200);
      const plan = JSON.parse(res.body);
      expect(plan.counts.TOTAL).toBe(2);
      expect(plan.counts.BLOCKED_DUPLICATE_WORKSTATION).toBe(2);
      expect(plan.items.every((item: any) => item.status === 'BLOCKED_DUPLICATE_WORKSTATION')).toBe(true);
    });
  });
});
