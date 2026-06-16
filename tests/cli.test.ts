import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliIO,parseArgs, run } from '../src/cli.js';
import { SCHEMA_SQL, SEED_SQL } from './helpers.js';

describe('parseArgs', () => {
  it('parses positional source/target', () => {
    expect(parseArgs(['src', 'dst'])).toEqual({
      source: 'src',
      target: 'dst',
      sourceEngine: '@electric-sql/pglite',
      targetEngine: '@electric-sql/pglite',
      validate: 'counts',
      onExisting: 'error',
      dryRun: false,
      backup: false,
      reconstructSchema: false,
    });
  });

  it('honors --source-engine / --target-engine overrides', () => {
    const args = parseArgs(['src', 'dst', '--source-engine', 'pglite-old', '--target-engine', 'pglite-new']);
    expect(args).toMatchObject({ sourceEngine: 'pglite-old', targetEngine: 'pglite-new' });
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

  it('parses --reconstruct-schema (and the --standalone alias)', () => {
    expect(parseArgs(['src', 'dst'])).toMatchObject({ reconstructSchema: false });
    expect(parseArgs(['src', 'dst', '--reconstruct-schema'])).toMatchObject({
      reconstructSchema: true,
    });
    expect(parseArgs(['src', 'dst', '--standalone'])).toMatchObject({ reconstructSchema: true });
  });
});

describe('run', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let io: CliIO;

  /** Boot a file-backed cluster at `name`, apply `sql`, and close it. */
  async function seedDir(name: string, ...sql: string[]): Promise<string> {
    const path = join(dir, name);
    const db = new PGlite(path);
    for (const s of sql) await db.exec(s);
    await db.close();
    return path;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-cli-'));
    out = [];
    err = [];
    io = { out: (m) => out.push(m), err: (m) => err.push(m) };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
    // with an independently-resolved PGlite module. Today both aliases resolve
    // to the same major, so this proves the plumbing; it becomes a genuine
    // cross-major check when `pglite-new` is bumped to the next major (PGLM-19).
    const source = await seedDir('source', SCHEMA_SQL, SEED_SQL);
    const target = await seedDir('target', SCHEMA_SQL);

    const code = await run(
      [source, target, '--source-engine', 'pglite-old', '--target-engine', 'pglite-new'],
      io,
    );

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('Done: 4 rows across 2 tables, 2 sequences aligned.');
  }, 30_000);
});
