import { defineConfig } from 'vitest/config';

/**
 * Unit tests. Fast, isolated, no two-version PGlite harness. The end-to-end
 * round-trip suite lives under `tests/e2e/` and runs via `vitest.e2e.config.ts`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    // Several unit tests boot a real in-memory PGlite (catalog SQL / COPY has no
    // meaningful mock), which is slower than the 5s default under full-suite load.
    // The heaviest single test boots five *file-backed* clusters, so 30s is ~4x
    // headroom on an idle machine. It is deliberately not larger: a test that
    // exceeds this is starved of CPU, not deadlocked (see docs/6 § "If the suite
    // goes red with a timeout and an errno 44"), and a bigger budget would hide
    // a real hang later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
    },
  },
});
