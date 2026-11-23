import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import xlsx from '../utils/xlsx.js';
import { PrismaClient, Prisma } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import {
  ReconciliationStatus,
  ReconciliationClassification,
  ReconciliationFieldDiff,
  ReconciliationCaseSummary,
  ReconciliationCaseDetail,
  ReconciliationEvidence,
  ReconciliationSummaryMetrics,
  ReconciliationPreviewResult
} from '@seating/shared';
import { logAudit } from './audit.service.js';
import { AdminUserContext } from '../utils/rbac.js';

export class ReconciliationConflictError extends Error {
  statusCode = 409;
  code = 'RECONCILIATION_STALE';
  constructor(message = 'Employee data changed after review began. Please refresh.') {
    super(message);
    this.name = 'ReconciliationConflictError';
  }
}

export class ReconciliationBlockedError extends Error {
  statusCode = 400;
  code = 'RECONCILIATION_BLOCKED';
  constructor(message = 'Correction is blocked by hierarchy or seat conflict.') {
    super(message);
    this.name = 'ReconciliationBlockedError';
  }
}

interface StoredCaseState {
  status: ReconciliationStatus;
  classification: ReconciliationClassification;
  notes?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  appliedAt?: string | null;
  updatedAt: string;
}

export interface ExcelEmployeeRow {
  rowNum: number;
  srNo: string | number;
  unit: string;
  building: string;
  floor: string;
  officeArea: string;
  department: string;
  section: string;
  functionName: string;
  wsNo: string;
  employeeCode: string;
  fullName: string;
  reportingTo: string;
  hod: string;
  status: string;
  sourceFields: Set<string>;
  raw: Record<string, any>;
}

export type BulkPlanItemStatus =
  | 'NO_CHANGE'
  | 'SAFE_FIELD_UPDATE'
  | 'SAFE_SEAT_ASSIGNMENT'
  | 'SAFE_SEAT_MOVE'
  | 'BLOCKED_DUPLICATE_EXCEL'
  | 'BLOCKED_DUPLICATE_WORKSTATION'
  | 'BLOCKED_OCCUPIED_TARGET_SEAT'
  | 'BLOCKED_INVALID_HIERARCHY'
  | 'BLOCKED_AMBIGUOUS_MAPPING'
  | 'BLOCKED_OTHER'
  | 'STALE';

export interface BulkReconciliationPlanItem {
  employeeCode: string;
  employeeId?: string;
  employeeName: string;
  excelRowNumbers: number[];
  status: BulkPlanItemStatus;
  reasons: string[];
  changedFields: string[];
  snapshotUpdatedAt?: string;
  expectedSeatId?: string | null;
  currentSeatLabel?: string | null;
  proposedSeatLabel?: string | null;
  proposedUnit?: string | null;
  proposedBuilding?: string | null;
  proposedFloor?: string | null;
}

export interface BulkReconciliationPlan {
  runId: string;
  sourceFilename: string;
  sourceHash: string;
  generatedAt: string;
  counts: Record<BulkPlanItemStatus | 'FORMATTING_ONLY' | 'TOTAL', number>;
  items: BulkReconciliationPlanItem[];
}

