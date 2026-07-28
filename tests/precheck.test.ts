import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertEngineMatchesDataDir, EngineMismatchError } from '../src/precheck.js';
import type { PGliteLike } from '../src/types.js';
import { readEngineMajor } from '../src/version.js';

/**
 * A stand-in engine that answers every query with fixed rows.
 *
 * Not a mock of the database — the real interaction is covered against a real
 * PGlite below and in the e2e suite. This exists only to drive the parse and
 * refusal branches, which a working engine cannot produce.
 */
function stubEngine(rows: Record<string, unknown>[]): PGliteLike {
  return {
    query: <R,>() => Promise.resolve({ rows: rows as R[] }),
    exec: () => Promise.resolve(undefined),
  };
}

describe('readEngineMajor', () => {
  let db: PGlite;

  beforeAll(() => {
    db = new PGlite();
  });

  afterAll(async () => {
    await db.close();
  });

  it("reports the running engine's major", async () => {
    const major = await readEngineMajor(db);
    // The default @electric-sql/pglite dev dep is the 0.5.x line → PG18.
    expect(major).toBe(18);
  });

  it('tolerates a development build stamp like `15devel`', async () => {
    const devel = stubEngine([{ v: '15devel' }]);
    await expect(readEngineMajor(devel)).resolves.toBe(15);
  });

  it('throws when server_version cannot be parsed', async () => {
    const nonsense = stubEngine([{ v: 'not-a-version' }]);
    await expect(readEngineMajor(nonsense)).rejects.toThrow(/Could not parse a major version/);
  });

  it('throws when the engine returns no row at all', async () => {
    const empty = stubEngine([]);
    await expect(readEngineMajor(empty)).rejects.toThrow(/Could not parse a major version/);
  });
});

describe('assertEngineMatchesDataDir', () => {
  let db: PGlite;
  let engineMajor: number;

  beforeAll(async () => {
    db = new PGlite();
    engineMajor = await readEngineMajor(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('passes when the engine major matches the directory', async () => {
    await expect(
      assertEngineMatchesDataDir(db as unknown as PGliteLike, {
        dataDir: '/tmp/whatever',
        expectedMajor: engineMajor,
        side: 'source',
        engine: 'pglite-new',
      }),
    ).resolves.toBe(engineMajor);
  });

  it('throws naming both majors, the directory, and the engine when they differ', async () => {
    const error = await assertEngineMatchesDataDir(db as unknown as PGliteLike, {
      dataDir: '/data/old',
      expectedMajor: 17,
      side: 'source',
      engine: 'pglite-new',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineMismatchError);
    const e = error as EngineMismatchError;
    expect(e.expectedMajor).toBe(17);
    expect(e.engineMajor).toBe(engineMajor);
    expect(e.dataDir).toBe('/data/old');
    expect(e.message).toContain('source data directory /data/old is PostgreSQL 17');
    expect(e.message).toContain(`is PostgreSQL ${engineMajor.toString()}`);
    // The pinned registry knows which engine *would* serve PG17, so say so.
    expect(e.message).toContain('npm install pglite-new@npm:@electric-sql/pglite@0.4.6');
    expect(e.message).toContain('--fetch-missing-engine');
  });

  it('omits the install hint for a major with no pinned engine', async () => {
    const error = await assertEngineMatchesDataDir(db as unknown as PGliteLike, {
      dataDir: '/data/ancient',
      expectedMajor: 9,
      engine: 'pglite-old',
    }).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('bundles PostgreSQL 9');
    expect(message).not.toContain('npm install');
  });

  it('reads acceptably without a side or engine name', async () => {
    const error = await assertEngineMatchesDataDir(db as unknown as PGliteLike, {
      dataDir: '/data/x',
      expectedMajor: 16,
    }).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('The data directory /data/x is PostgreSQL 16');
    // No engine name given → falls back to a generic alias in the hint.
    expect(message).toContain('npm install pglite-old@npm:@electric-sql/pglite@0.2.17');
  });

  describe('when the directory has no PG_VERSION yet', () => {
    /** A cluster that fails loudly if anything queries it. */
    const exploding: PGliteLike = {
      query: () => {
        throw new Error('the precheck must not query a directory with no PG_VERSION');
      },
      exec: () => {
        throw new Error('the precheck must not exec');
      },
    };

    it('skips the check without issuing a query', async () => {
      // Booting the engine would initialize the directory as a side effect,
      // which must never happen just because we wanted to check it.
      await expect(
        assertEngineMatchesDataDir(exploding, { dataDir: '/data/new', expectedMajor: null }),
      ).resolves.toBeNull();
    });
  });

  describe('when the engine cannot read the directory at all', () => {
    /** Stands in for PGlite's opaque "failed to initialize properly". */
    const refusing: PGliteLike = {
      query: () => Promise.reject(new Error('PGlite failed to initialize properly')),
      exec: () => Promise.reject(new Error('PGlite failed to initialize properly')),
    };

    it('replaces the opaque failure with an actionable one, preserving the cause', async () => {
      const error = await assertEngineMatchesDataDir(refusing, {
        dataDir: '/data/old',
        expectedMajor: 17,
        side: 'source',
        engine: 'pglite-new',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EngineMismatchError);
      const e = error as EngineMismatchError;
      expect(e.engineMajor).toBeNull(); // it never answered
      expect(e.message).toContain('could not read it');
      expect(e.message).toContain('PostgreSQL 17');
      expect(e.message).toContain('npm install pglite-new@npm:@electric-sql/pglite@0.4.6');
      // The original PGlite error is kept for anyone who wants it.
      expect((e.cause as Error).message).toContain('failed to initialize properly');
    });
  });
});
