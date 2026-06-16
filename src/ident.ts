/**
 * SQL identifier quoting. Schema/table/column names come from the system
 * catalogs (trusted), but they can still contain characters that require
 * quoting, so every identifier we splice into SQL goes through here.
 */

/** Quote a single identifier, doubling any embedded double-quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a schema-qualified name: `"schema"."table"`. */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Quote a string literal for inlining (used only for `::regclass` casts). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
