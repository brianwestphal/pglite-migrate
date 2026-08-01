import { objectKey, regclassLiteral, systemSchemaFilter, tableKey } from './catalog.js';
import { quoteIdent, quoteLiteral, quoteQualified } from './ident.js';
import type {
  PGliteLike,
  ReconstructionReport,
  ReconstructOptions,
  UnsupportedObject,
} from './types.js';

/** Every query here aliases `pg_namespace` as `n`, so the schema filter uses `n.nspname`. */
const SYS = systemSchemaFilter('n.nspname');

/**
 * Splice a catalog-sourced integer into DDL.
 *
 * Sequence bounds arrive as text from `pg_sequence` and are not identifiers, so
 * `src/ident.ts` does not apply — but they are still spliced into SQL, so they
 * are validated rather than trusted (project convention: validate at trust
 * boundaries, don't assert).
 */
function numericLiteral(value: string, field: string): string {
  // `pg_sequence`'s bounds are bigint columns cast to text, so a non-numeric
  // value cannot come from a real engine. The guard exists so that a
  // hand-rolled `PGliteLike` cannot turn a catalog read into SQL injection;
  // deliberately not covered for the same reason it cannot fire.
  /* v8 ignore next 3 */
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Refusing to reconstruct: non-numeric ${field} from the catalog: ${value}`);
  }
  return value;
}

/**
 * Reconstruct the app-class schema of `source` onto `target` (the no-host-app
 * "standalone" path). Emits DDL in dependency order — schemas → custom types →
 * sequences → tables (+ defaults) → sequence ownership → constraints → indexes —
 * using PostgreSQL's own `pg_get_*def` functions, which run inside PGlite (no
 * `pg_dump` binary).
 *
 * Scope is app-class objects only: tables, columns, custom types (enums,
 * domains, composites — `docs/16`), sequences, PK/UNIQUE/CHECK/FK, and indexes.
 * Out-of-scope objects — views, materialized views, partitioned and foreign
 * tables, range types, functions, triggers, RLS policies, rules, operator
 * classes, collations, comments, grants, and extensions — are **detected and
 * reported**, never silently dropped. See `docs/9`.
 *
 * `options.onUnsupported` (default `warn`) controls what happens when the source
 * has out-of-scope objects: `warn` rebuilds the app-class schema anyway and
 * lists them in the report; `error` throws **before any DDL runs**, leaving the
 * target untouched.
 */
export async function reconstructSchema(
  source: PGliteLike,
  target: PGliteLike,
  options: ReconstructOptions = {},
): Promise<ReconstructionReport> {
  const onUnsupported = options.onUnsupported ?? 'warn';

  // Detect first so `error` can fail before touching the target.
  const unsupported = await detectUnsupported(source);
  if (onUnsupported === 'error' && unsupported.length > 0) {
    const list = unsupported.map((u) => `${u.kind} ${u.name}`).join(', ');
    throw new Error(
      `Cannot reconstruct: source has ${unsupported.length.toString()} out-of-scope ` +
        `object(s) that would not be recreated: ${list}. ` +
        `Re-run with onUnsupported: 'warn' to rebuild the app-class schema anyway.`,
    );
  }

  // Schemas first: every qualified CREATE below lands inside one, and only
  // `public` is guaranteed to exist on a fresh target (PGLM-76).
  const schemas = await reconstructSchemas(source, target);
  const { enums, domains, composites } = await reconstructCustomTypes(source, target);
  const sequences = await reconstructSequences(source, target);
  const tables = await reconstructTables(source, target);
  // Ownership is re-linked only once the owning tables exist (PGLM-78).
  await reconstructSequenceOwnership(source, target);
  const constraints = await reconstructConstraints(source, target);
  const indexes = await reconstructIndexes(source, target);
  return {
    schemas,
    enums,
    domains,
    composites,
    sequences,
    tables,
    constraints,
    indexes,
    unsupported,
  };
}

/**
 * Create every non-system schema the source uses, so the qualified DDL that
 * follows has somewhere to land. `public` already exists on a fresh target and
 * is skipped.
 *
 * `introspectSchema` covers all non-system schemas, so reconstruction must too —
 * without this a multi-schema source fails on the first qualified `CREATE`.
 */
async function reconstructSchemas(source: PGliteLike, target: PGliteLike): Promise<string[]> {
  const { rows } = await source.query<{ name: string }>(
    `SELECT n.nspname AS name
       FROM pg_namespace n
      WHERE ${SYS} AND n.nspname <> 'public'
      ORDER BY n.nspname`,
  );
  const created: string[] = [];
  for (const r of rows) {
    await target.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(r.name)}`);
    created.push(r.name);
  }
  return created;
}

