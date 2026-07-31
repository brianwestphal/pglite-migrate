import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Temp-directory helpers for tests that materialize real data directories.
 *
 * Twelve test files create a `mkdtemp` scratch directory and remove it in
 * `afterEach`. Keeping one copy of that pair here is the same reasoning as
 * `src/catalog.ts` and `src/fsutil.ts` on the product side — but here it also
 * fixes a real failure mode, described on {@link removeTempDir}.
 */

/** Create a scratch directory under the OS temp dir. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Remove a scratch directory, tolerating a cluster that is still letting go of
 * it, and never failing the test.
 *
 * Two things are deliberate here (PGLM-93):
 *
 * **Retries.** When a test times out, vitest runs `afterEach` while the test's
 * own async work is still in flight — a PGlite instance may still be writing
 * into the directory being removed. `rm` then walks a tree that repopulates
 * underneath it and throws `ENOTEMPTY`. Node's `rm` retries exactly this error
 * class (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM`) with a linear
 * backoff when asked, so the fix is to ask.
 *
 * **Swallowing what survives the retries.** Cleanup says nothing about the
 * system under test, so it must never be the thing that fails a test. Before
 * this, a timeout surfaced *twice* — once as the real "Test timed out in
 * 30000ms", and again as an `ENOTEMPTY` from the teardown — and the second
 * error buried the first. The scratch directory is under the OS temp dir; the
 * operating system reclaims anything left behind.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
    () => undefined,
  );
}
