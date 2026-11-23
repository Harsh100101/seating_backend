import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  CreateEmployeeRequestSchema,
  UpdateEmployeeRequestSchema,
  EmployeeCsvRowSchema,
  type Employee,
  type CreateEmployeeRequest,
  type UpdateEmployeeRequest,
  type EmployeeListQuery
} from '@seating/shared';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_PATH = path.resolve(__dirname, '../prisma/schema.prisma');
const enabled = process.env.RUN_REAL_PRISMA_EMPLOYEE_MATRIX === '1' && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('Empirical Challenger: Milestone 1 Interface Conformance & Backward Compatibility', () => {
  let prisma: PrismaClient;
  let testDepartmentId: string;
  const createdEmployeeIds: string[] = [];

  beforeAll(async () => {
    await verifyDisposableTestDatabase(process.env.TEST_DATABASE_URL);
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    await prisma.$connect();
    const dept = await prisma.department.findFirst();
    if (!dept) {
      const created = await prisma.department.create({
        data: {
          name: 'QA Challenger Dept',
          code: 'QAC',
          colorHex: '#10B981'
        }
      });
      testDepartmentId = created.id;
    } else {
      testDepartmentId = dept.id;
    }
  });

  afterAll(async () => {
    if (createdEmployeeIds.length > 0) {
      await prisma.employee.deleteMany({
        where: { id: { in: createdEmployeeIds } }
      });
    }
    await prisma.$disconnect();
  });

  describe('1. Schema AST & Interface Conformance', () => {
    it('verifies Employee model contains all R1 fields with appropriate @map decorators', () => {
      const content = fs.readFileSync(SCHEMA_PATH, 'utf-8');
      const empModelMatch = content.match(/model Employee\s*\{([\s\S]*?)\n\}/);
      expect(empModelMatch).not.toBeNull();
      const empBody = empModelMatch![1];

      // R1 fields
      expect(empBody).toMatch(/ext\s+String\?\s+@map\("ext"\)/);
      expect(empBody).toMatch(/section\s+String\?/);
      expect(empBody).toMatch(/functionName\s+String\?\s+@map\("function_name"\)/);
      expect(empBody).toMatch(/grade\s+String\?/);
      expect(empBody).toMatch(/reportingManager\s+String\?\s+@map\("reporting_manager"\)/);
      expect(empBody).toMatch(/hod\s+String\?/);

      // Backward compatibility & spatial fields
      expect(empBody).toMatch(/reportingTo\s+String\?\s+@map\("reporting_to"\)/);
      expect(empBody).toMatch(/officeArea\s+String\?\s+@map\("office_area"\)/);
    });
  });

  describe('2. @seating/shared Type and Zod Schema Conformance', () => {
    it('validates CreateEmployeeRequestSchema with enterprise matrix fields', () => {
      const validPayload = {
        employeeCode: 'EMP-CHALLENGE-01',
        fullName: 'Jane Matrix Challenger',
        email: 'jane.matrix@example.com',
        departmentId: testDepartmentId,
        ext: '1234',
        section: 'Quality Assurance',
        functionName: 'Operations',
        grade: 'M2',
        reportingManager: 'Alice Director',
        reportingTo: 'Alice Director',
        hod: 'Bob VP',
        officeArea: 'Plant 1 Admin Wing'
      };

      const parsed = CreateEmployeeRequestSchema.parse(validPayload);
      expect(parsed.ext).toBe('1234');
      expect(parsed.section).toBe('Quality Assurance');
      expect(parsed.functionName).toBe('Operations');
      expect(parsed.grade).toBe('M2');
      expect(parsed.reportingManager).toBe('Alice Director');
      expect(parsed.reportingTo).toBe('Alice Director');
      expect(parsed.hod).toBe('Bob VP');
      expect(parsed.officeArea).toBe('Plant 1 Admin Wing');
    });

    it('validates CreateEmployeeRequestSchema allows legacy payload specifying only reportingTo', () => {
      const legacyPayload = {
        employeeCode: 'EMP-CHALLENGE-02',
        fullName: 'Legacy Employee',
        departmentId: testDepartmentId,
        reportingTo: 'Legacy Manager'
      };

      const parsed = CreateEmployeeRequestSchema.parse(legacyPayload);
      expect(parsed.reportingTo).toBe('Legacy Manager');
      expect(parsed.reportingManager).toBeUndefined();
    });

    it('validates UpdateEmployeeRequestSchema supports nullifying matrix fields', () => {
      const updatePayload = {
        ext: null,
        section: null,
        functionName: null,
        reportingManager: null,
        reportingTo: null,
        officeArea: null
      };

      const parsed = UpdateEmployeeRequestSchema.parse(updatePayload);
      expect(parsed.ext).toBeNull();
      expect(parsed.section).toBeNull();
      expect(parsed.reportingManager).toBeNull();
      expect(parsed.reportingTo).toBeNull();
      expect(parsed.officeArea).toBeNull();
    });

    it('validates EmployeeCsvRowSchema accepts matrix fields', () => {
      const csvRow = {
        employeeCode: 'CSV-EMP-01',
        fullName: 'CSV Imported Employee',
        departmentCode: 'ENG',
        ext: '4455',
        section: 'Powder Coating Cell',
        functionName: 'Finishing',
        grade: 'L3',
        reportingManager: 'Mr. Foreman',
        hod: 'Mr. Chief',
        officeArea: 'Powder Coating Office'
      };

      const parsed = EmployeeCsvRowSchema.parse(csvRow);
      expect(parsed.ext).toBe('4455');
      expect(parsed.section).toBe('Powder Coating Cell');
      expect(parsed.functionName).toBe('Finishing');
      expect(parsed.reportingManager).toBe('Mr. Foreman');
      expect(parsed.officeArea).toBe('Powder Coating Office');
    });

    it('enforces string length constraints on matrix fields in CreateEmployeeRequestSchema', () => {
      // ext max 30
      expect(() => {
        CreateEmployeeRequestSchema.parse({
          employeeCode: 'OVER-EXT',
          fullName: 'Over Ext',
          departmentId: testDepartmentId,
          ext: 'A'.repeat(31)
        });
      }).toThrow();

      // reportingManager max 100
      expect(() => {
        CreateEmployeeRequestSchema.parse({
          employeeCode: 'OVER-MGR',
          fullName: 'Over Mgr',
          departmentId: testDepartmentId,
          reportingManager: 'B'.repeat(101)
        });
      }).toThrow();

      // officeArea max 100
      expect(() => {
        CreateEmployeeRequestSchema.parse({
          employeeCode: 'OVER-AREA',
          fullName: 'Over Area',
          departmentId: testDepartmentId,
          officeArea: 'C'.repeat(101)
        });
      }).toThrow();
    });

    it('trims leading/trailing whitespace on matrix fields', () => {
      const parsed = CreateEmployeeRequestSchema.parse({
        employeeCode: 'TRIM-01',
        fullName: 'Trim Employee',
        departmentId: testDepartmentId,
        ext: '  x204  ',
        reportingManager: '  Pankaj Upadhyay  ',
        officeArea: '  Admin IT office  '
      });
      expect(parsed.ext).toBe('x204');
      expect(parsed.reportingManager).toBe('Pankaj Upadhyay');
      expect(parsed.officeArea).toBe('Admin IT office');
    });

    it('enforces TypeScript type shapes for compile-time safety', () => {
      const emp: Employee = {
        id: 'mock-id',
        employeeCode: 'CODE-01',
        fullName: 'Type Safety Test',
        departmentId: testDepartmentId,
        ext: '9000',
        section: 'Section A',
        functionName: 'Function B',
        grade: 'G1',
        reportingManager: 'Manager One',
        reportingTo: 'Manager One',
        hod: 'HOD One',
        officeArea: 'Area 1',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        seat: {
          id: 'seat-1',
          label: 'WS-01',
          officeArea: 'Area 1',
          floor: { id: 'fl-1', name: 'Floor 1', number: 1, buildingId: 'b-1' }
        }
      };

      const query: EmployeeListQuery = {
        officeArea: 'Area 1',
        section: 'Section A',
        reportingManager: 'Manager One'
      };

      expect(emp.ext).toBe('9000');
      expect(emp.seat?.officeArea).toBe('Area 1');
      expect(query.officeArea).toBe('Area 1');
    });
  });

  describe('3. Database Live CRUD & Backward Compatibility', () => {
    it('creates an employee with all R1 matrix fields and verifies persistence', async () => {
      const code = `TEST-M1-${Date.now()}`;
      const created = await prisma.employee.create({
        data: {
          employeeCode: code,
          fullName: 'Live DB Matrix Employee',
          email: `${code.toLowerCase()}@example.com`,
          departmentId: testDepartmentId,
          ext: '7890',
          section: 'Precision Fabrication',
          functionName: 'Machining',
          grade: 'M1-Pro',
          reportingManager: 'Master Foreman',
          reportingTo: 'Master Foreman',
          hod: 'Plant Director',
          officeArea: 'Plant 1 Admin Wing'
        }
      });

      createdEmployeeIds.push(created.id);

      expect(created.id).toBeDefined();
      expect(created.ext).toBe('7890');
      expect(created.section).toBe('Precision Fabrication');
      expect(created.functionName).toBe('Machining');
      expect(created.grade).toBe('M1-Pro');
      expect(created.reportingManager).toBe('Master Foreman');
      expect(created.reportingTo).toBe('Master Foreman');
      expect(created.hod).toBe('Plant Director');
      expect(created.officeArea).toBe('Plant 1 Admin Wing');

      // Fetch back from DB to verify persistence
      const fetched = await prisma.employee.findUnique({
        where: { id: created.id }
      });

      expect(fetched?.ext).toBe('7890');
      expect(fetched?.section).toBe('Precision Fabrication');
      expect(fetched?.reportingManager).toBe('Master Foreman');
      expect(fetched?.reportingTo).toBe('Master Foreman');
    });

    it('supports backward-compatible query by reportingTo alone', async () => {
      const code = `TEST-LEGACY-${Date.now()}`;
      const created = await prisma.employee.create({
        data: {
          employeeCode: code,
          fullName: 'Legacy Query Employee',
          email: `${code.toLowerCase()}@example.com`,
          departmentId: testDepartmentId,
          reportingTo: 'Legacy Boss Unique',
          reportingManager: 'Legacy Boss Unique'
        }
      });

      createdEmployeeIds.push(created.id);

      // Query by legacy reportingTo
      const foundByLegacy = await prisma.employee.findFirst({
        where: { reportingTo: 'Legacy Boss Unique' }
      });

      expect(foundByLegacy).not.toBeNull();
      expect(foundByLegacy?.id).toBe(created.id);
      expect(foundByLegacy?.reportingTo).toBe('Legacy Boss Unique');

      // Query by new reportingManager
      const foundByNew = await prisma.employee.findFirst({
        where: { reportingManager: 'Legacy Boss Unique' }
      });

      expect(foundByNew).not.toBeNull();
      expect(foundByNew?.id).toBe(created.id);
      expect(foundByNew?.reportingManager).toBe('Legacy Boss Unique');
    });
  });
});
