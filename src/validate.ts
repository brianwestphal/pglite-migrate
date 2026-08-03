import { countRows, tableKey } from './catalog.js';
import { quoteIdent, quoteLiteral, quoteQualified } from './ident.js';
import { introspectSchema } from './introspect.js';
import type {
  PGliteLike,
  SchemaInfo,
  SequenceValidation,
  TableInfo,
  TableValidation,
  ValidationLevel,
  ValidationReport,
} from './types.js';

/**
 * Thrown by {@link migrate} when post-migration validation fails and
 * `onValidationFailure: 'throw'` was requested. Carries the full
 * {@link ValidationReport} so the caller can inspect which tables/sequences
 * diverged. With the default `report` mode this is never thrown.
 */
export class ValidationError extends Error {
  /** The validation report whose `ok` is false. */
  readonly report: ValidationReport;

  constructor(report: ValidationReport, message?: string) {
    super(message ?? `Post-migration validation failed (${report.level}).`);
    this.name = 'ValidationError';
    this.report = report;
  }
}

/**
 * A portable per-table content digest: md5 over the rows' own text rendering,
 * ordered deterministically so row order does not affect the result. Empty
 * tables hash to a stable value. Uses only stable, version-agnostic SQL.
 *
 * The projected column list is what makes this a *content* digest rather than a
 * content-plus-layout one (PGLM-99). A bare whole-row `t::text` renders columns
 * in ordinal-position order, so a target whose columns sit in a different
 * physical order — the norm in the app-driven path, where the source grew by
 * `ALTER TABLE ADD COLUMN` (appends) and the target was built from the app's
 * current `CREATE TABLE` — digests differently despite holding identical data.
 * Projecting an explicit, identically-ordered subset on both sides removes the
 * layout from the hash. Callers pass {@link comparableColumns}' result.
 */
async function tableDigest(
  db: PGliteLike,
  table: TableInfo,
  columns: string[],
): Promise<string> {
  const qualified = quoteQualified(table.schema, table.name);
  const projection = columns.map(quoteIdent).join(', ');
  const { rows } = await db.query<{ d: string | null }>(
    `SELECT md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS d
       FROM (SELECT ${projection} FROM ${qualified}) AS x`,
  );
  return rows[0]?.d ?? '';
}

/** How a table's source columns line up with the target's. */
interface ColumnComparison {
  /** Columns present on both sides, in a canonical (name-sorted) order. */
  compared: string[];
  /** Source columns the target lacks — real data loss; fails validation. */
  missing: string[];
  /** Target-only columns — expected when the app is on a newer schema; reported only. */
  extra: string[];
}

/**
 * Line a table's source columns up against the target's.
 *
 * Sorting by name gives both sides the same projection order regardless of
 * either table's physical layout; the sort is done in JS (not SQL) so the two
 * engines cannot disagree about collation.
 */
function comparableColumns(source: TableInfo, targetColumns: Set<string>): ColumnComparison {
  const sourceNames = source.columns.map((c) => c.name);
  const sourceSet = new Set(sourceNames);
  return {
    compared: sourceNames.filter((n) => targetColumns.has(n)).sort(),
    missing: sourceNames.filter((n) => !targetColumns.has(n)).sort(),
    extra: [...targetColumns].filter((n) => !sourceSet.has(n)).sort(),
  };
}

/** Map of qualified table key → its column names, for one cluster. */
async function columnsByTable(db: PGliteLike): Promise<Map<string, Set<string>>> {
  const schema = await introspectSchema(db);
  return new Map(schema.tables.map((t) => [tableKey(t), new Set(t.columns.map((c) => c.name))]));
}

/** Read a sequence's current value on a cluster, or null if unreadable. */
async function sequenceValue(db: PGliteLike, schema: string, name: string): Promise<string | null> {
  const { rows } = await db.query<{ v: string | number | bigint | null }>(
    `SELECT last_value AS v FROM pg_sequences
      WHERE schemaname = ${quoteLiteral(schema)} AND sequencename = ${quoteLiteral(name)}`,
  );
  if (rows.length === 0) return null;
  const v = rows[0].v;
  return v === null ? null : v.toString();
}

/**
 * Verify a migration landed correctly: per-table row-count parity between
 * source and target (and, at the `full` level, a content digest), plus that
 * each target sequence is at least as advanced as the source. Reads only; never
 * mutates. Returns a report whose `ok` is true only if every check passed.
 *
 * At the `full` level the target is introspected once so each table's digest
 * can be taken over the columns the two sides share (PGLM-99). Columns the
 * target lacks are reported as `missingColumns` and fail the table outright —
 * that is data the migration could not carry. Target-only columns are reported
 * as `extraColumns` and do **not** fail: a host app on a newer schema than the
 * data it is migrating is the expected app-driven case, not an error.
 *
 * @param level - validation depth, `counts` or `full`. The public `validate`
 * option's `off` value is filtered out by `migrate` before reaching here, so
 * this function only accepts the levels that actually do work.
 */
export async function validateMigration(
  source: PGliteLike,
  target: PGliteLike,
  schema: SchemaInfo,
  level: Exclude<ValidationLevel, 'off'>,
): Promise<ValidationReport> {
  // Only the digest level needs the target's layout, and introspecting a whole
  // cluster is not free — keep the default `counts` level as cheap as it was.
  const targetColumns = level === 'full' ? await columnsByTable(target) : null;

  const tables: TableValidation[] = [];
  for (const t of schema.tables) {
    const qualified = quoteQualified(t.schema, t.name);
    const sourceRows = await countRows(source, qualified);
    const targetRows = await countRows(target, qualified);
    let ok = sourceRows === targetRows;
    const entry: TableValidation = { table: tableKey(t), sourceRows, targetRows, ok };

    if (targetColumns !== null) {
      const cols = comparableColumns(t, targetColumns.get(tableKey(t)) ?? new Set());
      entry.comparedColumns = cols.compared;
      if (cols.missing.length > 0) entry.missingColumns = cols.missing;
      if (cols.extra.length > 0) entry.extraColumns = cols.extra;
      // A missing column is a failure on its own, and it also makes the digest
      // meaningless — the source data in that column has nowhere to live.
      if (cols.missing.length > 0) ok = false;
      else if (ok && cols.compared.length > 0) {
        entry.digestMatch =
          (await tableDigest(source, t, cols.compared)) ===
          (await tableDigest(target, t, cols.compared));
        ok = entry.digestMatch;
      }
      // A zero-column table (`CREATE TABLE t()`) has nothing to digest; the
      // row-count check above is the whole verdict.
    }

    entry.ok = ok;
    tables.push(entry);
  }

  const sequences: SequenceValidation[] = [];
  for (const s of schema.sequences) {
    if (s.lastValue === null) continue; // never advanced; nothing to realign or check
    const sourceValue = s.lastValue.toString();
    const targetValue = await sequenceValue(target, s.schema, s.name);
    // The target must be at least as advanced so nextval cannot collide.
    const ok = targetValue !== null && BigInt(targetValue) >= BigInt(sourceValue);
    sequences.push({ sequence: tableKey(s), sourceValue, targetValue, ok });
  }

  const ok = tables.every((t) => t.ok) && sequences.every((s) => s.ok);
  return { level, ok, tables, sequences };
}
