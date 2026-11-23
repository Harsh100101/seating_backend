import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

// SheetJS ESM intentionally leaves Node filesystem helpers opt-in. Configure
// once for backend routes and services that read/write workbook paths.
XLSX.set_fs(fs);

export default XLSX;
