import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import xlsx from '../utils/xlsx.js';
import { PrismaClient } from '@prisma/client';
import { logAudit } from './audit.service.js';
import { authoritativeExcelPath, isInitialImportApplyEnabled } from '../config/feature-flags.js';
import { canonicalLabel, idNorm, isExcelPlaceholder } from './data-reconciliation.service.js';

export type InitialImportStatus =
  | 'NOT_STARTED'
  | 'VALIDATING'
  | 'AWAITING_MANUAL_COMPLETION'
  | 'READY_TO_APPLY'
  | 'APPLYING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED_RECOVERABLE';

export type MigrationBlockReason =
  | 'DUPLICATE_EMPLOYEE_ID'
  | 'DUPLICATE_WORKSTATION'
  | 'MISSING_HIERARCHY'
  | 'AMBIGUOUS_HIERARCHY'
  | 'MISSING_WORKSTATION'
  | 'OCCUPIED_TARGET'
  | 'STALE_RECORD'
  | 'EXTRA_MONGO_RECORD'
  | 'INVALID_ROW';

export interface AuthoritativeImportPlan {
  runId: string;
  sourceFilename: string;
  sourceHash: string;
  sheet: string;
  generatedAt: string;
  source: {
    rows: number;
    validEmployeeRows: number;
    uniqueEmployeeIds: number;
    placeholderRows: number;
    uniqueWorkstationKeys: number;
    duplicateEmployeeGroups: number;
    duplicateWorkstationGroups: number;
  };
  counts: {
    employeesToCreate: number;
    employeesToUpdate: number;
    employeesToArchive: number;
    workstationsToCreate: number;
    workstationsToUpdate: number;
    workstationsToArchive: number;
    seatAssignments: number;
    seatReleases: number;
    seatMoves: number;
    seatSwaps: number;
    hierarchyAdditions: number;
    blockedRows: number;
    manualDetailsRequired: number;
    historicalRecordsPreserved: number;
    extraRecordsRequiringDecision: number;
  };
  employees: Array<Record<string, unknown>>;
  workstations: Array<Record<string, unknown>>;
  workstationVerification: Array<Record<string, unknown>>;
  seatOperations: Array<Record<string, unknown>>;
  hierarchyAdditions: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  extraRecords: Array<Record<string, unknown>>;
  historicalRecords: Array<Record<string, unknown>>;
}

export interface WorkbookRow {
  rowNumber: number;
  code: string;
  name: string;
  unit: string;
  building: string;
  floor: string;
  officeArea: string;
  department: string;
  section: string;
  functionName: string;
  workstation: string;
  reportingTo: string;
  hod: string;
  status: string;
  raw: Record<string, unknown>;
}

const IMPORT_KEY = 'AUTHORITATIVE_WORKBOOK';
const fallbackState = new Map<string, any>();
const fallbackOverrides = new Map<string, any>();
const fallbackExtraDecisions = new Map<string, any>();

const clean = (value: unknown) => String(value ?? '').trim();
const normalize = (value: unknown) => canonicalLabel(value);
const normalizeCode = (value: unknown) => idNorm(value);
const plannedId = (type: string, ...parts: unknown[]) =>
  `PLAN:${type}:${crypto.createHash('sha1').update(parts.map(normalize).join('|')).digest('hex').slice(0, 20)}`;
const technicalCode = (prefix: string, ...parts: unknown[]) =>
  `${prefix}-${crypto.createHash('sha1').update(parts.map(normalize).join('|')).digest('hex').slice(0, 12).toUpperCase()}`;
const sourceFile = (explicit?: string) => {
  const configured = clean(explicit || authoritativeExcelPath());
  if (!configured) throw Object.assign(new Error('AUTHORITATIVE_EXCEL_PATH must explicitly identify the owner-approved workbook.'), { code: 'AUTHORITATIVE_SOURCE_NOT_CONFIGURED' });
  return path.resolve(configured);
};

const OVERRIDE_FIELDS: Record<string, keyof Pick<WorkbookRow,
  'code' | 'name' | 'unit' | 'building' | 'floor' | 'officeArea' | 'department' | 'section' | 'functionName' | 'workstation' | 'reportingTo' | 'hod' | 'status'
>> = {
  'emp code': 'code',
  'employee code': 'code',
  'e. name': 'name',
  'employee name': 'name',
  unit: 'unit',
  building: 'building',
  floor: 'floor',
  'office / area': 'officeArea',
  'office/area': 'officeArea',
  area: 'officeArea',
  department: 'department',
  section: 'section',
  function: 'functionName',
  'ws no': 'workstation',
  workstation: 'workstation',
  'reporting to': 'reportingTo',
  hod: 'hod',
  status: 'status'
};

const overrideField = (value: string) => OVERRIDE_FIELDS[normalize(value)];

const value = (row: Record<string, unknown>, ...keys: string[]) => {
  const key = Object.keys(row).find((candidate) => keys.some((keyName) => normalize(candidate) === normalize(keyName)));
  return key ? clean(row[key]) : '';
};

export const parseAuthoritativeWorkbook = (filePath: string): { rows: WorkbookRow[]; source: AuthoritativeImportPlan['source']; hash: string; sheetNames: string[]; columns: string[] } => {
  if (!filePath || !fs.existsSync(filePath)) throw Object.assign(new Error('The explicitly configured authoritative workbook was not found.'), { code: 'AUTHORITATIVE_SOURCE_MISSING' });
  if (path.extname(filePath).toLowerCase() !== '.xlsx') throw Object.assign(new Error('The authoritative source must be an XLSX workbook.'), { code: 'AUTHORITATIVE_SOURCE_INVALID_TYPE' });
  const fileBytes = fs.readFileSync(filePath);
  if (fileBytes.length < 4 || fileBytes[0] !== 0x50 || fileBytes[1] !== 0x4b || fileBytes[2] !== 0x03 || fileBytes[3] !== 0x04) {
    throw Object.assign(new Error('The authoritative XLSX file does not have a valid ZIP container signature.'), { code: 'AUTHORITATIVE_SOURCE_INVALID_XLSX' });
  }
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets.Sheet1;
  if (!sheet) throw new Error('Authoritative workbook is missing Sheet1.');
  const rawRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const columns = Object.keys(rawRows[0] || {});
  const requiredColumns = ['Unit', 'Building', 'Floor', 'Office / Area', 'Department', 'WS NO', 'Emp Code', 'E. Name', 'Status'];
  const missingColumns = requiredColumns.filter((required) => !columns.some((column) => normalize(column) === normalize(required)));
  if (missingColumns.length) {
    throw Object.assign(new Error(`Sheet1 is missing required column(s): ${missingColumns.join(', ')}`), { code: 'AUTHORITATIVE_SOURCE_MISSING_COLUMNS', missingColumns });
  }
  const rows = rawRows.map((raw, index) => ({
    rowNumber: index + 2,
    code: normalizeCode(value(raw, 'Emp Code', 'Employee Code')),
    name: value(raw, 'E. Name', 'Employee Name'),
    unit: value(raw, 'Unit'),
    building: value(raw, 'Building'),
    floor: value(raw, 'Floor'),
    officeArea: value(raw, 'Office / Area', 'Office/Area', 'Area'),
    department: value(raw, 'Department'),
    section: value(raw, 'Section'),
    functionName: value(raw, 'Function'),
    workstation: value(raw, 'WS NO', 'Workstation'),
    reportingTo: value(raw, 'Reporting to', 'Reporting To'),
    hod: value(raw, 'HOD'),
    status: value(raw, 'Status'),
    raw
  } satisfies WorkbookRow));
  const employeeRows = rows.filter((row) => !isExcelPlaceholder(row.code, row.name));
  const codeGroups = new Map<string, WorkbookRow[]>();
  for (const row of employeeRows) codeGroups.set(row.code, [...(codeGroups.get(row.code) || []), row]);
  const workstationGroups = new Map<string, WorkbookRow[]>();
  for (const row of rows) {
    if (!row.workstation) continue;
    const key = [row.unit, row.building, row.floor, row.officeArea, row.workstation].map(normalize).join('|');
    workstationGroups.set(key, [...(workstationGroups.get(key) || []), row]);
  }
  const conflictingDuplicateEmployeeGroups = [...codeGroups.values()].filter((group) => {
    const signatures = new Set(group.map((row) => JSON.stringify([row.name, row.unit, row.building, row.floor, row.officeArea, row.department, row.section, row.functionName, row.workstation, row.status].map(normalize))));
    return signatures.size > 1;
  });
  const duplicateWorkstationGroups = [...workstationGroups.values()].filter((group) => {
    const assignments = new Set(group.map((row) => isExcelPlaceholder(row.code, row.name) ? '__VACANT__' : row.code));
    return assignments.size > 1;
  });
  return {
    rows,
    hash: crypto.createHash('sha256').update(fileBytes).digest('hex'),
    sheetNames: workbook.SheetNames,
    columns,
    source: {
      rows: rows.length,
      validEmployeeRows: employeeRows.length,
      uniqueEmployeeIds: codeGroups.size,
      placeholderRows: rows.length - employeeRows.length,
      uniqueWorkstationKeys: workstationGroups.size,
      duplicateEmployeeGroups: conflictingDuplicateEmployeeGroups.length,
      duplicateWorkstationGroups: duplicateWorkstationGroups.length
    }
  };
};

const floorMatches = (floor: any, requested: string) => {
  const target = normalize(requested);
  if (!target) return true;
  if (normalize(floor.name) === target) return true;
  const numeric = Number(target);
  return Number.isFinite(numeric) && floor.floorNumber === numeric;
};

const sourceActiveState = (value: string): boolean | undefined | null => {
  const normalized = normalize(value);
  if (!normalized) return undefined;
  if (['active', 'available'].includes(normalized)) return true;
  if (['inactive', 'in active'].includes(normalized)) return false;
  return null;
};

