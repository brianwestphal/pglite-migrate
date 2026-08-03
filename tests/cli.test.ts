import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliIO,parseArgs, run } from '../src/cli.js';
import { SCHEMA_SQL, SEED_SQL } from './helpers.js';
import { makeTempDir, removeTempDir } from './tempdir.js';

describe('parseArgs', () => {
  it('parses positional source/target', () => {
    expect(parseArgs(['src', 'dst'])).toEqual({
      source: 'src',
      target: 'dst',
      sourceEngine: '@electric-sql/pglite',
      targetEngine: '@electric-sql/pglite',
      sourceOptions: undefined,
      targetOptions: undefined,
      validate: 'counts',
      onExisting: 'error',
      onValidationFailure: 'report',
      dryRun: false,
      backup: false,
      backupDir: undefined,
      keep: undefined,
      reconstructSchema: false,
      onUnsupported: 'warn',
      fetchMissingEngine: false,
      engineCache: 'keep',
      engineCacheDir: undefined,
    });
  });

  it('parses --strict as opting into onValidationFailure: throw (default report)', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ onValidationFailure: 'report' });
    expect(parseArgs(['src', 'dst', '--strict'])).toMatchObject({ onValidationFailure: 'throw' });
  });

  it('honors --source-engine / --target-engine overrides', () => {
    const args = parseArgs(['src', 'dst', '--source-engine', 'pglite-old', '--target-engine', 'pglite-new']);
    expect(args).toMatchObject({ sourceEngine: 'pglite-old', targetEngine: 'pglite-new' });
  });

  it('honors --source-database / --target-database (PGLM-100)', () => {
    const args = parseArgs(['src', 'dst', '--source-database', 'template1']);
    expect(args?.sourceOptions).toEqual({ database: 'template1' });
    expect(args?.targetOptions).toBeUndefined();
    expect(parseArgs(['src', 'dst', '--target-database', 'postgres'])?.targetOptions).toEqual({
      database: 'postgres',
    });
  });

  // PGLM-102. Everything from argv is a string, but PGlite's options are not:
  // `relaxedDurability` is a boolean and `debug` a number, so the value has to
  // be coerced — JSON when it parses as JSON, the raw string otherwise.
  describe('--source-option / --target-option (PGLM-102)', () => {
    /** `sourceOptions` after parsing a single `--source-option k=v`. */
    function opt(pair: string): Record<string, unknown> | undefined {
      return parseArgs(['src', 'dst', '--source-option', pair])?.sourceOptions;
    }

    it('reads JSON scalars as their JSON types', () => {
      expect(opt('relaxedDurability=true')).toEqual({ relaxedDurability: true });
      expect(opt('relaxedDurability=false')).toEqual({ relaxedDurability: false });
      expect(opt('debug=1')).toEqual({ debug: 1 });
      expect(opt('x=null')).toEqual({ x: null });
      expect(opt('x=1.5')).toEqual({ x: 1.5 });
    });

    it('leaves a value that is not valid JSON as a plain string', () => {
      expect(opt('database=template1')).toEqual({ database: 'template1' });
      expect(opt('dataDir=/var/lib/pg')).toEqual({ dataDir: '/var/lib/pg' });
      // Empty value: `JSON.parse('')` throws, so it lands as the empty string.
      expect(opt('x=')).toEqual({ x: '' });
    });

    it('lets an explicit JSON string force a string that looks like JSON', () => {
      // The escape hatch for the one genuine ambiguity in the rule above.
      expect(opt('label="true"')).toEqual({ label: 'true' });
      expect(opt('label="1"')).toEqual({ label: '1' });
    });

    it('splits on the first = so a value may contain one', () => {
      expect(opt('conn=host=local')).toEqual({ conn: 'host=local' });
    });

    it('accepts JSON objects and arrays', () => {
      expect(opt('nested={"a":1}')).toEqual({ nested: { a: 1 } });
      expect(opt('list=[1,2]')).toEqual({ list: [1, 2] });
    });

    it('is repeatable, and accumulates per side independently', () => {
      const args = parseArgs([
        'src', 'dst',
        '--source-option', 'relaxedDurability=true',
        '--source-option', 'debug=2',
        '--target-option', 'debug=0',
      ]);
      expect(args?.sourceOptions).toEqual({ relaxedDurability: true, debug: 2 });
      expect(args?.targetOptions).toEqual({ debug: 0 });
    });

    it('treats --source-database as sugar for the same key, last one winning', () => {
      // Both write `database`, so precedence is plain argv order — no special case.
      expect(
        parseArgs(['src', 'dst', '--source-database', 'a', '--source-option', 'database=b'])
          ?.sourceOptions,
      ).toEqual({ database: 'b' });
      expect(
        parseArgs(['src', 'dst', '--source-option', 'database=b', '--source-database', 'a'])
          ?.sourceOptions,
      ).toEqual({ database: 'a' });
    });

    it('rejects a pair with no key or no =', () => {
      expect(() => parseArgs(['src', 'dst', '--source-option', 'nokey'])).toThrow(
        /Invalid --source-option value: nokey \(expected key=value\)/,
      );
      expect(() => parseArgs(['src', 'dst', '--source-option', '=novalue'])).toThrow(
        /Invalid --source-option value/,
      );
      expect(() => parseArgs(['src', 'dst', '--target-option', 'nokey'])).toThrow(
        /Invalid --target-option value/,
      );
    });
  });

  it('returns null for -h / --help', () => {
    expect(parseArgs(['-h'])).toBeNull();
    expect(parseArgs(['--help'])).toBeNull();
  });

  it('returns null when fewer than two positionals are given', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['only-one'])).toBeNull();
  });

  it('throws on an unknown option', () => {
    expect(() => parseArgs(['src', 'dst', '--bogus'])).toThrow(/Unknown option: --bogus/);
  });

  it('tolerates a missing value after --source-engine (empty string)', () => {
    expect(parseArgs(['src', 'dst', '--source-engine'])).toMatchObject({ sourceEngine: '' });
  });

  it('parses --validate levels and rejects invalid ones', () => {
    expect(parseArgs(['src', 'dst', '--validate', 'full'])).toMatchObject({ validate: 'full' });
    expect(parseArgs(['src', 'dst', '--validate', 'off'])).toMatchObject({ validate: 'off' });
    expect(() => parseArgs(['src', 'dst', '--validate', 'bogus'])).toThrow(/Invalid --validate/);
  });

  it('parses --on-existing modes and rejects invalid ones', () => {
    expect(parseArgs(['src', 'dst', '--on-existing', 'truncate'])).toMatchObject({
      onExisting: 'truncate',
    });
    expect(() => parseArgs(['src', 'dst', '--on-existing', 'bogus'])).toThrow(/Invalid --on-existing/);
  });

  it('parses --on-unsupported modes (default warn) and rejects invalid ones', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ onUnsupported: 'warn' });
    expect(parseArgs(['src', 'dst', '--on-unsupported', 'error'])).toMatchObject({
      onUnsupported: 'error',
    });
    expect(() => parseArgs(['src', 'dst', '--on-unsupported', 'bogus'])).toThrow(
      /Invalid --on-unsupported/,
    );
  });

  it('parses --dry-run as a boolean flag (default false)', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ dryRun: false });
    expect(parseArgs(['src', 'dst', '--dry-run'])).toMatchObject({ dryRun: true });
  });

  it('parses --backup and --backup-dir (the latter implies backup)', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ backup: false });
    expect(parseArgs(['src', 'dst', '--backup'])).toMatchObject({ backup: true });
    expect(parseArgs(['src', 'dst', '--backup-dir', '/tmp/b'])).toMatchObject({
      backup: true,
      backupDir: '/tmp/b',
    });
  });

  it('parses --keep as a positive integer (implies backup) and rejects invalid values', () => {
    expect(parseArgs(['src', 'dst', '--keep', '3'])).toMatchObject({ keep: 3, backup: true });
    expect(parseArgs(['src', 'dst'])).toMatchObject({ keep: undefined });
    expect(() => parseArgs(['src', 'dst', '--keep', '0'])).toThrow(/Invalid --keep/);
    expect(() => parseArgs(['src', 'dst', '--keep', '-1'])).toThrow(/Invalid --keep/);
    expect(() => parseArgs(['src', 'dst', '--keep', 'abc'])).toThrow(/Invalid --keep/);
  });

  it('parses --reconstruct-schema (and the --standalone alias)', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ reconstructSchema: false });
    expect(parseArgs(['src', 'dst', '--reconstruct-schema'])).toMatchObject({
      reconstructSchema: true,
    });
    expect(parseArgs(['src', 'dst', '--standalone'])).toMatchObject({ reconstructSchema: true });
  });

  it('leaves engine acquisition off unless asked', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ fetchMissingEngine: false });
    expect(parseArgs(['src', 'dst', '--fetch-missing-engine'])).toMatchObject({
      fetchMissingEngine: true,
    });
  });

  it('defaults --engine-cache to keep and rejects invalid modes', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ engineCache: 'keep' });
    expect(parseArgs(['src', 'dst', '--engine-cache', 'ephemeral'])).toMatchObject({
      engineCache: 'ephemeral',
    });
    expect(parseArgs(['src', 'dst', '--engine-cache', 'keep'])).toMatchObject({
      engineCache: 'keep',
    });
    expect(() => parseArgs(['src', 'dst', '--engine-cache', 'bogus'])).toThrow(
      /Invalid --engine-cache mode: bogus \(expected keep or ephemeral\)/,
    );
  });

  it('parses --engine-cache-dir', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ engineCacheDir: undefined });
    expect(parseArgs(['src', 'dst', '--engine-cache-dir', '/tmp/engines'])).toMatchObject({
      engineCacheDir: '/tmp/engines',
    });
  });

  it('documents the engine flags in the usage text', async () => {
    const usage: string[] = [];
    await run(['--help'], { out: (m) => usage.push(m), err: () => undefined });
    const text = usage.join('\n');
    expect(text).toContain('--fetch-missing-engine');
    expect(text).toContain('--engine-cache <mode>');
    expect(text).toContain('--engine-cache-dir');
  });
});

