#!/usr/bin/env node
import { openDataDir } from './loader.js';
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

function parseArgs(argv: string[]): CliArgs | null {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    return;
  }

  const sourceVersion = await readClusterVersion(args.source).catch(() => null);
  const targetVersion = await readClusterVersion(args.target).catch(() => null);
  console.error(
    `Migrating ${args.source} (PG ${sourceVersion?.toString() ?? '?'}) -> ${args.target} (PG ${targetVersion?.toString() ?? '?'})`,
  );

  const source = await openDataDir(args.source, args.sourceEngine);
  const target = await openDataDir(args.target, args.targetEngine);
  try {
    const report = await migrate({
      source,
      target,
      onProgress: (e) => {
        console.error(`  ${e.table}: ${e.rowsCopied.toString()} rows`);
      },
    });
    for (const warning of report.warnings) console.error(`warning: ${warning}`);
    console.error(
      `Done: ${report.totalRows.toString()} rows across ${report.tables.length.toString()} tables, ${report.sequencesSet.toString()} sequences aligned.`,
    );
  } finally {
    await source.close();
    await target.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
