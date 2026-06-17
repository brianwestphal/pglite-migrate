#!/usr/bin/env node
/**
 * Re-capturable CLI demos for the README.
 *
 * Each demo provisions throwaway PGlite data directories on two *different*
 * PostgreSQL majors — `pglite-old` (PG17, 0.4.x) for the source and
 * `pglite-new` (PG18, 0.5.x) for the target — then runs the real built CLI
 * (`dist/cli.js`) against them and captures its actual transcript.
 *
 *   npm run build && node scripts/demo.mjs            # print every demo
 *   node scripts/demo.mjs > /tmp/demos.txt            # capture for the README
 *
 * The transcripts pasted into README.md are the verbatim output of this script,
 * so re-running it after a behavior change is how the README demos are refreshed.
 * Nothing here is committed state — every run uses a fresh temp directory.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite as PGliteNew } from 'pglite-new'; // PG18
import { PGlite as PGliteOld } from 'pglite-old'; // PG17

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

const SCHEMA_SQL = `
CREATE TABLE authors (
  id serial PRIMARY KEY,
  name text NOT NULL,
  metadata jsonb
);

CREATE TABLE books (
  id serial PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors (id),
  title text NOT NULL,
  price numeric(8, 2),
  published_at timestamptz
);
`;

const SEED_SQL = `
INSERT INTO authors (name, metadata) VALUES
  ('Ursula K. Le Guin', '{"awards": ["Hugo", "Nebula"]}'),
  ('Octavia E. Butler', '{"awards": ["MacArthur"]}'),
  ('N. K. Jemisin',     '{"awards": ["Hugo"]}');

INSERT INTO books (author_id, title, price, published_at) VALUES
  (1, 'A Wizard of Earthsea', 9.99,  '1968-01-01T00:00:00Z'),
  (1, 'The Dispossessed',     12.50, '1974-01-01T00:00:00Z'),
  (2, 'Kindred',              11.00, '1979-01-01T00:00:00Z'),
  (2, 'Parable of the Sower', 13.25, '1993-01-01T00:00:00Z'),
  (3, 'The Fifth Season',     14.99, '2015-01-01T00:00:00Z');
`;

/** Boot an engine on `dir`, apply each SQL string, close it cleanly. */
async function provision(Engine, dir, ...sql) {
  const db = new Engine(dir);
  for (const s of sql) await db.exec(s);
  await db.close();
}

/**
 * Run the built CLI and return its combined transcript (stderr + stdout), with
 * the throwaway temp paths rewritten to friendly placeholders so the captured
 * output reads the same on every machine.
 */
function runCli(argv, replacements = {}) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  let transcript = `${r.stderr}${r.stdout}`.trimEnd();
  for (const [from, to] of Object.entries(replacements)) transcript = transcript.replaceAll(from, to);
  return transcript;
}

/** Print one demo block: a title, the command, and the captured transcript. */
function show(title, command, transcript) {
  process.stdout.write(`### ${title}\n\n$ ${command}\n${transcript}\n\n`);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'pglite-migrate-demo-'));
  const engines = ['--source-engine', 'pglite-old', '--target-engine', 'pglite-new'];
  try {
    // 1. App-driven migration: the host app creates the target schema, we copy data.
    {
      const src = join(root, 'd1-old');
      const tgt = join(root, 'd1-new');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL); // PG17 source with data
      await provision(PGliteNew, tgt, SCHEMA_SQL); // PG18 target, schema only
      const paths = { [src]: './data-pg17', [tgt]: './data-pg18' };
      show(
        'App-driven migration (PG17 → PG18)',
        `pglite-migrate ./data-pg17 ./data-pg18 \\\n    --source-engine pglite-old --target-engine pglite-new`,
        runCli([src, tgt, ...engines], paths),
      );
    }

    // 2. Dry run: report the plan, write nothing.
    {
      const src = join(root, 'd2-old');
      const tgt = join(root, 'd2-new');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL);
      await provision(PGliteNew, tgt, SCHEMA_SQL);
      const paths = { [src]: './data-pg17', [tgt]: './data-pg18' };
      show(
        'Dry run — preview the plan, write nothing',
        `pglite-migrate ./data-pg17 ./data-pg18 --dry-run \\\n    --source-engine pglite-old --target-engine pglite-new`,
        runCli([src, tgt, '--dry-run', ...engines], paths),
      );
    }

    // 3. Standalone: no host app — rebuild the schema on an empty target, then copy.
    {
      const src = join(root, 'd3-old');
      const tgt = join(root, 'd3-new');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL);
      await provision(PGliteNew, tgt); // empty PG18 cluster, no schema
      const paths = { [src]: './data-pg17', [tgt]: './data-pg18' };
      show(
        'Standalone — rebuild the schema, then migrate',
        `pglite-migrate ./data-pg17 ./data-pg18 --reconstruct-schema \\\n    --source-engine pglite-old --target-engine pglite-new`,
        runCli([src, tgt, '--reconstruct-schema', ...engines], paths),
      );
    }

    // 4. Safety: back up the source first and run full content validation.
    {
      const src = join(root, 'd4-old');
      const tgt = join(root, 'd4-new');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL);
      await provision(PGliteNew, tgt, SCHEMA_SQL);
      const backup = join(root, 'd4-backup');
      const paths = { [src]: './data-pg17', [tgt]: './data-pg18', [backup]: './data-pg17.bak' };
      show(
        'Safety — back up the source and validate every row',
        `pglite-migrate ./data-pg17 ./data-pg18 --backup --validate full \\\n    --source-engine pglite-old --target-engine pglite-new`,
        runCli([src, tgt, '--backup', '--backup-dir', backup, '--validate', 'full', ...engines], paths),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
