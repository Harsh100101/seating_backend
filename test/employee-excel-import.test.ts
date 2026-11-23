import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import xlsx from 'xlsx';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Employee Excel (.xlsx) & CSV Bulk Import Pipeline', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let mockPrisma: any;

  function buildMultipart(boundary: string, filename: string, mime: string, content: Buffer): Buffer {
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    return Buffer.concat([header, content, footer]);
  }

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!',
    });
    await server.ready();

    // Authenticate Super Admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password,
      },
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  it('EXCEL-01: Correctly imports native .xlsx with "Employee Code", "Employee Name", "Email", "Department" without name collision', async () => {
    // Generate valid in-memory .xlsx workbook
    const wb = xlsx.utils.book_new();
    const data = [
      ['Employee Code', 'Employee Name', 'Email', 'Department'],
      ['EMP-9001', 'Alice Johnson', 'alice.j@shaktiman.com', 'ENG'],
      ['EMP-9002', 'Bob Builder', 'bob.b@shaktiman.com', 'ENG'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Roster');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const boundary = '----WebKitFormBoundaryExcelTest01';
    const payload = buildMultipart(boundary, 'roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/import',
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.errors).toHaveLength(0);

    // Verify employee was inserted with actual fullName, not employeeCode!
    const emp1 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-9001' } });
    expect(emp1).toBeDefined();
    expect(emp1.fullName).toBe('Alice Johnson');
    expect(emp1.fullName).not.toBe('EMP-9001');
    expect(emp1.email).toBe('alice.j@shaktiman.com');

    const emp2 = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-9002' } });
    expect(emp2).toBeDefined();
    expect(emp2.fullName).toBe('Bob Builder');
    expect(emp2.fullName).not.toBe('EMP-9002');
  });

  it('EXCEL-02: Backward-compatible /api/employees/import-csv alias supports native .xlsx files', async () => {
    const wb = xlsx.utils.book_new();
    const data = [
      ['EmpNo', 'Name', 'Email Address', 'Dept'],
      ['EMP-9010', 'Carol Danvers', 'carol.d@shaktiman.com', 'ENG'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Employees');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const boundary = '----WebKitFormBoundaryExcelTest02';
    const payload = buildMultipart(boundary, 'employees.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/import-csv',
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);

    const carol = await mockPrisma.employee.findUnique({ where: { employeeCode: 'EMP-9010' } });
    expect(carol).toBeDefined();
    expect(carol.fullName).toBe('Carol Danvers');
  });

  it('EXCEL-03: Rejects corrupted or invalid Excel workbook with 400 Bad Request', async () => {
    const corruptBuffer = Buffer.from('NOT_A_VALID_EXCEL_ZIP_OR_BIFF_STREAM');
    const boundary = '----WebKitFormBoundaryCorruptTest';
    const payload = buildMultipart(boundary, 'corrupt.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', corruptBuffer);

    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/import',
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Bad Request');
    expect(body.message).toContain('missing ZIP container signature');
  });

  it('EXCEL-04: Rejects corrupted ZIP payload with 400 Bad Request', async () => {
    // Starts with PKZip signature but has invalid zip payload
    const corruptZipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]);
    const boundary = '----WebKitFormBoundaryCorruptZip';
    const payload = buildMultipart(boundary, 'corrupt-zip.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', corruptZipBuffer);

    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/import',
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Bad Request');
    expect(body.message).toContain('Failed to parse Excel workbook');
  });

  it('EXCEL-05: Handles empty worksheet gracefully returning 0 imported records', async () => {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([]);
    xlsx.utils.book_append_sheet(wb, ws, 'EmptySheet');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const boundary = '----WebKitFormBoundaryEmptySheet';
    const payload = buildMultipart(boundary, 'empty.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/import',
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.errors).toHaveLength(0);
  });

  it('EXCEL-06: Handles duplicates and missing departments gracefully with error reporting', async () => {
    const wb = xlsx.utils.book_new();
    const data = [
      ['Code', 'Name', 'Email', 'Department'],
      ['EMP-8001', 'Valid One', 'valid1@shaktiman.com', 'ENG'],
      [' eMp-8001 ', 'Duplicate Code In File', 'valid2@shaktiman.com', 'ENG'],
      ['EMP-8003', 'Invalid Dept', 'valid3@shaktiman.com', 'NON_EXISTENT_DEPARTMENT'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Roster');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const boundary = '----WebKitFormBoundaryValidation';
    const payload = buildMultipart(boundary, 'roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);

    const res = await server.inject({
      method: 'POST',
      url: '/api/employees/import',
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(2);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.some((entry: any) => entry.error.includes('Duplicate employeeCode'))).toBe(true);
    expect(body.errors.some((entry: any) => entry.error.includes('does not exist'))).toBe(true);
  });
});
