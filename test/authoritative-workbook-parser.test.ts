import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAuthoritativeWorkbook } from '../src/services/authoritative-import.service.js';

const temporaryDirectories: string[] = [];

const writeWorkbook = (rows: Array<Record<string, unknown>>, columns?: string[]) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seating-authoritative-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'authorized.xlsx');
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.json_to_sheet(rows, { header: columns });
  xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Context only']]), 'Sheet3');
  xlsx.writeFile(workbook, filePath);
  return filePath;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('authoritative workbook parser', () => {
  it('normalizes employee codes, preserves blank status, identifies placeholders, and never edits the source', () => {
    const filePath = writeWorkbook([
      { Unit: ' Unit-1 ', Building: 'Main', Floor: '1', 'Office / Area': 'QA', Department: 'Quality', Section: 'Audit', Function: 'Inspection', 'WS NO': 'WS-01', 'Emp Code': 12345, 'E. Name': ' Asha ', Status: '' },
      { Unit: 'Unit-1', Building: 'Main', Floor: '1', 'Office / Area': 'QA', Department: '', Section: '', Function: '', 'WS NO': 'WS-02', 'Emp Code': 'VACANT', 'E. Name': '', Status: 'Active' }
    ]);
    const before = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

    const parsed = parseAuthoritativeWorkbook(filePath);

    expect(parsed.sheetNames).toEqual(['Sheet1', 'Sheet3']);
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 2, code: '12345', name: 'Asha', status: '' });
    expect(parsed.source).toMatchObject({ rows: 2, validEmployeeRows: 1, uniqueEmployeeIds: 1, placeholderRows: 1, uniqueWorkstationKeys: 2 });
    expect(parsed.hash).toBe(before);
    expect(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')).toBe(before);
  });

  it('blocks a workstation described as both vacant and assigned', () => {
    const base = { Unit: 'Unit-1', Building: 'Main', Floor: '1', 'Office / Area': 'QA', Department: 'Quality', Section: '', Function: '', 'WS NO': 'WS-01', Status: 'Active' };
    const filePath = writeWorkbook([
      { ...base, 'Emp Code': 'VACANT', 'E. Name': '' },
      { ...base, 'Emp Code': '20001', 'E. Name': 'Employee One' }
    ]);

    expect(parseAuthoritativeWorkbook(filePath).source.duplicateWorkstationGroups).toBe(1);
  });

  it('rejects missing required columns and non-XLSX input', () => {
    const filePath = writeWorkbook([{ Unit: 'Unit-1' }], ['Unit']);
    expect(() => parseAuthoritativeWorkbook(filePath)).toThrow(/missing required column/i);

    const textPath = path.join(path.dirname(filePath), 'not-a-workbook.txt');
    fs.writeFileSync(textPath, 'not xlsx');
    expect(() => parseAuthoritativeWorkbook(textPath)).toThrow(/must be an XLSX/i);
  });
});
