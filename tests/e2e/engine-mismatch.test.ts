import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDataDir } from '../../src/loader.js';
import { assertEngineMatchesDataDir, EngineMismatchError } from '../../src/precheck.js';
import { readClusterVersion } from '../../src/version.js';
import { SCHEMA_SQL } from '../helpers.js';

/**
 * The precheck against a genuinely mismatched pair (PGLM-68).
 *
 * `cross-major.test.ts` proves a new-major engine *refuses* an old-major
 * directory. What it fails with, though, is PGlite's opaque initialization
 * error, which names neither major, nor the directory, nor the engine. This
 * suite proves the precheck replaces that with a diagnostic the operator can
 * act on, using two real engines rather than a stand-in.
 *
 * Self-gates on the aliases actually resolving to different majors, matching
 * `cross-major.test.ts` (do not collapse them — NFR-6.3).
 */
describe('engine/data-directory major mismatch (PG18 engine on a PG17 dir)', () => {
  let oldDir: string;

  beforeEach(async () => {
    oldDir = await mkdtemp(join(tmpdir(), 'pglite-migrate-mismatch-'));
  });

  afterEach(async () => {
    await rm(oldDir, { recursive: true, force: true });
  });

  /** Materialize a real PG17 cluster on disk with the old engine. */
  async function seedOld(): Promise<number> {
    const db = new PGliteOld(oldDir);
    await db.exec(SCHEMA_SQL);
    await db.close();
    return readClusterVersion(oldDir);
  }

  it('turns the opaque PGlite failure into an actionable mismatch error', async (ctx) => {
    const dirMajor = await seedOld();

    // Open the PG17 directory with the NEW-major engine — the misconfiguration.
    const wrong = await openDataDir(oldDir, 'pglite-new');
    try {
      const engineIsSameMajor = await wrong
        .query<{ v: string }>('SELECT current_setting($1) AS v', ['server_version'])
        .then((r) => Number.parseInt(r.rows[0].v, 10) === dirMajor)
        .catch(() => false);
      // Aliases temporarily aligned → nothing to prove. Skip rather than return,
      // so this can never report as a pass that asserted nothing.
      if (engineIsSameMajor) ctx.skip();

      const error = await assertEngineMatchesDataDir(wrong, {
        dataDir: oldDir,
        expectedMajor: dirMajor,
        side: 'source',
        engine: 'pglite-new',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EngineMismatchError);
      const e = error as EngineMismatchError;
      expect(e.expectedMajor).toBe(17);
      expect(e.dataDir).toBe(oldDir);
      // The whole point: the message says what is wrong and what to install.
      expect(e.message).toContain('PostgreSQL 17');
      expect(e.message).toContain('pglite-new');
      expect(e.message).toContain('npm install pglite-new@npm:@electric-sql/pglite@0.4.6');
      // …instead of PGlite's bare initialization failure.
      expect(e.message).not.toMatch(/^PGlite failed to initialize properly$/);
    } finally {
      await wrong.close().catch(() => undefined);
    }
  }, 60_000);

  it('passes silently when the engine does match the directory', async () => {
    const dirMajor = await seedOld();

    const right = await openDataDir(oldDir, 'pglite-old');
    try {
      await expect(
        assertEngineMatchesDataDir(right, {
          dataDir: oldDir,
          expectedMajor: dirMajor,
          side: 'source',
          engine: 'pglite-old',
        }),
      ).resolves.toBe(dirMajor);
    } finally {
      await right.close();
    }
  }, 60_000);
});
