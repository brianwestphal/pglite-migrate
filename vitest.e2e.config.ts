import { defineConfig } from 'vitest/config';

/**
 * End-to-end cross-major suite. Loads two independently-resolved PGlite
 * instances (the `pglite-old` / `pglite-new` npm aliases) and migrates real
 * data between them. The aliases resolve to two different PostgreSQL majors —
 * `@electric-sql/pglite@0.4.x` is PG17, `@0.5.x` is PG18 — so the suite is a
 * genuine cross-major migration (PG17 → PG18). When a future PGlite ships PG19,
 * bump only the `pglite-new` alias in package.json and the same suite re-targets
 * the new pair.
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
