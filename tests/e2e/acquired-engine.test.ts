import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { PGlite as PGliteOld } from 'pglite-old';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PGLITE_PACKAGE, resolveEngine } from '../../src/engines/registry.js';
import { openDataDir } from '../../src/loader.js';
import { migrate } from '../../src/migrate.js';
import { readClusterVersion } from '../../src/version.js';
import { SCHEMA_SQL, SEED_SQL } from '../helpers.js';
import { makeTempDir, removeTempDir } from '../tempdir.js';

/**
 * The motivating real-world shape: **the consumer bundles only the destination
 * engine**. The old engine that wrote the data on disk is not installed at all,
 * so it has to be acquired before the migration can even start.
 *
 * `pglite-old` is used here to *materialize* a genuine PG17 data directory, but
 * the migration itself never imports it — the source engine specifier is
 * deliberately unresolvable, forcing the acquisition path to download, verify,
 * extract, and import a real engine.
 *
 * This is the only suite in the repo that needs network access, so it self-gates
 * on the registry being reachable and skips with a clear message otherwise (see
 * `docs/6-testing.md`). Do not collapse the `pglite-old` / `pglite-new` aliases
 * — the two-engine shape is still the property under test (NFR-6.3).
 */

/** An engine specifier that cannot resolve, standing in for "not installed". */
const MISSING_ENGINE = 'pglite-definitely-not-installed';

/** Is the npm registry reachable? Decides whether this suite can run. */
async function registryReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 10_000);
    try {
      const res = await fetch(`https://registry.npmjs.org/${PGLITE_PACKAGE}`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

let online = false;

beforeAll(async () => {
  online = await registryReachable();
  if (!online) {
    console.warn(
      '[acquired-engine] npm registry unreachable — skipping engine-acquisition e2e. ' +
        'These assertions need network access; every other e2e suite runs offline.',
    );
  }
}, 30_000);

describe('migrating with an acquired source engine (fetched PG17 → bundled PG18)', () => {
  let sourceDir: string;
  let targetDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    sourceDir = await makeTempDir('pglite-migrate-acq-src-');
    targetDir = await makeTempDir('pglite-migrate-acq-tgt-');
    cacheDir = await makeTempDir('pglite-migrate-acq-cache-');
  });

  afterEach(async () => {
    await removeTempDir(sourceDir);
    await removeTempDir(targetDir);
    await removeTempDir(cacheDir);
  });

  /** Materialize a real PG17 cluster on disk using the old alias, then close it. */
  async function seedRealSource(): Promise<void> {
    const db = new PGliteOld(sourceDir);
    await db.exec(SCHEMA_SQL);
    await db.exec(SEED_SQL);
    await db.close();
    expect(await readClusterVersion(sourceDir)).toBe(17);
  }

  it('acquires the engine the data directory needs and migrates through it', async (ctx) => {
    if (!online) ctx.skip();
    await seedRealSource();

    // The source engine is NOT installed — it must be acquired.
    const source = await openDataDir(sourceDir, MISSING_ENGINE, {
      fetchMissingEngine: true,
      cacheDir,
    });
    const target = await openDataDir(targetDir, 'pglite-new');
    try {
      expect(source.acquired).toEqual({ version: resolveEngine(17).version, fromCache: false });

      // The acquired engine really is PG17, not whatever happened to download.
      const version = await source.query<{ v: string }>('SELECT version() AS v');
      expect(version.rows[0].v).toContain('PostgreSQL 17');

      // Host app owns the target schema (the app-driven v1 path).
      await target.exec(SCHEMA_SQL);
      const report = await migrate({ source, target });

      expect(report.warnings).toEqual([]);
      expect(report.totalRows).toBe(4);
      expect(report.sequencesSet).toBe(2);

      const books = await target.query<{ title: string; author: string }>(
        'SELECT b.title, a.name AS author FROM books b JOIN authors a ON a.id = b.author_id ORDER BY b.id',
      );
      expect(books.rows).toEqual([
        { title: 'A Wizard of Earthsea', author: 'Ursula' },
        { title: 'Kindred', author: 'Octavia' },
      ]);

      // Sequences realigned, so the target can keep inserting without collisions.
      const next = await target.query<{ id: number }>(
        "INSERT INTO authors (name) VALUES ('Nnedi') RETURNING id",
      );
      expect(next.rows[0].id).toBe(3);
    } finally {
      await source.close();
      await target.close();
    }

    // Target persisted on disk is the new major — a genuine cross-major result.
    expect(await readClusterVersion(targetDir)).toBe(18);
  }, 120_000);

  it('keeps the engine cached by default and reuses it on the next run', async (ctx) => {
    if (!online) ctx.skip();
    await seedRealSource();

    const first = await openDataDir(sourceDir, MISSING_ENGINE, {
      fetchMissingEngine: true,
      cacheDir,
    });
    expect(first.acquired?.fromCache).toBe(false);
    await first.close();

    // `keep` is the default, so closing must NOT remove the cache entry.
    const entries = await readdir(cacheDir);
    expect(entries).toEqual([`pglite-${resolveEngine(17).version}`]);

    const second = await openDataDir(sourceDir, MISSING_ENGINE, {
      fetchMissingEngine: true,
      cacheDir,
    });
    try {
      expect(second.acquired?.fromCache).toBe(true);
      const version = await second.query<{ v: string }>('SELECT version() AS v');
      expect(version.rows[0].v).toContain('PostgreSQL 17');
    } finally {
      await second.close();
    }
    // Still cached after the second run.
    expect(await readdir(cacheDir)).toEqual([`pglite-${resolveEngine(17).version}`]);
  }, 120_000);

  it('removes an ephemeral engine once the cluster is closed', async (ctx) => {
    if (!online) ctx.skip();
    await seedRealSource();

    const source = await openDataDir(sourceDir, MISSING_ENGINE, {
      fetchMissingEngine: true,
      cache: 'ephemeral',
      cacheDir,
    });
    const engineDirs = await readdir(cacheDir);
    expect(engineDirs).toHaveLength(1);
    expect((await stat(join(cacheDir, engineDirs[0]))).isDirectory()).toBe(true);

    // Still a fully working engine, not a degraded one.
    const rows = await source.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM authors',
    );
    expect(rows.rows[0].count).toBe('2');

    await source.close();
    expect(await readdir(cacheDir)).toEqual([]);
  }, 120_000);

  it('refuses to run without the opt-in, naming the engine the directory needs', async () => {
    // No network needed: resolution fails locally, before anything is fetched.
    await seedRealSource();

    const error = await openDataDir(sourceDir, MISSING_ENGINE).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('PostgreSQL 17');
    expect(message).toContain(`${PGLITE_PACKAGE}@${resolveEngine(17).version}`);
    expect(message).toContain('--fetch-missing-engine');
  }, 60_000);
});

afterAll(() => {
  if (!online) {
    console.warn('[acquired-engine] suite ran in offline mode — network assertions were skipped.');
  }
});