const employeeChanges = (current: any, row: WorkbookRow, departmentId: string, sectionId?: string, functionId?: string, isActive?: boolean) => {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const compare = (field: string, before: unknown, after: unknown) => {
    if (after !== '' && normalize(before) !== normalize(after)) changes[field] = { before: before ?? null, after };
  };
  compare('fullName', current?.fullName, row.name);
  compare('departmentId', current?.departmentId, departmentId);
  if (sectionId) compare('sectionId', current?.sectionId, sectionId);
  if (functionId) compare('functionId', current?.functionId, functionId);
  compare('officeArea', current?.officeArea, row.officeArea);
  compare('reportingTo', current?.reportingTo, row.reportingTo);
  compare('hod', current?.hod, row.hod);
  if (isActive !== undefined) compare('isActive', current?.isActive, isActive);
  return changes;
};

/** Group seat moves by connected reassignment cycle so a swap/chain is one atomic unit. */
export const groupSeatOperations = (seatOperations: Array<Record<string, unknown>>) => {
  const graphOperations = seatOperations.filter((operation: any) => operation.action !== 'SEAT_RELEASE' && operation.employeeCode);
  const operationsByCode = new Map(graphOperations.map((operation: any) => [operation.employeeCode, operation]));
  const seatGraph = new Map<string, Set<string>>();
  for (const operation of graphOperations as any[]) {
    const sourceNeighbors = seatGraph.get(operation.employeeCode) || new Set<string>();
    seatGraph.set(operation.employeeCode, sourceNeighbors);
    if (operation.targetOccupantCode && operationsByCode.has(operation.targetOccupantCode)) {
      const targetNeighbors = seatGraph.get(operation.targetOccupantCode) || new Set<string>();
      seatGraph.set(operation.targetOccupantCode, targetNeighbors);
      sourceNeighbors.add(operation.targetOccupantCode);
      targetNeighbors.add(operation.employeeCode);
    }
  }
  const visitedSeatCodes = new Set<string>();
  let seatGroupNumber = 0;
  for (const code of seatGraph.keys()) {
    if (visitedSeatCodes.has(code)) continue;
    const component: string[] = [];
    const queue = [code];
    visitedSeatCodes.add(code);
    while (queue.length) {
      const currentCode = queue.shift()!;
      component.push(currentCode);
      for (const neighbor of seatGraph.get(currentCode) || []) {
        if (!visitedSeatCodes.has(neighbor)) {
          visitedSeatCodes.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const groupId = component.length > 1 ? `SEAT_GROUP_${++seatGroupNumber}` : 'SIMPLE';
    for (const member of component) {
      const operation = operationsByCode.get(member) as any;
      if (operation) {
        operation.groupId = groupId;
        operation.group = component.length > 1 ? 'SWAP_OR_CHAIN' : 'SIMPLE';
      }
    }
  }
  return seatOperations;
};

const getStateModel = (prisma: PrismaClient) => (prisma as any).initialImportRun;
const getOverrideModel = (prisma: PrismaClient) => (prisma as any).initialImportOverride;
const getExtraDecisionModel = (prisma: PrismaClient) => (prisma as any).initialImportExtraDecision;

export class AuthoritativeImportService {
  public async getState(prisma: PrismaClient): Promise<any | null> {
    const model = getStateModel(prisma);
    if (model?.findUnique) return model.findUnique({ where: { key: IMPORT_KEY } });
    return fallbackState.get(IMPORT_KEY) || null;
  }

  public async listOverrides(prisma: PrismaClient, sourceHash: string): Promise<any[]> {
    const model = getOverrideModel(prisma);
    if (model?.findMany) return model.findMany({ where: { sourceHash }, orderBy: [{ rowNumber: 'asc' }, { field: 'asc' }] });
    return [...fallbackOverrides.values()].filter((item) => item.sourceHash === sourceHash);
  }

  public async listExtraDecisions(prisma: PrismaClient, sourceHash: string): Promise<any[]> {
    const model = getExtraDecisionModel(prisma);
    if (model?.findMany) return model.findMany({ where: { sourceHash }, orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }] });
    return [...fallbackExtraDecisions.values()].filter((item) => item.sourceHash === sourceHash);
  }

  public async saveExtraDecision(prisma: PrismaClient, admin: any, request: any, input: {
    sourceHash: string;
    entityType: 'EMPLOYEE' | 'WORKSTATION';
    entityId: string;
    decision: 'QUARANTINED' | 'ARCHIVED';
    explanation: string;
  }): Promise<any> {
    if (!['EMPLOYEE', 'WORKSTATION'].includes(input.entityType)) throw Object.assign(new Error('Unsupported extra-record entity type.'), { statusCode: 400, code: 'INVALID_EXTRA_ENTITY_TYPE' });
    if (!['QUARANTINED', 'ARCHIVED'].includes(input.decision)) throw Object.assign(new Error('Extra records may only be quarantined or archived.'), { statusCode: 400, code: 'INVALID_EXTRA_DECISION' });
    if (!input.explanation?.trim()) throw Object.assign(new Error('An extra-record decision explanation is required.'), { statusCode: 400, code: 'EXTRA_DECISION_EXPLANATION_REQUIRED' });
    const sourceHash = input.sourceHash.toLowerCase();
    const data = { ...input, sourceHash, explanation: input.explanation.trim(), approvedById: admin.id, approvedAt: new Date() };
    const model = getExtraDecisionModel(prisma);
    const saved = model?.upsert
      ? await model.upsert({
        where: { sourceHash_entityType_entityId: { sourceHash, entityType: input.entityType, entityId: input.entityId } },
        create: data,
        update: { decision: input.decision, explanation: data.explanation, approvedById: admin.id, approvedAt: data.approvedAt }
      })
      : { id: crypto.randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() };
    if (!model?.upsert) fallbackExtraDecisions.set(`${sourceHash}|${input.entityType}|${input.entityId}`, saved);
    await logAudit(prisma, request, 'AUTHORITATIVE_EXTRA_RECORD_DECISION_APPROVED', input.entityType, input.entityId, {
      sourceHash,
      decision: input.decision,
      explanation: data.explanation,
      adminId: admin.id
    });
    return saved;
  }

  public async saveOverride(prisma: PrismaClient, admin: any, request: any, input: {
    sourceHash: string;
    sheet: string;
    rowNumber: number;
    field: string;
    originalValue?: unknown;
    correctedValue: unknown;
    explanation: string;
  }): Promise<any> {
    if (input.sheet !== 'Sheet1') throw Object.assign(new Error('Only Sheet1 may receive migration overrides.'), { statusCode: 400, code: 'INVALID_OVERRIDE_SHEET' });
    const fieldKey = overrideField(input.field);
    if (!fieldKey) throw Object.assign(new Error(`Unsupported migration override field: ${input.field}`), { statusCode: 400, code: 'INVALID_OVERRIDE_FIELD' });
    if (!Number.isInteger(input.rowNumber) || input.rowNumber < 2) throw Object.assign(new Error('A valid Excel row number is required.'), { statusCode: 400, code: 'INVALID_OVERRIDE_ROW' });
    if (!input.explanation?.trim()) throw Object.assign(new Error('An override explanation is required.'), { statusCode: 400, code: 'OVERRIDE_EXPLANATION_REQUIRED' });
    const data = {
      sourceHash: input.sourceHash.toLowerCase(),
      sheet: 'Sheet1',
      rowNumber: input.rowNumber,
      field: input.field,
      originalValue: input.originalValue ?? null,
      correctedValue: input.correctedValue ?? '',
      explanation: input.explanation.trim(),
      approvedById: admin.id,
      approvedAt: new Date()
    };
    const model = getOverrideModel(prisma);
    const saved = model?.upsert
      ? await model.upsert({
        where: { sourceHash_sheet_rowNumber_field: { sourceHash: data.sourceHash, sheet: data.sheet, rowNumber: data.rowNumber, field: data.field } },
        create: data,
        update: { originalValue: data.originalValue, correctedValue: data.correctedValue, explanation: data.explanation, approvedById: data.approvedById, approvedAt: data.approvedAt }
      })
      : { id: crypto.randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() };
    if (!model?.upsert) fallbackOverrides.set(`${data.sourceHash}|${data.sheet}|${data.rowNumber}|${normalize(data.field)}`, saved);
    await logAudit(prisma, request, 'AUTHORITATIVE_INITIAL_OVERRIDE_APPROVED', 'InitialImportOverride', String(saved.id), {
      sourceHash: data.sourceHash,
      sheet: data.sheet,
      rowNumber: data.rowNumber,
      field: data.field,
      originalValue: data.originalValue,
      correctedValue: data.correctedValue,
      explanation: data.explanation,
      adminId: admin.id
    });
    return saved;
  }

  private applyOverrides(rows: WorkbookRow[], overrides: any[]): WorkbookRow[] {
    const byRowAndField = new Map<string, any>();
    for (const item of overrides) byRowAndField.set(`${item.rowNumber}|${normalize(item.field)}`, item);
    return rows.map((row) => {
      const next = { ...row };
      for (const [label, key] of Object.entries(OVERRIDE_FIELDS)) {
        const item = byRowAndField.get(`${row.rowNumber}|${normalize(label)}`);
        if (!item) continue;
        if (item.originalValue != null && normalize((row as any)[key]) !== normalize(item.originalValue)) {
          throw Object.assign(new Error(`Override for Sheet1 row ${row.rowNumber} field ${item.field} no longer matches the source workbook.`), { statusCode: 409, code: 'STALE_MIGRATION_OVERRIDE' });
        }
        (next as any)[key] = key === 'code' ? normalizeCode(item.correctedValue) : clean(item.correctedValue);
      }
      return next;
    });
  }

  private async saveState(prisma: PrismaClient, data: any, id?: string) {
    const model = getStateModel(prisma);
    if (model?.update) {
      return model.update({ where: id ? { id } : { key: IMPORT_KEY }, data });
    }
    const state = { id: id || crypto.randomUUID(), key: IMPORT_KEY, ...data, updatedAt: new Date() };
    fallbackState.set(IMPORT_KEY, state);
    return state;
  }

  public async recoverInterruptedRun(prisma: PrismaClient, admin: any, request: any, confirmation: string): Promise<any> {
    if (confirmation !== 'MARK_FAILED_RECOVERABLE') {
      throw Object.assign(new Error('Explicit recovery confirmation is required.'), { statusCode: 400, code: 'INITIAL_IMPORT_RECOVERY_CONFIRMATION_REQUIRED' });
    }
    const current = await this.getState(prisma);
    if (!current || !['VALIDATING', 'APPLYING', 'VERIFYING'].includes(current.status)) {
      throw Object.assign(new Error('There is no interrupted active migration to recover.'), { statusCode: 409, code: 'INITIAL_IMPORT_NOT_INTERRUPTED' });
    }
    const updatedAt = current.updatedAt instanceof Date ? current.updatedAt : new Date(current.updatedAt || 0);
    if (Date.now() - updatedAt.getTime() < 15 * 60 * 1000) {
      throw Object.assign(new Error('The migration lock is still fresh. Recovery is permitted only after 15 minutes without progress.'), { statusCode: 409, code: 'INITIAL_IMPORT_LOCK_ACTIVE' });
    }
    const recovered = await this.saveState(prisma, {
      status: 'FAILED_RECOVERABLE',
      error: { code: 'INTERRUPTED_RUN_RECOVERED', message: 'An authorized owner released a stale migration lock. Regenerate the plan or restore the verified backup before applying.' }
    }, current.id);
    await logAudit(prisma, request, 'AUTHORITATIVE_INITIAL_IMPORT_RECOVERED', 'InitialImportRun', String(current.id), { migrationRunId: current.id, sourceHash: current.sourceHash || null, previousStatus: current.status, adminId: admin.id });
    return recovered;
  }

  private async claimValidation(prisma: PrismaClient, adminId: string) {
    const current = await this.getState(prisma);
    if (current?.status === 'COMPLETED') throw Object.assign(new Error('Initial authoritative import is already completed.'), { statusCode: 409, code: 'INITIAL_IMPORT_COMPLETED' });
    if (current && ['VALIDATING', 'APPLYING', 'VERIFYING'].includes(current.status)) {
      throw Object.assign(new Error('Another initial authoritative import operation is already in progress.'), { statusCode: 409, code: 'INITIAL_IMPORT_ALREADY_IN_PROGRESS' });
    }
    const model = getStateModel(prisma);
    if (!current && model?.create) {
      try {
        return await model.create({ data: { key: IMPORT_KEY, status: 'VALIDATING', startedById: adminId, startedAt: new Date() } });
      } catch (error: any) {
        if (error?.code === 'P2002') throw Object.assign(new Error('Another initial authoritative import operation is already in progress.'), { statusCode: 409, code: 'INITIAL_IMPORT_ALREADY_IN_PROGRESS' });
        throw error;
      }
    }
    if (current && model?.updateMany) {
      const claimed = await model.updateMany({
        where: { id: current.id, status: current.status },
        data: { status: 'VALIDATING', startedById: adminId, startedAt: new Date(), completedAt: null, error: null }
      });
      if (claimed.count !== 1) {
        throw Object.assign(new Error('Another initial authoritative import operation claimed the database first.'), { statusCode: 409, code: 'INITIAL_IMPORT_ALREADY_IN_PROGRESS' });
      }
      return model.findUnique({ where: { id: current.id } });
    }
    return this.saveState(prisma, { status: 'VALIDATING', startedById: adminId, startedAt: new Date(), completedAt: null, error: null }, current?.id);
  }

  /** Builds a complete comparison without creating or changing migration state. */
  public async generateDryRunPlan(prisma: PrismaClient, explicitPath?: string): Promise<AuthoritativeImportPlan> {
    fallbackState.delete(IMPORT_KEY);
    const readOnlyStatePrisma = new Proxy(prisma as any, {
      get(target, property, receiver) {
        if (property === 'initialImportRun') return undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as PrismaClient;
    try {
      return await this.generatePlan(readOnlyStatePrisma, 'DRY_RUN', explicitPath);
    } finally {
      fallbackState.delete(IMPORT_KEY);
    }
  }

  public async generatePlan(prisma: PrismaClient, adminId: string, explicitPath?: string): Promise<AuthoritativeImportPlan> {
    const state = await this.claimValidation(prisma, adminId);
    const filePath = sourceFile(explicitPath);
    try {
      const parsed = parseAuthoritativeWorkbook(filePath);
      const overrides = await this.listOverrides(prisma, parsed.hash);
      const extraDecisions = await this.listExtraDecisions(prisma, parsed.hash);
      const extraDecisionByEntity = new Map(extraDecisions.map((item) => [`${item.entityType}|${item.entityId}`, item]));
      parsed.rows = this.applyOverrides(parsed.rows, overrides);
      const [units, plants, buildings, floors, areas, departments, sections, functions, employees, seats, transfers, auditLogs] = await Promise.all([
        prisma.unit.findMany(), prisma.plant.findMany(), prisma.building.findMany(), prisma.floor.findMany(),
        prisma.area.findMany(), prisma.department.findMany(), prisma.section.findMany(), prisma.orgFunction.findMany(),
        prisma.employee.findMany(),
        prisma.seat.findMany(),
        prisma.seatTransferRequest.findMany(), prisma.auditLog.findMany()
      ]);
      const hierarchyAdditions: Array<Record<string, unknown>> = [];
      const unitByName = new Map<string, any>();
      for (const unit of units) { unitByName.set(normalize(unit.name), unit); unitByName.set(normalize(unit.code), unit); }
      const plantsByUnit = new Map<string, any[]>();
      for (const plant of plants) plantsByUnit.set(plant.unitId, [...(plantsByUnit.get(plant.unitId) || []), plant]);
      const buildingsByUnit = new Map<string, any[]>();
      for (const building of buildings) {
        const plant = building.plantId ? plants.find((candidate: any) => candidate.id === building.plantId) : null;
        const buildingUnitId = building.unitId || plant?.unitId;
        if (buildingUnitId) buildingsByUnit.set(buildingUnitId, [...(buildingsByUnit.get(buildingUnitId) || []), building]);
      }

      // Build missing hierarchy directly from exact workbook labels. Generated
      // codes/floor numbers are deterministic technical keys only; displayed
      // business names remain the untouched Excel values. No Plant is created.
      const validHierarchyValue = (input: unknown) => Boolean(clean(input) && !['0', '#n/a', 'n/a'].includes(normalize(input)));
      const ensureUnit = (name: string) => {
        if (!validHierarchyValue(name)) return null;
        const existing = unitByName.get(normalize(name));
        if (existing) return existing;
        const entity = { id: plannedId('UNIT', name), name: clean(name), code: technicalCode('UNIT', name), planned: true };
        units.push(entity as any);
        unitByName.set(normalize(name), entity);
        unitByName.set(normalize(entity.code), entity);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'UNIT', plannedId: entity.id, name: entity.name, code: entity.code, sourceRows: [] });
        return entity;
      };
      const ensureBuilding = (unit: any, name: string) => {
        if (!unit || !validHierarchyValue(name)) return null;
        const candidates = buildingsByUnit.get(unit.id) || [];
        const existingMatches = candidates.filter((item: any) => normalize(item.name) === normalize(name) || normalize(item.code) === normalize(name));
        if (existingMatches.length === 1) return existingMatches[0];
        if (existingMatches.length > 1) return null;
        const entity = { id: plannedId('BUILDING', unit.id, name), name: clean(name), code: technicalCode('BLD', unit.name, name), unitId: unit.id, plantId: null, planned: true };
        buildings.push(entity as any);
        buildingsByUnit.set(unit.id, [...candidates, entity]);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'BUILDING', plannedId: entity.id, unitId: unit.id, name: entity.name, code: entity.code, sourceRows: [] });
        return entity;
      };
      const ensureFloor = (building: any, name: string) => {
        if (!building || !validHierarchyValue(name)) return null;
        const existingMatches = floors.filter((item: any) => item.buildingId === building.id && normalize(item.name) === normalize(name));
        if (existingMatches.length === 1) return existingMatches[0];
        if (existingMatches.length > 1) return null;
        const numeric = Number(clean(name).match(/-?\d+/)?.[0]);
        const usedNumbers = floors.filter((item: any) => item.buildingId === building.id).map((item: any) => Number(item.floorNumber)).filter(Number.isFinite);
        const floorNumber = Number.isFinite(numeric) ? numeric : (usedNumbers.length ? Math.max(...usedNumbers) + 1 : 1);
        const entity = { id: plannedId('FLOOR', building.id, name), name: clean(name), floorNumber, buildingId: building.id, planned: true };
        floors.push(entity as any);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'FLOOR', plannedId: entity.id, buildingId: building.id, name: entity.name, floorNumber, sourceRows: [] });
        return entity;
      };
      const ensureArea = (floor: any, name: string) => {
        if (!floor || !validHierarchyValue(name)) return null;
        const existingMatches = areas.filter((item: any) => item.floorId === floor.id && normalize(item.name) === normalize(name));
        if (existingMatches.length === 1) return existingMatches[0];
        if (existingMatches.length > 1) return null;
        const entity = { id: plannedId('AREA', floor.id, name), name: clean(name), normalizedName: normalize(name), floorId: floor.id, planned: true };
        areas.push(entity as any);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'AREA', plannedId: entity.id, floorId: floor.id, name: entity.name, normalizedName: entity.normalizedName, sourceRows: [] });
        return entity;
      };
      const ensureDepartment = (unit: any, name: string) => {
        if (!unit || !validHierarchyValue(name)) return null;
        const existingMatches = departments.filter((item: any) => item.unitId === unit.id && (normalize(item.name) === normalize(name) || normalize(item.code) === normalize(name)));
        if (existingMatches.length === 1) return existingMatches[0];
        if (existingMatches.length > 1) return null;
        const entity = { id: plannedId('DEPARTMENT', unit.id, name), name: clean(name), code: technicalCode('DEPT', unit.name, name), unitId: unit.id, planned: true };
        departments.push(entity as any);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'DEPARTMENT', plannedId: entity.id, unitId: unit.id, name: entity.name, code: entity.code, sourceRows: [] });
        return entity;
      };
      const ensureSection = (department: any, name: string) => {
        if (!department || !validHierarchyValue(name)) return null;
        const existing = sections.find((item: any) => item.departmentId === department.id && normalize(item.name) === normalize(name));
        if (existing) return existing;
        const entity = { id: plannedId('SECTION', department.id, name), name: clean(name), normalizedName: normalize(name), departmentId: department.id, planned: true };
        sections.push(entity as any);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'SECTION', plannedId: entity.id, departmentId: department.id, name: entity.name, normalizedName: entity.normalizedName, sourceRows: [] });
        return entity;
      };
      const ensureFunction = (section: any, name: string) => {
        if (!section || !validHierarchyValue(name)) return null;
        const existing = functions.find((item: any) => item.sectionId === section.id && normalize(item.name) === normalize(name));
        if (existing) return existing;
        const entity = { id: plannedId('FUNCTION', section.id, name), name: clean(name), normalizedName: normalize(name), sectionId: section.id, planned: true };
        functions.push(entity as any);
        hierarchyAdditions.push({ action: 'CREATE', entityType: 'FUNCTION', plannedId: entity.id, sectionId: section.id, name: entity.name, normalizedName: entity.normalizedName, sourceRows: [] });
        return entity;
      };
      for (const row of parsed.rows) {
        const unit = ensureUnit(row.unit);
        const building = ensureBuilding(unit, row.building);
        const floor = ensureFloor(building, row.floor);
        ensureArea(floor, row.officeArea);
        const department = ensureDepartment(unit, row.department);
        const section = ensureSection(department, row.section);
        ensureFunction(section, row.functionName);
        for (const addition of hierarchyAdditions) {
          const relevant = [addition.plannedId, addition.unitId, addition.buildingId, addition.floorId, addition.departmentId, addition.sectionId].includes(unit?.id)
            || [addition.plannedId, addition.buildingId, addition.floorId].includes(building?.id)
            || [addition.plannedId, addition.floorId].includes(floor?.id)
            || [addition.plannedId, addition.departmentId].includes(department?.id)
            || [addition.plannedId, addition.sectionId].includes(section?.id);
          if (relevant && Array.isArray(addition.sourceRows) && !(addition.sourceRows as number[]).includes(row.rowNumber)) (addition.sourceRows as number[]).push(row.rowNumber);
        }
      }
      const employeesByCode = new Map(employees.map((employee: any) => [normalizeCode(employee.employeeCode), employee]));
      const employeesById = new Map(employees.map((employee: any) => [String(employee.id), employee]));
      const areasById = new Map(areas.map((area: any) => [String(area.id), area]));
      const seatAreaName = (seat: any) => seat.areaId ? areasById.get(String(seat.areaId))?.name : seat.officeArea;
      const pendingTransferEmployeeIds = new Set(
        transfers
          .filter((transfer: any) => String(transfer.status || '').startsWith('PENDING_'))
          .map((transfer: any) => String(transfer.employeeId))
      );
      const employeeRows = parsed.rows.filter((row) => !isExcelPlaceholder(row.code, row.name));
      const rowsByCode = new Map<string, WorkbookRow[]>();
      for (const row of employeeRows) rowsByCode.set(row.code, [...(rowsByCode.get(row.code) || []), row]);
      const duplicateEmployeeCodes = new Set([...rowsByCode.entries()].filter(([, group]) => new Set(group.map((row) => JSON.stringify([row.name, row.unit, row.building, row.floor, row.officeArea, row.department, row.section, row.functionName, row.workstation, row.status].map(normalize)))).size > 1).map(([code]) => code));
      const targetSeatByCode = new Map<string, any>();
      const targetCodesBySeat = new Map<string, string[]>();
      const plannedSeatsByKey = new Map<string, any>();
      const vacantSeatTargets = new Map<string, { row: WorkbookRow; seat: any }>();
      const blockers: Array<Record<string, unknown>> = [];
      const employeesPlan: Array<Record<string, unknown>> = [];
      const workstationPlan: Array<Record<string, unknown>> = [];
      const workstationVerificationByKey = new Map<string, any>();
      const safeEmployeeCodes = new Set<string>();
      const sourceConflictedRows = new Set<number>();
      const sourceWorkstationGroups = new Map<string, WorkbookRow[]>();
      for (const row of parsed.rows) {
        if (!row.workstation) continue;
        const sourceKey = [row.unit, row.building, row.floor, row.officeArea, row.workstation].map(normalize).join('|');
        sourceWorkstationGroups.set(sourceKey, [...(sourceWorkstationGroups.get(sourceKey) || []), row]);
      }
      for (const [sourceKey, group] of sourceWorkstationGroups.entries()) {
        const assignments = new Set(group.map((row) => isExcelPlaceholder(row.code, row.name) ? '__VACANT__' : row.code));
        if (assignments.size <= 1) continue;
        group.forEach((row) => sourceConflictedRows.add(row.rowNumber));
        blockers.push({
          type: 'DUPLICATE_WORKSTATION',
          workstationKey: sourceKey,
          rows: group.map((row) => row.rowNumber),
          employeeCodes: [...assignments].filter((code) => code !== '__VACANT__'),
          includesVacancy: assignments.has('__VACANT__'),
          reason: 'Conflicting authoritative rows describe different occupants for the same scoped workstation.'
        });
      }

      for (const [code, group] of rowsByCode.entries()) {
        const row = group[0];
        if (group.some((item) => sourceConflictedRows.has(item.rowNumber))) continue;
        if (duplicateEmployeeCodes.has(code)) {
          blockers.push({ type: 'DUPLICATE_EMPLOYEE_ID', employeeCode: code, rows: group.map((item) => item.rowNumber), reason: 'Conflicting authoritative rows share the same Employee ID.' });
          continue;
        }
        const unit = unitByName.get(normalize(row.unit));
        const matchingBuildings = unit ? (buildingsByUnit.get(unit.id) || []).filter((building: any) => normalize(building.name) === normalize(row.building) || normalize(building.code) === normalize(row.building)) : [];
        if (!unit || !row.building || matchingBuildings.length !== 1) {
          blockers.push({ type: !unit || matchingBuildings.length === 0 ? 'MISSING_HIERARCHY' : 'AMBIGUOUS_HIERARCHY', employeeCode: code, rows: group.map((item) => item.rowNumber), field: !unit ? 'Unit' : 'Building', value: !unit ? row.unit : row.building });
          continue;
        }
        const building = matchingBuildings[0];
        const matchingFloors = floors.filter((floor: any) => floor.buildingId === building.id && floorMatches(floor, row.floor));
        if (!row.floor || matchingFloors.length !== 1) {
          blockers.push({ type: matchingFloors.length > 1 ? 'AMBIGUOUS_HIERARCHY' : 'MISSING_HIERARCHY', employeeCode: code, rows: group.map((item) => item.rowNumber), field: 'Floor', value: row.floor });
          continue;
        }
        const floor = matchingFloors[0];
        const areaMatches = row.officeArea
          ? areas.filter((candidate: any) => candidate.floorId === floor.id && normalize(candidate.name) === normalize(row.officeArea))
          : [];
        if (!row.officeArea || areaMatches.length !== 1) {
          blockers.push({
            type: areaMatches.length > 1 ? 'AMBIGUOUS_HIERARCHY' : 'MISSING_HIERARCHY',
            employeeCode: code,
            rows: group.map((item) => item.rowNumber),
            field: 'Office / Area',
            value: row.officeArea,
            reason: !row.officeArea ? 'The authoritative workstation row has no Office / Area.' : 'The Office / Area does not resolve uniquely within the selected Floor.'
          });
          continue;
        }
        const area = areaMatches[0];
        const departmentMatches = departments.filter((department: any) => department.unitId === unit.id && (normalize(department.name) === normalize(row.department) || normalize(department.code) === normalize(row.department)));
        if (!row.department || departmentMatches.length !== 1) {
          blockers.push({ type: departmentMatches.length > 1 ? 'AMBIGUOUS_HIERARCHY' : 'MISSING_HIERARCHY', employeeCode: code, rows: group.map((item) => item.rowNumber), field: 'Department', value: row.department });
          continue;
        }
        const department = departmentMatches[0];
        const section = row.section ? sections.find((candidate: any) => candidate.departmentId === department.id && normalize(candidate.name) === normalize(row.section)) : undefined;
        const functionEntity = row.functionName && section ? functions.find((candidate: any) => candidate.sectionId === section.id && normalize(candidate.name) === normalize(row.functionName)) : undefined;
        if (row.section && !section) {
          blockers.push({ type: 'MISSING_HIERARCHY', employeeCode: code, rows: group.map((item) => item.rowNumber), field: 'Section', value: row.section });
          continue;
        }
        if (row.functionName && !functionEntity) {
          blockers.push({ type: 'MISSING_HIERARCHY', employeeCode: code, rows: group.map((item) => item.rowNumber), field: 'Function', value: row.functionName });
          continue;
        }
        const current = employeesByCode.get(code);
        if (current && pendingTransferEmployeeIds.has(String(current.id))) {
          blockers.push({
            type: 'STALE_RECORD',
            employeeCode: code,
            rows: group.map((item) => item.rowNumber),
            field: 'Transfer',
            reason: 'A pending transfer conflicts with authoritative baseline alignment and requires manual review.'
          });
          continue;
        }
        const sourceIsActive = sourceActiveState(row.status);
        if (sourceIsActive === null || (!current && sourceIsActive === undefined)) {
          blockers.push({
            type: 'INVALID_ROW',
            employeeCode: code,
            rows: group.map((item) => item.rowNumber),
            field: 'Status',
            value: row.status,
            reason: sourceIsActive === null ? 'Unsupported employee status.' : 'Status is required when creating a missing employee.'
          });
          continue;
        }
        const desiredIsActive = sourceIsActive ?? current.isActive;
        const changes = employeeChanges(current, row, department.id, section?.id, functionEntity?.id, desiredIsActive);
        const desired = {
          employeeCode: code,
          fullName: row.name,
          departmentId: department.id,
          sectionId: section?.id || null,
          functionId: functionEntity?.id || null,
          officeArea: row.officeArea || null,
          reportingTo: row.reportingTo || null,
          hod: row.hod || null,
          isActive: desiredIsActive
        };
        const employeePlan = {
          employeeCode: code,
          employeeId: current?.id || null,
          rows: group.map((item) => item.rowNumber),
          action: current ? (Object.keys(changes).length ? 'UPDATE' : 'NO_CHANGE') : 'CREATE',
          changes,
          desired,
          expected: current ? {
            fullName: current.fullName ?? null,
            departmentId: current.departmentId ?? null,
            sectionId: current.sectionId ?? null,
            functionId: current.functionId ?? null,
            officeArea: current.officeArea ?? null,
            reportingTo: current.reportingTo ?? null,
            hod: current.hod ?? null,
            isActive: current.isActive,
            updatedAt: current.updatedAt instanceof Date ? current.updatedAt.toISOString() : current.updatedAt ?? null
          } : null
        };
        employeesPlan.push(employeePlan);
        safeEmployeeCodes.add(code);
        if (row.workstation) {
          const targetSeats = seats.filter((seat: any) => seat.floorId === floor.id && normalize(seat.label) === normalize(row.workstation));
          if (targetSeats.length > 1) {
            blockers.push({ type: 'AMBIGUOUS_HIERARCHY', employeeCode: code, rows: group.map((item) => item.rowNumber), workstation: row.workstation, floor: row.floor });
            continue;
          }
          const plannedKey = `${floor.id}|${normalize(row.workstation)}`;
          let targetSeat: any = targetSeats[0] || plannedSeatsByKey.get(plannedKey);
          if (!targetSeat) {
            targetSeat = {
              id: null,
              plannedKey,
              label: row.workstation,
              floorId: floor.id,
              areaId: area.id,
              officeArea: row.officeArea,
              departmentId: department.id,
              employeeId: null,
              employee: null
            };
            plannedSeatsByKey.set(plannedKey, targetSeat);
            workstationPlan.push({
              action: 'CREATE',
              plannedKey,
              row: row.rowNumber,
              label: row.workstation,
              floorId: floor.id,
              areaId: area.id,
              officeArea: row.officeArea,
              departmentId: department.id,
              x: 0,
              y: 0,
              placementSource: null
            });
          } else if (targetSeat.id && normalize(seatAreaName(targetSeat)) !== normalize(row.officeArea)) {
            workstationPlan.push({ seatId: targetSeat.id, areaId: area.id, row: row.rowNumber, action: 'UPDATE_AREA', expectedAreaId: targetSeat.areaId || null, expectedOfficeArea: targetSeat.officeArea || null, before: seatAreaName(targetSeat) || null, after: row.officeArea });
          }
          targetSeatByCode.set(code, targetSeat);
          const workstationVerification = workstationVerificationByKey.get(plannedKey) || { plannedKey, seatId: targetSeat.id || null, label: row.workstation, floorId: floor.id, areaId: area.id, sourceRows: [] };
          workstationVerification.sourceRows.push(...group.map((item) => item.rowNumber));
          workstationVerificationByKey.set(plannedKey, workstationVerification);
          const targetKey = targetSeat.id || targetSeat.plannedKey;
          targetCodesBySeat.set(targetKey, [...(targetCodesBySeat.get(targetKey) || []), code]);
        }
      }

      for (const row of parsed.rows.filter((item) => isExcelPlaceholder(item.code, item.name))) {
        if (!row.workstation || sourceConflictedRows.has(row.rowNumber)) continue;
        const unit = unitByName.get(normalize(row.unit));
        const matchingBuildings = unit ? (buildingsByUnit.get(unit.id) || []).filter((building: any) => normalize(building.name) === normalize(row.building) || normalize(building.code) === normalize(row.building)) : [];
        const building = matchingBuildings.length === 1 ? matchingBuildings[0] : null;
        const matchingFloors = building ? floors.filter((floor: any) => floor.buildingId === building.id && floorMatches(floor, row.floor)) : [];
        const floor = matchingFloors.length === 1 ? matchingFloors[0] : null;
        const areaMatches = floor && row.officeArea
          ? areas.filter((candidate: any) => candidate.floorId === floor.id && normalize(candidate.name) === normalize(row.officeArea))
          : [];
        const area = areaMatches.length === 1 ? areaMatches[0] : null;
        if (!unit || !building || !floor || !area) {
          blockers.push({
            type: 'MISSING_HIERARCHY',
            rows: [row.rowNumber],
            field: !unit ? 'Unit' : !building ? 'Building' : !floor ? 'Floor' : 'Office / Area',
            value: !unit ? row.unit : !building ? row.building : !floor ? row.floor : row.officeArea,
            workstation: row.workstation,
            reason: 'Vacant workstation rows must resolve to one complete operational hierarchy.'
          });
          continue;
        }
        const plannedKey = `${floor.id}|${normalize(row.workstation)}`;
        const targetSeats = seats.filter((seat: any) => seat.floorId === floor.id && normalize(seat.label) === normalize(row.workstation));
        if (targetSeats.length > 1) {
          blockers.push({ type: 'AMBIGUOUS_HIERARCHY', rows: [row.rowNumber], field: 'Workstation', value: row.workstation });
          continue;
        }
        let targetSeat: any = targetSeats[0] || plannedSeatsByKey.get(plannedKey);
        if (!targetSeat) {
          targetSeat = { id: null, plannedKey, label: row.workstation, floorId: floor.id, areaId: area.id, officeArea: row.officeArea, departmentId: null, employeeId: null, employee: null };
          plannedSeatsByKey.set(plannedKey, targetSeat);
          workstationPlan.push({ action: 'CREATE', plannedKey, row: row.rowNumber, label: row.workstation, floorId: floor.id, areaId: area.id, officeArea: row.officeArea, departmentId: null, x: 0, y: 0, placementSource: null });
        } else if (targetSeat.id && normalize(seatAreaName(targetSeat)) !== normalize(row.officeArea)) {
          workstationPlan.push({ seatId: targetSeat.id, areaId: area.id, row: row.rowNumber, action: 'UPDATE_AREA', expectedAreaId: targetSeat.areaId || null, expectedOfficeArea: targetSeat.officeArea || null, before: seatAreaName(targetSeat) || null, after: row.officeArea });
        }
        vacantSeatTargets.set(targetSeat.id || plannedKey, { row, seat: targetSeat });
        const workstationVerification = workstationVerificationByKey.get(plannedKey) || { plannedKey, seatId: targetSeat.id || null, label: row.workstation, floorId: floor.id, areaId: area.id, sourceRows: [] };
        workstationVerification.sourceRows.push(row.rowNumber);
        workstationVerificationByKey.set(plannedKey, workstationVerification);
      }

      for (const [seatKey, codes] of targetCodesBySeat.entries()) {
        if (codes.length > 1) blockers.push({ type: 'DUPLICATE_WORKSTATION', seatId: seatKey, employeeCodes: codes, rows: codes.flatMap((code) => (rowsByCode.get(code) || []).map((row) => row.rowNumber)), reason: 'Multiple authoritative employees target the same physical workstation.' });
      }
      for (const [seatKey, vacancy] of vacantSeatTargets.entries()) {
        const codes = targetCodesBySeat.get(seatKey) || [];
        if (!codes.length) continue;
        blockers.push({
          type: 'DUPLICATE_WORKSTATION',
          seatId: seatKey,
          employeeCodes: codes,
          rows: [vacancy.row.rowNumber, ...codes.flatMap((code) => (rowsByCode.get(code) || []).map((row) => row.rowNumber))],
          includesVacancy: true,
          reason: 'The workbook marks a workstation both vacant and assigned.'
        });
      }
      const seatByEmployee = new Map<string, any>();
      for (const seat of seats) if (seat.employeeId) seatByEmployee.set(normalizeCode(employeesById.get(String(seat.employeeId))?.employeeCode), seat);
      const seatOperations: Array<Record<string, unknown>> = [];
      const blockedCodes = new Set(blockers.flatMap((blocker: any) => blocker.employeeCode ? [blocker.employeeCode] : blocker.employeeCodes || []));
      for (const [code, targetSeat] of targetSeatByCode.entries()) {
        if (!safeEmployeeCodes.has(code) || blockedCodes.has(code)) continue;
        const currentSeat = seatByEmployee.get(code);
        if (currentSeat?.id === targetSeat.id) continue;
        const targetOccupantRecord = targetSeat.employeeId ? employeesById.get(String(targetSeat.employeeId)) : null;
        const targetOccupant = targetOccupantRecord?.employeeCode ? normalizeCode(targetOccupantRecord.employeeCode) : null;
        const occupantTarget = targetOccupant ? targetSeatByCode.get(targetOccupant) : null;
        if (targetOccupant && (!occupantTarget || occupantTarget.id === targetSeat.id)) {
          blockers.push({ type: 'OCCUPIED_TARGET', employeeCode: code, workstation: targetSeat.label, currentOccupant: targetOccupant, rows: (rowsByCode.get(code) || []).map((row) => row.rowNumber) });
          blockedCodes.add(code);
          continue;
        }
        seatOperations.push({
          employeeCode: code,
          currentSeatId: currentSeat?.id || null,
          targetSeatId: targetSeat.id || null,
          targetWorkstationKey: targetSeat.plannedKey || `${targetSeat.floorId}|${normalize(targetSeat.label)}`,
          targetLabel: targetSeat.label,
          targetOccupantCode: targetOccupant,
          expectedTargetOccupantId: targetSeat.employeeId || null,
          action: currentSeat ? 'SEAT_MOVE' : 'SEAT_ASSIGNMENT',
          group: targetOccupant && occupantTarget ? 'SWAP_OR_CHAIN' : 'SIMPLE'
        });
      }
      for (const [seatKey, vacancy] of vacantSeatTargets.entries()) {
        if (targetCodesBySeat.has(seatKey)) continue;
        const seat = vacancy.seat;
        if (!seat.id || !seat.employeeId) continue;
        const occupant = employeesById.get(String(seat.employeeId));
        const occupantCode = normalizeCode(occupant?.employeeCode);
        if (occupant && pendingTransferEmployeeIds.has(String(occupant.id))) {
          blockers.push({
            type: 'STALE_RECORD',
            employeeCode: occupantCode,
            rows: [vacancy.row.rowNumber],
            field: 'Transfer',
            workstation: seat.label,
            reason: 'A pending transfer prevents the workbook vacancy from releasing this workstation.'
          });
          continue;
        }
        if (occupantCode && targetSeatByCode.has(occupantCode)) continue;
        seatOperations.push({
          employeeCode: occupantCode || null,
          currentSeatId: seat.id,
          targetSeatId: null,
          targetWorkstationKey: null,
          targetLabel: null,
          expectedTargetOccupantId: null,
          expectedCurrentOccupantId: seat.employeeId,
          action: 'SEAT_RELEASE',
          group: 'SIMPLE',
          groupId: 'SIMPLE',
          sourceRow: vacancy.row.rowNumber
        });
      }
      groupSeatOperations(seatOperations);
      const historicalRecords = [
        { type: 'TRANSFER_HISTORY', count: transfers.length },
        { type: 'AUDIT_HISTORY', count: auditLogs.length }
      ];
      const sourceEmployeeCodes = new Set(employeeRows.map((row) => normalizeCode(row.code)));
      const sourceWorkstationKeys = new Set(sourceWorkstationGroups.keys());
      const floorById = new Map(floors.map((floor: any) => [String(floor.id), floor]));
      const buildingById = new Map(buildings.map((building: any) => [String(building.id), building]));
      const unitById = new Map(units.map((unit: any) => [String(unit.id), unit]));
      const plantById = new Map(plants.map((plant: any) => [String(plant.id), plant]));
      const transferCounts = new Map<string, number>();
      for (const transfer of transfers) transferCounts.set(String(transfer.employeeId), (transferCounts.get(String(transfer.employeeId)) || 0) + 1);
      const auditCounts = new Map<string, number>();
      for (const audit of auditLogs) auditCounts.set(String(audit.entityId), (auditCounts.get(String(audit.entityId)) || 0) + 1);
      const extraRecords: Array<Record<string, unknown>> = [];
      for (const employee of employees) {
        if (sourceEmployeeCodes.has(normalizeCode(employee.employeeCode))) continue;
        const seat = seats.find((candidate: any) => String(candidate.employeeId || '') === String(employee.id));
        const decision = extraDecisionByEntity.get(`EMPLOYEE|${employee.id}`);
        const record = {
          entityType: 'EMPLOYEE',
          entityId: String(employee.id),
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          classification: decision?.decision || 'REQUIRES_MANUAL_INPUT',
          proposedAction: decision?.decision === 'ARCHIVED' ? 'ARCHIVE_EXTRA' : 'QUARANTINE_EXTRA',
          approvedDecisionId: decision?.id || null,
          explanation: decision?.explanation || null,
          dependencies: {
            transfers: transferCounts.get(String(employee.id)) || 0,
            auditLogs: auditCounts.get(String(employee.id)) || 0,
            activeSeatId: seat?.id || null
          },
          reason: 'Mongo employee is absent from the authoritative workbook. Absence alone does not prove that hard deletion is safe.'
        };
        extraRecords.push(record);
        if (!decision) blockers.push({ type: 'EXTRA_MONGO_RECORD', ...record, rows: [] });
      }
      for (const seat of seats) {
        const floor = floorById.get(String(seat.floorId)) as any;
        const building = floor ? buildingById.get(String(floor.buildingId)) as any : null;
        const plant = building?.plantId ? plantById.get(String(building.plantId)) as any : null;
        const unit = building?.unitId ? unitById.get(String(building.unitId)) as any : plant?.unitId ? unitById.get(String(plant.unitId)) as any : null;
        const key = unit && building && floor
          ? [unit.name, building.name, floor.name, seatAreaName(seat), seat.label].map(normalize).join('|')
          : '';
        if (key && sourceWorkstationKeys.has(key)) continue;
        const decision = extraDecisionByEntity.get(`WORKSTATION|${seat.id}`);
        const record = {
          entityType: 'WORKSTATION',
          entityId: String(seat.id),
          workstation: seat.label,
          workstationKey: key || null,
          classification: decision?.decision || 'REQUIRES_MANUAL_INPUT',
          proposedAction: decision?.decision === 'ARCHIVED' ? 'ARCHIVE_EXTRA' : 'QUARANTINE_EXTRA',
          approvedDecisionId: decision?.id || null,
          explanation: decision?.explanation || null,
          dependencies: {
            employeeId: seat.employeeId || null,
            auditLogs: auditCounts.get(String(seat.id)) || 0,
            floorId: seat.floorId
          },
          reason: 'Mongo workstation is absent from the authoritative workbook or cannot be mapped to a complete operational hierarchy.'
        };
        extraRecords.push(record);
        if (!decision) blockers.push({ type: 'EXTRA_MONGO_RECORD', ...record, rows: [] });
      }
      const blockedRowNumbers = new Set<number>(blockers.flatMap((blocker: any) => Array.isArray(blocker.rows) ? blocker.rows : []));
      const uniqueNames = (items: any[], selector: (item: any) => unknown) => [...new Set(items.map(selector).map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const availableChoices: Record<string, string[]> = {
        Unit: uniqueNames(units, (item) => item.name),
        Building: uniqueNames(buildings, (item) => item.name),
        Floor: uniqueNames(floors, (item) => item.name || item.floorNumber),
        'Office / Area': uniqueNames(areas, (item) => item.name),
        Department: uniqueNames(departments, (item) => item.name),
        Section: uniqueNames(sections, (item) => item.name),
        Function: uniqueNames(functions, (item) => item.name),
        Workstation: uniqueNames(seats, (item) => item.label),
        Status: ['Active', 'InActive']
      };
      const manualBlockers = blockers.map((blocker: any) => {
        const excelRows = Array.isArray(blocker.rows) ? blocker.rows : [];
        const sourceRow = parsed.rows.find((row) => excelRows.includes(row.rowNumber));
        const problemField = blocker.field || (blocker.type === 'DUPLICATE_EMPLOYEE_ID' ? 'Emp Code' : blocker.type === 'DUPLICATE_WORKSTATION' ? 'WS NO' : 'Record');
        return {
          ...blocker,
          sheet: 'Sheet1',
          excelRows,
          employeeId: blocker.employeeCode || sourceRow?.code || null,
          employeeName: sourceRow?.name || null,
          problemField,
          currentSourceValue: blocker.value ?? (sourceRow && overrideField(problemField) ? (sourceRow as any)[overrideField(problemField)!] : null),
          availableValidChoices: availableChoices[problemField] || [],
          requiredManualInput: blocker.type === 'DUPLICATE_EMPLOYEE_ID' || blocker.type === 'DUPLICATE_WORKSTATION'
            ? 'Resolve every conflicting Excel row explicitly; no row is selected automatically.'
            : 'Choose an exact valid value and provide an approval explanation.'
        };
      });
      const plan: AuthoritativeImportPlan = {
        runId: state.id,
        sourceFilename: path.basename(filePath),
        sourceHash: parsed.hash,
        sheet: 'Sheet1',
        generatedAt: new Date().toISOString(),
        source: parsed.source,
        counts: {
          employeesToCreate: employeesPlan.filter((item) => item.action === 'CREATE').length,
          employeesToUpdate: employeesPlan.filter((item) => item.action === 'UPDATE').length,
          employeesToArchive: extraRecords.filter((item: any) => item.entityType === 'EMPLOYEE' && item.classification !== 'REQUIRES_MANUAL_INPUT').length,
          workstationsToCreate: workstationPlan.filter((item) => item.action === 'CREATE').length,
          workstationsToUpdate: workstationPlan.filter((item) => item.action === 'UPDATE_AREA').length,
          workstationsToArchive: extraRecords.filter((item: any) => item.entityType === 'WORKSTATION' && item.classification !== 'REQUIRES_MANUAL_INPUT').length,
          seatAssignments: seatOperations.filter((item) => item.action === 'SEAT_ASSIGNMENT').length,
          seatReleases: seatOperations.filter((item) => item.action === 'SEAT_RELEASE').length,
          seatMoves: seatOperations.filter((item) => item.action === 'SEAT_MOVE').length,
          seatSwaps: new Set(seatOperations.filter((item) => item.group === 'SWAP_OR_CHAIN').map((item) => item.groupId)).size,
          hierarchyAdditions: hierarchyAdditions.length,
          blockedRows: blockedRowNumbers.size,
          manualDetailsRequired: manualBlockers.length,
          historicalRecordsPreserved: transfers.length + auditLogs.length,
          extraRecordsRequiringDecision: extraRecords.filter((item: any) => item.classification === 'REQUIRES_MANUAL_INPUT').length
        },
        employees: employeesPlan,
        workstations: workstationPlan,
        workstationVerification: [...workstationVerificationByKey.values()],
        seatOperations,
        hierarchyAdditions,
        blockers: manualBlockers,
        extraRecords,
        historicalRecords
      };
      const planStatus: InitialImportStatus = plan.counts.blockedRows || plan.counts.manualDetailsRequired
        ? 'AWAITING_MANUAL_COMPLETION'
        : 'READY_TO_APPLY';
      await this.saveState(prisma, { status: planStatus, sourceFilename: plan.sourceFilename, sourceHash: plan.sourceHash, startedById: adminId, startedAt: new Date(), manifest: plan, processedRows: parsed.rows.length, successfulRows: employeesPlan.length, blockedRows: plan.counts.blockedRows, failedRows: 0, error: null }, state.id);
      return plan;
    } catch (error: any) {
      await this.saveState(prisma, { status: 'FAILED_RECOVERABLE', error: { message: error.message || 'Validation failed' } }, state.id);
      throw error;
    }
  }

  public async applyPlan(prisma: PrismaClient, admin: any, request: any, runId: string, sourceHash: string, confirmation: string) {
    if (!isInitialImportApplyEnabled()) throw Object.assign(new Error('Live authoritative migration apply is disabled until the owner approval gate is enabled.'), { statusCode: 403, code: 'INITIAL_IMPORT_APPLY_DISABLED' });
    if (confirmation !== 'APPLY_AUTHORITATIVE_WORKBOOK') throw Object.assign(new Error('Explicit authoritative workbook confirmation is required.'), { statusCode: 400, code: 'INITIAL_IMPORT_CONFIRMATION_REQUIRED' });
    const state = await this.getState(prisma);
    if (!state || state.id !== runId || state.sourceHash !== sourceHash) throw Object.assign(new Error('Migration plan is missing or stale.'), { statusCode: 409, code: 'INITIAL_IMPORT_STALE' });
    if (state.status === 'COMPLETED') throw Object.assign(new Error('Initial authoritative import is already completed.'), { statusCode: 409, code: 'INITIAL_IMPORT_COMPLETED' });
    if (state.status !== 'READY_TO_APPLY') throw Object.assign(new Error(`Migration is not ready to apply. Current status: ${state.status}`), { statusCode: 409, code: 'INITIAL_IMPORT_NOT_READY' });
    const currentSource = parseAuthoritativeWorkbook(sourceFile(authoritativeExcelPath()));
    if (currentSource.hash !== sourceHash) {
      throw Object.assign(new Error('The authoritative workbook changed after planning. Generate and approve a new plan.'), { statusCode: 409, code: 'AUTHORITATIVE_SOURCE_CHANGED' });
    }
    await this.saveState(prisma, { status: 'APPLYING' }, state.id);
    const plan = state.manifest as AuthoritativeImportPlan;
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        let applied = 0;
        const plannedSeatIds = new Map<string, string>();
        const resolvedHierarchyIds = new Map<string, string>();
        const plannedEmployeeCodes = new Set((plan.employees || []).map((item: any) => normalizeCode(item?.desired?.employeeCode)).filter(Boolean));
        const resolveHierarchyId = (value: unknown) => {
          const key = String(value || '');
          return key.startsWith('PLAN:') ? resolvedHierarchyIds.get(key) || null : key || null;
        };
        const hierarchyOrder: Record<string, number> = { UNIT: 1, BUILDING: 2, FLOOR: 3, AREA: 4, DEPARTMENT: 5, SECTION: 6, FUNCTION: 7 };
        const hierarchyItems = [...(plan.hierarchyAdditions || [])].sort((a: any, b: any) => (hierarchyOrder[a.entityType] || 99) - (hierarchyOrder[b.entityType] || 99)) as any[];
        for (const item of hierarchyItems) {
          let created: any;
          if (item.entityType === 'UNIT') {
            const stale = await tx.unit.findFirst({ where: { OR: [{ name: item.name }, { code: item.code }] } });
            if (stale) throw Object.assign(new Error(`Unit ${item.name} appeared after planning.`), { code: 'STALE_RECORD' });
            created = await tx.unit.create({ data: { name: item.name, code: item.code } });
          } else if (item.entityType === 'BUILDING') {
            const unitId = resolveHierarchyId(item.unitId);
            if (!unitId) throw Object.assign(new Error(`Building ${item.name} has an unresolved Unit.`), { code: 'INVALID_HIERARCHY_PLAN' });
            const stale = await tx.building.findFirst({ where: { unitId, code: item.code } });
            if (stale) throw Object.assign(new Error(`Building ${item.name} appeared after planning.`), { code: 'STALE_RECORD' });
            created = await tx.building.create({ data: { name: item.name, code: item.code, unitId } });
          } else if (item.entityType === 'FLOOR') {
            const buildingId = resolveHierarchyId(item.buildingId);
            if (!buildingId) throw Object.assign(new Error(`Floor ${item.name} has an unresolved Building.`), { code: 'INVALID_HIERARCHY_PLAN' });
            created = await tx.floor.create({ data: { name: item.name, floorNumber: item.floorNumber, buildingId } });
          } else if (item.entityType === 'AREA') {
            const floorId = resolveHierarchyId(item.floorId);
            if (!floorId) throw Object.assign(new Error(`Area ${item.name} has an unresolved Floor.`), { code: 'INVALID_HIERARCHY_PLAN' });
            created = await tx.area.create({ data: { name: item.name, normalizedName: item.normalizedName, floorId } });
          } else if (item.entityType === 'DEPARTMENT') {
            const unitId = resolveHierarchyId(item.unitId);
            if (!unitId) throw Object.assign(new Error(`Department ${item.name} has an unresolved Unit.`), { code: 'INVALID_HIERARCHY_PLAN' });
            created = await tx.department.create({ data: { name: item.name, code: item.code, unitId } });
          } else if (item.entityType === 'SECTION') {
            const departmentId = resolveHierarchyId(item.departmentId);
            if (!departmentId) throw Object.assign(new Error(`Section ${item.name} has an unresolved Department.`), { code: 'INVALID_HIERARCHY_PLAN' });
            created = await tx.section.create({ data: { name: item.name, normalizedName: item.normalizedName, departmentId } });
          } else if (item.entityType === 'FUNCTION') {
            const sectionId = resolveHierarchyId(item.sectionId);
            if (!sectionId) throw Object.assign(new Error(`Function ${item.name} has an unresolved Section.`), { code: 'INVALID_HIERARCHY_PLAN' });
            created = await tx.orgFunction.create({ data: { name: item.name, normalizedName: item.normalizedName, sectionId } });
          } else {
            throw Object.assign(new Error(`Unsupported hierarchy addition ${item.entityType}.`), { code: 'INVALID_HIERARCHY_PLAN' });
          }
          resolvedHierarchyIds.set(item.plannedId, String(created.id));
          await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_HIERARCHY_CREATED', item.entityType, String(created.id), { migrationRunId: runId, sourceHash, sourceRows: item.sourceRows, name: item.name, adminId: admin.id });
          applied++;
        }
        const employeeItems = plan.employees.filter((item: any) => item.action === 'CREATE' || item.action === 'UPDATE') as any[];

        for (const item of employeeItems) {
          const desired = item.desired;
          const existing = item.action === 'UPDATE'
            ? await tx.employee.findUnique({ where: { id: item.employeeId } })
            : await tx.employee.findUnique({ where: { employeeCode: desired.employeeCode } });
          if (item.action === 'CREATE' && existing) throw Object.assign(new Error(`Employee ${desired.employeeCode} already exists.`), { code: 'STALE_RECORD' });
          const existingUpdatedAt = existing?.updatedAt instanceof Date ? existing.updatedAt.toISOString() : existing?.updatedAt == null ? null : String(existing.updatedAt);
          if (item.action === 'UPDATE' && (!existing || (item.expected?.updatedAt && existingUpdatedAt !== String(item.expected.updatedAt)))) {
            throw Object.assign(new Error(`Employee ${desired.employeeCode} changed after the migration plan was generated.`), { code: 'STALE_RECORD' });
          }
          const data: any = {
            fullName: desired.fullName,
            departmentId: resolveHierarchyId(desired.departmentId),
            officeArea: desired.officeArea,
            reportingTo: desired.reportingTo,
            hod: desired.hod,
            isActive: desired.isActive,
            sectionId: resolveHierarchyId(desired.sectionId),
            functionId: resolveHierarchyId(desired.functionId)
          };
          const employee = item.action === 'CREATE'
            ? await tx.employee.create({ data: { ...data, employeeCode: desired.employeeCode, email: null } })
            : await tx.employee.update({ where: { id: item.employeeId }, data });
          await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_EMPLOYEE_CORRECTED', 'Employee', String(employee.id), { migrationRunId: runId, sourceHash, employeeCode: desired.employeeCode, changes: item.changes, adminId: admin.id });
          applied++;
        }

        for (const item of plan.workstations as any[]) {
          if (item.action === 'CREATE') {
            const floorId = resolveHierarchyId(item.floorId);
            const areaId = resolveHierarchyId(item.areaId);
            const departmentId = resolveHierarchyId(item.departmentId);
            if (!floorId || !areaId) throw Object.assign(new Error(`Workstation ${item.label} has unresolved hierarchy.`), { code: 'INVALID_HIERARCHY_PLAN' });
            const floorSeats = await tx.seat.findMany({ where: { floorId }, select: { id: true, label: true } });
            const existing = floorSeats.find((seat: any) => normalize(seat.label) === normalize(item.label));
            if (existing) throw Object.assign(new Error(`Workstation ${item.label} was created after planning.`), { code: 'STALE_RECORD' });
            const created = await tx.seat.create({
              data: {
                label: item.label,
                floorId,
                x: 0,
                y: 0,
                placementSource: null,
                status: 'AVAILABLE',
                areaId,
                officeArea: item.officeArea,
                ...(departmentId ? { departmentId } : {})
              }
            });
            plannedSeatIds.set(item.plannedKey, created.id);
            await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_WORKSTATION_CREATED', 'Seat', String(created.id), { migrationRunId: runId, sourceHash, row: item.row, label: item.label, floorId, placementSource: null, adminId: admin.id });
          } else {
            const seat = await tx.seat.findUnique({ where: { id: item.seatId } });
            if (!seat || (item.expectedAreaId && seat.areaId !== item.expectedAreaId) || (!item.expectedAreaId && (seat.officeArea || null) !== (item.expectedOfficeArea || null))) {
              throw Object.assign(new Error(`Workstation ${item.seatId} changed after planning.`), { code: 'STALE_RECORD' });
            }
            await tx.seat.update({ where: { id: item.seatId }, data: { areaId: resolveHierarchyId(item.areaId), officeArea: item.after } });
            await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_WORKSTATION_CORRECTED', 'Seat', String(item.seatId), { migrationRunId: runId, sourceHash, row: item.row, before: item.before, after: item.after, adminId: admin.id });
          }
          applied++;
        }

        const operations = (plan.seatOperations as any[]).map((operation) => ({
          ...operation,
          resolvedTargetSeatId: operation.targetSeatId || (operation.targetWorkstationKey ? plannedSeatIds.get(operation.targetWorkstationKey) : null)
        }));
        const targetIds = operations.filter((operation) => operation.action !== 'SEAT_RELEASE').map((operation) => operation.resolvedTargetSeatId);
        if (targetIds.some((id) => !id) || new Set(targetIds).size !== targetIds.length) {
          throw Object.assign(new Error('The final migration seat graph contains a missing or duplicate target workstation.'), { code: 'INVALID_SEAT_GRAPH' });
        }

        const movingEmployeeIds = new Set<string>();
        for (const operation of operations) {
          if (operation.action === 'SEAT_RELEASE') continue;
          const employee = await tx.employee.findUnique({ where: { employeeCode: operation.employeeCode } });
          if (!employee) throw Object.assign(new Error(`Employee ${operation.employeeCode} disappeared after planning.`), { code: 'STALE_RECORD' });
          operation.resolvedEmployeeId = employee.id;
          movingEmployeeIds.add(employee.id);
        }

        for (const operation of operations) {
          if (operation.currentSeatId) {
            const currentSeat = await tx.seat.findUnique({ where: { id: operation.currentSeatId } });
            const expectedEmployeeId = operation.action === 'SEAT_RELEASE' ? operation.expectedCurrentOccupantId : operation.resolvedEmployeeId;
            if (!currentSeat || currentSeat.employeeId !== expectedEmployeeId) {
              throw Object.assign(new Error(`Current workstation changed for ${operation.employeeCode || operation.currentSeatId}.`), { code: 'STALE_RECORD' });
            }
          }
          if (operation.action === 'SEAT_RELEASE') continue;
          const targetSeat = await tx.seat.findUnique({ where: { id: operation.resolvedTargetSeatId } });
          if (!targetSeat) throw Object.assign(new Error(`Migration target disappeared for ${operation.employeeCode}.`), { code: 'STALE_RECORD' });
          if (targetSeat.employeeId && !movingEmployeeIds.has(targetSeat.employeeId)) {
            throw Object.assign(new Error(`Target workstation ${operation.targetLabel} became occupied outside the migration graph.`), { code: 'STALE_RECORD' });
          }
        }

        const seatsToClear = new Set(operations.map((operation) => operation.currentSeatId).filter(Boolean));
        for (const seatId of seatsToClear) {
          await tx.seat.update({ where: { id: seatId }, data: { employeeId: { unset: true }, status: 'AVAILABLE' } });
        }
        for (const operation of operations) {
          if (operation.action === 'SEAT_RELEASE') {
            await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_SEAT_RELEASED', 'Seat', String(operation.currentSeatId), { migrationRunId: runId, sourceHash, employeeCode: operation.employeeCode, sourceRow: operation.sourceRow, adminId: admin.id });
          } else {
            await tx.seat.update({ where: { id: operation.resolvedTargetSeatId }, data: { employeeId: operation.resolvedEmployeeId, status: 'AVAILABLE' } });
            await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_SEAT_CORRECTED', 'Seat', String(operation.resolvedTargetSeatId), { migrationRunId: runId, sourceHash, employeeCode: operation.employeeCode, beforeSeatId: operation.currentSeatId, afterSeatId: operation.resolvedTargetSeatId, adminId: admin.id });
          }
          applied++;
        }

        for (const item of (plan.extraRecords || []) as any[]) {
          if (!['QUARANTINED', 'ARCHIVED'].includes(item.classification)) continue;
          const data = {
            operationalState: item.classification,
            archivedAt: new Date(),
            archiveReason: item.explanation,
            archivedByRunId: runId
          };
          if (item.entityType === 'EMPLOYEE') {
            const existing = await tx.employee.findUnique({ where: { id: item.entityId } });
            if (!existing || plannedEmployeeCodes.has(normalizeCode(existing.employeeCode))) {
              throw Object.assign(new Error(`Extra employee ${item.entityId} changed after planning.`), { code: 'STALE_RECORD' });
            }
            await tx.employee.update({ where: { id: item.entityId }, data });
          } else if (item.entityType === 'WORKSTATION') {
            const existing = await tx.seat.findUnique({ where: { id: item.entityId } });
            if (!existing) throw Object.assign(new Error(`Extra workstation ${item.entityId} changed after planning.`), { code: 'STALE_RECORD' });
            await tx.seat.update({ where: { id: item.entityId }, data });
          }
          await logAudit(tx, request, 'AUTHORITATIVE_EXTRA_RECORD_ARCHIVED', item.entityType, item.entityId, {
            migrationRunId: runId,
            sourceHash,
            operationalState: item.classification,
            reason: item.explanation,
            dependencies: item.dependencies,
            adminId: admin.id
          });
          applied++;
        }

        await tx.initialImportRun.update({ where: { id: state.id }, data: { status: 'VERIFYING' } });
        const verificationErrors: Array<Record<string, unknown>> = [];
        for (const item of plan.employees as any[]) {
          if (item.action === 'NO_CHANGE' || item.action === 'CREATE' || item.action === 'UPDATE') {
            const employee = await tx.employee.findUnique({ where: { employeeCode: item.desired.employeeCode } });
            if (!employee
              || normalize(employee.fullName) !== normalize(item.desired.fullName)
              || employee.departmentId !== resolveHierarchyId(item.desired.departmentId)
              || (employee.sectionId || null) !== resolveHierarchyId(item.desired.sectionId)
              || (employee.functionId || null) !== resolveHierarchyId(item.desired.functionId)
              || normalize(employee.officeArea) !== normalize(item.desired.officeArea)
              || normalize(employee.reportingTo) !== normalize(item.desired.reportingTo)
              || normalize(employee.hod) !== normalize(item.desired.hod)
              || employee.isActive !== item.desired.isActive) {
              verificationErrors.push({ type: 'EMPLOYEE_VERIFICATION_FAILED', employeeCode: item.desired.employeeCode });
            }
          }
        }
        for (const item of plan.workstationVerification || []) {
          const seatId = item.seatId || plannedSeatIds.get(String(item.plannedKey));
          const seat = seatId ? await tx.seat.findUnique({ where: { id: seatId } }) : null;
          if (!seat || normalize(seat.label) !== normalize(item.label) || seat.floorId !== resolveHierarchyId(item.floorId) || (seat.areaId || null) !== resolveHierarchyId(item.areaId)) {
            verificationErrors.push({ type: 'WORKSTATION_VERIFICATION_FAILED', workstation: item.label, rows: item.sourceRows });
          }
        }
        for (const operation of operations) {
          const seatId = operation.action === 'SEAT_RELEASE' ? operation.currentSeatId : operation.resolvedTargetSeatId;
          const seat = await tx.seat.findUnique({ where: { id: seatId } });
          const expectedEmployeeId = operation.action === 'SEAT_RELEASE' ? null : operation.resolvedEmployeeId;
          if (!seat || (seat.employeeId || null) !== expectedEmployeeId) {
            verificationErrors.push({ type: 'SEAT_VERIFICATION_FAILED', seatId, employeeCode: operation.employeeCode || null });
          }
        }
        for (const item of (plan.extraRecords || []) as any[]) {
          if (!['QUARANTINED', 'ARCHIVED'].includes(item.classification)) continue;
          const record = item.entityType === 'EMPLOYEE'
            ? await tx.employee.findUnique({ where: { id: item.entityId }, select: { operationalState: true } })
            : await tx.seat.findUnique({ where: { id: item.entityId }, select: { operationalState: true } });
          if (!record || record.operationalState !== item.classification) {
            verificationErrors.push({ type: 'EXTRA_RECORD_VERIFICATION_FAILED', entityType: item.entityType, entityId: item.entityId });
          }
        }
        const assignedSeats = await tx.seat.findMany({ where: { employeeId: { isSet: true } }, select: { id: true, employeeId: true } });
        const assignmentCounts = new Map<string, number>();
        for (const seat of assignedSeats) if (seat.employeeId) assignmentCounts.set(seat.employeeId, (assignmentCounts.get(seat.employeeId) || 0) + 1);
        for (const [employeeId, count] of assignmentCounts.entries()) {
          if (count > 1) verificationErrors.push({ type: 'DUPLICATE_ACTIVE_ASSIGNMENT', employeeId, count });
        }
        if (verificationErrors.length) {
          throw Object.assign(new Error('Post-apply verification failed; the transaction was rolled back.'), { code: 'POST_APPLY_VERIFICATION_FAILED', verificationErrors });
        }

        const completedAt = new Date();
        const verification = {
          verifiedEmployees: plan.source.uniqueEmployeeIds,
          verifiedWorkstations: plan.workstationVerification?.length || 0,
          appliedOperations: applied,
          blockedRows: 0,
          duplicateAssignments: 0,
          completedAt
        };
        await tx.initialImportRun.update({
          where: { id: state.id },
          data: { status: 'COMPLETED', completedAt, successfulRows: plan.source.validEmployeeRows, blockedRows: 0, failedRows: 0, verification, error: null }
        });
        await logAudit(tx, request, 'AUTHORITATIVE_INITIAL_IMPORT_COMPLETED', 'InitialImportRun', String(state.id), { migrationRunId: runId, sourceHash, verification, adminId: admin.id });
        return { runId, sourceHash, applied, blocked: 0, status: 'COMPLETED', verification };
      }, { maxWait: 10_000, timeout: 120_000 });
      return result;
    } catch (error: any) {
      await this.saveState(prisma, { status: 'FAILED_RECOVERABLE', error: { message: error.message || 'Apply failed', code: error.code || null, verificationErrors: error.verificationErrors || [] } }, state.id);
      throw error;
    }
  }
}

export const authoritativeImportService = new AuthoritativeImportService();
