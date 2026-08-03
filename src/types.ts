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

/**
 * What an acquired engine leaves behind on disk:
 * - `keep` — extract into a shared cache directory and reuse it on later runs
 *   (default). A retried migration must not re-download the engine.
 * - `ephemeral` — extract into a fresh temporary directory and remove it when
 *   the run finishes, successfully or not. Never reads or writes the shared
 *   cache, so it always downloads; that is the trade the caller opted into.
 */
export type EngineCacheMode = 'keep' | 'ephemeral';

/**
 * A pinned, known-good `@electric-sql/pglite` release for one Postgres major.
 *
 * Engine acquisition only ever needs the *source* side (the host application
 * supplies the target it was built against), and old majors are frozen history —
 * so a pinned table does not rot the way version allowlists usually do.
 */
export interface EngineRelease {
  /** Postgres major this engine bundles, as stamped into the data dir's `PG_VERSION`. */
  postgresMajor: number;
  /** The `@electric-sql/pglite` version to acquire. */
  version: string;
  /**
   * npm `dist.integrity` for that version's tarball (sha512, base64). Pinned
   * in-package rather than read from the registry at fetch time, so a
   * compromised or spoofed registry response cannot get code past us.
   */
  integrity: string;
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
 * What `migrate` does when post-migration validation fails:
 * - `report` — return the {@link MigrationReport} with `validation.ok === false`
 *   and a warning; the caller decides what to do (default, non-breaking).
 * - `throw` — raise a typed `ValidationError` (carrying the `ValidationReport`)
 *   so an unattended host cannot accidentally ignore a falsy `ok` (FR-13.4).
 */
export type OnValidationFailure = 'report' | 'throw';

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
  /**
   * What to do when validation fails: `report` (default — return a report with
   * `validation.ok === false`) or `throw` (raise a typed `ValidationError`).
   */
  onValidationFailure?: OnValidationFailure;
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
  /**
   * True when the target has no such table at all — the strongest failure this
   * report carries, and the reason `targetRows` reads 0 rather than being
   * counted (counting would raise `relation "…" does not exist`). Checked at
   * every level; omitted when the table is present.
   */
  missingTable?: boolean;
  /**
   * Present only at the `full` level, and only when a digest was actually
   * taken: whether the content digests matched. Absent when the row counts
   * already diverged, when the target lacks the table or a source column, or
   * when the table has no comparable columns at all.
   */
  digestMatch?: boolean;
  /**
   * Present only at the `full` level: the columns the digest compared — the
   * source/target intersection, name-sorted. Recorded so a mismatch is
   * diagnosable without re-deriving which columns took part (PGLM-99).
   */
  comparedColumns?: string[];
  /**
   * Source columns the target does not have. Real data loss, so the table fails.
   * Present only at the `full` level, and omitted when empty.
   */
  missingColumns?: string[];
  /**
   * Columns the target has and the source does not. Expected whenever the host
   * app is on a newer schema than the data being migrated, so these are
   * reported but do **not** fail the table. Present only at the `full` level,
   * and omitted when empty.
   */
  extraColumns?: string[];
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
  /** Non-`public` schemas created on the target so qualified objects can land. */
  schemas: string[];
  enums: string[];
  /** Domain types recreated with their base type, default, NOT NULL, collation and CHECKs. */
  domains: string[];
  /** Standalone composite types recreated with their attributes in physical order. */
  composites: string[];
  /**
   * Range types recreated. Excludes any range depending on a canonical or
   * subdiff **function** — those stay in {@link ReconstructionReport.unsupported},
   * since functions are out of scope and Postgres cannot create such a range in
   * a single statement anyway (`docs/17`).
   */
  ranges: string[];
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
  /**
   * The re-run policy this run applied, including the default when the caller
   * did not pass one — so a report is self-describing (FR-14.5).
   */
  onExisting: OnExisting;
  /**
   * Tables that already held rows and were emptied before transfer under
   * `onExisting: 'truncate'` (FR-14.10).
   *
   * Always empty under `error` and `skip`. This is the only record that a
   * destructive re-run discarded data: without it a `truncate` run is
   * indistinguishable from a clean first run.
   */
  truncatedTables: string[];
  /** Post-migration validation result; present unless validation was `off`. */
  validation?: ValidationReport;
  /** Schema reconstruction result; present only when `reconstructSchema` was set. */
  reconstruction?: ReconstructionReport;
}
