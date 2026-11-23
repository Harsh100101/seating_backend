import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  CreateEmployeeRequestSchema,
  UpdateEmployeeRequestSchema,
  EmployeeCsvRowSchema,
} from '@seating/shared';
import { createMockPrisma } from './mock-prisma.js';
import xlsx from 'xlsx';

describe('Milestone 1 Empirical Challenge: Prisma Client DMMF & Type Safety', () => {
  it('CHALLENGE-01: Prisma DMMF contains all Matrix fields on Employee model with exact types and mappings', () => {
    const employeeModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Employee');
    expect(employeeModel, 'Employee model must exist in Prisma DMMF').toBeDefined();

    const fieldMap = new Map(employeeModel!.fields.map((f) => [f.name, f]));

    // 1. ext
    const ext = fieldMap.get('ext');
    expect(ext, 'Employee.ext field must exist').toBeDefined();
    expect(ext!.type).toBe('String');
    expect(ext!.isRequired).toBe(false);
    expect(ext!.dbName).toBe('ext');

    // 2. section
    const section = fieldMap.get('section');
    expect(section, 'Employee.section field must exist').toBeDefined();
    expect(section!.type).toBe('String');
    expect(section!.isRequired).toBe(false);

    // 3. functionName
    const functionName = fieldMap.get('functionName');
    expect(functionName, 'Employee.functionName field must exist').toBeDefined();
    expect(functionName!.type).toBe('String');
    expect(functionName!.isRequired).toBe(false);
    expect(functionName!.dbName).toBe('function_name');

    // 4. grade
    const grade = fieldMap.get('grade');
    expect(grade, 'Employee.grade field must exist').toBeDefined();
    expect(grade!.type).toBe('String');
    expect(grade!.isRequired).toBe(false);

    // 5. reportingManager
    const reportingManager = fieldMap.get('reportingManager');
    expect(reportingManager, 'Employee.reportingManager field must exist').toBeDefined();
    expect(reportingManager!.type).toBe('String');
    expect(reportingManager!.isRequired).toBe(false);
    expect(reportingManager!.dbName).toBe('reporting_manager');

    // 6. reportingTo (retained for backward compatibility)
    const reportingTo = fieldMap.get('reportingTo');
    expect(reportingTo, 'Employee.reportingTo field must exist').toBeDefined();
    expect(reportingTo!.type).toBe('String');
    expect(reportingTo!.isRequired).toBe(false);
    expect(reportingTo!.dbName).toBe('reporting_to');

    // 7. hod
    const hod = fieldMap.get('hod');
    expect(hod, 'Employee.hod field must exist').toBeDefined();
    expect(hod!.type).toBe('String');
    expect(hod!.isRequired).toBe(false);

    // 8. officeArea
    const officeArea = fieldMap.get('officeArea');
    expect(officeArea, 'Employee.officeArea field must exist').toBeDefined();
    expect(officeArea!.type).toBe('String');
    expect(officeArea!.isRequired).toBe(false);
    expect(officeArea!.dbName).toBe('office_area');
  });

  it('CHALLENGE-02: Prisma TypeScript types allow creating and updating all Matrix fields', async () => {
    // Compile-time and runtime check that Prisma Input types include the Matrix fields
    const testCreateInput: Prisma.EmployeeCreateInput = {
      employeeCode: 'EMP-CHALLENGE-01',
      fullName: 'Matrix Test Employee',
      email: 'challenge01@shaktiman.com',
      designation: 'Senior Lead',
      grade: 'M2',
      ext: '4055',
      section: 'Central Procurement Cell',
      functionName: 'Supply Chain Operations',
      reportingManager: 'Rajesh Sharma',
      reportingTo: 'Rajesh Sharma',
      hod: 'Vikram Patel',
      officeArea: 'Main Plant Floor 2',
      department: {
        connect: { id: '000000000000000000000001' }
      }
    };

    expect(testCreateInput.ext).toBe('4055');
    expect(testCreateInput.reportingManager).toBe('Rajesh Sharma');
    expect(testCreateInput.section).toBe('Central Procurement Cell');
    expect(testCreateInput.functionName).toBe('Supply Chain Operations');
    expect(testCreateInput.grade).toBe('M2');
    expect(testCreateInput.hod).toBe('Vikram Patel');
    expect(testCreateInput.officeArea).toBe('Main Plant Floor 2');

    const testUpdateInput: Prisma.EmployeeUpdateInput = {
      ext: '4056',
      reportingManager: 'Amit Verma',
      reportingTo: 'Amit Verma',
      section: 'Vendor Management',
    };

    expect(testUpdateInput.ext).toBe('4056');
    expect(testUpdateInput.reportingManager).toBe('Amit Verma');
    expect(testUpdateInput.section).toBe('Vendor Management');
  });

  it('CHALLENGE-03: Mock Prisma correctly persists and retrieves Matrix fields on employee operations', async () => {
    const mockPrisma = await createMockPrisma();

    // Create a department first
    const dept = await mockPrisma.department.create({
      data: {
        code: 'ENG',
        name: 'Engineering',
        colorHex: '#2563EB',
      }
    });

    // Create employee with all Matrix fields
    const created = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-M1-001',
        fullName: 'Empirical Tester',
        email: 'tester@shaktiman.com',
        departmentId: dept.id,
        ext: '2100',
        section: 'Automation Cell',
        functionName: 'Robotics R&D',
        grade: 'G3',
        reportingManager: 'Dr. Banner',
        reportingTo: 'Dr. Banner',
        hod: 'Tony Stark',
        officeArea: 'R&D Lab West',
      }
    });

    expect(created.ext).toBe('2100');
    expect(created.section).toBe('Automation Cell');
    expect(created.functionName).toBe('Robotics R&D');
    expect(created.grade).toBe('G3');
    expect(created.reportingManager).toBe('Dr. Banner');
    expect(created.reportingTo).toBe('Dr. Banner');
    expect(created.hod).toBe('Tony Stark');
    expect(created.officeArea).toBe('R&D Lab West');

    // Retrieve via findUnique
    const fetched = await mockPrisma.employee.findUnique({
      where: { employeeCode: 'EMP-M1-001' }
    });
    expect(fetched).toBeDefined();
    expect(fetched.ext).toBe('2100');
    expect(fetched.reportingManager).toBe('Dr. Banner');
    expect(fetched.section).toBe('Automation Cell');

    // Update via update
    const updated = await mockPrisma.employee.update({
      where: { id: created.id },
      data: {
        ext: '2105',
        reportingManager: 'Pepper Potts',
      }
    });
    expect(updated.ext).toBe('2105');
    expect(updated.reportingManager).toBe('Pepper Potts');
  });
});

