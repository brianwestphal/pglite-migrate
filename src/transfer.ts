import { quoteIdent, quoteLiteral, quoteQualified } from './ident.js';
import type {
  ForeignKey,
  PGliteLike,
  ProgressEvent,
  SequenceInfo,
  TableInfo,
  TableResult,
} from './types.js';

/** The qualified `schema.name` key used to match tables against FK edges. */
function tableKey(t: { schema: string; name: string }): string {
  return `${t.schema}.${t.name}`;
}

/**
 * Order tables so every parent is inserted before its children, satisfying
 * foreign-key constraints during a plain `INSERT` transfer.
 *
 * Pure and side-effect free, so it is unit-tested directly. Tables involved in
 * a dependency cycle (mutually-referential FKs) cannot be linearized; they are
 * appended in their original order and reported via {@link TopoResult.cycles}
 * so the caller can decide how to handle them (e.g. deferred constraints).
 */
export function topologicalSort(tables: TableInfo[], foreignKeys: ForeignKey[]): TopoResult {
  const keys = new Set(tables.map(tableKey));
  // parent -> children, restricted to tables we actually know about.
  const dependsOn = new Map<string, Set<string>>();
  for (const t of tables) dependsOn.set(tableKey(t), new Set());
  for (const fk of foreignKeys) {
    if (keys.has(fk.child) && keys.has(fk.parent) && fk.child !== fk.parent) {
      dependsOn.get(fk.child)?.add(fk.parent);
    }
  }

  const ordered: TableInfo[] = [];
  const placed = new Set<string>();
  const byKey = new Map(tables.map((t) => [tableKey(t), t]));

  // Kahn-style: repeatedly emit tables whose parents are all already placed.
  let progress = true;
  while (placed.size < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      const key = tableKey(t);
      if (placed.has(key)) continue;
      const parents = dependsOn.get(key);
      if (parents && [...parents].every((p) => placed.has(p))) {
        ordered.push(t);
        placed.add(key);
        progress = true;
      }
    }
  }

  const cycles: string[] = [];
  for (const t of tables) {
    const key = tableKey(t);
    if (!placed.has(key)) {
      cycles.push(key);
      const table = byKey.get(key);
      if (table) ordered.push(table);
    }
  }

  return { ordered, cycles };
}

/** Result of {@link topologicalSort}. */
export interface TopoResult {
  ordered: TableInfo[];
  cycles: string[];
}

/**
 * Copy every row of `table` from `source` into `target`.
 *
 * Uses a `COPY … TO/FROM '/dev/blob'` TEXT path that keeps each value in
 * Postgres's own text representation end to end (high fidelity for `json`,
 * `numeric`, `bytea`, and array types — see `docs/7-copy-text-transfer.md`).
 * If COPY is unavailable for this table, it falls back to a row-by-row
 * parameterized `INSERT` for that table and records the reason on the result so
 * the caller can surface a warning.
 *
 * `GENERATED ALWAYS AS (…) STORED` columns are excluded from both paths — the
 * target recomputes them, and supplying a value errors.
 */
export async function transferTable(
  source: PGliteLike,
  target: PGliteLike,
  table: TableInfo,
  onProgress?: (event: ProgressEvent) => void,
): Promise<TableResult> {
  const qualified = quoteQualified(table.schema, table.name);
  // Stored generated columns cannot be written; the engine recomputes them.
  const cols = table.columns.filter((c) => c.generated !== true);
  const colList = cols.map((c) => quoteIdent(c.name)).join(', ');

  let result: TableResult;
  try {
    const rowsCopied = await copyTable(source, target, qualified, colList);
    result = { table: tableKey(table), rowsCopied, method: 'copy' };
  } catch (err) {
    const rowsCopied = await insertTable(source, target, qualified, cols, colList);
    result = {
      table: tableKey(table),
      rowsCopied,
      method: 'insert',
      fallbackReason: err instanceof Error ? err.message : String(err),
    };
  }

  onProgress?.(result);
  return result;
}

/**
 * COPY a table's rows source → target via the `/dev/blob` payload, keeping the
 * values in Postgres's TEXT representation the whole way. Returns the row count.
 */
