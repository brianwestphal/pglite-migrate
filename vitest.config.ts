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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
    },
  },
});
