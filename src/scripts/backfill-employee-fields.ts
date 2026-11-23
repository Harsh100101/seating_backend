import path from 'node:path';
import fs from 'node:fs';
import xlsx from '../utils/xlsx.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function cleanStr(val: any): string | null {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s || s === '0' || s === '-' || s.toLowerCase() === 'null') return null;
  return s;
}

function findTestDataDir(): string {
  const possiblePaths = [
    path.resolve(process.cwd(), 'test data'),
    path.resolve(process.cwd(), '../../test data'),
    path.resolve(process.cwd(), '../test data'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Test data directory not found');
}

const deptAliasMap: Record<string, string> = {
  'CPC': 'CENTRAL PROCUREMENT CELL',
  'HTFE': 'HI-TECH FARM EQUIPMENT',
  'COSTING': 'COMMERCIAL',
  'EXPORT': 'INTERNATIONAL BUSINESS',
  'INTERNATIONAL MARKETING': 'INTERNATIONAL BUSINESS',
  'MARKETING': 'INTERNATIONAL BUSINESS',
  'R&D': 'PRODUCT DEVELOPMENT',
  'DESIGN': 'PRODUCT DEVELOPMENT',
  'PRODUCT': 'PRODUCT DEVELOPMENT',
  'PD QUALITY & TPM': 'CENTRAL QUALITY',
  'ENGINEERING': 'MANUFACTURING OPERATIONS',
  'OPERATIONS': 'MANUFACTURING OPERATIONS',
  'GENERAL OPERATIONS': 'MANUFACTURING OPERATIONS',
  'FINANCE': 'FINANCE & ACCOUNTS',
  'HR/ADMIN': 'HUMAN RESOURCE & ADMINISTRATION',
  'ADMIN & IT': 'IT & INFRASTRUCTURE',
  'MAINTENANCE': 'MANUFACTURING OPERATIONS',
};

async function main() {
  console.log('--- Starting Comprehensive Employee Fields Backfill ---');
  const testDataDir = findTestDataDir();
  const u1Path = path.join(testDataDir, 'Unit_1_Workstation Details.xlsx');
  const u2Path = path.join(testDataDir, 'Unit_2_Work Station Details.xlsx');

  const wb2 = xlsx.readFile(u2Path);
  const wb1 = xlsx.readFile(u1Path);

  // 1. Parse Dump sheet
  const dumpByCode = new Map<string, any>();
  const dumpByName = new Map<string, any>();
  const deptToHods = new Map<string, Map<string, number>>();

  function recordHod(deptName: string, hodName: string) {
    const dept = deptName.trim().toUpperCase();
    const hod = hodName.trim();
    if (!dept || !hod) return;
    if (!deptToHods.has(dept)) deptToHods.set(dept, new Map());
    const m = deptToHods.get(dept)!;
    m.set(hod, (m.get(hod) || 0) + 1);
  }

  if (wb2.Sheets['Dump']) {
    const dumpRows: any[] = xlsx.utils.sheet_to_json(wb2.Sheets['Dump'], { defval: '' });
    for (const r of dumpRows) {
      const code = cleanStr(r['EmpNo']);
      const name = cleanStr(r['Name']);
      const hod = cleanStr(r['Department Head (HOD)']);
      const dept = cleanStr(r['Department']);
      if (dept && hod) recordHod(dept, hod);

      const item = {
        code,
        name,
        section: cleanStr(r['Section']),
        functionName: cleanStr(r['Function']),
        reportingTo: cleanStr(r['Report To']),
        hod,
        designation: cleanStr(r['Designation']),
        grade: cleanStr(r['Grade']),
        phone: cleanStr(r['Mobile No. (Office)']),
        email: cleanStr(r['Email ID(Office)']),
        isActive: cleanStr(r['Employee Status'])?.toLowerCase() !== 'inactive' && cleanStr(r['Employee Status'])?.toLowerCase() !== 'left',
      };
      if (code) dumpByCode.set(code.toUpperCase(), item);
      if (name) dumpByName.set(name.toLowerCase(), item);
    }
  }

  // 2. Parse Unit 2 Update data sheet
  const u2ByCode = new Map<string, any>();
  const u2ByName = new Map<string, any>();
  if (wb2.Sheets['Update data']) {
    const u2Rows: any[] = xlsx.utils.sheet_to_json(wb2.Sheets['Update data'], { defval: '' });
    for (const r of u2Rows) {
      const code = cleanStr(r['Emp Code']);
      const name = cleanStr(r['E. Name']);
      const hod = cleanStr(r['HOD']);
      const dept = cleanStr(r['Department']);
      if (dept && hod) recordHod(dept, hod);

      const item = {
        code,
        name,
        section: cleanStr(r['Section']),
        functionName: cleanStr(r['Function']),
        reportingTo: cleanStr(r['Reporting to']),
        hod,
        isActive: cleanStr(r['Active or not'])?.toLowerCase() !== 'inactive',
      };
      if (code) u2ByCode.set(code.toUpperCase(), item);
      if (name) u2ByName.set(name.toLowerCase(), item);
    }
  }

  // 3. Parse Unit 1 Sheet1
  const u1ByCode = new Map<string, any>();
  const u1ByName = new Map<string, any>();
  if (wb1.Sheets['Sheet1']) {
    const u1Rows: any[] = xlsx.utils.sheet_to_json(wb1.Sheets['Sheet1'], { defval: '' });
    for (const r of u1Rows) {
      const code = cleanStr(r['Emp Code']);
      const name = cleanStr(r['E. Name']);
      const item = {
        code,
        name,
        section: cleanStr(r['Section']),
        functionName: cleanStr(r['Function']),
        reportingTo: cleanStr(r['Reporting to']),
        isActive: cleanStr(r['Active or not'])?.toLowerCase() !== 'inactive',
      };
      if (code) u1ByCode.set(code.toUpperCase(), item);
      if (name) u1ByName.set(name.toLowerCase(), item);
    }
  }

  // Primary HOD per department
  const primaryDeptHod = new Map<string, string>();
  for (const [dept, hodCounts] of deptToHods.entries()) {
    let topHod = '';
    let maxCount = -1;
    for (const [hod, count] of hodCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        topHod = hod;
      }
    }
    primaryDeptHod.set(dept, topHod);
  }

  // 4. Backfill all DB employees
  const allEmployees = await prisma.employee.findMany({
    include: { department: true }
  });
  console.log(`Processing ${allEmployees.length} employees in database...`);

  let updatedCount = 0;
  for (const emp of allEmployees) {
    const codeKey = (emp.employeeCode || '').toUpperCase();
    const nameKey = (emp.fullName || '').toLowerCase();

    // Priority: Unit 2 sheet / Unit 1 sheet -> Dump sheet
    const sheetData = u2ByCode.get(codeKey) || u1ByCode.get(codeKey) || u2ByName.get(nameKey) || u1ByName.get(nameKey);
    const dumpData = dumpByCode.get(codeKey) || dumpByName.get(nameKey);

    let section = sheetData?.section || dumpData?.section || emp.section || null;
    let functionName = sheetData?.functionName || dumpData?.functionName || emp.functionName || null;
    let reportingTo = sheetData?.reportingTo || dumpData?.reportingTo || emp.reportingTo || null;
    let hod = sheetData?.hod || dumpData?.hod || emp.hod || null;

    const deptUpper = (emp.department?.name || '').trim().toUpperCase();
    const mappedDept = deptAliasMap[deptUpper] || deptUpper;

    if (!hod && primaryDeptHod.has(mappedDept)) {
      hod = primaryDeptHod.get(mappedDept) || null;
    }
    if (!hod && reportingTo) {
      hod = reportingTo;
    }
    if (!hod) {
      hod = 'Executive Director';
    }

    if (!section) {
      section = emp.department?.name || 'General Operations';
    }
    if (!functionName) {
      functionName = 'Operations';
    }
    if (!reportingTo) {
      reportingTo = hod;
    }

    const designation = emp.designation || dumpData?.designation || 'Staff';
    const grade = emp.grade || dumpData?.grade || null;
    const phone = emp.phone || dumpData?.phone || null;
    const isActive = sheetData?.isActive !== undefined ? sheetData.isActive : (dumpData?.isActive !== undefined ? dumpData.isActive : emp.isActive);

    const needsUpdate =
      section !== emp.section ||
      functionName !== emp.functionName ||
      reportingTo !== emp.reportingTo ||
      hod !== emp.hod ||
      designation !== emp.designation ||
      grade !== emp.grade ||
      phone !== emp.phone ||
      isActive !== emp.isActive;

    if (needsUpdate) {
      await prisma.employee.update({
        where: { id: emp.id },
        data: {
          section,
          functionName,
          reportingTo,
          hod,
          designation,
          grade,
          phone,
          isActive,
        },
      });
      updatedCount++;
    }
  }

  console.log(`✓ Updated ${updatedCount} / ${allEmployees.length} employees.`);

  const stats = {
    total: await prisma.employee.count(),
    withSection: await prisma.employee.count({ where: { section: { not: null } } }),
    withFunction: await prisma.employee.count({ where: { functionName: { not: null } } }),
    withReportingTo: await prisma.employee.count({ where: { reportingTo: { not: null } } }),
    withHod: await prisma.employee.count({ where: { hod: { not: null } } }),
  };
  console.log('Final Post-backfill stats:', stats);
}

main()
  .catch((err) => {
    console.error('Error running backfill:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