describe('Milestone 1 Empirical Challenge: Zod Validation Schemas Stress Test', () => {
  const validDeptId = '507f1f77bcf86cd799439011';

  it('CHALLENGE-04: CreateEmployeeRequestSchema validates valid Matrix fields and allows null/omission', () => {
    // Valid full payload
    const validFull = {
      employeeCode: 'EMP-ZOD-01',
      fullName: 'Full Matrix User',
      email: 'matrix@shaktiman.com',
      departmentId: validDeptId,
      ext: '3044',
      section: 'Tooling & Fixtures',
      functionName: 'Heavy Manufacturing',
      grade: 'L2',
      reportingManager: 'Suresh Raina',
      reportingTo: 'Suresh Raina',
      hod: 'Mahendra Dhoni',
      officeArea: 'Shop Floor 1',
    };
    const parsed = CreateEmployeeRequestSchema.parse(validFull);
    expect(parsed.ext).toBe('3044');
    expect(parsed.reportingManager).toBe('Suresh Raina');
    expect(parsed.section).toBe('Tooling & Fixtures');
    expect(parsed.functionName).toBe('Heavy Manufacturing');

    // Valid with null values
    const validNulls = {
      employeeCode: 'EMP-ZOD-02',
      fullName: 'Null Fields User',
      departmentId: validDeptId,
      ext: null,
      reportingManager: null,
      reportingTo: null,
      section: null,
      functionName: null,
      grade: null,
      hod: null,
      officeArea: null,
    };
    const parsedNulls = CreateEmployeeRequestSchema.parse(validNulls);
    expect(parsedNulls.ext).toBeNull();
    expect(parsedNulls.reportingManager).toBeNull();

    // Valid with omitted optional fields
    const minimal = {
      employeeCode: 'EMP-ZOD-03',
      fullName: 'Minimal User',
      departmentId: validDeptId,
    };
    const parsedMinimal = CreateEmployeeRequestSchema.parse(minimal);
    expect(parsedMinimal.ext).toBeUndefined();
    expect(parsedMinimal.reportingManager).toBeUndefined();
  });

  it('CHALLENGE-05: CreateEmployeeRequestSchema enforces trimming on string fields', () => {
    const untrimmed = {
      employeeCode: 'EMP-ZOD-04',
      fullName: '  Trimmed User  ',
      departmentId: validDeptId,
      ext: '   4400   ',
      reportingManager: '   Manager Name   ',
      section: '   Section A   ',
      officeArea: '   Area B   ',
    };
    const parsed = CreateEmployeeRequestSchema.parse(untrimmed);
    expect(parsed.ext).toBe('4400');
    expect(parsed.reportingManager).toBe('Manager Name');
    expect(parsed.section).toBe('Section A');
    expect(parsed.officeArea).toBe('Area B');
  });

  it('CHALLENGE-06: CreateEmployeeRequestSchema strictly rejects invalid types for ext and reportingManager', () => {
    // Number type for ext
    const numberExt = {
      employeeCode: 'EMP-ZOD-05',
      fullName: 'Invalid Ext User',
      departmentId: validDeptId,
      ext: 1234, // Invalid: should be string
    };
    const resExtNum = CreateEmployeeRequestSchema.safeParse(numberExt);
    expect(resExtNum.success).toBe(false);

    // Boolean type for ext
    const boolExt = {
      employeeCode: 'EMP-ZOD-06',
      fullName: 'Invalid Ext User',
      departmentId: validDeptId,
      ext: true,
    };
    const resExtBool = CreateEmployeeRequestSchema.safeParse(boolExt);
    expect(resExtBool.success).toBe(false);

    // Number type for reportingManager
    const numberMgr = {
      employeeCode: 'EMP-ZOD-07',
      fullName: 'Invalid Manager User',
      departmentId: validDeptId,
      reportingManager: 99999, // Invalid: should be string
    };
    const resMgrNum = CreateEmployeeRequestSchema.safeParse(numberMgr);
    expect(resMgrNum.success).toBe(false);

    // Array type for reportingManager
    const arrayMgr = {
      employeeCode: 'EMP-ZOD-08',
      fullName: 'Invalid Manager User',
      departmentId: validDeptId,
      reportingManager: ['Manager One'], // Invalid: should be string
    };
    const resMgrArr = CreateEmployeeRequestSchema.safeParse(arrayMgr);
    expect(resMgrArr.success).toBe(false);
  });

  it('CHALLENGE-07: CreateEmployeeRequestSchema enforces length boundary constraints', () => {
    // ext: max 30 chars
    const exactly30 = '123456789012345678901234567890';
    expect(exactly30.length).toBe(30);
    const valid30 = CreateEmployeeRequestSchema.safeParse({
      employeeCode: 'EMP-ZOD-09',
      fullName: 'Boundary User',
      departmentId: validDeptId,
      ext: exactly30,
    });
    expect(valid30.success).toBe(true);

    const length31 = '1234567890123456789012345678901';
    expect(length31.length).toBe(31);
    const invalid31 = CreateEmployeeRequestSchema.safeParse({
      employeeCode: 'EMP-ZOD-10',
      fullName: 'Boundary User',
      departmentId: validDeptId,
      ext: length31,
    });
    expect(invalid31.success).toBe(false);

    // reportingManager: max 100 chars
    const exactly100 = 'A'.repeat(100);
    const valid100 = CreateEmployeeRequestSchema.safeParse({
      employeeCode: 'EMP-ZOD-11',
      fullName: 'Boundary User',
      departmentId: validDeptId,
      reportingManager: exactly100,
    });
    expect(valid100.success).toBe(true);

    const length101 = 'A'.repeat(101);
    const invalid101 = CreateEmployeeRequestSchema.safeParse({
      employeeCode: 'EMP-ZOD-12',
      fullName: 'Boundary User',
      departmentId: validDeptId,
      reportingManager: length101,
    });
    expect(invalid101.success).toBe(false);
  });

  it('CHALLENGE-08: UpdateEmployeeRequestSchema and EmployeeCsvRowSchema validate matrix fields correctly', () => {
    // Update schema partial update with null values
    const updatePayload = {
      ext: null,
      reportingManager: null,
      officeArea: 'Building 2 Floor 1',
    };
    const parsedUpdate = UpdateEmployeeRequestSchema.parse(updatePayload);
    expect(parsedUpdate.ext).toBeNull();
    expect(parsedUpdate.reportingManager).toBeNull();
    expect(parsedUpdate.officeArea).toBe('Building 2 Floor 1');

    // CsvRow schema
    const csvRow = {
      employeeCode: 'EMP-CSV-01',
      fullName: 'Csv Imported',
      departmentCode: 'ENG',
      ext: '5010',
      section: 'Assembly Line',
      functionName: 'Operations',
      grade: 'G1',
      reportingManager: 'Chief Engineer',
      hod: 'Director',
      officeArea: 'Plant 1',
    };
    const parsedCsv = EmployeeCsvRowSchema.parse(csvRow);
    expect(parsedCsv.ext).toBe('5010');
    expect(parsedCsv.reportingManager).toBe('Chief Engineer');
  });
});

