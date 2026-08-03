#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { backupDataDir, type BackupOptions } from './backup.js';
import { openDataDir, type OpenedCluster, type OpenOptions } from './loader.js';
import { migrate } from './migrate.js';
import { assertEngineMatchesDataDir } from './precheck.js';
import type {
  EngineCacheMode,
  OnExisting,
  OnUnsupported,
  OnValidationFailure,
  ValidationLevel,
  ValidationReport,
} from './types.js';
import { readClusterVersion } from './version.js';

const USAGE = `pglite-migrate — migrate PGlite data across PostgreSQL major versions

Usage:
  pglite-migrate <source-data-dir> <target-data-dir> [options]

Arguments:
  source-data-dir   Existing PGlite data directory (the old version).
  target-data-dir   Target PGlite data directory whose schema already exists.

Options:
  --source-engine <pkg>   npm module/alias for the source engine (default: @electric-sql/pglite)
  --target-engine <pkg>   npm module/alias for the target engine (default: @electric-sql/pglite)
  --source-database <db>  Database to open on the source (PGlite's own default otherwise).
  --target-database <db>  Database to open on the target (PGlite's own default otherwise).
  --fetch-missing-engine  Download a pinned engine when the named one is not installed.
  --engine-cache <mode>   Retention for a downloaded engine: keep | ephemeral (default: keep)
  --engine-cache-dir <p>  Where to store downloaded engines (default: an OS cache directory).
  --validate <level>      Post-migration validation: off | counts | full (default: counts)
  --strict                On validation failure, throw a ValidationError (default: report + exit non-zero)
  --on-existing <mode>    Non-empty target: error | truncate | skip (default: error)
  --backup                Back up the source data dir before migrating.
  --backup-dir <path>     Where to write the backup (default: <source>.bak-<timestamp>).
  --keep <n>              Retain at most n timestamped backups; prune the oldest (default: keep all).
  --reconstruct-schema    Rebuild the source's app-class schema on an empty target first.
  --on-unsupported <mode> With --reconstruct-schema, on out-of-scope objects: warn | error (default: warn)
  --dry-run               Report the plan without writing anything to the target.
  -h, --help              Show this help.

Note: by default the target schema must already exist (created by the host
application); pass --reconstruct-schema to rebuild it from the source for a
standalone (no-host-app) migration. Out-of-scope objects (views, triggers,
functions, RLS, partitioning) are reported, not recreated.

Engines are resolved from node_modules first; --fetch-missing-engine only
applies when a named engine does not resolve at all. It downloads and then runs
code from the npm registry, so it is off unless you ask for it.

PGlite 0.4.0 changed the default working database from template1 to postgres.
If a cluster was written by an older PGlite, its tables live in template1 and a
default open finds nothing — pass --source-database template1 for that side.`;

interface CliArgs {
  source: string;
  target: string;
  sourceEngine: string;
  targetEngine: string;
  /** PGlite `database` option for the source; undefined leaves PGlite's default. */
  sourceDatabase?: string;
  /** PGlite `database` option for the target; undefined leaves PGlite's default. */
  targetDatabase?: string;
  validate: ValidationLevel;
  onValidationFailure: OnValidationFailure;
  onExisting: OnExisting;
  dryRun: boolean;
  backup: boolean;
  backupDir?: string;
  keep?: number;
  reconstructSchema: boolean;
  onUnsupported: OnUnsupported;
  fetchMissingEngine: boolean;
  engineCache: EngineCacheMode;
  engineCacheDir?: string;
}

function parseValidationLevel(value: string): ValidationLevel {
  if (value === 'off' || value === 'counts' || value === 'full') return value;
  throw new Error(`Invalid --validate level: ${value} (expected off, counts, or full)`);
}

function parseOnExisting(value: string): OnExisting {
  if (value === 'error' || value === 'truncate' || value === 'skip') return value;
  throw new Error(`Invalid --on-existing mode: ${value} (expected error, truncate, or skip)`);
}

function parseOnUnsupported(value: string): OnUnsupported {
  if (value === 'warn' || value === 'error') return value;
  throw new Error(`Invalid --on-unsupported mode: ${value} (expected warn or error)`);
}

function parseEngineCache(value: string): EngineCacheMode {
  if (value === 'keep' || value === 'ephemeral') return value;
  throw new Error(`Invalid --engine-cache mode: ${value} (expected keep or ephemeral)`);
}

