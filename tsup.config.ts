import { defineConfig } from 'tsup';

/**
 * Library + CLI build.
 *
 * - `index` is the public programmatic API (app-driven migrations).
 * - `engines` is the opt-in engine-acquisition API, published as its own entry
 *   point because it is the only code here that reaches the network — importing
 *   the main entry never pulls it in.
 * - `cli` is the `pglite-migrate` bin for standalone data-directory migration.
 *   Its source keeps a leading `#!/usr/bin/env node` shebang, which esbuild
 *   preserves on entry points, so no banner injection is needed.
 *
 * `@electric-sql/pglite` is a peer dependency — never bundled. The host app (or
 * the CLI, via dynamic import) supplies the runtime PGlite versions.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    engines: 'src/engines.ts',
    cli: 'src/cli.ts',
  },
  format: 'esm',
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  splitting: false,
  clean: true,
  sourcemap: true,
  dts: true,
  external: ['@electric-sql/pglite'],
});
