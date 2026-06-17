#!/usr/bin/env node
/**
 * Re-capturable animated CLI demos for the README.
 *
 * Each demo provisions throwaway PGlite data directories on two *different*
 * PostgreSQL majors — `pglite-old` (PG17, 0.4.x) for the source and
 * `pglite-new` (PG18, 0.5.x) for the target — runs the real built CLI
 * (`dist/cli.js`) against them, captures its actual transcript, then renders
 * that transcript into a self-contained animated terminal SVG with
 * `domotion-svg`: a title card introducing the concept, then a terminal that
 * types the command and reveals the captured output.
 *
 *   npm run demo                       # build + (re)generate assets/demos/*.svg
 *
 * The SVGs embedded in README.md are the output of this script: the *output*
 * text is the verbatim CLI transcript (real PG17 -> PG18 runs), so re-running
 * this after a behavior change is how the README demos are refreshed. The data
 * directories are throwaway temp dirs; only the SVGs under assets/ are kept.
 *
 * Generating the SVGs drives headless Chromium via Playwright (domotion installs
 * it on first use). The data capture needs no browser.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite as PGliteNew } from 'pglite-new'; // PG18
import { PGlite as PGliteOld } from 'pglite-old'; // PG17

import { terminalHeight, terminalHtml, titleCardHtml, WIDTH } from './lib/terminal.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const DOMOTION = join(ROOT, 'node_modules', '.bin', 'domotion');
const OUT_DIR = join(ROOT, 'assets', 'demos');

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
 * Run the built CLI and return its combined transcript (stderr + stdout) as an
 * array of lines, with the throwaway temp paths rewritten to friendly
 * placeholders so the captured output reads the same on every machine.
 */
function runCli(argv, replacements = {}) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  let transcript = `${r.stderr}${r.stdout}`.trimEnd();
  for (const [from, to] of Object.entries(replacements)) transcript = transcript.replaceAll(from, to);
  return transcript.split('\n');
}

/** The npm-alias engine flags every demo run needs (two real majors). */
const ENGINES = ['--source-engine', 'pglite-old', '--target-engine', 'pglite-new'];

/**
 * The four demos. `capture(root)` provisions a fresh pair of data dirs and
 * returns the real CLI output lines; `cmd` is the clean command a user actually
 * types (the alias flags are a harness detail and are omitted from the typing).
 */
const DEMOS = [
  {
    slug: 'app-driven',
    title: { eyebrow: 'App-driven', headline: 'Migrate PG17&nbsp;&rarr;&nbsp;PG18',
      subtitle: 'Your app creates the target schema; pglite-migrate copies the data across.' },
    cmd: 'pglite-migrate ./data-pg17 ./data-pg18',
    async capture(root) {
      const src = join(root, 'src');
      const tgt = join(root, 'tgt');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL); // PG17 source with data
      await provision(PGliteNew, tgt, SCHEMA_SQL); // PG18 target, schema only
      return runCli([src, tgt, ...ENGINES], paths(src, tgt));
    },
  },
  {
    slug: 'dry-run',
    title: { eyebrow: 'Dry run', headline: 'Preview the plan, write nothing',
      subtitle: 'See exactly what would move — provably without touching the target.' },
    cmd: 'pglite-migrate ./data-pg17 ./data-pg18 --dry-run',
    async capture(root) {
      const src = join(root, 'src');
      const tgt = join(root, 'tgt');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL);
      await provision(PGliteNew, tgt, SCHEMA_SQL);
      return runCli([src, tgt, '--dry-run', ...ENGINES], paths(src, tgt));
    },
  },
  {
    slug: 'standalone',
    title: { eyebrow: 'Standalone', headline: 'Rebuild the schema, then migrate',
      subtitle: 'No host app? Reconstruct the app-class schema from the source first.' },
    cmd: 'pglite-migrate ./data-pg17 ./data-pg18 --reconstruct-schema',
    async capture(root) {
      const src = join(root, 'src');
      const tgt = join(root, 'tgt');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL);
      await provision(PGliteNew, tgt); // empty PG18 cluster, no schema
      return runCli([src, tgt, '--reconstruct-schema', ...ENGINES], paths(src, tgt));
    },
  },
  {
    slug: 'safety',
    title: { eyebrow: 'Safety', headline: 'Back up the source, validate every row',
      subtitle: 'Optional source backup plus full content validation before you commit.' },
    cmd: 'pglite-migrate ./data-pg17 ./data-pg18 --backup --validate full',
    async capture(root) {
      const src = join(root, 'src');
      const tgt = join(root, 'tgt');
      const backup = join(root, 'backup');
      await provision(PGliteOld, src, SCHEMA_SQL, SEED_SQL);
      await provision(PGliteNew, tgt, SCHEMA_SQL);
      return runCli(
        [src, tgt, '--backup', '--backup-dir', backup, '--validate', 'full', ...ENGINES],
        { ...paths(src, tgt), [backup]: './data-pg17.bak' },
      );
    },
  },
];

/** Friendly placeholders for the throwaway source/target temp paths. */
function paths(src, tgt) {
  return { [src]: './data-pg17', [tgt]: './data-pg18' };
}

/**
 * Compose one demo into an animated SVG: write the two frame HTML files and a
 * domotion `animate` config into a temp dir, then shell out to the installed
 * `domotion` CLI to capture and stitch them.
 */
async function buildSvg(demo, lines) {
  const height = terminalHeight(lines.length);
  const work = await mkdtemp(join(tmpdir(), `dm-${demo.slug}-`));
  try {
    const titleHtml = join(work, 'title.html');
    const termHtml = join(work, 'term.html');
    const config = join(work, 'config.json');
    await writeFile(titleHtml, titleCardHtml({ ...demo.title, height }));
    await writeFile(termHtml, terminalHtml({ title: 'pglite-migrate', outputLines: lines, height }));

    const speed = 30; // characters per second
    const typeMs = Math.ceil((demo.cmd.length / speed) * 1000);
    const revealDelay = typeMs + 350; // let the command settle before output appears
    const termDuration = revealDelay + 300 + 3200; // reveal + fade + hold

    await writeFile(
      config,
      JSON.stringify(
        {
          width: WIDTH,
          height,
          output: join(OUT_DIR, `${demo.slug}.svg`),
          optimize: true,
          frames: [
            {
              input: 'title.html',
              duration: 1600,
              transition: { type: 'crossfade', duration: 500 },
            },
            {
              input: 'term.html',
              duration: termDuration,
              transition: { type: 'crossfade', duration: 500 },
              overlays: [
                {
                  kind: 'typing',
                  text: `${demo.cmd} `, // trailing space so the caret rests clear of the last char
                  anchor: { selector: '.cmd', at: 'left' },
                  fontSize: 15,
                  color: '#e6edf3',
                  speed,
                  caret: true,
                },
              ],
              animations: [
                {
                  selector: '.out',
                  property: 'opacity',
                  from: '0',
                  to: '1',
                  duration: 300,
                  delay: revealDelay,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    const r = spawnSync(DOMOTION, ['animate', config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error(`domotion failed for ${demo.slug} (exit ${r.status})`);
    process.stdout.write(`  ${demo.slug}.svg\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'pglite-migrate-demo-'));
  try {
    for (const demo of DEMOS) {
      const dir = join(root, demo.slug);
      await mkdir(dir, { recursive: true });
      const lines = await demo.capture(dir);
      await buildSvg(demo, lines);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  process.stdout.write(`\nWrote ${DEMOS.length} demo SVGs to assets/demos/\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
