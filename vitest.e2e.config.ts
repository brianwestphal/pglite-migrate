import { defineConfig } from 'vitest/config';

/**
 * End-to-end round-trip suite. Loads two independently-resolved PGlite
 * instances (the `pglite-old` / `pglite-new` npm aliases) and migrates real
 * data between them. Today both aliases point at the same PGlite version, so
 * the suite proves the full pipeline as a same-major round-trip; when PGlite
 * ships the next PostgreSQL major, bump the `pglite-new` alias in package.json
 * and the same suite becomes a genuine cross-major test.
 *
 * E2E runs are slower (real PGlite boots, disk I/O), so they get a longer
 * timeout and live outside the default `vitest run`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
