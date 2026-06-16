/**
 * Shared types for pglite-migrate.
 *
 * The core never imports `@electric-sql/pglite` directly — it speaks to a
 * minimal structural interface ({@link PGliteLike}) so a caller can hand in two
 * *different* PGlite major versions (an old engine for the source, a new engine
 * for the target) without the library pinning either one.
 */

/** Minimal subset of the PGlite (and node-postgres-ish) query surface we rely on. */
export interface PGliteLike {
  /** Run a parameterized query and return its rows. */
  query<R = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
  /** Run one or more statements with no parameters (DDL, multi-statement). */
  exec(query: string): Promise<unknown>;
}

/** A column of a user table, in physical order. */
export interface ColumnInfo {
  name: string;
  /** Rendered Postgres type, e.g. `integer`, `text`, `timestamp with time zone`. */
  type: string;
}

/** A user table and its columns. */
export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

/** A foreign-key edge: rows in `child` reference rows in `parent`. */
export interface ForeignKey {
  child: string;
  parent: string;
}

/** A sequence and its captured current value (null if never advanced). */
export interface SequenceInfo {
  schema: string;
  name: string;
  lastValue: string | number | bigint | null;
}

/** The full introspected shape of a cluster's user schema. */
export interface SchemaInfo {
  tables: TableInfo[];
  foreignKeys: ForeignKey[];
  sequences: SequenceInfo[];
}

/** Options for a single migration run. */
export interface MigrateOptions {
  /** The old-version engine, opened on the existing data. */
  source: PGliteLike;
  /**
   * The new-version engine. For the v1 app-driven path the target's schema is
   * assumed to already exist (the host app created it on startup); this library
   * transfers data only.
   */
  target: PGliteLike;
  /** Optional progress callback, invoked once per table as it is copied. */
  onProgress?: (event: ProgressEvent) => void;
}

/** Emitted as each table is transferred. */
export interface ProgressEvent {
  table: string;
  rowsCopied: number;
}

/** Per-table outcome. */
export interface TableResult {
  table: string;
  rowsCopied: number;
}

/** The result of a migration run. */
export interface MigrationReport {
  tables: TableResult[];
  sequencesSet: number;
  totalRows: number;
  warnings: string[];
}