/** Structural constructor shared by the aliased PGlite engines. */
type EngineCtor = new (dir: string) => {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

describe('run', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let io: CliIO;

  /** Boot a file-backed cluster at `name`, apply `sql`, and close it. */
  async function seedDir(name: string, ...sql: string[]): Promise<string> {
    return seedDirWith(PGlite, name, ...sql);
  }

  /** Like {@link seedDir} but with an explicit engine — needed when the dir will
   * be reopened by a *different* major (the cross-major CLI test). */
  async function seedDirWith(Ctor: EngineCtor, name: string, ...sql: string[]): Promise<string> {
    const path = join(dir, name);
    const db = new Ctor(path);
    for (const s of sql) await db.exec(s);
    await db.close();
    return path;
  }

  beforeEach(async () => {
    dir = await makeTempDir('pglite-migrate-cli-');
    out = [];
    err = [];
    io = { out: (m) => out.push(m), err: (m) => err.push(m) };
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('prints usage and exits 0 for --help', async () => {
    const code = await run(['--help'], io);

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
    expect(err).toEqual([]);
  });

  it('migrates data, reports versions/progress/summary, and exits 0', async () => {
    const source = await seedDir('source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDir('target', SCHEMA_SQL);

    const code = await run([source, target], io);
    const errText = err.join('\n');

    expect(code).toBe(0);
    // Reports the major-version transition (FR-4.4).
    expect(errText).toMatch(/Migrating .* \(PG \d+\) -> .* \(PG \d+\)/);
    // Per-table progress (FR-4.5).
    expect(errText).toContain('public.authors: 2 rows');
    expect(errText).toContain('public.books: 2 rows');
    expect(errText).toContain('Done: 4 rows across 2 tables, 2 sequences aligned.');

    // Target really received the data.
    const verify = new PGlite(target);
    try {
      const { rows } = await verify.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM books',
      );
      expect(rows[0].count).toBe('2');
    } finally {
      await verify.close();
    }
  }, 30_000);

  // PGLM-100: a cluster written before PGlite 0.4.0 keeps its tables in
  // `template1`, which the CLI could not reach at all before these flags.
  it('migrates a template1-era source via --source-database', async () => {
    const source = join(dir, 'legacy-source');
    const legacy = new PGlite(source, { database: 'template1' });
    await legacy.exec(SCHEMA_SQL);
    await legacy.exec(SEED_SQL);
    await legacy.close();

    const target = await seedDir('target', SCHEMA_SQL);

    // Without the flag the CLI opens the default database and finds no tables.
    const bare = await run([source, target], io);
    expect(bare).toBe(0);
    expect(err.join('\n')).toContain('Done: 0 rows across 0 tables');

    err = [];
    const code = await run([source, target, '--source-database', 'template1'], io);

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('Done: 4 rows across 2 tables, 2 sequences aligned.');
  }, 30_000);

  // PGLM-102: the general form has to reach the engine the same way the
  // purpose-built flag does — it is the same `pgliteOptions` bag either way.
  it('reaches the engine through the general --source-option form too', async () => {
    const source = join(dir, 'legacy-source-generic');
    const legacy = new PGlite(source, { database: 'template1' });
    await legacy.exec(SCHEMA_SQL);
    await legacy.exec(SEED_SQL);
    await legacy.close();

    const target = await seedDir('target', SCHEMA_SQL);

    const code = await run(
      [source, target, '--source-option', 'database=template1', '--target-option', 'debug=0'],
      io,
    );

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('Done: 4 rows across 2 tables, 2 sequences aligned.');
  }, 30_000);

  it('stays quiet about per-table validation detail when everything matches', async () => {
    const source = await seedDir('source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDir('target', SCHEMA_SQL);

    const code = await run([source, target], io);
    const errText = err.join('\n');

    expect(code).toBe(0);
    expect(errText).toContain('Validation (counts): OK.');
    // A healthy run should not print a wall of per-table parity lines.
    expect(errText).not.toMatch(/public\.authors: \d+ = \d+/);
  }, 30_000);

  it('prints the source-vs-target counts for every table when validation fails', async () => {
    // Two independent tables (no FK, so the mismatch is purely a count one).
    // `onExisting: skip` leaves the pre-populated `a` short of the source while
    // `b` transfers cleanly — so one table fails validation and one passes, and
    // the output has to show both.
    const schema = `CREATE TABLE a (id int PRIMARY KEY, v text);
                    CREATE TABLE b (id int PRIMARY KEY, v text);`;
    const source = await seedDir(
      'source',
      schema,
      `INSERT INTO a VALUES (1, 'x'), (2, 'y'); INSERT INTO b VALUES (1, 'p'), (2, 'q');`,
    );
    const target = await seedDir('target', schema, `INSERT INTO a VALUES (1, 'x')`);

    const code = await run([source, target, '--on-existing', 'skip'], io);
    const errText = err.join('\n');

    expect(code).toBe(1);
    expect(errText).toContain('Validation (counts): FAILED.');
    // The numbers, which were previously only reachable from the library report.
    expect(errText).toMatch(/public\.a: 2 ≠ 1/);
    // Matching tables are printed too, so the operator sees the whole picture.
    expect(errText).toMatch(/public\.b: 2 = 2/);
  }, 30_000);

  it('exits non-zero and tolerates an unreadable PG_VERSION on error', async () => {
    const source = await seedDir('source', SCHEMA_SQL, SEED_SQL);
    // Fresh, never-initialized target dir: no schema -> first insert fails,
    // and its PG_VERSION cannot be read at start (tolerated as "PG ?").
    const target = join(dir, 'empty-target');

    const code = await run([source, target], io);
    const errText = err.join('\n');

    expect(code).toBe(1);
    expect(errText).toContain('PG ?');
    expect(errText.length).toBeGreaterThan(0);
  }, 30_000);

  it('opens source and target via distinct --source-engine/--target-engine aliases', async () => {
    // Exercises the two-engine wiring (FR-4.2 / NG-4.8): each side is opened
    // with an independently-resolved PGlite module. The aliases now resolve to
    // different majors (pglite-old = PG17, pglite-new = PG18), so each dir must
    // be seeded with the same engine the CLI will reopen it with — a genuine
    // cross-major run through the bin (PGLM-19).
    const source = await seedDirWith(PGliteOld, 'source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDirWith(PGliteNew, 'target', SCHEMA_SQL);

    const code = await run(
      [source, target, '--source-engine', 'pglite-old', '--target-engine', 'pglite-new'],
      io,
    );

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('Done: 4 rows across 2 tables, 2 sequences aligned.');
  }, 30_000);

  it('refuses an engine whose major does not match the data directory', async () => {
    // A PG17 source opened with the PG18 engine — the classic misconfiguration.
    const source = await seedDirWith(PGliteOld, 'source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDirWith(PGliteNew, 'target', SCHEMA_SQL);

    const code = await run(
      [source, target, '--source-engine', 'pglite-new', '--target-engine', 'pglite-new'],
      io,
    );
    const errText = err.join('\n');

    expect(code).toBe(1);
    expect(errText).toContain('is PostgreSQL 17');
    expect(errText).toContain('pglite-new');
    expect(errText).toContain('npm install pglite-new@npm:@electric-sql/pglite@0.4.6');
    // Regression guard: closing a cluster that never initialized used to reject
    // out of the finally block, appending PGlite's opaque failure after the
    // clean diagnostic and bypassing run()'s exit code.
    expect(errText).not.toContain('PGlite failed to initialize properly');
    expect(errText.trimEnd().endsWith('to acquire it automatically.')).toBe(true);
  }, 30_000);

  it('accepts matching engines on both sides', async () => {
    const source = await seedDirWith(PGliteOld, 'source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDirWith(PGliteNew, 'target', SCHEMA_SQL);

    const code = await run(
      [source, target, '--source-engine', 'pglite-old', '--target-engine', 'pglite-new'],
      io,
    );
    expect(code).toBe(0);
    expect(err.join('\n')).not.toContain('PostgreSQL');
  }, 30_000);

  it('fails with actionable guidance when an engine is missing and fetching is off', async () => {
    const source = await seedDirWith(PGliteOld, 'source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDirWith(PGliteNew, 'target', SCHEMA_SQL);

    const code = await run([source, target, '--source-engine', 'pglite-not-installed'], io);
    const errText = err.join('\n');

    expect(code).toBe(1);
    // Not a bare ERR_MODULE_NOT_FOUND: it must name the major, the install
    // command, and the opt-in flag.
    expect(errText).toContain('pglite-not-installed');
    expect(errText).toContain('PostgreSQL 17');
    expect(errText).toContain('npm install pglite-not-installed@npm:@electric-sql/pglite@0.4.6');
    expect(errText).toContain('--fetch-missing-engine');
    // Nothing was downloaded, because acquisition was never opted into.
    expect(errText).not.toContain('Acquired');
  }, 30_000);
});
