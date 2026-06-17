import { quoteLiteral, quoteQualified } from './ident.js';
import type { PGliteLike } from './types.js';

/**
 * Shared building blocks for catalog SQL. These were previously duplicated
 * across `introspect`, `transfer`, `migrate`, `reconstruct`, and `validate`;
 * keeping one copy each avoids the modules drifting out of lockstep.
 */

/**
 * The qualified `schema.name` key used to match tables against foreign-key
 * edges and FK-cycle entries. This MUST stay identical to the endpoint format
 * `introspectForeignKeys` builds (`schema || '.' || name`), or topological
 * sorting silently fails to match edges — so it lives in exactly one place.
 */
export function tableKey(t: { schema: string; name: string }): string {
  return `${t.schema}.${t.name}`;
}

/**
 * A `WHERE` fragment excluding the schemas that never carry user objects:
 * `pg_catalog`, `information_schema`, and the per-session `pg_toast*` / `pg_temp*`
 * schemas. The catalog column that holds the schema name differs by query
 * (`nspname`, `schemaname`, …), so the caller passes the alias to splice in
 * rather than string-rewriting the fragment afterward.
 */
export function systemSchemaFilter(alias = 'nspname'): string {
  return (
    `${alias} NOT IN ('pg_catalog', 'information_schema') ` +
    `AND ${alias} NOT LIKE 'pg_toast%' AND ${alias} NOT LIKE 'pg_temp%'`
  );
}

/**
 * A quoted string literal of a qualified name, ready for a `::regclass` cast
 * (e.g. `'"public"."t"'`). The cast itself stays at the call site so the SQL
 * reads naturally, e.g. `${regclassLiteral(s, n)}::regclass`.
 */
export function regclassLiteral(schema: string, name: string): string {
  return quoteLiteral(quoteQualified(schema, name));
}

/** Count rows currently in a (pre-quoted, qualified) table. Version-agnostic. */
export async function countRows(db: PGliteLike, qualified: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${qualified}`);
  return rows[0]?.n ?? 0;
}
