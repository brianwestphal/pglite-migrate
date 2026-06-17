import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';
import { readClusterVersion } from '../../src/version.js';
import { SCHEMA_SQL, SEED_SQL } from '../helpers.js';

/**
 * The genuine cross-major run (FR-6.2, PGLM-19 / PGLM-9).
 *
 * The `pglite-old` / `pglite-new` npm aliases now resolve to two *different*
 * PostgreSQL majors: `@electric-sql/pglite@0.4.x` bundles PG17, `@0.5.x` bundles
 * PG18. So unlike the in-memory `roundtrip.test.ts`, this suite materializes a
 * real source cluster on disk with the old engine and proves two things at once:
 *
 *  1. The motivating failure — a new-major engine genuinely *cannot* open an
 *     old-major data directory (the gap this whole library exists to bridge).
 *  2. The logical route around it — `migrate` copies the data into a new-major
 *     target whose schema the host app created up front.
 *
 * The cross-major assertions self-gate on the engines actually differing, so the
 * suite stays green even if the aliases are temporarily pointed at one version
 * (do not collapse them permanently — NFR-6.3).
 */
describe('cross-major on-disk migration (PG17 → PG18)', () => {
  let oldDir: string;
  let newDir: string;

  beforeEach(async () => {
    oldDir = await mkdtemp(join(tmpdir(), 'pglite-migrate-xmaj-old-'));
    newDir = await mkdtemp(join(tmpdir(), 'pglite-migrate-xmaj-new-'));
  });

  afterEach(async () => {
    await rm(oldDir, { recursive: true, force: true });
    await rm(newDir, { recursive: true, force: true });
  });

  /** Boot an engine on a throwaway dir just to learn its on-disk major. */
  type EngineCtor = new (dir: string) => {
    query: (sql: string) => Promise<unknown>;
    close: () => Promise<void>;
  };
  async function engineMajor(Ctor: EngineCtor, dir: string): Promise<number> {
    const db = new Ctor(dir);
    await db.query('SELECT 1');
    await db.close();
    return readClusterVersion(dir);
  }

  it('the old engine stamps its major into PG_VERSION on disk', async () => {
    const source = new PGliteOld(oldDir);
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await source.close();

    // PGlite 0.4.x → PG17; the file is the major with no boot required.
    await expect(readClusterVersion(oldDir)).resolves.toBe(17);
  });

  it('a new-major engine refuses to open an old-major data directory', async () => {
    // Materialize a real source cluster on disk with the OLD engine.
    const source = new PGliteOld(oldDir);
    await source.exec(SCHEMA_SQL);
    await source.close();

    const sourceMajor = await readClusterVersion(oldDir);
    const targetMajor = await engineMajor(PGliteNew, newDir);

    if (sourceMajor === targetMajor) {
      // Aliases resolve to one major — there is no cross-major refusal to prove.
      // (Until a same-version regression, this branch should not run in CI.)
      expect(sourceMajor).toBe(targetMajor);
      return;
    }

    // It must be an *upgrade* pair, and the new engine must reject the old dir.
    expect(targetMajor).toBeGreaterThan(sourceMajor);
    await expect(
      (async () => {
        const wrong = new PGliteNew(oldDir);
        await wrong.query('SELECT 1');
        await wrong.close();
      })(),
    ).rejects.toThrow();
  });

  it('migrates data from an on-disk old-major source into a new-major target', async () => {
    // Source: a real old-major cluster on disk.
    const source = new PGliteOld(oldDir);
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);

    // Target: the host app creates its schema on the new engine (app-driven v1).
    const target = new PGliteNew(newDir);
    await target.exec(SCHEMA_SQL);

    try {
      const report = await migrate({ source, target });

      expect(report.warnings).toEqual([]);
      expect(report.totalRows).toBe(4);

      const authors = await target.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM authors',
      );
      const books = await target.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM books',
      );
      expect(authors.rows[0].count).toBe('2');
      expect(books.rows[0].count).toBe('2');
    } finally {
      await source.close();
      await target.close();
    }

    // The target cluster persisted on disk is the new major.
    await expect(readClusterVersion(newDir)).resolves.toBe(18);
  });
});
