import { countRows, tableKey } from './catalog.js';
import { quoteQualified } from './ident.js';
import { introspectSchema } from './introspect.js';
import { reconstructSchema } from './reconstruct.js';
import { applySequences, topologicalSort, transferCycle, transferTable } from './transfer.js';
import type {
  MigrateOptions,
  MigrationReport,
  OnExisting,
  PGliteLike,
  ProgressEvent,
  ReconstructionReport,
  TableInfo,
  TableResult,
  ValidationReport,
} from './types.js';
import { validateMigration } from './validate.js';

/** Count rows currently in a table on the given cluster. */
async function rowCount(db: PGliteLike, table: TableInfo): Promise<number> {
  return countRows(db, quoteQualified(table.schema, table.name));
}

/**
 * Apply the re-run-safety policy to the target before transferring, returning
 * the set of table keys to skip. `error` refuses on any populated table;
 * `truncate` empties all target tables (FK-safe, in one statement); `skip`
 * marks already-populated tables to leave untouched.
 */
async function prepareTarget(
  target: PGliteLike,
  ordered: TableInfo[],
  onExisting: OnExisting,
): Promise<Set<string>> {
  const skip = new Set<string>();
  if (ordered.length === 0) return skip;

  if (onExisting === 'truncate') {
    // Truncating every table in one statement handles mutual FKs atomically.
    const list = ordered.map((t) => quoteQualified(t.schema, t.name)).join(', ');
    await target.exec(`TRUNCATE TABLE ${list}`);
    return skip;
  }

  const populated: string[] = [];
  for (const t of ordered) {
    if ((await rowCount(target, t)) > 0) populated.push(tableKey(t));
  }
  if (onExisting === 'skip') {
    for (const key of populated) skip.add(key);
    return skip;
  }
  // onExisting === 'error'
  if (populated.length > 0) {
    throw new Error(
      `Target already contains rows in: ${populated.join(', ')}. ` +
        `Re-run with onExisting: 'truncate' or 'skip', or start from an empty target.`,
    );
  }
  return skip;
}

/** Synthesize a warning when a table fell back from COPY to row-by-row INSERT. */
function fallbackWarning(result: TableResult): string | null {
  if (result.method === 'insert' && result.fallbackReason !== undefined) {
    return `Table ${result.table}: COPY unavailable (${result.fallbackReason}); fell back to row-by-row INSERT.`;
  }
  return null;
}

/**
 * Compute what a migration *would* do without writing anything to the target:
 * tables in FK-safe order with the source row counts, which tables would be
 * deferred (FK cycles), and how many sequences would be realigned. Returns the
 * same {@link MigrationReport} shape as a real run so output is comparable.
 *
 * This is a separate function (not just a flag) so the dry-run path provably
 * cannot reach `transferTable` / `applySequences`.
 */
export async function planMigration(
  source: PGliteLike,
  onProgress?: (event: ProgressEvent) => void,
): Promise<MigrationReport> {
  const schema = await introspectSchema(source);
  const { ordered, cycles } = topologicalSort(schema.tables, schema.foreignKeys);

  const tables: TableResult[] = [];
  let totalRows = 0;
  for (const table of ordered) {
    const rowsCopied = await rowCount(source, table);
    const result: TableResult = { table: tableKey(table), rowsCopied, method: 'copy' };
    tables.push(result);
    totalRows += rowsCopied;
    onProgress?.(result);
  }

  const sequencesSet = schema.sequences.filter((s) => s.lastValue !== null).length;
  return {
    tables,
    sequencesSet,
    totalRows,
    warnings: [],
    deferredTables: [...cycles],
    skippedTables: [],
  };
}

/**
 * Migrate data from an old-version PGlite engine (`source`) into a new-version
 * engine (`target`) whose schema already exists.
 *
 * This is the v1 app-driven, data-only path: the host application has already
 * created its schema on `target` (typically via its normal startup
 * migrations), so the only job here is to introspect the source, transfer rows
 * in foreign-key-safe order, and re-align sequences.
 *
 * The function performs no DDL on the target and never touches on-disk files
 * directly — both clusters are passed in already open, which is what lets the
 * caller use two different PGlite major versions side by side.
 */
export async function migrate(options: MigrateOptions): Promise<MigrationReport> {
  const { source, target, onProgress } = options;
  if (options.dryRun === true) return planMigration(source, onProgress);

  const level = options.validate ?? 'counts';
  const onExisting = options.onExisting ?? 'error';
  const warnings: string[] = [];

  // Standalone path: build the target's schema from the source first. With
  // onUnsupported: 'error', reconstructSchema throws here before any transfer.
  let reconstruction: ReconstructionReport | undefined;
  if (options.reconstructSchema === true) {
    reconstruction = await reconstructSchema(source, target, {
      onUnsupported: options.onUnsupported ?? 'warn',
    });
    for (const u of reconstruction.unsupported) {
      warnings.push(`Unsupported ${u.kind} not reconstructed: ${u.name}.`);
    }
  }

  const schema = await introspectSchema(source);
  const { ordered, cycles } = topologicalSort(schema.tables, schema.foreignKeys);
  const cyclicSet = new Set(cycles);

  const skip = await prepareTarget(target, ordered, onExisting);
  const skippedTables = [...skip];

  const tables: TableResult[] = [];
  const deferredTables: string[] = [];
  let totalRows = 0;

  // Acyclic tables on the fast path, in FK-safe order.
  for (const table of ordered) {
    if (cyclicSet.has(tableKey(table)) || skip.has(tableKey(table))) continue;
    const result = await transferTable(source, target, table, onProgress);
    tables.push(result);
    totalRows += result.rowsCopied;
    const warning = fallbackWarning(result);
    if (warning !== null) warnings.push(warning);
  }

  // Cyclic subset (if any) transferred together with deferred constraints.
  if (cycles.length > 0) {
    const cyclicTables = ordered.filter(
      (t) => cyclicSet.has(tableKey(t)) && !skip.has(tableKey(t)),
    );
    const cyclicResults = await transferCycle(source, target, cyclicTables, onProgress);
    for (const result of cyclicResults) {
      tables.push(result);
      totalRows += result.rowsCopied;
      deferredTables.push(result.table);
      const warning = fallbackWarning(result);
      if (warning !== null) warnings.push(warning);
    }
  }

  const sequencesSet = await applySequences(target, schema.sequences);

  let validation: ValidationReport | undefined;
  if (level !== 'off' && schema.tables.length > 0) {
    validation = await validateMigration(source, target, schema, level);
    if (!validation.ok) {
      const bad = [
        ...validation.tables.filter((t) => !t.ok).map((t) => t.table),
        ...validation.sequences.filter((s) => !s.ok).map((s) => s.sequence),
      ];
      warnings.push(`Post-migration validation failed for: ${bad.join(', ')}.`);
    }
  }

  return {
    tables,
    sequencesSet,
    totalRows,
    warnings,
    deferredTables,
    skippedTables,
    validation,
    reconstruction,
  };
}
