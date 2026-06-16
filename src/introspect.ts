import { quoteLiteral, quoteQualified } from './ident.js';
import type {
  ColumnInfo,
  ForeignKey,
  PGliteLike,
  SchemaInfo,
  SequenceInfo,
  TableInfo,
} from './types.js';

/** System schemas that never carry user data. */
const SYSTEM_SCHEMA_FILTER = `nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'`;

/**
 * Read the user schema (tables + columns + foreign keys + sequences) from a
 * live cluster via the system catalogs. Version-agnostic: only stable catalog
 * relations and `format_type` are used, so the same query works against every
 * supported PostgreSQL major.
 */
export async function introspectSchema(db: PGliteLike): Promise<SchemaInfo> {
  const tables = await introspectTables(db);
  const foreignKeys = await introspectForeignKeys(db);
  const sequences = await introspectSequences(db);
  return { tables, foreignKeys, sequences };
}

async function introspectTables(db: PGliteLike): Promise<TableInfo[]> {
  const { rows } = await db.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND ${SYSTEM_SCHEMA_FILTER.replace(/nspname/g, 'n.nspname')}
      ORDER BY n.nspname, c.relname`,
  );

  const tables: TableInfo[] = [];
  for (const { schema, name } of rows) {
    tables.push({ schema, name, columns: await introspectColumns(db, schema, name) });
  }
  return tables;
}

async function introspectColumns(
  db: PGliteLike,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const regclass = quoteLiteral(quoteQualified(schema, table));
  const { rows } = await db.query<{
    name: string;
    type: string;
    generated: string;
    identity: string;
  }>(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attgenerated AS generated,
            a.attidentity AS identity
       FROM pg_attribute a
      WHERE a.attrelid = ${regclass}::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
  );
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    // attgenerated is 's' for STORED generated columns, '' otherwise.
    generated: r.generated === 's',
    // attidentity is 'a' (always) / 'd' (by default) / '' (not an identity column).
    identity: r.identity === 'a' ? 'always' : r.identity === 'd' ? 'default' : null,
  }));
}

async function introspectForeignKeys(db: PGliteLike): Promise<ForeignKey[]> {
  // Build qualified `schema.name` edges by joining the catalogs explicitly.
  // `regclass::text` would be search-path-sensitive (it drops the schema for
  // public), which would stop the edges from matching the always-qualified
  // table keys used in topologicalSort.
  const { rows } = await db.query<{ child: string; parent: string }>(
    `SELECT cn.nspname || '.' || cc.relname AS child,
            pn.nspname || '.' || pc.relname AS parent
       FROM pg_constraint con
       JOIN pg_class cc ON cc.oid = con.conrelid
       JOIN pg_namespace cn ON cn.oid = cc.relnamespace
       JOIN pg_class pc ON pc.oid = con.confrelid
       JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE con.contype = 'f'
        AND con.conrelid <> con.confrelid
        AND ${SYSTEM_SCHEMA_FILTER.replace(/nspname/g, 'cn.nspname')}`,
  );
  return rows.map((r) => ({ child: r.child, parent: r.parent }));
}

async function introspectSequences(db: PGliteLike): Promise<SequenceInfo[]> {
  const { rows } = await db.query<{
    schemaname: string;
    sequencename: string;
    last_value: string | number | bigint | null;
  }>(
    `SELECT schemaname, sequencename, last_value
       FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );
  return rows.map((r) => ({
    schema: r.schemaname,
    name: r.sequencename,
    lastValue: r.last_value,
  }));
}
