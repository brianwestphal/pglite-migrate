# 4 — CLI (`pglite-migrate`)

The `pglite-migrate` bin (`src/cli.ts`) is the standalone, command-line face of the library. Its source keeps a leading `#!/usr/bin/env node` shebang, which esbuild preserves on entry points.

## Behavior

- **FR-4.1** `pglite-migrate <source-data-dir> <target-data-dir>` migrates data from the source data directory into the target.
- **FR-4.2** `--source-engine <pkg>` / `--target-engine <pkg>` select the npm module/alias used to open each side (default `@electric-sql/pglite`). This is how two different PGlite majors are wired in.
- **FR-4.2a** `--fetch-missing-engine` downloads a pinned engine when the named one does not resolve, so a host that bundles only the destination version can still migrate. `--engine-cache <keep|ephemeral>` chooses retention (default `keep`) and `--engine-cache-dir <path>` overrides where engines are stored. Off unless asked for; resolution is always tried first. Full spec: [`15-engine-acquisition.md`](15-engine-acquisition.md).
- **FR-4.2b** `--source-database <db>` / `--target-database <db>` select which database inside the cluster to open on each side, forwarded to the engine as `pgliteOptions.database`. Needed for a cluster written before PGlite 0.4.0 moved the default working database from `template1` to `postgres`: without it the CLI opens the empty default and transfers zero rows from a source that is entirely intact. Full spec: [`18-engine-construction-options.md`](18-engine-construction-options.md).
- **FR-4.3** `-h` / `--help` prints usage. No positional args (or fewer than two) prints usage and exits 0.
- **FR-4.4** On start, the CLI reads and reports each side's `PG_VERSION` (tolerating a missing/unreadable file) so the operator sees the major-version transition.
- **FR-4.5** Progress is written to stderr (one line per table); the final summary reports total rows, table count, and sequences aligned. Warnings are printed.
- **FR-4.6** On error, the message is printed to stderr and the process exits non-zero.
- **FR-4.7 Engine/data-directory precheck** After opening each side, the CLI verifies that the engine actually serves that directory's major and fails early with a diagnostic naming the directory, both majors, the engine specifier, and the `npm install` line for a version that *would* work (from the pinned registry, [`15-engine-acquisition.md`](15-engine-acquisition.md)). Without it a mismatch surfaces as PGlite's opaque initialization failure, which names none of those. The check compares against the `PG_VERSION` read **before** opening — an engine initializes a fresh directory at its own major, so a post-open read would always agree and the check would be vacuous. It is skipped when the directory had no `PG_VERSION` (nothing to compare, and querying would boot a cluster into existence) and, for the **target**, under `--dry-run` (see [`12-dry-run.md`](12-dry-run.md) FR-12.1). Library equivalent: `assertEngineMatchesDataDir`.

## Safety and re-run flags

- **FR-4.8** `--dry-run` reports the plan and writes nothing to the target ([`12-dry-run.md`](12-dry-run.md)). `--validate <off|counts|full>` selects post-migration validation depth (default `counts`) and `--strict` turns a validation failure into a thrown `ValidationError` ([`13-post-migration-validation.md`](13-post-migration-validation.md)); either way a failed validation exits non-zero. `--on-existing <error|truncate|skip>` picks the re-run policy for a non-empty target (default `error`, [`14-idempotence.md`](14-idempotence.md)).
- **FR-4.9** `--backup` copies the source data directory before migrating, `--backup-dir <path>` redirects it, and `--keep <n>` bounds how many timestamped backups are retained ([`10-backup.md`](10-backup.md)). Backup runs before either engine is opened, and is skipped under `--dry-run`. It is **opt-in**; doc 10's open question about making it default-on is still unresolved.
- **FR-4.10** `--reconstruct-schema` (alias `--standalone`) rebuilds the source's app-class schema on an empty target first, and `--on-unsupported <warn|error>` decides what happens when the source holds out-of-scope objects ([`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md)).

## Current limitations / deferred

- **NG-4.7** ~~The CLI assumes the **target schema already exists**.~~ **Lifted** by `--reconstruct-schema` (FR-4.10, [`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md)). Without that flag the default is still app-driven and data-only, so pointing the CLI at a bare empty target does fail on the first write — that is now a choice, not a limitation.
- **NG-4.8** `openDataDir` (`src/loader.ts`) resolves a single engine module per call, so cross-major use still needs an engine per side, selected via `--source-engine`/`--target-engine`. Installing both under npm aliases is **no longer the only option**: `--fetch-missing-engine` acquires a pinned engine for whichever side is missing (FR-4.2a, [`15-engine-acquisition.md`](15-engine-acquisition.md)). **Verified (PGLM-19/PGLM-9):** with `pglite-old` = PG17 (0.4.3) and `pglite-new` = PG18 (0.5.3), `tests/e2e/cross-major.test.ts` asserts the two-engine flow is wired through *and* that a new-major engine genuinely refuses to open an old-major directory (the failure that motivates the tool). `tests/e2e/acquired-engine.test.ts` proves the same migration with the source engine acquired rather than installed.
- **NG-4.9** ~~No `--dry-run`, `--backup`, or atomic-swap flags yet.~~ **Mostly lifted:** `--dry-run`, `--backup`/`--backup-dir`/`--keep`, `--validate`/`--strict`, and `--on-existing` all ship (FR-4.8/FR-4.9). **Atomic swap is still CLI-unwired** — `swapIntoPlace` exists as a library primitive only, so the CLI migrates directly into the target rather than staging-then-swapping. None of doc 11's flags (`--swap`/`--no-swap`, `--staging-dir`, `--keep-old`, `--clean-stale`, `--force-cross-fs`) exist yet; see [`11-atomic-swap.md`](11-atomic-swap.md).
- **NG-4.11** ~~The CLI prints validation as a single line.~~ **Lifted (PGLM-85).** On a failure the CLI now prints one line per table (`public.a: 2 ≠ 1`) and per sequence before the verdict, so the operator sees *by how much* something diverged, not just which table. A passing run stays quiet — `counts` is the default, and the per-table progress lines already show what moved. The one piece still unimplemented is doc 13's `Validation: FAILED — target not swapped` wording, which would assert something untrue until the CLI has a swap step to suppress.

## Acceptance

- `pglite-migrate --help` prints usage and exits 0.
- Given a source with data and a target whose schema exists, the CLI reports the per-table row counts and a non-zero total, and the target ends up with the data.
- `--dry-run` prints a plan, exits 0, and leaves the target byte-for-byte unchanged.
- An engine that cannot serve its data directory fails with the FR-4.7 diagnostic rather than PGlite's opaque initialization error.

> **Numbering note:** `FR-4.7` (engine precheck) and `NG-4.7` (target-schema assumption) share a number for historical reasons. They are distinct requirements; the prefix disambiguates them.