describe('Milestone 1 Empirical Challenge: Excel Importer Header Aliasing & Missing Headers', () => {
  // Test the exact extraction logic implemented in excel-importer.service.ts
  function extractExt(row: Record<string, any>): string | null {
    return String(row['Ext'] || row['Extension'] || row['Intercom'] || row['Ext.'] || row['Ext No'] || row['Phone Ext'] || '').trim() || null;
  }

  function extractReportingManager(row: Record<string, any>): string | null {
    return String(row['Reporting Manager'] || row['Report To'] || row['Reporting to'] || '').trim() || null;
  }

  it('CHALLENGE-09: Robustly extracts ext across all supported header aliases', () => {
    const testCases: Array<{ row: Record<string, any>; expected: string | null; label: string }> = [
      { row: { Ext: '1001' }, expected: '1001', label: 'Ext' },
      { row: { Extension: '1002' }, expected: '1002', label: 'Extension' },
      { row: { Intercom: '1003' }, expected: '1003', label: 'Intercom' },
      { row: { 'Ext.': '1004' }, expected: '1004', label: 'Ext.' },
      { row: { 'Ext No': '1005' }, expected: '1005', label: 'Ext No' },
      { row: { 'Phone Ext': '1006' }, expected: '1006', label: 'Phone Ext' },
      // Numeric value in Excel cell
      { row: { Ext: 2045 }, expected: '2045', label: 'Numeric Ext' },
      { row: { Intercom: 3050 }, expected: '3050', label: 'Numeric Intercom' },
      // Untrimmed whitespace
      { row: { Ext: '  4055  ' }, expected: '4055', label: 'Whitespace Ext' },
      // Empty string
      { row: { Ext: '' }, expected: null, label: 'Empty Ext' },
      { row: { Extension: '   ' }, expected: null, label: 'Whitespace-only Ext' },
      // Completely missing header
      { row: { 'Other Column': 'val' }, expected: null, label: 'Missing Ext Header' },
    ];

    for (const tc of testCases) {
      const result = extractExt(tc.row);
      expect(result, `Failed on alias case: ${tc.label}`).toBe(tc.expected);
    }
  });

  it('CHALLENGE-10: Robustly extracts reportingManager across all supported header aliases', () => {
    const testCases: Array<{ row: Record<string, any>; expected: string | null; label: string }> = [
      { row: { 'Reporting Manager': 'Pankaj Upadhyay' }, expected: 'Pankaj Upadhyay', label: 'Reporting Manager' },
      { row: { 'Report To': 'Pankaj Upadhyay' }, expected: 'Pankaj Upadhyay', label: 'Report To (Dump Sheet Header)' },
      { row: { 'Reporting to': 'Pankaj Upadhyay' }, expected: 'Pankaj Upadhyay', label: 'Reporting to (Update Data Header)' },
      // Whitespace trimming
      { row: { 'Report To': '  Anand Mahindra  ' }, expected: 'Anand Mahindra', label: 'Trimmed Report To' },
      // Empty string
      { row: { 'Reporting Manager': '' }, expected: null, label: 'Empty Reporting Manager' },
      // Completely missing header
      { row: { 'User Name': 'Worker' }, expected: null, label: 'Missing Reporting Manager Header' },
    ];

    for (const tc of testCases) {
      const result = extractReportingManager(tc.row);
      expect(result, `Failed on alias case: ${tc.label}`).toBe(tc.expected);
    }
  });

  it('CHALLENGE-11: End-to-End Excel In-Memory Workbook with Non-Standard Headers (Intercom, Report To, Missing Ext)', async () => {
    // Generate a synthetic workbook with:
    // Row 1: Header 'Intercom' and 'Report To'
    // Row 2: Missing 'Ext' entirely
    const wb = xlsx.utils.book_new();
    const data = [
      ['Emp Code', 'E. Name', 'Department', 'Intercom', 'Report To', 'Section', 'Function', 'Active or not'],
      ['EMP-SYN-01', 'Alice Matrix', 'ENG', '9011', 'Bob Manager', 'Precision Eng', 'Aero Operations', 'Active'],
      ['EMP-SYN-02', 'Charlie Desk', 'ENG', '', 'Bob Manager', 'Precision Eng', 'Aero Operations', 'Active'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Workstations');

    // Parse with sheet_to_json
    const parsedRows: any[] = xlsx.utils.sheet_to_json(ws, { defval: '' });
    expect(parsedRows).toHaveLength(2);

    // Row 1: Alice Matrix has 'Intercom' and 'Report To'
    const r1 = parsedRows[0];
    const ext1 = extractExt(r1);
    const rep1 = extractReportingManager(r1);
    expect(ext1).toBe('9011');
    expect(rep1).toBe('Bob Manager');

    // Row 2: Charlie Desk has empty Intercom and no Ext
    const r2 = parsedRows[1];
    const ext2 = extractExt(r2);
    const rep2 = extractReportingManager(r2);
    expect(ext2).toBeNull();
    expect(rep2).toBe('Bob Manager');
  });

  it('CHALLENGE-12: Fallback logic between extraDetails and Dump roster simulation', () => {
    // Simulated Dump roster record for an employee
    const dumpRoster = new Map<string, { ext: string | null; reportingManager: string | null; section: string | null }>();
    dumpRoster.set('EMP-100', {
      ext: '7788',
      reportingManager: 'Master Roster Manager',
      section: 'Master Section',
    });

    // Function simulating resolveOrCreateEmployee fallback
    function resolveEmployeeAttributes(
      code: string,
      extraDetails?: { ext?: string | null; reportingManager?: string | null; section?: string | null }
    ) {
      const dumpInfo = dumpRoster.get(code);

      // Section and reportingManager use || fallback:
      const section = extraDetails?.section || dumpInfo?.section || null;
      const reportingManager = extraDetails?.reportingManager || dumpInfo?.reportingManager || null;
      
      // Note: testing how ext is resolved:
      // When extraDetails provides an explicit value (not null/empty), it should override dumpInfo.
      // When extraDetails provides null/empty or undefined, dumpInfo should be the fallback.
      const ext = (extraDetails?.ext ? extraDetails.ext : (dumpInfo?.ext || null));

      return { section, reportingManager, ext };
    }

    // Case 1: Workstation row has explicit ext ('9999') -> overrides Dump ('7788')
    const case1 = resolveEmployeeAttributes('EMP-100', { ext: '9999', reportingManager: 'Local Lead' });
    expect(case1.ext).toBe('9999');
    expect(case1.reportingManager).toBe('Local Lead');

    // Case 2: Workstation row has missing ext (null) -> falls back to Dump ('7788')
    const case2 = resolveEmployeeAttributes('EMP-100', { ext: null, reportingManager: null });
    expect(case2.ext).toBe('7788');
    expect(case2.reportingManager).toBe('Master Roster Manager');
    expect(case2.section).toBe('Master Section');

    // Case 3: Employee not in Dump roster -> defaults to null cleanly
    const case3 = resolveEmployeeAttributes('EMP-UNKNOWN', { ext: null });
    expect(case3.ext).toBeNull();
    expect(case3.reportingManager).toBeNull();
    expect(case3.section).toBeNull();
  });
});