async function copyTable(
  source: PGliteLike,
  target: PGliteLike,
  qualified: string,
  colList: string,
): Promise<number> {
  if (colList === '') return 0; // nothing transferable (all columns generated)

  // Count first: an empty table yields no COPY payload on some engines, so
  // short-circuit it rather than treating the missing blob as a COPY failure.
  const { rows } = await source.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${qualified}`,
  );
  const rowCount = rows[0]?.n ?? 0;
  if (rowCount === 0) return 0;

  const { blob } = await source.query(`COPY ${qualified} (${colList}) TO '/dev/blob'`);
  if (blob === undefined) throw new Error('COPY TO produced no blob payload');
  await target.query(`COPY ${qualified} (${colList}) FROM '/dev/blob'`, [], { blob });
  return rowCount;
}

/** Row-by-row parameterized INSERT fallback. Returns the row count. */
async function insertTable(
  source: PGliteLike,
  target: PGliteLike,
  qualified: string,
  cols: TableInfo['columns'],
  colList: string,
): Promise<number> {
  if (colList === '') return 0;
  const { rows } = await source.query(`SELECT ${colList} FROM ${qualified}`);

  if (rows.length > 0) {
    const placeholders = cols.map((_, i) => `$${(i + 1).toString()}`).join(', ');
    const insertSql = `INSERT INTO ${qualified} (${colList}) VALUES (${placeholders})`;
    for (const row of rows) {
      const values = cols.map((c) => row[c.name] ?? null);
      await target.query(insertSql, values);
    }
  }
  return rows.length;
}

/** A foreign-key constraint on the target, with the info needed to defer it. */
interface TargetConstraint {
  qualified: string;
  name: string;
  deferrable: boolean;
}

/** Read the target's FK constraints for the given tables (name + deferrability). */
async function targetCycleConstraints(
  target: PGliteLike,
  cyclicTables: TableInfo[],
): Promise<TargetConstraint[]> {
  const constraints: TargetConstraint[] = [];
  for (const t of cyclicTables) {
    const qualified = quoteQualified(t.schema, t.name);
    const { rows } = await target.query<{ name: string; deferrable: boolean }>(
      `SELECT conname AS name, condeferrable AS deferrable
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid = ${quoteLiteral(qualified)}::regclass`,
    );
    for (const r of rows) constraints.push({ qualified, name: r.name, deferrable: r.deferrable });
  }
  return constraints;
}

/**
 * Transfer a foreign-key **cycle** (a set of tables that cannot be linearized)
 * correctly: defer the cyclic FK constraints inside a single target transaction
 * so the rows can be inserted in any order and the constraints are checked once,
 * at commit.
 *
 * Constraints the host app created as `NOT DEFERRABLE` are transiently flipped
 * to `DEFERRABLE` (then restored), since `SET CONSTRAINTS … DEFERRED` only
 * affects deferrable constraints. This is the one sanctioned DDL touch on the
 * target (see `docs/8-fk-cycle-deferred-constraints.md`).
 */
export async function transferCycle(
  source: PGliteLike,
  target: PGliteLike,
  cyclicTables: TableInfo[],
  onProgress?: (event: ProgressEvent) => void,
): Promise<TableResult[]> {
  const toFlip = (await targetCycleConstraints(target, cyclicTables)).filter((c) => !c.deferrable);
  const flipped: TargetConstraint[] = [];
  const results: TableResult[] = [];

  try {
    for (const c of toFlip) {
      await target.query(
        `ALTER TABLE ${c.qualified} ALTER CONSTRAINT ${quoteIdent(c.name)} DEFERRABLE INITIALLY IMMEDIATE`,
      );
      flipped.push(c);
    }

    await target.exec('BEGIN');
    await target.exec('SET CONSTRAINTS ALL DEFERRED');
    for (const t of cyclicTables) {
      results.push(await transferTable(source, target, t, onProgress));
    }
    await target.exec('COMMIT');
  } catch (err) {
    await target.exec('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    // Restore the original NOT DEFERRABLE characteristic on what we flipped.
    for (const c of flipped) {
      await target
        .query(`ALTER TABLE ${c.qualified} ALTER CONSTRAINT ${quoteIdent(c.name)} NOT DEFERRABLE`)
        .catch(() => undefined);
    }
  }

  return results;
}

/**
 * Align each target sequence's current value with the source so `nextval`
 * continues past the migrated rows. Sequences never advanced in the source
 * (null `lastValue`) are left at their fresh state.
 */
export async function applySequences(
  target: PGliteLike,
  sequences: SequenceInfo[],
): Promise<number> {
  let applied = 0;
  for (const seq of sequences) {
    if (seq.lastValue === null) continue;
    const qualified = quoteLiteral(quoteQualified(seq.schema, seq.name));
    await target.query(`SELECT setval(${qualified}::regclass, $1, true)`, [
      seq.lastValue.toString(),
    ]);
    applied++;
  }
  return applied;
}
