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
 * v1 uses a row-by-row parameterized `INSERT`. This is correct for the common
 * app schemas the library targets; the documented next step is a COPY-text
 * path that keeps values in Postgres's own text representation end to end for
 * higher fidelity on `json`, `numeric`, `bytea`, and array types.
 */
export async function transferTable(
  source: PGliteLike,
  target: PGliteLike,
  table: TableInfo,
  onProgress?: (event: ProgressEvent) => void,
): Promise<TableResult> {
  const qualified = quoteQualified(table.schema, table.name);
  const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ');
  const { rows } = await source.query(`SELECT ${colList} FROM ${qualified}`);

  if (rows.length > 0) {
    const placeholders = table.columns.map((_, i) => `$${(i + 1).toString()}`).join(', ');
    const insertSql = `INSERT INTO ${qualified} (${colList}) VALUES (${placeholders})`;
    for (const row of rows) {
      const values = table.columns.map((c) => row[c.name] ?? null);
      await target.query(insertSql, values);
    }
  }

  const result: TableResult = { table: tableKey(table), rowsCopied: rows.length };
  onProgress?.(result);
  return result;
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
