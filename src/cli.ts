#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { openDataDir, type OpenedCluster } from './loader.js';
import { migrate } from './migrate.js';
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
  -h, --help              Show this help.

Note: v1 transfers data only and assumes the target schema already exists
(created by the host application). Standalone schema reconstruction is planned;
see the project requirements docs.`;

interface CliArgs {
  source: string;
  target: string;
  sourceEngine: string;
  targetEngine: string;
}

/**
 * Parse CLI argv into structured args, or `null` when usage should be printed
 * (`-h`/`--help`, or fewer than two positionals). Throws on an unknown option.
 */
export function parseArgs(argv: string[]): CliArgs | null {
  const positionals: string[] = [];
  let sourceEngine = '@electric-sql/pglite';
  let targetEngine = '@electric-sql/pglite';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return null;
    if (arg === '--source-engine') {
      sourceEngine = argv[++i] ?? '';
    } else if (arg === '--target-engine') {
      targetEngine = argv[++i] ?? '';
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length < 2) return null;
  return { source: positionals[0], target: positionals[1], sourceEngine, targetEngine };
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
    source = await openDataDir(args.source, args.sourceEngine);
    target = await openDataDir(args.target, args.targetEngine);
    const report = await migrate({
      source,
      target,
      onProgress: (e) => {
        io.err(`  ${e.table}: ${e.rowsCopied.toString()} rows`);
      },
    });
    for (const warning of report.warnings) io.err(`warning: ${warning}`);
    io.err(
      `Done: ${report.totalRows.toString()} rows across ${report.tables.length.toString()} tables, ${report.sequencesSet.toString()} sequences aligned.`,
    );
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
