import { quoteLiteral, quoteQualified } from './ident.js';
import type {
  PGliteLike,
  SchemaInfo,
  SequenceValidation,
  TableInfo,
  TableValidation,
  ValidationLevel,
  ValidationReport,
} from './types.js';

/** Count rows in a table (version-agnostic). */
async function countRows(db: PGliteLike, qualified: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${qualified}`);
  return rows[0]?.n ?? 0;
}

/**
 * A portable per-table content digest: md5 over the rows' own text rendering,
 * ordered deterministically so row order does not affect the result. Empty
 * tables hash to a stable value. Uses only stable, version-agnostic SQL.
 */
async function tableDigest(db: PGliteLike, table: TableInfo): Promise<string> {
  const qualified = quoteQualified(table.schema, table.name);
  const { rows } = await db.query<{ d: string | null }>(
    `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS d
       FROM ${qualified} AS t`,
  );
  return rows[0]?.d ?? '';
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
 */
export async function validateMigration(
  source: PGliteLike,
  target: PGliteLike,
  schema: SchemaInfo,
  level: Exclude<ValidationLevel, 'off'>,
): Promise<ValidationReport> {
  const tables: TableValidation[] = [];
  for (const t of schema.tables) {
    const qualified = quoteQualified(t.schema, t.name);
    const sourceRows = await countRows(source, qualified);
    const targetRows = await countRows(target, qualified);
    let ok = sourceRows === targetRows;
    let digestMatch: boolean | undefined;
    if (level === 'full' && ok) {
      digestMatch = (await tableDigest(source, t)) === (await tableDigest(target, t));
      ok = digestMatch;
    }
    tables.push({ table: `${t.schema}.${t.name}`, sourceRows, targetRows, digestMatch, ok });
  }

  const sequences: SequenceValidation[] = [];
  for (const s of schema.sequences) {
    if (s.lastValue === null) continue; // never advanced; nothing to realign or check
    const sourceValue = s.lastValue.toString();
    const targetValue = await sequenceValue(target, s.schema, s.name);
    // The target must be at least as advanced so nextval cannot collide.
    const ok = targetValue !== null && BigInt(targetValue) >= BigInt(sourceValue);
    sequences.push({ sequence: `${s.schema}.${s.name}`, sourceValue, targetValue, ok });
  }

  const ok = tables.every((t) => t.ok) && sequences.every((s) => s.ok);
  return { level, ok, tables, sequences };
}
