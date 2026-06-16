#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { backupDataDir } from './backup.js';
import { openDataDir, type OpenedCluster } from './loader.js';
import { migrate } from './migrate.js';
import type { OnExisting, ValidationLevel } from './types.js';
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
  --validate <level>      Post-migration validation: off | counts | full (default: counts)
  --on-existing <mode>    Non-empty target: error | truncate | skip (default: error)
  --backup                Back up the source data dir before migrating.
  --backup-dir <path>     Where to write the backup (default: <source>.bak-<timestamp>).
  --reconstruct-schema    Rebuild the source's app-class schema on an empty target first.
  --dry-run               Report the plan without writing anything to the target.
  -h, --help              Show this help.

Note: by default the target schema must already exist (created by the host
application); pass --reconstruct-schema to rebuild it from the source for a
standalone (no-host-app) migration. Out-of-scope objects (views, triggers,
functions, RLS, partitioning) are reported, not recreated.`;

interface CliArgs {
  source: string;
  target: string;
  sourceEngine: string;
  targetEngine: string;
  validate: ValidationLevel;
  onExisting: OnExisting;
  dryRun: boolean;
  backup: boolean;
  backupDir?: string;
  reconstructSchema: boolean;
}

function parseValidationLevel(value: string): ValidationLevel {
  if (value === 'off' || value === 'counts' || value === 'full') return value;
  throw new Error(`Invalid --validate level: ${value} (expected off, counts, or full)`);
}

function parseOnExisting(value: string): OnExisting {
  if (value === 'error' || value === 'truncate' || value === 'skip') return value;
  throw new Error(`Invalid --on-existing mode: ${value} (expected error, truncate, or skip)`);
}

/**
 * Parse CLI argv into structured args, or `null` when usage should be printed
 * (`-h`/`--help`, or fewer than two positionals). Throws on an unknown option.
 */
export function parseArgs(argv: string[]): CliArgs | null {
  const positionals: string[] = [];
  let sourceEngine = '@electric-sql/pglite';
  let targetEngine = '@electric-sql/pglite';
  let validate: ValidationLevel = 'counts';
  let onExisting: OnExisting = 'error';
  let dryRun = false;
  let backup = false;
  let backupDir: string | undefined;
  let reconstructSchema = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return null;
    if (arg === '--source-engine') {
      sourceEngine = argv[++i] ?? '';
    } else if (arg === '--target-engine') {
      targetEngine = argv[++i] ?? '';
    } else if (arg === '--validate') {
      validate = parseValidationLevel(argv[++i] ?? '');
    } else if (arg === '--on-existing') {
      onExisting = parseOnExisting(argv[++i] ?? '');
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--backup') {
      backup = true;
    } else if (arg === '--backup-dir') {
      backupDir = argv[++i] ?? '';
      backup = true;
    } else if (arg === '--reconstruct-schema' || arg === '--standalone') {
      reconstructSchema = true;
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
    validate,
    onExisting,
    dryRun,
    backup,
    backupDir,
    reconstructSchema,
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
      const path = await backupDataDir(
        args.source,
        args.backupDir !== undefined ? { backupDir: args.backupDir } : {},
      );
      io.err(`Backed up source to ${path}`);
    }
    source = await openDataDir(args.source, args.sourceEngine);
    target = await openDataDir(args.target, args.targetEngine);
    if (args.dryRun) io.err('DRY RUN — no changes will be written to the target.');
    const report = await migrate({
      source,
      target,
      validate: args.validate,
      onExisting: args.onExisting,
      dryRun: args.dryRun,
      reconstructSchema: args.reconstructSchema,
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
      io.err(
        `Validation (${report.validation.level}): ${report.validation.ok ? 'OK' : 'FAILED'}.`,
      );
      if (!report.validation.ok) return 1;
    }
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await source?.close();
    await target?.close();
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