// Normalization utilities
export const clean = (v: unknown): string => String(v ?? '').trim();
export const norm = (v: unknown): string => clean(v).replace(/[-‐‑‒–—]/g, ' ').replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
export const idNorm = (v: unknown): string => clean(v).replace(/^'+/, '').replace(/\.0+$/, '').toUpperCase();
export const isBlank = (v: unknown): boolean =>
  clean(v) === '' || ['0', '#N/A', 'N/A', 'NA', 'NULL', 'NONE', 'UNDEFINED'].includes(clean(v).toUpperCase());

export const canonicalLabel = (v: unknown): string =>
  norm(v)
    .replace(/[‐‑–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const isExcelPlaceholder = (code: unknown, name: unknown): boolean => {
  const combined = (norm(code) + ' ' + norm(name)).trim();
  return (
    !norm(code) ||
    norm(code) === '0' ||
    [
      'vacant',
      'vaccant',
      'null',
      'undefined',
      'not coming',
      'up coming',
      'upcoming',
      'outsource',
      'out sourse',
      'contact person',
      'printer',
      'user name',
      'user emp.no.',
      'sr.no.',
      'layout',
      'emp code'
    ].some((m) => combined.includes(m))
  );
};

const EXCEL_FIELD_ALIASES: Record<string, string[]> = {
  employeeId: ['emp code', 'employee code', 'empcode', 'employeecode'],
  employeeName: ['e. name', 'employee name', 'name'],
  unit: ['unit'],
  building: ['building'],
  floor: ['floor'],
  officeArea: ['office / area', 'office/area', 'office area', 'area'],
  department: ['department'],
  section: ['section'],
  functionName: ['function'],
  workstation: ['ws no', 'ws no.', 'workstation'],
  designation: ['designation'],
  status: ['status']
};

const excelFieldPresent = (row: ExcelEmployeeRow, field: string): boolean => {
  const aliases = EXCEL_FIELD_ALIASES[field] || [];
  return aliases.some((alias) => row.sourceFields.has(norm(alias)));
};

const excelFieldValue = (row: ExcelEmployeeRow, field: string): string => {
  const aliases = EXCEL_FIELD_ALIASES[field] || [];
  const rawKey = Object.keys(row.raw).find((key) => aliases.includes(norm(key)));
  if (rawKey) return clean(row.raw[rawKey]);
  switch (field) {
    case 'employeeId': return row.employeeCode;
    case 'employeeName': return row.fullName;
    case 'unit': return row.unit;
    case 'building': return row.building;
    case 'floor': return row.floor;
    case 'officeArea': return row.officeArea;
    case 'department': return row.department;
    case 'section': return row.section;
    case 'functionName': return row.functionName;
    case 'workstation': return row.wsNo;
    case 'status': return row.status;
    default: return '';
  }
};

const excelFieldLabel = (field: string): string => ({
  employeeId: 'Employee ID',
  employeeName: 'Employee Name',
  unit: 'Unit',
  building: 'Building',
  floor: 'Floor',
  officeArea: 'Office/Area',
  department: 'Department',
  section: 'Section',
  functionName: 'Function',
  workstation: 'Workstation',
  designation: 'Designation',
  status: 'Status'
}[field] || field);

export class DataReconciliationService {
  private static instance: DataReconciliationService;
  private excelCache: { path: string; mtimeMs: number; rows: ExcelEmployeeRow[] } | null = null;
  private stateStorePath: string;
  private inMemoryStore = new Map<string, StoredCaseState>();
  private bulkPlans = new Map<string, BulkReconciliationPlan>();

  private constructor() {
    this.stateStorePath = path.resolve(process.cwd(), 'apps/backend/data/reconciliation-store.json');
    this.loadStateStore();
  }

  public static getInstance(): DataReconciliationService {
    if (!DataReconciliationService.instance) {
      DataReconciliationService.instance = new DataReconciliationService();
    }
    return DataReconciliationService.instance;
  }

  /** For unit tests: resets internal in-memory case modifications and cache */
  public resetState(): void {
    this.inMemoryStore.clear();
    this.bulkPlans.clear();
    this.excelCache = null;
    try {
      if (fs.existsSync(this.stateStorePath)) {
        fs.unlinkSync(this.stateStorePath);
      }
    } catch {
      // Ignore cleanup error in test
    }
  }

  public setStateStorePath(newPath: string): void {
    this.stateStorePath = newPath;
    this.loadStateStore();
  }

  private loadStateStore(): void {
    try {
      if (fs.existsSync(this.stateStorePath)) {
        const raw = fs.readFileSync(this.stateStorePath, 'utf8');
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          this.inMemoryStore.set(k, v as StoredCaseState);
        }
      }
    } catch {
      // In-memory fallback
    }
  }

  private saveStateStore(): void {
    try {
      const dir = path.dirname(this.stateStorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Object.fromEntries(this.inMemoryStore.entries());
      fs.writeFileSync(this.stateStorePath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Ignore disk persistence failures in restricted environments
    }
  }

  /** Resolves the authoritative Excel file location */
  public resolveExcelPath(explicitPath?: string): string | null {
    if (explicitPath && fs.existsSync(explicitPath)) {
      return explicitPath;
    }
    if (process.env.RECONCILIATION_EXCEL_PATH && fs.existsSync(process.env.RECONCILIATION_EXCEL_PATH)) {
      return process.env.RECONCILIATION_EXCEL_PATH;
    }
    const candidates = [
      'C:\\Users\\23321\\Desktop\\Unit_1_Workstation Detail.xlsx',
      path.resolve(process.cwd(), '../Unit_1_Workstation Detail.xlsx'),
      path.resolve(process.cwd(), '../../Unit_1_Workstation Detail.xlsx'),
      path.resolve(process.cwd(), 'Unit_1_Workstation Detail.xlsx'),
      path.resolve(process.cwd(), 'test data/Unit_1_Workstation Detail raj.xlsx'),
      path.resolve(process.cwd(), 'test data/Unit_1_Workstation Details.xlsx')
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
    return null;
  }

  /** Loads and parses Excel employee rows */
  public loadExcelRows(explicitPath?: string): ExcelEmployeeRow[] {
    const filePath = this.resolveExcelPath(explicitPath);
    if (!filePath) {
      return [];
    }

    try {
      const stat = fs.statSync(filePath);
      if (this.excelCache && this.excelCache.path === filePath && this.excelCache.mtimeMs === stat.mtimeMs) {
        return this.excelCache.rows;
      }

      const workbook = xlsx.readFile(filePath, { cellDates: true });
      const sheetName = workbook.SheetNames.find((s) => s.toLowerCase() === 'sheet1') || workbook.SheetNames[0];
      const rawRows = xlsx.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[sheetName], { defval: '' });

      const rows: ExcelEmployeeRow[] = [];
      for (let i = 0; i < rawRows.length; i++) {
        const r = rawRows[i];
        const rowNum = i + 2;
        const employeeCode = idNorm(r['Emp Code'] || r['emp code'] || r['EmpCode'] || r['EmployeeCode']);
        const fullName = clean(r['E. Name'] || r['e. name'] || r['Employee Name'] || r['Name']);

        if (isExcelPlaceholder(employeeCode, fullName)) {
          continue;
        }

        rows.push({
          rowNum,
          srNo: r['Sr.No.'] ?? r['SrNo'] ?? rowNum - 1,
          unit: clean(r['Unit'] || r['unit']),
          building: clean(r['Building'] || r['building']),
          floor: clean(r['Floor'] || r['floor']),
          officeArea: clean(r['Office / Area'] || r['Office/Area'] || r['office area'] || r['Area']),
          department: clean(r['Department'] || r['department']),
          section: clean(r['Section'] || r['section']),
          functionName: clean(r['Function'] || r['function']),
          wsNo: clean(r['WS NO'] || r['ws no'] || r['WS No'] || r['Workstation']),
          employeeCode,
          fullName,
          reportingTo: clean(r['Reporting to'] || r['reporting to']),
          hod: clean(r['HOD'] || r['hod']),
          status: clean(r['Status'] || r['status'] || 'Active'),
          sourceFields: new Set(Object.keys(r).map((key) => norm(key))),
          raw: r
        });
      }

      this.excelCache = { path: filePath, mtimeMs: stat.mtimeMs, rows };
      return rows;
    } catch (err) {
      return [];
    }
  }

  /**
   * Compares two string values for differences.
   */
  private compareField(
    fieldName: string,
    expectedVal: string | undefined | null,
    actualVal: string | undefined | null
  ): ReconciliationFieldDiff {
    const exp = clean(expectedVal);
    const act = clean(actualVal);

    // Blank workbook cells are not instructions to erase valid system data.
    if (isBlank(exp)) {
      return { field: fieldName, excelValue: exp, systemValue: act, isMatch: true, status: 'MATCH' };
    }

    if (canonicalLabel(exp) === canonicalLabel(act)) {
      if (exp === act) {
        return { field: fieldName, excelValue: exp, systemValue: act, isMatch: true, status: 'MATCH' };
      }
      return { field: fieldName, excelValue: exp, systemValue: act, isMatch: true, status: 'FORMATTING_ONLY' };
    }

    return { field: fieldName, excelValue: exp, systemValue: act, isMatch: false, status: 'MISMATCH' };
  }

  private compareAuthoritativeFields(
    row: ExcelEmployeeRow,
    systemValues: Record<string, string>
  ): { diffs: ReconciliationFieldDiff[]; mismatchCount: number; allFieldsMatch: boolean; formattingCount: number } {
    const fields = Object.keys(EXCEL_FIELD_ALIASES);
    const diffs = fields
      .filter((field) => excelFieldPresent(row, field))
      .map((field) => this.compareField(
        excelFieldLabel(field),
        excelFieldValue(row, field),
        systemValues[field] || ''
      ));
    const mismatchCount = diffs.filter((diff) => diff.status === 'MISMATCH').length;
    return {
      diffs,
      mismatchCount,
      allFieldsMatch: mismatchCount === 0,
      formattingCount: diffs.filter((diff) => diff.status === 'FORMATTING_ONLY').length
    };
  }

  /**
   * Evaluates all data reconciliation cases against current database state.
   */
  public async evaluateAllCases(
    prisma: PrismaClient,
    explicitExcelPath?: string
  ): Promise<{
    matchedCount: number;
    cases: Array<{
      employee: any;
      excelRow: ExcelEmployeeRow;
      duplicateExcelRows: ExcelEmployeeRow[];
      diffs: ReconciliationFieldDiff[];
      mismatchedFields: string[];
      mismatchCount: number;
      allFieldsMatch: boolean;
      hasDuplicateConflict: boolean;
      approvedTransfer: any | null;
      explainsMismatch: boolean;
      initialClassification: ReconciliationClassification;
      initialStatus: ReconciliationStatus;
      seat: any | null;
      hierarchy: any;
    }>;
  }> {
    const excelRows = this.loadExcelRows(explicitExcelPath);
    if (!excelRows.length) {
      return { matchedCount: 0, cases: [] };
    }

    // Group Excel rows by normalized employeeCode to detect duplicates
    const excelByCode = new Map<string, ExcelEmployeeRow[]>();
    for (const row of excelRows) {
      if (!excelByCode.has(row.employeeCode)) {
        excelByCode.set(row.employeeCode, []);
      }
      excelByCode.get(row.employeeCode)!.push(row);
    }

    // Fetch all entities directly to ensure 100% compatibility across Prisma & MockPrisma
    const [
      employees,
      allSeats,
      allTransfers,
      allUnits,
      allPlants,
      allBuildings,
      allFloors,
      allDepartments,
      allSections,
      allFunctions
    ] = await Promise.all([
      prisma.employee.findMany(),
      prisma.seat.findMany(),
      prisma.seatTransferRequest.findMany(),
      prisma.unit.findMany(),
      prisma.plant.findMany(),
      prisma.building.findMany(),
      prisma.floor.findMany(),
      prisma.department.findMany(),
      typeof prisma.section?.findMany === 'function' ? prisma.section.findMany() : Promise.resolve([]),
      typeof prisma.orgFunction?.findMany === 'function' ? prisma.orgFunction.findMany() : Promise.resolve([])
    ]);

    const unitMap = new Map<string, any>(allUnits.map((u: any) => [u.id, u]));
    const plantMap = new Map<string, any>(allPlants.map((p: any) => [p.id, p]));
    const buildingMap = new Map<string, any>(allBuildings.map((b: any) => [b.id, b]));
    const floorMap = new Map<string, any>(allFloors.map((f: any) => [f.id, f]));
    const deptMap = new Map<string, any>(allDepartments.map((d: any) => [d.id, d]));
    const sectionMap = new Map<string, any>(allSections.map((s: any) => [s.id, s]));
    const functionMap = new Map<string, any>(allFunctions.map((fn: any) => [fn.id, fn]));

    const seatByEmployeeId = new Map<string, any>();
    for (const seat of allSeats) {
      if (seat.employeeId) {
        seatByEmployeeId.set(seat.employeeId, seat);
      }
    }

    const transfersByEmployeeId = new Map<string, any[]>();
    for (const tr of allTransfers) {
      if (tr.employeeId) {
        if (!transfersByEmployeeId.has(tr.employeeId)) {
          transfersByEmployeeId.set(tr.employeeId, []);
        }
        transfersByEmployeeId.get(tr.employeeId)!.push(tr);
      }
    }

    const employeeMap = new Map<string, any>();
    for (const emp of employees) {
      employeeMap.set(idNorm(emp.employeeCode), emp);
    }

    let matchedCount = 0;
    const cases: Array<any> = [];

    for (const [code, rowsForCode] of excelByCode.entries()) {
      const emp = employeeMap.get(code);
      if (!emp) {
        // Employee absent in Mongo - can be tracked if needed
        continue;
      }

      const primaryExcel = rowsForCode[0];
      const duplicateValues = rowsForCode.map((row) => Object.keys(EXCEL_FIELD_ALIASES)
        .map((field) => `${field}:${canonicalLabel(excelFieldValue(row, field))}`)
        .join('|'));
      const hasDuplicateConflict = rowsForCode.length > 1 && duplicateValues.some((value) => value !== duplicateValues[0]);

      // Extract system hierarchy and seat details
      const seat = seatByEmployeeId.get(emp.id) || null;
      const seatFloor = seat ? floorMap.get(seat.floorId) || null : null;
      const seatBuilding = seatFloor ? buildingMap.get(seatFloor.buildingId) || null : null;
      const seatPlant = seatBuilding ? plantMap.get(seatBuilding.plantId) || null : null;
      const seatUnit = seatBuilding?.unitId
        ? unitMap.get(seatBuilding.unitId) || null
        : seatPlant
          ? unitMap.get(seatPlant.unitId) || null
          : null;

      const dept = deptMap.get(emp.departmentId) || null;
      const deptUnit = dept?.unitId ? unitMap.get(dept.unitId) || null : null;

      const empSection = emp.sectionId ? sectionMap.get(emp.sectionId) : null;
      const empFunction = emp.functionId ? functionMap.get(emp.functionId) : null;

      const systemHierarchy = {
        unit: seatUnit || deptUnit || null,
        plant: seatPlant || null,
        building: seatBuilding || null,
        floor: seatFloor
          ? { id: seatFloor.id, name: seatFloor.name, floorNumber: seatFloor.floorNumber }
          : null,
        department: dept
          ? { id: dept.id, name: dept.name, code: dept.code }
          : null,
        section: empSection
          ? { id: empSection.id, name: empSection.name }
          : emp.section
            ? { id: '', name: emp.section }
            : null,
        functionName: empFunction?.name || emp.functionName || null
      };

      const systemValues = {
        employeeId: idNorm(emp.employeeCode),
        employeeName: clean(emp.fullName),
        unit: seatUnit?.name || deptUnit?.name || '',
        building: seatBuilding?.name || '',
        floor: seatFloor?.name || '',
        officeArea: clean(emp.officeArea || seat?.officeArea || ''),
        department: dept?.name || '',
        section: clean(emp.section || empSection?.name || ''),
        functionName: clean(emp.functionName || empFunction?.name || ''),
        workstation: clean(seat?.label || ''),
        designation: clean(emp.designation || ''),
        status: emp.isActive ? 'Active' : 'Inactive'
      };

      const comparison = this.compareAuthoritativeFields(primaryExcel, systemValues);
      const { diffs } = comparison;
      const mismatchedDiffs = diffs.filter((d) => d.status === 'MISMATCH');
      const hasMismatch = comparison.mismatchCount > 0;
      const isPureFormatting = comparison.allFieldsMatch && comparison.formattingCount > 0;

      if (comparison.allFieldsMatch && !isPureFormatting && !hasDuplicateConflict) {
        matchedCount++;
        continue;
      }

      // Check Transfer History
      const employeeTransfers = transfersByEmployeeId.get(emp.id) || [];
      const approvedTransfer =
        employeeTransfers.find((t: any) => t.status === 'APPROVED' || t.status === 'TARGET_ADMIN_APPROVED') ||
        null;

      let explainsMismatch = false;
      if (approvedTransfer) {
        explainsMismatch = true;
      }

      // Determine initial classification
      let initialClassification = ReconciliationClassification.UNKNOWN;
      if (hasDuplicateConflict) {
        initialClassification = ReconciliationClassification.DUPLICATE_EXCEL_CONFLICT;
      } else if (explainsMismatch) {
        initialClassification = ReconciliationClassification.EXPECTED_LIVE_CHANGE;
      } else if (isPureFormatting) {
        initialClassification = ReconciliationClassification.FORMATTING_ONLY;
      } else {
        initialClassification = ReconciliationClassification.SYSTEM_WRONG;
      }

      // Determine initial status
      let initialStatus = ReconciliationStatus.OPEN;
      if (isPureFormatting) {
        initialStatus = ReconciliationStatus.FORMATTING_ONLY;
      }

      cases.push({
        employee: { ...emp, department: dept, transferRequests: employeeTransfers },
        excelRow: primaryExcel,
        duplicateExcelRows: rowsForCode,
        diffs,
        mismatchedFields: mismatchedDiffs.map((d) => d.field),
        mismatchCount: comparison.mismatchCount,
        allFieldsMatch: comparison.allFieldsMatch,
        hasDuplicateConflict,
        approvedTransfer,
        explainsMismatch,
        initialClassification,
        initialStatus,
        seat: seat
          ? {
              ...seat,
              floor: seatFloor
                ? {
                    ...seatFloor,
                    building: seatBuilding
                      ? {
                          ...seatBuilding,
                          plant: seatPlant ? { ...seatPlant, unit: seatUnit } : null
                        }
                      : null
                  }
                : null
            }
          : null,
        hierarchy: systemHierarchy
      });
    }

    return { matchedCount, cases };
  }

  /**
   * Retrieves dashboard summary metrics.
   */
  public async getSummaryMetrics(
    prisma: PrismaClient,
    explicitExcelPath?: string
  ): Promise<ReconciliationSummaryMetrics> {
    const { matchedCount, cases } = await this.evaluateAllCases(prisma, explicitExcelPath);
    const totalExcelEmployees = matchedCount + cases.length;

    let openMismatches = 0;
    let resolvedMismatches = 0;
    let needsReview = 0;
    let excelStale = 0;
    let systemCorrectionRequired = 0;
    let formattingOnly = 0;
    let blocked = 0;

    for (const c of cases) {
      const code = idNorm(c.employee.employeeCode);
      const stored = this.inMemoryStore.get(code);
      const status = stored?.status || c.initialStatus;

      switch (status) {
        case ReconciliationStatus.OPEN:
        case ReconciliationStatus.REOPENED:
          openMismatches++;
          break;
        case ReconciliationStatus.RESOLVED:
          resolvedMismatches++;
          break;
        case ReconciliationStatus.NEEDS_REVIEW:
          needsReview++;
          break;
        case ReconciliationStatus.EXCEL_STALE:
          excelStale++;
          break;
        case ReconciliationStatus.SYSTEM_CORRECTION_REQUIRED:
          systemCorrectionRequired++;
          break;
        case ReconciliationStatus.FORMATTING_ONLY:
          formattingOnly++;
          break;
        case ReconciliationStatus.BLOCKED:
          blocked++;
          break;
      }
    }

    return {
      totalCases: cases.length,
      totalExcelEmployees,
      matchedEmployees: matchedCount,
      openMismatches,
      resolvedMismatches,
      needsReview,
      excelStale,
      systemCorrectionRequired,
      formattingOnly,
      blocked
    };
  }

  public getSourceMetadata(explicitExcelPath?: string): { sourceFilename: string; sourceHash: string } | null {
    const filePath = this.resolveExcelPath(explicitExcelPath);
    if (!filePath) return null;
    return {
      sourceFilename: path.basename(filePath),
      sourceHash: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    };
  }

  /** Builds a read-only, idempotent plan. It never calls a Prisma mutation. */
  public async generateBulkPlan(
    prisma: PrismaClient,
    explicitExcelPath?: string
  ): Promise<BulkReconciliationPlan> {
    const source = this.getSourceMetadata(explicitExcelPath);
    if (!source) throw new Error('Authoritative Excel workbook was not found.');

    const excelRows = this.loadExcelRows(explicitExcelPath);
    const evaluated = await this.evaluateAllCases(prisma, explicitExcelPath);
    const employees = await prisma.employee.findMany();
    const employeeByCode = new Map(employees.map((employee: any) => [idNorm(employee.employeeCode), employee]));
    const rowsByCode = new Map<string, ExcelEmployeeRow[]>();
    for (const row of excelRows) {
      const list = rowsByCode.get(row.employeeCode) || [];
      list.push(row);
      rowsByCode.set(row.employeeCode, list);
    }

    const workstationRows = new Map<string, ExcelEmployeeRow[]>();
    const workstationIdentityKey = (row: ExcelEmployeeRow) => [
      'unit', 'building', 'floor', 'officeArea', 'workstation'
    ].map((field) => canonicalLabel(excelFieldValue(row, field))).join('\u001f');
    for (const row of excelRows) {
      const workstation = canonicalLabel(excelFieldValue(row, 'workstation'));
      if (!workstation) continue;
      const identity = workstationIdentityKey(row);
      const list = workstationRows.get(identity) || [];
      list.push(row);
      workstationRows.set(identity, list);
    }
    const duplicateWorkstationEmployeeCodes = new Set<string>();
    for (const rows of workstationRows.values()) {
      const codes = new Set(rows.map((row) => row.employeeCode));
      if (codes.size > 1) rows.forEach((row) => duplicateWorkstationEmployeeCodes.add(row.employeeCode));
    }

    const caseByCode = new Map(evaluated.cases.map((item: any) => [idNorm(item.employee.employeeCode), item]));
    const items: BulkReconciliationPlanItem[] = [];
    const counts = {} as BulkReconciliationPlan['counts'];
    const statuses: Array<BulkPlanItemStatus | 'FORMATTING_ONLY' | 'TOTAL'> = [
      'NO_CHANGE', 'SAFE_FIELD_UPDATE', 'SAFE_SEAT_ASSIGNMENT', 'SAFE_SEAT_MOVE',
      'BLOCKED_DUPLICATE_EXCEL', 'BLOCKED_DUPLICATE_WORKSTATION', 'BLOCKED_OCCUPIED_TARGET_SEAT',
      'BLOCKED_INVALID_HIERARCHY', 'BLOCKED_AMBIGUOUS_MAPPING', 'BLOCKED_OTHER', 'STALE',
      'FORMATTING_ONLY', 'TOTAL'
    ];
    statuses.forEach((status) => { counts[status] = 0; });

    for (const [code, rows] of rowsByCode.entries()) {
      const current = employeeByCode.get(code);
      const item = caseByCode.get(code);
      if (!item) {
        items.push({
          employeeCode: code,
          employeeId: current?.id,
          employeeName: current?.fullName || rows[0].fullName,
          excelRowNumbers: rows.map((row) => row.rowNum),
          status: current ? 'NO_CHANGE' : 'BLOCKED_OTHER',
          reasons: current ? [] : ['Employee ID is not present in MongoDB.'],
          changedFields: [],
          snapshotUpdatedAt: current?.updatedAt?.toISOString?.() || current?.updatedAt,
          expectedSeatId: null,
          proposedSeatLabel: excelFieldValue(rows[0], 'workstation') || null
        });
        counts[current ? 'NO_CHANGE' : 'BLOCKED_OTHER']++;
        continue;
      }

      const base: BulkReconciliationPlanItem = {
        employeeCode: code,
        employeeId: item.employee.id,
        employeeName: item.employee.fullName,
        excelRowNumbers: rows.map((row) => row.rowNum),
        status: 'BLOCKED_OTHER',
        reasons: [],
        changedFields: item.mismatchedFields,
        snapshotUpdatedAt: item.employee.updatedAt?.toISOString?.() || String(item.employee.updatedAt),
        expectedSeatId: item.seat?.id || null,
        currentSeatLabel: item.seat?.label || null,
        proposedSeatLabel: excelFieldValue(rows[0], 'workstation') || null,
        proposedUnit: excelFieldValue(rows[0], 'unit') || null,
        proposedBuilding: excelFieldValue(rows[0], 'building') || null,
        proposedFloor: excelFieldValue(rows[0], 'floor') || null
      };

      if (item.hasDuplicateConflict) {
        base.status = 'BLOCKED_DUPLICATE_EXCEL';
        base.reasons.push('Multiple Excel rows for this Employee ID contain conflicting authoritative values.');
      } else if (duplicateWorkstationEmployeeCodes.has(code)) {
        base.status = 'BLOCKED_DUPLICATE_WORKSTATION';
        base.reasons.push('The authoritative workbook assigns the same workstation to multiple employees.');
      } else if (item.mismatchCount === 0) {
        base.status = item.diffs.some((diff: ReconciliationFieldDiff) => diff.status === 'FORMATTING_ONLY') ? 'NO_CHANGE' : 'NO_CHANGE';
        if (item.diffs.some((diff: ReconciliationFieldDiff) => diff.status === 'FORMATTING_ONLY')) {
          counts.FORMATTING_ONLY++;
        }
      } else {
        const preview = await this.previewCorrection(prisma, code, explicitExcelPath);
        if (preview.seatConflict?.hasConflict) {
          base.status = 'BLOCKED_OCCUPIED_TARGET_SEAT';
          base.reasons.push(preview.seatConflict.message || 'Target workstation is occupied by another employee.');
        } else if (preview.validationErrors.length > 0) {
          base.status = 'BLOCKED_INVALID_HIERARCHY';
          base.reasons.push(...preview.validationErrors);
        } else if (preview.canApply) {
          const movesSeat = item.seat?.label && base.proposedSeatLabel && canonicalLabel(item.seat.label) !== canonicalLabel(base.proposedSeatLabel);
          base.status = movesSeat ? 'SAFE_SEAT_MOVE' : item.seat ? 'SAFE_FIELD_UPDATE' : 'SAFE_SEAT_ASSIGNMENT';
        } else {
          base.status = 'BLOCKED_OTHER';
          base.reasons.push('Correction did not pass the safe preview validation.');
        }
      }

      items.push(base);
      counts[base.status]++;
    }

    counts.TOTAL = items.length;
    const plan: BulkReconciliationPlan = {
      runId: crypto.randomUUID(),
      sourceFilename: source.sourceFilename,
      sourceHash: source.sourceHash,
      generatedAt: new Date().toISOString(),
      counts,
      items
    };
    this.bulkPlans.set(plan.runId, plan);
    return plan;
  }

  public getBulkPlan(runId: string): BulkReconciliationPlan | null {
    return this.bulkPlans.get(runId) || null;
  }

  /** Applies only the previously planned safe subset in bounded batches. */
  public async applyBulkPlan(
    prisma: PrismaClient,
    runId: string,
    admin: AdminUserContext,
    request: FastifyRequest
  ): Promise<{ runId: string; sourceHash: string; applied: number; stale: number; blocked: number; errors: number }> {
    const plan = this.bulkPlans.get(runId);
    if (!plan) throw new Error(`Reconciliation plan '${runId}' not found. Generate a new preview.`);

    const safeItems = plan.items.filter((item) =>
      item.status === 'SAFE_FIELD_UPDATE' || item.status === 'SAFE_SEAT_ASSIGNMENT' || item.status === 'SAFE_SEAT_MOVE'
    );
    let applied = 0;
    let stale = 0;
    let blocked = 0;
    let errors = 0;

    for (let offset = 0; offset < safeItems.length; offset += 25) {
      const batch = safeItems.slice(offset, offset + 25);
      for (const item of batch) {
        try {
          const result = await this.applyCorrection(
            prisma,
            item.employeeCode,
            {
              snapshotUpdatedAt: item.snapshotUpdatedAt,
              expectedSeatId: item.expectedSeatId,
              notes: `Authoritative workbook reconciliation run ${runId}`
            },
            admin,
            request
          );
          await logAudit(prisma, request, item.status === 'SAFE_FIELD_UPDATE'
            ? 'RECONCILIATION_BULK_EMPLOYEE_CORRECTED'
            : 'RECONCILIATION_BULK_SEAT_CORRECTED', 'Employee', result.employee.id, {
            runId,
            sourceFilename: plan.sourceFilename,
            sourceHash: plan.sourceHash,
            employeeCode: item.employeeCode,
            changedFields: item.changedFields,
            before: { seat: item.currentSeatLabel },
            after: { seat: item.proposedSeatLabel }
          });
          applied++;
        } catch (error) {
          if (error instanceof ReconciliationConflictError) {
            item.status = 'STALE';
            item.reasons = [error.message];
            stale++;
          } else if (error instanceof ReconciliationBlockedError) {
            item.status = 'BLOCKED_OTHER';
            item.reasons = [error.message];
            blocked++;
          } else {
            errors++;
          }
        }
      }
    }

    return { runId, sourceHash: plan.sourceHash, applied, stale, blocked, errors };
  }

  /**
   * Returns paginated and filtered reconciliation cases.
   */
  public async getCases(
    prisma: PrismaClient,
    query: {
      status?: string;
      classification?: string;
      unitId?: string;
      unit?: string;
      departmentId?: string;
      department?: string;
      mismatchField?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
    explicitExcelPath?: string
  ): Promise<{
    cases: ReconciliationCaseSummary[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const { cases } = await this.evaluateAllCases(prisma, explicitExcelPath);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 20));

    const summaries: ReconciliationCaseSummary[] = cases.map((c) => {
      const code = idNorm(c.employee.employeeCode);
      const stored = this.inMemoryStore.get(code);
      const status = stored?.status || c.initialStatus;
      const classification = stored?.classification || c.initialClassification;

      return {
        id: code,
        employeeCode: c.employee.employeeCode,
        employeeName: c.employee.fullName,
        departmentName: c.employee.department?.name || '',
        unitName: c.hierarchy.unit?.name || '',
        status,
        classification,
        mismatchedFields: c.mismatchedFields,
        fieldDiffCount: c.mismatchedFields.length,
        mismatchCount: c.mismatchCount,
        allFieldsMatch: c.allFieldsMatch,
        hasDuplicateExcel: c.hasDuplicateConflict,
        hasApprovedTransfer: c.explainsMismatch,
        notes: stored?.notes || null,
        updatedAt: stored?.updatedAt || c.employee.updatedAt?.toISOString() || new Date().toISOString()
      };
    });

    let filtered = summaries;

    if (query.status && query.status.trim() !== '' && query.status.toUpperCase() !== 'ALL') {
      const targetStatus = query.status.trim().toUpperCase();
      filtered = filtered.filter((s) => s.status.toUpperCase() === targetStatus);
    }

    if (query.classification && query.classification.trim() !== '' && query.classification.toUpperCase() !== 'ALL') {
      const targetClass = query.classification.trim().toUpperCase();
      filtered = filtered.filter((s) => s.classification.toUpperCase() === targetClass);
    }

    if (query.unitId || query.unit) {
      const targetUnit = norm(query.unitId || query.unit);
      filtered = filtered.filter((s) => norm(s.unitName).includes(targetUnit));
    }

    if (query.departmentId || query.department) {
      const targetDept = norm(query.departmentId || query.department);
      filtered = filtered.filter((s) => norm(s.departmentName).includes(targetDept));
    }

    if (query.mismatchField && query.mismatchField.trim() !== '' && query.mismatchField.toUpperCase() !== 'ALL') {
      const fieldNorm = query.mismatchField.trim().toLowerCase();
      filtered = filtered.filter((s) => s.mismatchedFields.some((f) => f.toLowerCase().includes(fieldNorm)));
    }

    if (query.search && query.search.trim() !== '') {
      const term = norm(query.search);
      filtered = filtered.filter((s) => norm(s.employeeCode).includes(term) || norm(s.employeeName).includes(term));
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    return {
      cases: paginated,
      total,
      page,
      limit,
      totalPages
    };
  }

  /**
   * Retrieves single case detail by employee code or ID.
   */
  public async getCaseDetail(
    prisma: PrismaClient,
    caseIdOrCode: string,
    explicitExcelPath?: string
  ): Promise<ReconciliationCaseDetail | null> {
    const { cases } = await this.evaluateAllCases(prisma, explicitExcelPath);
    const targetCode = idNorm(caseIdOrCode);

    const c = cases.find(
      (item) => idNorm(item.employee.employeeCode) === targetCode || item.employee.id === caseIdOrCode
    );

    if (!c) {
      return null;
    }

    const code = idNorm(c.employee.employeeCode);
    const stored = this.inMemoryStore.get(code);
    const status = stored?.status || c.initialStatus;
    const classification = stored?.classification || c.initialClassification;

    // Fetch recent audit logs for this employee or seat
    let auditLogs: any[] = [];
    try {
      const logs = await prisma.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'Employee', entityId: c.employee.id },
            { entityType: 'DataReconciliationCase', entityId: code },
            c.seat ? { entityType: 'Seat', entityId: c.seat.id } : { entityType: 'NONE', entityId: 'NONE' }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      });
      auditLogs = logs.map((l: any) => ({
        id: l.id,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        metadata: l.metadata,
        createdAt: l.createdAt?.toISOString?.() || String(l.createdAt)
      }));
    } catch {
      // Ignore in mock environment if auditLog unsupported
    }

    const transferHistory = (c.employee.transferRequests || []).map((t: any) => ({
      id: t.id,
      requestNumber: t.requestNumber || t.id,
      status: t.status,
      createdAt: t.createdAt?.toISOString?.() || String(t.createdAt),
      sourceUnitName: t.sourceUnitId,
      targetUnitName: t.targetUnitId,
      sourceFloorName: t.sourceFloorId,
      targetFloorName: t.targetFloorId,
      sourceSeatLabel: t.sourceSeatId,
      targetSeatLabel: t.targetSeatId
    }));

    const evidence: ReconciliationEvidence = {
      currentRecord: {
        id: c.employee.id,
        employeeCode: c.employee.employeeCode,
        fullName: c.employee.fullName,
        email: c.employee.email,
        designation: c.employee.designation,
        officeArea: c.employee.officeArea,
        section: c.employee.section || c.employee.sectionMaster?.name,
        functionName: c.employee.functionName || c.employee.functionMaster?.name,
        isActive: c.employee.isActive,
        departmentId: c.employee.departmentId,
        departmentName: c.employee.department?.name,
        createdAt: c.employee.createdAt?.toISOString?.() || String(c.employee.createdAt),
        updatedAt: c.employee.updatedAt?.toISOString?.() || String(c.employee.updatedAt)
      },
      currentSeat: c.seat
        ? {
            id: c.seat.id,
            label: c.seat.label,
            status: c.seat.status,
            floorId: c.seat.floorId,
            floorName: c.seat.floor?.name,
            buildingName: c.seat.floor?.building?.name,
            unitName: c.seat.floor?.building?.unit?.name || c.seat.floor?.building?.plant?.unit?.name
          }
        : null,
      hierarchy: c.hierarchy,
      transferHistory,
      hasApprovedTransfer: !!c.approvedTransfer,
      explainsMismatch: c.explainsMismatch,
      duplicateExcelRows: c.duplicateExcelRows.map((r: ExcelEmployeeRow) => r.raw),
      auditLogs,
      excelRowDetails: {
        sheet: 'Sheet1',
        row: c.excelRow.rowNum,
        excelData: c.excelRow.raw
      }
    };

    return {
      id: code,
      employeeCode: c.employee.employeeCode,
      employeeName: c.employee.fullName,
      status,
      classification,
      notes: stored?.notes || null,
      snapshotUpdatedAt: c.employee.updatedAt?.toISOString?.() || new Date().toISOString(),
      diff: c.diffs,
      mismatchCount: c.mismatchCount,
      allFieldsMatch: c.allFieldsMatch,
      evidence
    };
  }

  /**
   * Preview a proposed correction against database hierarchy and workstation occupancy rules.
   */
  public async previewCorrection(
    prisma: PrismaClient,
    caseIdOrCode: string,
    explicitExcelPath?: string
  ): Promise<ReconciliationPreviewResult> {
    const detail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    if (!detail) {
      throw new Error(`Reconciliation case '${caseIdOrCode}' not found`);
    }

    const excel = detail.evidence.excelRowDetails.excelData;
    const proposedUnitName = clean(excel['Unit']);
    const proposedBuildingName = clean(excel['Building']);
    const proposedFloorName = clean(excel['Floor']);
    const proposedDeptName = clean(excel['Department']);
    const proposedWsNo = clean(excel['WS NO']);
    const proposedOfficeArea = clean(excel['Office / Area']);
    const proposedSection = clean(excel['Section']);
    const proposedFunction = clean(excel['Function']);
    const proposedStatus = clean(excel['Status']);
    const excelHas = (aliases: string[]) => Object.keys(excel).some((key) => aliases.includes(norm(key)));
    const hasUnit = excelHas(EXCEL_FIELD_ALIASES.unit) && !isBlank(proposedUnitName);
    const hasBuilding = excelHas(EXCEL_FIELD_ALIASES.building) && !isBlank(proposedBuildingName);
    const hasFloor = excelHas(EXCEL_FIELD_ALIASES.floor) && !isBlank(proposedFloorName);
    const hasDepartment = excelHas(EXCEL_FIELD_ALIASES.department) && !isBlank(proposedDeptName);
    const hasSection = excelHas(EXCEL_FIELD_ALIASES.section) && !isBlank(proposedSection);
    const hasFunction = excelHas(EXCEL_FIELD_ALIASES.functionName) && !isBlank(proposedFunction);
    const hasWorkstation = excelHas(EXCEL_FIELD_ALIASES.workstation) && !isBlank(proposedWsNo);

    const validationErrors: string[] = [];
    let seatConflict: ReconciliationPreviewResult['seatConflict'] = null;

    // 1. Hierarchy Validation
    const [units, plants, buildings, floors, departments, sections, functions] = await Promise.all([
      prisma.unit.findMany(),
      prisma.plant.findMany(),
      prisma.building.findMany(),
      prisma.floor.findMany(),
      prisma.department.findMany(),
      typeof prisma.section?.findMany === 'function' ? prisma.section.findMany() : Promise.resolve([]),
      typeof prisma.orgFunction?.findMany === 'function' ? prisma.orgFunction.findMany() : Promise.resolve([])
    ]);

    const targetUnit = units.find(
      (u: any) =>
        canonicalLabel(u.name) === canonicalLabel(proposedUnitName) ||
        canonicalLabel(u.code) === canonicalLabel(proposedUnitName)
    );

    let targetBuilding: any = null;
    let targetFloor: any = null;
    let targetDepartment: any = null;
    let targetSection: any = null;
    let targetFunction: any = null;

    if (!targetUnit && hasUnit) {
      validationErrors.push(`Unit '${proposedUnitName}' not found in active facility hierarchy.`);
    } else if (targetUnit) {
      const unitPlantIds = new Set(plants.filter((p: any) => p.unitId === targetUnit.id).map((p: any) => p.id));
      const buildingsInUnit = buildings.filter((b: any) => b.unitId === targetUnit.id || (!b.unitId && unitPlantIds.has(b.plantId)));

      targetBuilding = buildingsInUnit.find(
        (b: any) =>
          canonicalLabel(b.name) === canonicalLabel(proposedBuildingName) ||
          canonicalLabel(b.code) === canonicalLabel(proposedBuildingName)
      );

      if (!targetBuilding && hasBuilding) {
        validationErrors.push(`Building '${proposedBuildingName}' does not exist under Unit '${targetUnit.name}'.`);
      } else if (targetBuilding && hasFloor) {
        targetFloor = floors.find(
          (f: any) =>
            f.buildingId === targetBuilding.id &&
            (canonicalLabel(f.name) === canonicalLabel(proposedFloorName) ||
              String(f.floorNumber) === canonicalLabel(proposedFloorName))
        );
        if (!targetFloor) {
          validationErrors.push(`Floor '${proposedFloorName}' does not exist under Building '${targetBuilding.name}'.`);
        }
      }

      // Find department under target unit
      if (hasDepartment) {
        targetDepartment = departments.find(
          (d: any) =>
            d.unitId === targetUnit.id &&
            (canonicalLabel(d.name) === canonicalLabel(proposedDeptName) ||
              canonicalLabel(d.code) === canonicalLabel(proposedDeptName))
        );
        if (!targetDepartment) {
          validationErrors.push(`Department '${proposedDeptName}' does not exist under Unit '${targetUnit.name}'.`);
        }

        if (targetDepartment && hasSection) {
          targetSection = sections.find((section: any) =>
            section.departmentId === targetDepartment.id &&
            (canonicalLabel(section.name) === canonicalLabel(proposedSection) || canonicalLabel(section.normalizedName) === canonicalLabel(proposedSection))
          );
          if (!targetSection) validationErrors.push(`Section '${proposedSection}' does not exist under Department '${targetDepartment.name}'.`);
        }

        if (!targetDepartment && hasSection) {
          validationErrors.push(`Section '${proposedSection}' cannot be resolved without a valid Department.`);
        }

        if (targetSection && hasFunction) {
          targetFunction = functions.find((fn: any) =>
            fn.sectionId === targetSection.id &&
            (canonicalLabel(fn.name) === canonicalLabel(proposedFunction) || canonicalLabel(fn.normalizedName) === canonicalLabel(proposedFunction))
          );
          if (!targetFunction) validationErrors.push(`Function '${proposedFunction}' does not exist under Section '${targetSection.name}'.`);
        }

        if (!targetSection && hasFunction) {
          validationErrors.push(`Function '${proposedFunction}' cannot be resolved without a valid Section.`);
        }
      }
    }

    // 2. Workstation / Seat Occupancy Check
    if (targetFloor && hasWorkstation) {
      const seatsOnFloor = await prisma.seat.findMany({
        where: { floorId: targetFloor.id }
      });

      const targetSeat = seatsOnFloor.find(
        (s) => canonicalLabel(s.label) === canonicalLabel(proposedWsNo)
      );

      if (!targetSeat) {
        validationErrors.push(`Workstation '${proposedWsNo}' does not exist on Floor '${targetFloor.name}'.`);
      } else {
        // Check if occupied by someone else
        if (targetSeat.employeeId && targetSeat.employeeId !== detail.evidence.currentRecord?.id) {
          const occupant = await prisma.employee.findUnique({
            where: { id: targetSeat.employeeId }
          });
          seatConflict = {
            hasConflict: true,
            occupiedBy: occupant
              ? { employeeId: occupant.id, employeeCode: occupant.employeeCode, fullName: occupant.fullName }
              : undefined,
            seatLabel: targetSeat.label,
            floorName: targetFloor.name,
            message: occupant
              ? `Workstation ${targetSeat.label} is already occupied by ${occupant.fullName} (${occupant.employeeCode}).`
              : `Workstation ${targetSeat.label} is currently occupied.`
          };
        } else if (targetSeat.status !== 'AVAILABLE') {
          validationErrors.push(`Workstation '${targetSeat.label}' has status '${targetSeat.status}' and cannot be assigned.`);
        }
      }
    }

    // Proposed field diffs
    const current = detail.evidence.currentRecord || {};
    const currentSeat = detail.evidence.currentSeat;
    const diffs: Array<{ field: string; current: string; proposed: string }> = [];

    const addDiffIfChanged = (field: string, curVal: string, propVal: string) => {
      if (canonicalLabel(curVal) !== canonicalLabel(propVal) && !isBlank(propVal)) {
        diffs.push({ field, current: curVal, proposed: propVal });
      }
    };

    addDiffIfChanged('Unit', detail.evidence.hierarchy.unit?.name || '', proposedUnitName);
    addDiffIfChanged('Building', detail.evidence.hierarchy.building?.name || '', proposedBuildingName);
    addDiffIfChanged('Floor', detail.evidence.hierarchy.floor?.name || '', proposedFloorName);
    addDiffIfChanged('Office/Area', current.officeArea || currentSeat?.officeArea || '', proposedOfficeArea);
    addDiffIfChanged('Department', current.departmentName || '', proposedDeptName);
    addDiffIfChanged('Section', current.section || '', proposedSection);
    addDiffIfChanged('Function', current.functionName || '', proposedFunction);
    addDiffIfChanged('Workstation', currentSeat?.label || '', proposedWsNo);
    addDiffIfChanged('Designation', current.designation || '', clean(excel['Designation']));
    addDiffIfChanged('Status', current.isActive ? 'Active' : 'Inactive', proposedStatus || 'Active');

    const valid = validationErrors.length === 0;
    const canApply = valid && (!seatConflict || !seatConflict.hasConflict);

    return {
      valid,
      canApply,
      diffs,
      validationErrors,
      seatConflict,
      snapshotUpdatedAt: detail.snapshotUpdatedAt
    };
  }

  /**
   * Safe Two-Step Correction Apply with Optimistic Concurrency and Transactional Seat Update.
   */
  public async applyCorrection(
    prisma: PrismaClient,
    caseIdOrCode: string,
    payload: { snapshotUpdatedAt?: string; expectedSeatId?: string | null; notes?: string },
    admin: AdminUserContext,
    request: FastifyRequest,
    explicitExcelPath?: string
  ): Promise<{ success: boolean; case: ReconciliationCaseDetail; employee: any }> {
    const detail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    if (!detail) {
      throw new Error(`Reconciliation case '${caseIdOrCode}' not found`);
    }

    // 1. Optimistic Concurrency Check
    const currentEmployee = await prisma.employee.findUnique({
      where: { id: detail.evidence.currentRecord!.id }
    });
    if (!currentEmployee) {
      throw new Error(`Employee record '${detail.employeeCode}' not found.`);
    }

    const currentUpdatedAtIso = currentEmployee.updatedAt.toISOString();
    if (payload.snapshotUpdatedAt && payload.snapshotUpdatedAt !== currentUpdatedAtIso) {
      throw new ReconciliationConflictError(
        'Employee data changed after review began. Please refresh and preview the latest state.'
      );
    }

    if (payload.expectedSeatId !== undefined) {
      const currentSeat = await prisma.seat.findFirst({ where: { employeeId: currentEmployee.id } });
      if ((currentSeat?.id || null) !== payload.expectedSeatId) {
        throw new ReconciliationConflictError(
          'Employee workstation assignment changed after review began. Please refresh and preview the latest state.'
        );
      }
    }

    // 2. Validate Preview
    const preview = await this.previewCorrection(prisma, caseIdOrCode, explicitExcelPath);
    if (!preview.canApply) {
      throw new ReconciliationBlockedError(
        preview.seatConflict?.message || preview.validationErrors.join(', ') || 'Cannot apply correction due to validation errors.'
      );
    }

    const excel = detail.evidence.excelRowDetails.excelData;
    const proposedUnitName = clean(excel['Unit']);
    const proposedBuildingName = clean(excel['Building']);
    const proposedFloorName = clean(excel['Floor']);
    const proposedDeptName = clean(excel['Department']);
    const proposedWsNo = clean(excel['WS NO']);
    const proposedOfficeArea = clean(excel['Office / Area']);
    const proposedSection = clean(excel['Section']);
    const proposedFunction = clean(excel['Function']);
    const proposedStatus = clean(excel['Status']);
    const excelHas = (aliases: string[]) => Object.keys(excel).some((key) => aliases.includes(norm(key)));
    const hasWorkstation = excelHas(EXCEL_FIELD_ALIASES.workstation) && !isBlank(proposedWsNo);
    const hasDesignation = excelHas(EXCEL_FIELD_ALIASES.designation);

    // Resolve target IDs using flat hierarchy
    const [units, plants, buildings, floors, departments, allSeats, sections, functions] = await Promise.all([
      prisma.unit.findMany(),
      prisma.plant.findMany(),
      prisma.building.findMany(),
      prisma.floor.findMany(),
      prisma.department.findMany(),
      prisma.seat.findMany(),
      typeof prisma.section?.findMany === 'function' ? prisma.section.findMany() : Promise.resolve([]),
      typeof prisma.orgFunction?.findMany === 'function' ? prisma.orgFunction.findMany() : Promise.resolve([])
    ]);

    const targetUnit = units.find(
      (u: any) =>
        canonicalLabel(u.name) === canonicalLabel(proposedUnitName) ||
        canonicalLabel(u.code) === canonicalLabel(proposedUnitName)
    );

    let targetBuilding: any = null;
    let targetFloor: any = null;
    let targetDept: any = null;

    if (targetUnit) {
      const unitPlantIds = new Set(plants.filter((p: any) => p.unitId === targetUnit.id).map((p: any) => p.id));
      const buildingsInUnit = buildings.filter((b: any) => b.unitId === targetUnit.id || (!b.unitId && unitPlantIds.has(b.plantId)));
      targetBuilding = buildingsInUnit.find(
        (b: any) =>
          canonicalLabel(b.name) === canonicalLabel(proposedBuildingName) ||
          canonicalLabel(b.code) === canonicalLabel(proposedBuildingName)
      );

      if (targetBuilding && proposedFloorName) {
        targetFloor = floors.find(
          (f: any) =>
            f.buildingId === targetBuilding.id &&
            (canonicalLabel(f.name) === canonicalLabel(proposedFloorName) ||
              String(f.floorNumber) === canonicalLabel(proposedFloorName))
        );
      }

      if (proposedDeptName) {
        targetDept = departments.find(
          (d: any) =>
            d.unitId === targetUnit.id &&
            (canonicalLabel(d.name) === canonicalLabel(proposedDeptName) ||
              canonicalLabel(d.code) === canonicalLabel(proposedDeptName))
        );
      }
    }

    const targetSection = targetDept && proposedSection
      ? sections.find((section: any) =>
          section.departmentId === targetDept.id &&
          (canonicalLabel(section.name) === canonicalLabel(proposedSection) ||
            canonicalLabel(section.normalizedName) === canonicalLabel(proposedSection)))
      : null;
    const targetFunction = targetSection && proposedFunction
      ? functions.find((fn: any) =>
          fn.sectionId === targetSection.id &&
          (canonicalLabel(fn.name) === canonicalLabel(proposedFunction) ||
            canonicalLabel(fn.normalizedName) === canonicalLabel(proposedFunction)))
      : null;

    let targetSeat: any = null;
    if (targetFloor && proposedWsNo && hasWorkstation) {
      targetSeat = allSeats.find(
        (s: any) => s.floorId === targetFloor.id && canonicalLabel(s.label) === canonicalLabel(proposedWsNo)
      );
    }

    // 3. Execute Transaction
    const updatedEmployee = await prisma.$transaction(async (tx) => {
      // Unassign existing seat if employee holds one
      const existingSeat = await tx.seat.findFirst({
        where: { employeeId: currentEmployee.id }
      });
      if (existingSeat && hasWorkstation && (!targetSeat || existingSeat.id !== targetSeat.id)) {
        await tx.seat.update({
          where: { id: existingSeat.id },
          data: { employeeId: null, departmentId: null }
        });
      }

      // Assign target seat if requested
      if (targetSeat) {
        // Re-check seat occupancy inside transaction
        const freshSeat = await tx.seat.findUnique({ where: { id: targetSeat.id } });
        if (freshSeat?.employeeId && freshSeat.employeeId !== currentEmployee.id) {
          throw new ReconciliationBlockedError(`Workstation '${targetSeat.label}' is already assigned.`);
        }
        await tx.seat.update({
          where: { id: targetSeat.id },
          data: {
            employeeId: currentEmployee.id,
            departmentId: targetDept ? targetDept.id : currentEmployee.departmentId
          }
        });
      }

      // Update employee record
      const empUpdateData: any = {};
      if (targetDept) empUpdateData.departmentId = targetDept.id;
      if (proposedOfficeArea) empUpdateData.officeArea = proposedOfficeArea;
      if (proposedSection) empUpdateData.section = proposedSection;
      if (proposedFunction) empUpdateData.functionName = proposedFunction;
      if (targetSection) empUpdateData.sectionId = targetSection.id;
      if (targetFunction) empUpdateData.functionId = targetFunction.id;
      if (hasDesignation && clean(excel['Designation'])) empUpdateData.designation = clean(excel['Designation']);
      if (proposedStatus) {
        empUpdateData.isActive = proposedStatus.toLowerCase() !== 'inactive';
      }

      if (empUpdateData.isActive === false && currentEmployee.isActive !== false) {
        const adminIdentifier = admin.name || admin.email || 'Admin';
        const autoRejectionReason = `Employee was inactivated during transfer by ${adminIdentifier}`;
        const pendingTransfers = await tx.seatTransferRequest.findMany({
          where: {
            employeeId: currentEmployee.id,
            status: { in: ['PENDING_TARGET_ADMIN'] }
          },
          select: { id: true }
        });
        if (pendingTransfers.length > 0) {
          const autoRejectedTransferIds = pendingTransfers.map((r) => r.id);
          await tx.seatTransferRequest.updateMany({
            where: {
              id: { in: autoRejectedTransferIds }
            },
            data: {
              status: 'REJECTED',
              activeTransferKey: { unset: true },
              rejectedByRole: admin.role || 'ADMIN',
              rejectionReason: autoRejectionReason,
              targetAdminApproval: {
                approvedById: admin.id || null,
                approverName: adminIdentifier,
                adminRole: admin.role || 'ADMIN',
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
        }
      }

      return tx.employee.update({
        where: { id: currentEmployee.id },
        data: empUpdateData
      });
    });

    // 4. Update case store status
    const code = idNorm(detail.employeeCode);
    const nowIso = new Date().toISOString();
    const updatedState: StoredCaseState = {
      status: ReconciliationStatus.RESOLVED,
      classification: detail.classification,
      notes: payload.notes || detail.notes,
      resolvedBy: admin.name || admin.email,
      resolvedAt: nowIso,
      appliedAt: nowIso,
      updatedAt: nowIso
    };
    this.inMemoryStore.set(code, updatedState);
    this.saveStateStore();

    // 5. Record AuditLog
    await logAudit(prisma, request, 'RECONCILIATION_CORRECTION_APPLIED', 'Employee', currentEmployee.id, {
      employeeCode: currentEmployee.employeeCode,
      caseId: code,
      appliedBy: admin.name || admin.email,
      notes: payload.notes,
      appliedDiffs: preview.diffs
    });

    const refreshedDetail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    return {
      success: true,
      case: refreshedDetail!,
      employee: updatedEmployee
    };
  }

  /**
   * Classifies a reconciliation case.
   */
  public async classifyCase(
    prisma: PrismaClient,
    caseIdOrCode: string,
    classification: ReconciliationClassification,
    notes: string | undefined,
    admin: AdminUserContext,
    request: FastifyRequest,
    explicitExcelPath?: string
  ): Promise<ReconciliationCaseDetail> {
    const detail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    if (!detail) {
      throw new Error(`Reconciliation case '${caseIdOrCode}' not found`);
    }

    const code = idNorm(detail.employeeCode);
    const existing = this.inMemoryStore.get(code);
    const nowIso = new Date().toISOString();

    const updatedState: StoredCaseState = {
      status: existing?.status || detail.status,
      classification,
      notes: notes !== undefined ? notes : existing?.notes,
      resolvedBy: existing?.resolvedBy,
      resolvedAt: existing?.resolvedAt,
      appliedAt: existing?.appliedAt,
      updatedAt: nowIso
    };

    this.inMemoryStore.set(code, updatedState);
    this.saveStateStore();

    await logAudit(prisma, request, 'RECONCILIATION_CASE_CLASSIFIED', 'DataReconciliationCase', code, {
      employeeCode: detail.employeeCode,
      classification,
      notes,
      classifiedBy: admin.name || admin.email
    });

    const refreshed = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    return refreshed!;
  }

  /**
   * Resolves a reconciliation case as KEEP_CURRENT or FORMATTING_ONLY.
   */
  public async resolveCase(
    prisma: PrismaClient,
    caseIdOrCode: string,
    resolutionType: 'KEEP_CURRENT' | 'FORMATTING_ONLY',
    notes: string | undefined,
    admin: AdminUserContext,
    request: FastifyRequest,
    explicitExcelPath?: string
  ): Promise<ReconciliationCaseDetail> {
    const detail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    if (!detail) {
      throw new Error(`Reconciliation case '${caseIdOrCode}' not found`);
    }

    const code = idNorm(detail.employeeCode);
    const nowIso = new Date().toISOString();

    let newStatus = ReconciliationStatus.RESOLVED;
    let newClassification = detail.classification;

    if (resolutionType === 'KEEP_CURRENT') {
      newStatus = ReconciliationStatus.EXCEL_STALE;
      newClassification = ReconciliationClassification.EXCEL_STALE;
    } else if (resolutionType === 'FORMATTING_ONLY') {
      newStatus = ReconciliationStatus.FORMATTING_ONLY;
      newClassification = ReconciliationClassification.FORMATTING_ONLY;
    }

    const updatedState: StoredCaseState = {
      status: newStatus,
      classification: newClassification,
      notes: notes !== undefined ? notes : detail.notes,
      resolvedBy: admin.name || admin.email,
      resolvedAt: nowIso,
      updatedAt: nowIso
    };

    this.inMemoryStore.set(code, updatedState);
    this.saveStateStore();

    await logAudit(prisma, request, 'RECONCILIATION_CASE_RESOLVED', 'DataReconciliationCase', code, {
      employeeCode: detail.employeeCode,
      resolutionType,
      newStatus,
      newClassification,
      notes,
      resolvedBy: admin.name || admin.email
    });

    const refreshed = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    return refreshed!;
  }

  /**
   * Marks a case as NEEDS_REVIEW.
   */
  public async markNeedsReview(
    prisma: PrismaClient,
    caseIdOrCode: string,
    notes: string | undefined,
    admin: AdminUserContext,
    _request: FastifyRequest,
    explicitExcelPath?: string
  ): Promise<ReconciliationCaseDetail> {
    const detail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    if (!detail) {
      throw new Error(`Reconciliation case '${caseIdOrCode}' not found`);
    }

    const code = idNorm(detail.employeeCode);
    const nowIso = new Date().toISOString();

    const updatedState: StoredCaseState = {
      status: ReconciliationStatus.NEEDS_REVIEW,
      classification: detail.classification,
      notes: notes !== undefined ? notes : detail.notes,
      updatedAt: nowIso
    };

    this.inMemoryStore.set(code, updatedState);
    this.saveStateStore();

    const refreshed = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    return refreshed!;
  }

  /**
   * Reopens a resolved/stale case (SUPER_ADMIN only).
   */
  public async reopenCase(
    prisma: PrismaClient,
    caseIdOrCode: string,
    notes: string | undefined,
    admin: AdminUserContext,
    request: FastifyRequest,
    explicitExcelPath?: string
  ): Promise<ReconciliationCaseDetail> {
    const detail = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    if (!detail) {
      throw new Error(`Reconciliation case '${caseIdOrCode}' not found`);
    }

    const code = idNorm(detail.employeeCode);
    const nowIso = new Date().toISOString();

    const updatedState: StoredCaseState = {
      status: ReconciliationStatus.REOPENED,
      classification: detail.classification,
      notes: notes !== undefined ? notes : detail.notes,
      resolvedBy: null,
      resolvedAt: null,
      appliedAt: null,
      updatedAt: nowIso
    };

    this.inMemoryStore.set(code, updatedState);
    this.saveStateStore();

    await logAudit(prisma, request, 'RECONCILIATION_CASE_REOPENED', 'DataReconciliationCase', code, {
      employeeCode: detail.employeeCode,
      notes,
      reopenedBy: admin.name || admin.email
    });

    const refreshed = await this.getCaseDetail(prisma, caseIdOrCode, explicitExcelPath);
    return refreshed!;
  }
}

export const dataReconciliationService = DataReconciliationService.getInstance();