function parseKeep(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --keep value: ${value} (expected a positive integer)`);
  }
  return n;
}

/**
 * Parse CLI argv into structured args, or `null` when usage should be printed
 * (`-h`/`--help`, or fewer than two positionals). Throws on an unknown option.
 */
export function parseArgs(argv: string[]): CliArgs | null {
  const positionals: string[] = [];
  let sourceEngine = '@electric-sql/pglite';
  let targetEngine = '@electric-sql/pglite';
  let sourceDatabase: string | undefined;
  let targetDatabase: string | undefined;
  let validate: ValidationLevel = 'counts';
  let onValidationFailure: OnValidationFailure = 'report';
  let onExisting: OnExisting = 'error';
  let dryRun = false;
  let backup = false;
  let backupDir: string | undefined;
  let keep: number | undefined;
  let reconstructSchema = false;
  let onUnsupported: OnUnsupported = 'warn';
  let fetchMissingEngine = false;
  let engineCache: EngineCacheMode = 'keep';
  let engineCacheDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return null;
    if (arg === '--source-engine') {
      sourceEngine = argv[++i] ?? '';
    } else if (arg === '--target-engine') {
      targetEngine = argv[++i] ?? '';
    } else if (arg === '--source-database') {
      sourceDatabase = argv[++i] ?? '';
    } else if (arg === '--target-database') {
      targetDatabase = argv[++i] ?? '';
    } else if (arg === '--validate') {
      validate = parseValidationLevel(argv[++i] ?? '');
    } else if (arg === '--strict') {
      onValidationFailure = 'throw';
    } else if (arg === '--on-existing') {
      onExisting = parseOnExisting(argv[++i] ?? '');
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--backup') {
      backup = true;
    } else if (arg === '--backup-dir') {
      backupDir = argv[++i] ?? '';
      backup = true;
    } else if (arg === '--keep') {
      keep = parseKeep(argv[++i] ?? '');
      backup = true;
    } else if (arg === '--reconstruct-schema' || arg === '--standalone') {
      reconstructSchema = true;
    } else if (arg === '--on-unsupported') {
      onUnsupported = parseOnUnsupported(argv[++i] ?? '');
    } else if (arg === '--fetch-missing-engine') {
      fetchMissingEngine = true;
    } else if (arg === '--engine-cache') {
      engineCache = parseEngineCache(argv[++i] ?? '');
    } else if (arg === '--engine-cache-dir') {
      engineCacheDir = argv[++i] ?? '';
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length < 2) return null;
  return {
    source: positionals[0],
    target: positionals[1],
    sourceEngine,
    targetEngine,
    sourceDatabase,
    targetDatabase,
    validate,
    onValidationFailure,
    onExisting,
    dryRun,
    backup,
    backupDir,
    keep,
    reconstructSchema,
    onUnsupported,
    fetchMissingEngine,
    engineCache,
    engineCacheDir,
  };
}

/** Output sinks, injectable so the run logic is testable without spawning. */
export interface CliIO {
  out: (message: string) => void;
  err: (message: string) => void;
}

const defaultIO: CliIO = {
  out: (m) => {
    console.log(m);
  },
  err: (m) => {
    console.error(m);
  },
};

/**
 * Build the engine-loading options for one side of the migration.
 *
 * The already-read `PG_VERSION` is passed through as `major` so acquisition
 * still works for a target directory that does not exist yet.
 *
 * `database` is left off entirely unless the operator named one, so the common
 * invocation still constructs the engine with no options object at all.
 */
function openOptions(args: CliArgs, major: number | null, database?: string): OpenOptions {
  const options: OpenOptions = { fetchMissingEngine: args.fetchMissingEngine };
  if (args.fetchMissingEngine) {
    options.cache = args.engineCache;
    if (args.engineCacheDir !== undefined) options.cacheDir = args.engineCacheDir;
    if (major !== null) options.major = major;
  }
  if (database !== undefined) options.pgliteOptions = { database };
  return options;
}

/** Report an engine that had to be downloaded, the way a backup is reported. */
function reportAcquired(io: CliIO, side: string, cluster: OpenedCluster): void {
  const acquired = cluster.acquired;
  if (acquired === undefined) return;
  const origin = acquired.fromCache ? 'from cache' : 'downloaded';
  io.err(`Acquired ${side} engine @electric-sql/pglite@${acquired.version} (${origin})`);
}

/**
 * Print the validation outcome: the per-table and per-sequence detail, then the
 * one-line verdict.
 *
 * Detail is printed for every entry on a failure (so the operator sees the
 * mismatched numbers, not just which table diverged) and only for the
 * mismatches on a pass — which is none, keeping a healthy run quiet. The
 * source-vs-target counts are the first thing anyone triaging a failed
 * unattended upgrade wants, and they were previously only reachable from the
 * library's `report.validation`.
 */
function reportValidation(io: CliIO, validation: ValidationReport): void {
  if (!validation.ok) {
    for (const t of validation.tables) {
      const mark = t.ok ? '=' : '≠';
      const notes: string[] = [];
      if (t.digestMatch === false) notes.push('digest mismatch');
      // Naming the missing columns is the whole diagnostic here: the counts
      // match, so without them a failed table looks identical to a digest drift.
      if (t.missingColumns !== undefined) {
        notes.push(`missing on target: ${t.missingColumns.join(', ')}`);
      }
      const detail = notes.length > 0 ? ` (${notes.join('; ')})` : '';
      const counts = `${t.sourceRows.toString()} ${mark} ${t.targetRows.toString()}`;
      io.err(`  ${t.table}: ${counts}${detail}`);
    }
    for (const s of validation.sequences) {
      const mark = s.ok ? '>=' : '<';
      const values = `source ${s.sourceValue ?? 'null'} ${mark} target ${s.targetValue ?? 'null'}`;
      io.err(`  ${s.sequence}: ${values}`);
    }
  }
  io.err(`Validation (${validation.level}): ${validation.ok ? 'OK' : 'FAILED'}.`);
}

/**
 * Execute the CLI for the given argv and return a process exit code (0 on
 * success / help, 1 on error). Side effects go through {@link CliIO} so tests
 * can capture them.
 */
export async function run(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let args: CliArgs | null;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (args === null) {
    io.out(USAGE);
    return 0;
  }

  const sourceVersion = await readClusterVersion(args.source).catch(() => null);
  const targetVersion = await readClusterVersion(args.target).catch(() => null);
  io.err(
    `Migrating ${args.source} (PG ${sourceVersion?.toString() ?? '?'}) -> ${args.target} (PG ${targetVersion?.toString() ?? '?'})`,
  );

  let source: OpenedCluster | undefined;
  let target: OpenedCluster | undefined;
  try {
    if (args.backup && !args.dryRun) {
      const backupOptions: BackupOptions = {};
      if (args.backupDir !== undefined) backupOptions.backupDir = args.backupDir;
      if (args.keep !== undefined) backupOptions.keep = args.keep;
      const path = await backupDataDir(args.source, backupOptions);
      io.err(`Backed up source to ${path}`);
    }
    source = await openDataDir(
      args.source,
      args.sourceEngine,
      openOptions(args, sourceVersion, args.sourceDatabase),
    );
    reportAcquired(io, 'source', source);
    await assertEngineMatchesDataDir(source, {
      dataDir: args.source,
      expectedMajor: sourceVersion,
      side: 'source',
      engine: args.sourceEngine,
    });

    target = await openDataDir(
      args.target,
      args.targetEngine,
      openOptions(args, targetVersion, args.targetDatabase),
    );
    reportAcquired(io, 'target', target);
    if (!args.dryRun) {
      // Skipped under --dry-run: the check has to query the target, which boots
      // the cluster and writes to it. A dry run must leave the target
      // byte-for-byte unchanged (FR-12.1), and it never touches it otherwise.
      await assertEngineMatchesDataDir(target, {
        dataDir: args.target,
        expectedMajor: targetVersion,
        side: 'target',
        engine: args.targetEngine,
      });
    }
    if (args.dryRun) io.err('DRY RUN — no changes will be written to the target.');
    const report = await migrate({
      source,
      target,
      validate: args.validate,
      onValidationFailure: args.onValidationFailure,
      onExisting: args.onExisting,
      dryRun: args.dryRun,
      reconstructSchema: args.reconstructSchema,
      onUnsupported: args.onUnsupported,
      onProgress: (e) => {
        io.err(`  ${e.table}: ${e.rowsCopied.toString()} rows`);
      },
    });
    for (const warning of report.warnings) io.err(`warning: ${warning}`);
    const verb = args.dryRun ? 'Plan' : 'Done';
    io.err(
      `${verb}: ${report.totalRows.toString()} rows across ${report.tables.length.toString()} tables, ${report.sequencesSet.toString()} sequences aligned.`,
    );
    if (report.validation !== undefined) {
      reportValidation(io, report.validation);
      if (!report.validation.ok) return 1;
    }
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    // Closing must not mask the real failure. A cluster that never initialized
    // (the classic case: an engine pointed at a data directory of another major)
    // rejects on close, and letting that escape would both append a confusing
    // second error to a clean diagnostic and bypass this function's exit code.
    await source?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
  }
}

/** Entry point: only runs when this module is the process entry, not on import. */
const entryArg = process.argv[1] as string | undefined;
const isEntry = entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href;
if (isEntry) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