/** The three custom-type kinds reconstruction emits, bucketed for the report. */
interface CustomTypes {
  enums: string[];
  domains: string[];
  composites: string[];
}

/** One user-declared custom type, as read from `pg_type`. */
interface ReconType {
  oid: number;
  schema: string;
  name: string;
  kind: 'e' | 'd' | 'c';
  /** Enum labels in sort order; empty for other kinds. */
  labels: string[] | null;
  /** Domain base type via `format_type`; null for other kinds. */
  base: string | null;
  notnull: boolean;
  default_expr: string | null;
  collation: string | null;
  collation_schema: string | null;
}

/**
 * Recreate the source's user-declared custom types: enums, domains, and
 * standalone composites (`docs/16`).
 *
 * All three kinds are emitted in **one pass ordered by `pg_type.oid`**, which is
 * a genuine dependency order rather than a heuristic: a type cannot be defined
 * over one that does not exist yet, and creation assigns increasing OIDs, so
 * every dependency has a lower OID than its dependant. That is what makes the
 * cross-kind cases work — a domain over an enum, a composite with a
 * domain-typed attribute, a domain over another domain — which three separate
 * name-ordered passes could not (NFR-16.7).
 *
 * Excluded: `information_schema`'s built-in domains, and the implicit composite
 * row type every table, view and sequence carries in `pg_type` (NFR-16.8).
 */
async function reconstructCustomTypes(
  source: PGliteLike,
  target: PGliteLike,
): Promise<CustomTypes> {
  const { rows } = await source.query<ReconType>(
    `SELECT t.oid::int AS oid, n.nspname AS schema, t.typname AS name, t.typtype AS kind,
            CASE WHEN t.typtype = 'e' THEN (
              SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
                FROM pg_enum e WHERE e.enumtypid = t.oid
            ) END AS labels,
            CASE WHEN t.typtype = 'd'
                 THEN format_type(t.typbasetype, t.typtypmod) END AS base,
            t.typnotnull AS notnull,
            pg_get_expr(t.typdefaultbin, 0) AS default_expr,
            co.collname AS collation,
            cn.nspname AS collation_schema
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_collation co ON co.oid = t.typcollation AND t.typtype = 'd'
       LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
      WHERE ${SYS}
        AND t.typtype IN ('e', 'd', 'c')
        -- A standalone composite has a pg_class entry of relkind 'c'; a table's
        -- implicit row type points at the table itself and must not be emitted.
        AND (t.typtype <> 'c'
             OR EXISTS (SELECT 1 FROM pg_class c
                         WHERE c.oid = t.typrelid AND c.relkind = 'c'))
      ORDER BY t.oid`,
  );

  const checks = await domainChecks(source);
  const out: CustomTypes = { enums: [], domains: [], composites: [] };

  for (const t of rows) {
    const qualified = quoteQualified(t.schema, t.name);
    if (t.kind === 'e') {
      const labels = (t.labels ?? []).map((l) => quoteLiteral(l)).join(', ');
      await target.exec(`CREATE TYPE ${qualified} AS ENUM (${labels})`);
      out.enums.push(tableKey(t));
    } else if (t.kind === 'd') {
      await target.exec(domainDef(qualified, t, checks.get(t.oid) ?? []));
      out.domains.push(tableKey(t));
    } else {
      await target.exec(`CREATE TYPE ${qualified} AS (${await compositeAttrs(source, t.oid)})`);
      out.composites.push(tableKey(t));
    }
  }
  return out;
}

/**
 * Domain CHECK constraints, keyed by the domain's oid.
 *
 * Joined on `contypid` — the *type* a constraint belongs to. `conrelid` is for
 * table constraints and is 0 here. The filter runs on the domain's namespace,
 * not the constraint's, or `information_schema`'s own built-in domain checks
 * (`cardinal_number`, `yes_or_no`, …) come back too.
 */
