import { introspectSchema } from './introspect.js';
import { applySequences, topologicalSort, transferTable } from './transfer.js';
import type { MigrateOptions, MigrationReport, TableResult } from './types.js';

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
  const warnings: string[] = [];

  const schema = await introspectSchema(source);
  const { ordered, cycles } = topologicalSort(schema.tables, schema.foreignKeys);
  if (cycles.length > 0) {
    warnings.push(
      `Foreign-key cycle among ${cycles.join(', ')}; inserted in original order, which may violate constraints. Consider deferring constraints for these tables.`,
    );
  }

  const tables: TableResult[] = [];
  let totalRows = 0;
  for (const table of ordered) {
    const result = await transferTable(source, target, table, onProgress);
    tables.push(result);
    totalRows += result.rowsCopied;
  }

  const sequencesSet = await applySequences(target, schema.sequences);

  return { tables, sequencesSet, totalRows, warnings };
}
