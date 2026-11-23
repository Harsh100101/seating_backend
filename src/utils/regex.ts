// apps/backend/src/utils/regex.ts
/**
 * Prisma's MongoDB `contains` filter is compiled directly to a regular expression.
 * Literal substring search must escape regex metacharacters before reaching Prisma
 * so user-supplied special characters (e.g. `(`, `[`, `*`, `+`, `?`, `.`) do not
 * trigger MongoDB regex syntax errors (500).
 */
export const escapeRegexLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