async function domainChecks(source: PGliteLike): Promise<Map<number, string[]>> {
  const { rows } = await source.query<{ oid: number; name: string; def: string }>(
    `SELECT t.oid::int AS oid, con.conname AS name, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_type t ON t.oid = con.contypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE con.contype = 'c' AND ${SYS}
      ORDER BY t.oid, con.conname`,
  );
  const byType = new Map<number, string[]>();
  for (const r of rows) {
    const clause = `CONSTRAINT ${quoteIdent(r.name)} ${r.def}`;
    byType.set(r.oid, [...(byType.get(r.oid) ?? []), clause]);
  }
  return byType;
}

/** Assemble a `CREATE DOMAIN` statement. */
function domainDef(qualified: string, t: ReconType, checks: string[]): string {
  const parts = [`CREATE DOMAIN ${qualified} AS ${t.base ?? 'text'}`];
  // Emitted deliberately even though NG-9.10 puts collations out of scope:
  // dropping it would silently change comparison and sort semantics for every
  // column of this domain. See docs/16 § Collation.
  if (t.collation !== null && t.collation_schema !== null) {
    parts.push(`COLLATE ${quoteQualified(t.collation_schema, t.collation)}`);
  }
  if (t.default_expr !== null) parts.push(`DEFAULT ${t.default_expr}`);
  if (t.notnull) parts.push('NOT NULL');
  parts.push(...checks);
  return parts.join(' ');
}

/** Render a standalone composite's attributes in physical order. */
async function compositeAttrs(source: PGliteLike, typeOid: number): Promise<string> {
  const { rows } = await source.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_type t
       JOIN pg_attribute a ON a.attrelid = t.typrelid
      WHERE t.oid = ${typeOid.toString()}
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
  );
  return rows.map((r) => `${quoteIdent(r.name)} ${r.type}`).join(', ');
}

interface ReconSequence {
  schema: string;
  name: string;
  data_type: string;
  start_value: string;
  increment_by: string;
  min_value: string;
  max_value: string;
  cycle: boolean;
}

async function reconstructSequences(source: PGliteLike, target: PGliteLike): Promise<string[]> {
  // Standalone (serial) sequences only; identity-owned sequences (deptype 'i')
  // are recreated implicitly by their GENERATED … AS IDENTITY column.
  //
  // `pg_sequence` carries the defining parameters. Emitting them matters even
  // though `applySequences` later setvals `last_value`: that only fixes where
  // the sequence *is*, not how it advances or where it stops (PGLM-77).
  const { rows } = await source.query<ReconSequence>(
    `SELECT n.nspname AS schema, c.relname AS name,
            format_type(s.seqtypid, NULL) AS data_type,
            s.seqstart::text AS start_value,
            s.seqincrement::text AS increment_by,
            s.seqmin::text AS min_value,
            s.seqmax::text AS max_value,
            s.seqcycle AS cycle
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_sequence s ON s.seqrelid = c.oid
      WHERE c.relkind = 'S' AND ${SYS}
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i')
      ORDER BY n.nspname, c.relname`,
  );
  const created: string[] = [];
  for (const r of rows) {
    await target.exec(
      `CREATE SEQUENCE IF NOT EXISTS ${quoteQualified(r.schema, r.name)} AS ${r.data_type}` +
        ` INCREMENT BY ${numericLiteral(r.increment_by, 'sequence increment')}` +
        ` MINVALUE ${numericLiteral(r.min_value, 'sequence minvalue')}` +
        ` MAXVALUE ${numericLiteral(r.max_value, 'sequence maxvalue')}` +
        ` START WITH ${numericLiteral(r.start_value, 'sequence start')}` +
        (r.cycle ? ' CYCLE' : ' NO CYCLE'),
    );
    created.push(tableKey(r));
  }
  return created;
}

/**
 * Re-establish `ALTER SEQUENCE … OWNED BY <table>.<column>` for the sequences a
 * `serial` column owns.
 *
 * Must run after the tables exist. Without it the column default `nextval(…)`
 * still works — which is why the omission hides — but the sequence is orphaned:
 * dropping the table leaves it behind, and `pg_get_serial_sequence` returns
 * null, breaking any tooling that resolves a column's sequence through it.
 */
