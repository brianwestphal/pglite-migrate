# 4 — CLI (`pglite-migrate`)

The `pglite-migrate` bin (`src/cli.ts`) is the standalone, command-line face of the library. Its source keeps a leading `#!/usr/bin/env node` shebang, which esbuild preserves on entry points.

## Behavior

- **FR-4.1** `pglite-migrate <source-data-dir> <target-data-dir>` migrates data from the source data directory into the target.
- **FR-4.2** `--source-engine <pkg>` / `--target-engine <pkg>` select the npm module/alias used to open each side (default `@electric-sql/pglite`). This is how two different PGlite majors are wired in.
- **FR-4.2a** `--fetch-missing-engine` downloads a pinned engine when the named one does not resolve, so a host that bundles only the destination version can still migrate. `--engine-cache <keep|ephemeral>` chooses retention (default `keep`) and `--engine-cache-dir <path>` overrides where engines are stored. Off unless asked for; resolution is always tried first. Full spec: [`15-engine-acquisition.md`](15-engine-acquisition.md).
- **FR-4.3** `-h` / `--help` prints usage. No positional args (or fewer than two) prints usage and exits 0.
- **FR-4.4** On start, the CLI reads and reports each side's `PG_VERSION` (tolerating a missing/unreadable file) so the operator sees the major-version transition.
- **FR-4.5** Progress is written to stderr (one line per table); the final summary reports total rows, table count, and sequences aligned. Warnings are printed.
- **FR-4.6** On error, the message is printed to stderr and the process exits non-zero.

## Current limitations / deferred

- **NG-4.7** The CLI assumes the **target schema already exists** (v1 is app-driven, data-only). Pointing it at a fresh empty target fails on the first insert. Standalone schema reconstruction (`3-schema-reconstruction.md`) lifts this.
- **NG-4.8** `openDataDir` (`src/loader.ts`) resolves a single engine module per call, so cross-major use still needs an engine per side, selected via `--source-engine`/`--target-engine`. Installing both under npm aliases is **no longer the only option**: `--fetch-missing-engine` acquires a pinned engine for whichever side is missing (FR-4.2a, [`15-engine-acquisition.md`](15-engine-acquisition.md)). **Verified (PGLM-19/PGLM-9):** with `pglite-old` = PG17 (0.4.3) and `pglite-new` = PG18 (0.5.3), `tests/e2e/cross-major.test.ts` asserts the two-engine flow is wired through *and* that a new-major engine genuinely refuses to open an old-major directory (the failure that motivates the tool). `tests/e2e/acquired-engine.test.ts` proves the same migration with the source engine acquired rather than installed.
- **NG-4.9** No `--dry-run`, `--backup`, or atomic-swap flags yet — see `5-safety-and-rollback.md`.

## Acceptance

- `pglite-migrate --help` prints usage and exits 0.
- Given a source with data and a target whose schema exists, the CLI reports the per-table row counts and a non-zero total, and the target ends up with the data.
