/**
 * Canonical employee identifier used by imports, API validation, and reports.
 * Employee codes are identifiers, so comparison is intentionally
 * whitespace-insensitive and case-insensitive.
 */
export function normalizeEmpCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

export function isVacantEmpCode(value: unknown): boolean {
  const code = normalizeEmpCode(value);
  return code === '' || code === 'VACANT' || code === 'VACCANT' || code === 'NULL' || code === 'UNDEFINED';
}

export function isVacantOrPlaceholder(code: unknown, name: unknown): boolean {
  const normalizedCode = normalizeEmpCode(code).toLowerCase();
  const normalizedName = String(name ?? '').trim().toLowerCase();
  const combined = `${normalizedCode} ${normalizedName}`;
  if (!normalizedCode && !normalizedName) return true;
  if (isVacantEmpCode(normalizedCode)) return true;
  return ['not coming', 'up coming', 'upcoming', 'outsource', 'out sourse', 'contact person', 'printer', 'user name', 'user emp.no.', 'sr.no.', 'layout', 'emp code']
    .some((marker) => combined.includes(marker));
}