async function reconstructSequenceOwnership(
  source: PGliteLike,
  target: PGliteLike,
): Promise<void> {
  const { rows } = await source.query<{
    seq_schema: string;
    seq_name: string;
    tbl_schema: string;
    tbl_name: string;
    col: string;
  }>(
    `SELECT n.nspname AS seq_schema, c.relname AS seq_name,
            tn.nspname AS tbl_schema, tc.relname AS tbl_name, a.attname AS col
       FROM pg_depend d
       JOIN pg_class c ON c.oid = d.objid AND c.relkind = 'S'
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class tc ON tc.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'a' AND ${SYS}`,
  );
  for (const r of rows) {
    await target.exec(
      `ALTER SEQUENCE ${quoteQualified(r.seq_schema, r.seq_name)} OWNED BY ` +
        `${quoteQualified(r.tbl_schema, r.tbl_name)}.${quoteIdent(r.col)}`,
    );
  }
}

interface ReconColumn {
  name: string;
  type: string;
  notnull: boolean;
  identity: string;
  generated: string;
  default_expr: string | null;
}

async function reconstructTables(source: PGliteLike, target: PGliteLike): Promise<string[]> {
  const { rows: tables } = await source.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND ${SYS}
      ORDER BY n.nspname, c.relname`,
  );

  const created: string[] = [];
  for (const t of tables) {
    const qualified = quoteQualified(t.schema, t.name);
    const { rows: cols } = await source.query<ReconColumn>(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull,
              a.attidentity AS identity,
              a.attgenerated AS generated,
              pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
         FROM pg_attribute a
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE a.attrelid = ${regclassLiteral(t.schema, t.name)}::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
    );
    const defs = cols.map((c) => columnDef(c)).join(',\n  ');
    await target.exec(`CREATE TABLE ${qualified} (\n  ${defs}\n)`);
    created.push(tableKey(t));
  }
  return created;
}

/** Build a single column definition for CREATE TABLE. */
function columnDef(c: ReconColumn): string {
  const parts = [`${quoteIdent(c.name)} ${c.type}`];
  if (c.identity === 'a') parts.push('GENERATED ALWAYS AS IDENTITY');
  else if (c.identity === 'd') parts.push('GENERATED BY DEFAULT AS IDENTITY');
  else if (c.generated === 's' && c.default_expr !== null) {
    parts.push(`GENERATED ALWAYS AS (${c.default_expr}) STORED`);
  } else if (c.default_expr !== null) {
    parts.push(`DEFAULT ${c.default_expr}`);
  }
  // Identity columns are implicitly NOT NULL; avoid a redundant clause.
  if (c.notnull && c.identity === '') parts.push('NOT NULL');
  return parts.join(' ');
}

async function reconstructConstraints(source: PGliteLike, target: PGliteLike): Promise<string[]> {
  // Emit FKs after all PK/UNIQUE/CHECK (ordered by contype below): every
  // referenced key then already exists, so no per-table (parent-before-child)
  // FK ordering is needed within the FK bucket.
  const { rows } = await source.query<{
    schema: string;
    table: string;
    name: string;
    contype: string;
    def: string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
            con.contype AS contype, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype IN ('p', 'u', 'c', 'f') AND ${SYS}
      ORDER BY CASE con.contype WHEN 'f' THEN 1 ELSE 0 END`, // FKs after PK/UNIQUE/CHECK
  );
  const created: string[] = [];
  for (const r of rows) {
    await target.exec(
      `ALTER TABLE ${quoteQualified(r.schema, r.table)} ADD CONSTRAINT ${quoteIdent(r.name)} ${r.def}`,
    );
    created.push(objectKey(r.schema, r.table, r.name));
  }
  return created;
}

async function reconstructIndexes(source: PGliteLike, target: PGliteLike): Promise<string[]> {
  // Indexes that do not back a constraint (those are created with the constraint).
  const { rows } = await source.query<{ name: string; def: string }>(
    `SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class tc ON tc.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = tc.relnamespace
      WHERE ${SYS}
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
      ORDER BY ic.relname`,
  );
  const created: string[] = [];
  for (const r of rows) {
    await target.exec(r.def);
    created.push(r.name);
  }
  return created;
}

