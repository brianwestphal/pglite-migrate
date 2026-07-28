/**
 * pglite-migrate — move data between two PGlite major versions without native
 * binaries or `pg_upgrade`.
 *
 * Primary entry point: {@link migrate}, the app-driven, data-only path. The
 * introspection and transfer primitives are exported too, for callers building
 * their own orchestration.
 */
export { backupDataDir, type BackupOptions } from './backup.js';
export {
  knownMajors,
  PGLITE_PACKAGE,
  resolveEngine,
  UnknownMajorError,
} from './engines/registry.js';
export { introspectSchema } from './introspect.js';
export { openDataDir, type OpenedCluster, type OpenOptions } from './loader.js';
export { migrate, planMigration } from './migrate.js';
export {
  assertEngineMatchesDataDir,
  type EngineCheckOptions,
  EngineMismatchError,
} from './precheck.js';
export { reconstructSchema } from './reconstruct.js';
export { swapIntoPlace, type SwapOptions, type SwapResult } from './swap.js';
export {
  applySequences,
  topologicalSort,
  type TopoResult,
  transferCycle,
  transferTable,
} from './transfer.js';
export type {
  ColumnInfo,
  EngineCacheMode,
  EngineRelease,
  ForeignKey,
  MigrateOptions,
  MigrationReport,
  OnExisting,
  OnUnsupported,
  OnValidationFailure,
  PGliteLike,
  ProgressEvent,
  QueryOptions,
  ReconstructionReport,
  ReconstructOptions,
  SchemaInfo,
  SequenceInfo,
  SequenceValidation,
  TableInfo,
  TableResult,
  TableValidation,
  UnsupportedObject,
  ValidationLevel,
  ValidationReport,
} from './types.js';
export { validateMigration, ValidationError } from './validate.js';
export { readClusterVersion, readEngineMajor } from './version.js';
