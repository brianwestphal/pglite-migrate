/**
 * pglite-migrate — move data between two PGlite major versions without native
 * binaries or `pg_upgrade`.
 *
 * Primary entry point: {@link migrate}, the app-driven, data-only path. The
 * introspection and transfer primitives are exported too, for callers building
 * their own orchestration.
 */
export { introspectSchema } from './introspect.js';
export { openDataDir, type OpenedCluster } from './loader.js';
export { migrate } from './migrate.js';
export { applySequences, topologicalSort, type TopoResult, transferTable } from './transfer.js';
export type {
  ColumnInfo,
  ForeignKey,
  MigrateOptions,
  MigrationReport,
  PGliteLike,
  ProgressEvent,
  SchemaInfo,
  SequenceInfo,
  TableInfo,
  TableResult,
} from './types.js';
export { readClusterVersion } from './version.js';