/** One out-of-scope object class: a query returning `{ kind, name }` rows. */
interface Detector {
  /** What NG-9.10 class this covers, for the report's `kind` field. */
  label: string;
  /** SQL yielding `kind` (optional, overrides `label`) and `name` columns. */
  sql: string;
}

/**
 * Every object class NG-9.10 puts out of scope, one query each.
 *
 * Table-driven rather than a run of near-identical blocks: the list is the
 * requirement, so it should read as a list. Each query yields a `name` column
 * already in its reported form, and may yield a `kind` column to distinguish
 * sub-kinds (relkinds, type kinds) within one class.
 */
const DETECTORS: readonly Detector[] = [
  {
    // Views, matviews, partitioned tables, foreign tables — one relkind sweep.
    label: 'relation',
    sql: `SELECT CASE c.relkind
                   WHEN 'v' THEN 'view'
                   WHEN 'm' THEN 'materialized view'
                   WHEN 'p' THEN 'partitioned table'
                   WHEN 'f' THEN 'foreign table'
                 END AS kind,
                 n.nspname || '.' || c.relname AS name
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('v', 'm', 'p', 'f') AND ${SYS}`,
  },
  {
    // Custom-type kinds that are still out of scope. Enums, domains and
    // composites are reconstructed (docs/16), so they are deliberately absent:
    // reporting a type as "not recreated" while recreating it would be worse
    // than either behavior alone (FR-16.3). Ranges remain reported.
    label: 'type',
    sql: `SELECT CASE t.typtype WHEN 'r' THEN 'range type' ELSE 'type' END AS kind,
                 n.nspname || '.' || t.typname AS name
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typtype = 'r' AND ${SYS}`,
  },
  {
    label: 'function',
    sql: `SELECT n.nspname || '.' || p.proname AS name
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE ${SYS}`,
  },
  {
    label: 'trigger',
    sql: `SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS name
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE NOT t.tgisinternal AND ${SYS}`,
  },
  {
    label: 'policy',
    sql: `SELECT n.nspname || '.' || c.relname || '.' || pol.polname AS name
            FROM pg_policy pol
            JOIN pg_class c ON c.oid = pol.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE ${SYS}`,
  },
  {
    // A view's implicit _RETURN rule is the view itself, already reported above.
    label: 'rule',
    sql: `SELECT n.nspname || '.' || c.relname || '.' || r.rulename AS name
            FROM pg_rewrite r
            JOIN pg_class c ON c.oid = r.ev_class
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE r.rulename <> '_RETURN' AND ${SYS}`,
  },
  {
    label: 'operator class',
    sql: `SELECT n.nspname || '.' || o.opcname AS name
            FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace
           WHERE ${SYS}`,
  },
  {
    label: 'collation',
    sql: `SELECT n.nspname || '.' || col.collname AS name
            FROM pg_collation col JOIN pg_namespace n ON n.oid = col.collnamespace
           WHERE ${SYS}`,
  },
  {
    // Comments on user relations and their columns. pg_description also carries
    // the built-in catalog's own docs, hence the join through pg_class.
    label: 'comment',
    sql: `SELECT n.nspname || '.' || c.relname AS name
            FROM pg_description d
            JOIN pg_class c ON c.oid = d.objoid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE ${SYS}
           GROUP BY n.nspname, c.relname`,
  },
  {
    // A relation with no explicit grants has relacl NULL; anything else means
    // privileges were granted and would be lost.
    label: 'grant',
    sql: `SELECT n.nspname || '.' || c.relname AS name
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relacl IS NOT NULL AND ${SYS}`,
  },
  {
    // plpgsql ships with every database; it is not something the source added.
    label: 'extension',
    sql: `SELECT e.extname AS name FROM pg_extension e WHERE e.extname <> 'plpgsql'`,
  },
];

/**
 * Detect out-of-scope objects so they can be reported rather than dropped.
 *
 * Runs before any DDL, which is what lets `onUnsupported: 'error'` refuse with
 * the target still untouched (FR-9.6).
 */
async function detectUnsupported(source: PGliteLike): Promise<UnsupportedObject[]> {
  const found: UnsupportedObject[] = [];
  for (const detector of DETECTORS) {
    const { rows } = await source.query<{ kind?: string | null; name: string }>(detector.sql);
    for (const r of rows) {
      found.push({ kind: r.kind ?? detector.label, name: r.name });
    }
  }
  return found;
}
