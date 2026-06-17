/**
 * Shared types for pglite-migrate.
 *
 * The core never imports `@electric-sql/pglite` directly — it speaks to a
 * minimal structural interface ({@link PGliteLike}) so a caller can hand in two
 * *different* PGlite major versions (an old engine for the source, a new engine
 * for the target) without the library pinning either one.
 */

/** Options accepted on a single query (e.g. the COPY `/dev/blob` payload). */
export interface QueryOptions {
  /** Payload for `COPY … FROM '/dev/blob'`; PGlite returns one for `COPY … TO '/dev/blob'`. */
  blob?: Blob;
}

/** Minimal subset of the PGlite (and node-postgres-ish) query surface we rely on. */
export interface PGliteLike {
  /**
   * Run a parameterized query and return its rows. The optional `options.blob`
   * carries a COPY payload in, and the result may carry a COPY payload out — the
   * mechanism PGlite uses for `COPY … TO/FROM '/dev/blob'`.
   */
  query<R = Record<string, unknown>>(
    query: string,
    params?: unknown[],
    options?: QueryOptions,
  ): Promise<{ rows: R[]; blob?: Blob }>;
  /** Run one or more statements with no parameters (DDL, multi-statement). */
  exec(query: string): Promise<unknown>;
}

/** A column of a user table, in physical order. */
export interface ColumnInfo {
  name: string;
  /** Rendered Postgres type, e.g. `integer`, `text`, `timestamp with time zone`. */
  type: string;
  /**
   * True for a `GENERATED ALWAYS AS (…) STORED` column. Its value is recomputed
   * by the engine from other columns, so it must be excluded from data transfer
   * (supplying a value errors). Absent/false for ordinary columns.
   */
  generated?: boolean;
  /**
   * Identity-column kind (`GENERATED ALWAYS`/`BY DEFAULT AS IDENTITY`), or
   * null/absent when the column is not an identity column.
   */
  identity?: 'always' | 'default' | null;
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

/**
 * Post-migration validation depth:
 * - `off` — no validation.
 * - `counts` — per-table row-count parity + sequence consistency (default).
 * - `full` — also a per-table content digest (stronger, more expensive).
 */
export type ValidationLevel = 'off' | 'counts' | 'full';

/**
 * What to do when a target table already contains rows (re-run safety):
 * - `error` — refuse and throw, naming the offending tables (default, safest).
 * - `truncate` — empty all target tables first (FK-safe), then transfer.
 * - `skip` — leave already-populated tables untouched and transfer the rest.
 */
export type OnExisting = 'error' | 'truncate' | 'skip';

/**
 * What standalone schema reconstruction does when the source contains
 * out-of-scope objects (views, triggers, functions, RLS, partitioning):
 * - `warn` — reconstruct the app-class schema anyway and report the skipped
 *   objects so the operator knows what was not recreated (default).
 * - `error` — refuse before touching the target, since the rebuilt schema would
 *   be incomplete (for strict, no-surprises environments).
 *
 * Either way the objects are never silently dropped.
 */
export type OnUnsupported = 'warn' | 'error';

/** Options for {@link reconstructSchema}. */
export interface ReconstructOptions {
  /** Behavior on out-of-scope objects in the source. Defaults to `warn`. */
  onUnsupported?: OnUnsupported;
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
  /** Post-migration validation depth. Defaults to `counts`. */
  validate?: ValidationLevel;
  /** Behavior when target tables are already populated. Defaults to `error`. */
  onExisting?: OnExisting;
  /** When true, report the plan (source row counts, cycles) and write nothing. */
  dryRun?: boolean;
  /**
   * When true, reconstruct the source's app-class schema on the target before
   * transferring data (the standalone, no-host-app path). Defaults to false
   * (the target schema is assumed to already exist).
   */
  reconstructSchema?: boolean;
  /**
   * Behavior when reconstruction finds out-of-scope objects in the source.
   * Only consulted when `reconstructSchema` is true. Defaults to `warn`.
   */
  onUnsupported?: OnUnsupported;
}

/** Per-table validation outcome. */
export interface TableValidation {
  table: string;
  sourceRows: number;
  targetRows: number;
  /** Present only at the `full` level: whether the content digests matched. */
  digestMatch?: boolean;
  ok: boolean;
}

/** Per-sequence validation outcome. */
export interface SequenceValidation {
  sequence: string;
  sourceValue: string | null;
  targetValue: string | null;
  ok: boolean;
}

/** An out-of-scope object detected during standalone reconstruction. */
export interface UnsupportedObject {
  /** e.g. `view`, `materialized view`, `partitioned table`, `function`, `trigger`, `policy`. */
  kind: string;
  /** Qualified object name. */
  name: string;
}

/** What standalone schema reconstruction created (and could not). */
export interface ReconstructionReport {
  enums: string[];
  sequences: string[];
  tables: string[];
  constraints: string[];
  indexes: string[];
  /** App-out-of-scope objects detected in the source and NOT recreated. */
  unsupported: UnsupportedObject[];
}

/** The outcome of post-migration validation. */
export interface ValidationReport {
  level: ValidationLevel;
  /** True only if every checked table and sequence is consistent. */
  ok: boolean;
  tables: TableValidation[];
  sequences: SequenceValidation[];
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
  /** Which transfer path was used for this table. */
  method?: 'copy' | 'insert';
  /** When `method` is `insert` due to COPY being unavailable, why COPY was skipped. */
  fallbackReason?: string;
}

/** The result of a migration run. */
export interface MigrationReport {
  tables: TableResult[];
  sequencesSet: number;
  totalRows: number;
  warnings: string[];
  /**
   * Tables that were part of a foreign-key cycle and transferred with deferred
   * constraints (see `transferCycle`). Empty when the schema is acyclic.
   */
  deferredTables: string[];
  /** Tables left untouched because they were already populated (`onExisting: 'skip'`). */
  skippedTables: string[];
  /** Post-migration validation result; present unless validation was `off`. */
  validation?: ValidationReport;
  /** Schema reconstruction result; present only when `reconstructSchema` was set. */
  reconstruction?: ReconstructionReport;
}
