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
 * The qualified name of an object that hangs off a table — a constraint, a
 * trigger, an RLS policy — as `schema.table.object`.
 *
 * A sibling of {@link tableKey} rather than a variation on it: these names are
 * reported to operators, never matched against foreign-key edges, so the two
 * formats are deliberately distinct. Both live here so a reader has one place to
 * look and neither gets hand-rolled at a call site.
 */
export function objectKey(schema: string, table: string, name: string): string {
  return `${schema}.${table}.${name}`;
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

/**
 * The {@link tableKey} of every user table on a cluster.
 *
 * Deliberately lighter than `introspectSchema`: callers that only need to know
 * *which* tables exist — validation, chiefly, so it can report a table the
 * target lacks instead of blowing up counting rows in it — should not pay for a
 * per-table column query they will not read.
 */
export async function tableKeys(db: PGliteLike): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT n.nspname || '.' || c.relname AS key
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND ${systemSchemaFilter('n.nspname')}`,
  );
  return rows.map((r) => r.key);
}

/**
 * Count rows currently in a (pre-quoted, qualified) table. Version-agnostic.
 *
 * `count(*)` returns `bigint`, read here as text rather than cast to `int`: the
 * cast raised `integer out of range` past 2³¹ rows, which turned an enormous
 * table into a raw Postgres error from inside validation. `Number` is exact to
 * 2⁵³, well past anything an embedded engine will hold.
 */
export async function countRows(db: PGliteLike, qualified: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qualified}`);
  // `count(*)` is an aggregate without GROUP BY, so it always yields exactly one
  // row of digits. Both guards below are belt-and-braces against a non-Postgres
  // `PGliteLike` and are unreachable against a real engine — deliberately not
  // covered, rather than covered by a contrived stub that asserts nothing.
  /* v8 ignore next */
  if (rows.length === 0) return 0;
  const raw = rows[0].n;
  const n = Number(raw);
  /* v8 ignore next */
  if (!Number.isFinite(n)) throw new Error(`Unparseable row count for ${qualified}: ${raw}`);
  return n;
}

/**
 * Whether a (pre-quoted, qualified) table holds any rows at all.
 *
 * The re-run-safety probe only needs one bit, and `count(*)` has no shortcut in
 * Postgres — it scans. `LIMIT 1` stops at the first row, which matters on the
 * `skip` path, where the target is large by definition.
 */
export async function hasRows(db: PGliteLike, qualified: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM ${qualified} LIMIT 1`);
  return rows.length > 0;
}
