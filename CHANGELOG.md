# Changelog

All notable changes to **pglite-migrate** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- `validateMigration(..., 'full')` no longer reports a mismatch for tables whose data migrated perfectly but whose columns sit in a different physical order on the target. The per-table digest hashed a whole-row `::text`, which Postgres renders in ordinal-position order, so it encoded the table's column *layout* along with its content. This is the norm in the app-driven path — the source reached its schema by `ALTER TABLE ADD COLUMN` (which appends) while the target was built from the host app's current `CREATE TABLE` — which made `full` unusable as a pass/fail gate there. The digest is now taken over the source/target column intersection, projected in the same name-sorted order on both sides.

### Added

- `openDataDir` accepts `pgliteOptions`, forwarded verbatim to the PGlite constructor on both the resolved and the acquired path — and the CLI gained `--source-database` / `--target-database`. PGlite 0.4.0 moved the default working database from `template1` to `postgres`, so a cluster written by an older PGlite keeps its tables where a default open never looks: every query fails with `relation "…" does not exist`, and a migration of such a source "succeeds" having transferred nothing. Previously the only way through was to skip `openDataDir` and hand-roll the engine import, reimplementing the resolve-then-acquire logic it exists to provide. New requirements doc: `docs/18-engine-construction-options.md`.

- `TableValidation` gained `comparedColumns`, `missingColumns`, and `extraColumns` (all `full`-level only). Source columns the target lacks now **fail** the table as an explicit, separately-reported check — and are named on the CLI's per-table failure line — rather than being caught only incidentally by the digest. Columns only the target has are reported and do **not** fail, since a host app on a newer schema than its data is the expected case.

## [2.0.1] - 2026-08-01



- Fixed the npm publish workflow failing before install; the publish job now pins npm to the 11.x line instead of installing `@latest`, which had begun requiring a newer Node than the workflow uses.


- Regenerated the terminal demo recordings, adding the previously missing engine-mismatch clip referenced by the README.

## [2.0.0] - 2026-08-01



- **Custom types are reconstructed, not just enums.** Standalone reconstruction
  now rebuilds **domains** (base type, `DEFAULT`, `NOT NULL`, `COLLATE`, and every
  `CHECK`, with constraint names preserved), **composite types**, and **range
  types** — completing the category that previously stopped at enums. All type
  kinds are emitted in a single dependency-safe pass, so a domain over an enum, a
  composite with a domain-typed attribute, or a range over a domain all land
  correctly. See `docs/16-custom-types.md` and `docs/17-range-types.md`.

- **Engine acquisition.** `pglite-migrate` can now fetch the old PGlite engine a
  data directory needs, instead of requiring every consumer to install one under
  an npm alias. An application typically bundles only the engine it was built
  against — the destination — while the *source* version is a property of the
  data on disk. Opt in with `openDataDir(dir, engine, { fetchMissingEngine: true })`
  or `--fetch-missing-engine`.
  - Engines are pinned per Postgres major (PG15–PG18) and verified against a
    sha512 shipped in this package, so a spoofed registry response cannot get
    code past verification.
  - Retention is the caller's choice: `keep` (default) caches the engine for
    later runs, `ephemeral` removes it when the cluster closes.
  - Resolution always comes first — an installed engine wins and nothing is
    downloaded. Off unless explicitly requested.
  - New `pglite-migrate/engines` entry point exposes the acquisition API.
    Importing `pglite-migrate` makes no network call and does not evaluate the
    acquisition module.
  - The package still has **zero runtime dependencies**.

- **Engine/data-directory precheck.** Pointing `--source-engine` at an engine
  that bundles the wrong PostgreSQL major used to surface as PGlite's opaque
  `PGlite failed to initialize properly`, which names neither major, nor the
  directory, nor the engine. The CLI now fails early with all of that plus the
  `npm install` line for a version that would work. Available to library callers
  as `assertEngineMatchesDataDir`.

- **The migration report says what a re-run actually did.** `MigrationReport`
  gains `onExisting` (the resolved policy, including the default) and
  `truncatedTables` — the only record that a destructive re-run discarded data.
  Previously an `onExisting: 'truncate'` run was indistinguishable from a clean
  first run.

- **Reconstruction reports what it created**, per object class:
  `ReconstructionReport` gains `schemas`, `domains`, `composites` and `ranges`
  alongside the existing buckets.

- **Per-table validation output on the CLI.** A failed `--validate` run now prints
  the source-vs-target counts for every table and sequence before the verdict, so
  an operator sees *by how much* something diverged rather than only which table.
  A passing run stays quiet.


- **Out-of-scope object detection is complete.** Standalone reconstruction
  reported 6 of the ~13 object classes it declares out of scope; it now covers all
  of them — views, materialized views, partitioned and foreign tables, functions,
  triggers, RLS policies, rules, operator classes, collations, comments, grants
  and extensions. `--on-unsupported error` is only as trustworthy as this list, so
  the gaps meant a "clean" pass could still lose objects silently.

- A missing engine now reports the detected major, the exact install command,
  and the opt-in flag instead of a bare `ERR_MODULE_NOT_FOUND`.

- The non-empty-target probe is now a bounded existence check rather than a full
  `count(*)` scan per table.


- **Multi-schema sources failed outright.** Reconstruction emitted qualified DDL
  without ever creating the schema, so any source using a non-`public` schema died
  with `schema "…" does not exist` — even though introspection deliberately covers
  every non-system schema.

- **Sequences lost their defining parameters.** `CREATE SEQUENCE` was emitted bare,
  so a source declaring `START 100 INCREMENT 5 MAXVALUE 900 CYCLE` reconstructed as
  a plain default sequence. Quiet in the common `serial` case, because sequence
  realignment masks it — but a cycling or strided sequence silently changed
  behavior on the target.

- **`OWNED BY` was never re-established**, orphaning a `serial` column's sequence:
  inserts still worked, so the omission hid, but dropping the table left the
  sequence behind and `pg_get_serial_sequence` returned null.

- **A domain- or composite-typed column crashed reconstruction mid-run**, leaving a
  partially-built target and bypassing `onUnsupported: 'error'` — whose entire
  purpose is to refuse *before* any DDL runs. Both kinds are now reconstructed.

- **A range type's five auto-created constructor functions were reported as
  unsupported user functions.** Under `--on-unsupported error` that would refuse an
  otherwise valid migration for objects the source never declared.

- **Row counts errored above 2³¹ rows.** `count(*)` was cast to `int`; it is now
  read as text and parsed, so the only remaining ceiling is JavaScript's exact
  integer range.

- **A failed COPY could mask its own cause.** When the row-by-row `INSERT` fallback
  also failed, only the fallback's error escaped — which inside a foreign-key cycle
  is a bare `current transaction is aborted` naming neither the real failure nor the
  table. Both errors are now reported, with the fallback's retained as `cause`.

- `openDataDir` now imports absolute engine paths via `pathToFileURL`, which
  previously would have failed on Windows.
- A cluster that never initialized rejects on `close()`; the CLI's cleanup let
  that escape, appending a second confusing error after the real one and
  bypassing the exit code it had already decided on.



- **Automatic engine acquisition.** `pglite-migrate` can now download the old PGlite engine a data directory needs instead of requiring you to hand-install it under an npm alias — opt in with `openDataDir(dir, engine, { fetchMissingEngine: true })` or the CLI's `--fetch-missing-engine`. Resolution is always tried first, so an installed engine still wins and nothing is downloaded.
- **Engine downloads are pinned and verified.** Each Postgres major maps to a known-good `@electric-sql/pglite` release with a pinned sha512; bytes are hash-checked before anything is written to disk, and the archive extractor refuses symlinks, hardlinks, devices and path traversal.
- **Choose where acquired engines live.** `--engine-cache <keep|ephemeral>` (default `keep`, reused across runs) and `--engine-cache-dir <path>`, with matching `cache`/`cacheDir` options on the library API.
- **New `pglite-migrate/engines` entry point** exposing `acquireEngine`, `resolveEngine`, `knownMajors`, `extractTarGz` and friends. It is the only network-reaching code in the package — importing `pglite-migrate` itself never evaluates it.
- **Standalone reconstruction now rebuilds every custom type.** Domains (base type, `DEFAULT`, `NOT NULL`, `COLLATE`, and every named `CHECK`), composite types, and range types join enums, all emitted in one dependency-ordered pass — so a domain over an enum, a composite with a domain-typed attribute, or a range over a domain all land correctly.
- **Multi-schema sources work.** Non-`public` schemas are created up front, before any qualified DDL is emitted.
- **Sequences are reconstructed faithfully**, including start/increment/min/max/cycle and their `OWNED BY` links.
- **Richer migration reports.** `MigrationReport` now echoes the active `onExisting` strategy and lists the tables a `truncate` re-run emptied.


- **Clear error when an engine can't serve its data directory.** Instead of PGlite's opaque `failed to initialize properly`, the CLI now names the directory, its PostgreSQL major, the engine you pointed at it, and the install line for a version that would work. Exposed as `assertEngineMatchesDataDir` / `EngineMismatchError`, plus `readEngineMajor(db)` to ask a running engine which major it is.
- **Failed transfers report both errors.** When COPY fails and the INSERT fallback also fails, the error now carries both messages — the fallback's error alone was often misleading inside an aborted transaction.
- **More out-of-scope objects are detected and reported** during reconstruction: comments, grants, collations, rules and functions. A view's implicit `_RETURN` rule and row type are no longer misreported as separate objects.
- **`GENERATED BY DEFAULT AS IDENTITY` is no longer confused with `GENERATED ALWAYS`**, so reconstruction emits the right DDL for each.
- **Row counts are bigint-safe**, and the non-empty-target check uses a bounded `LIMIT 1` probe instead of counting every row.
- **Backup and swap directory suffixes no longer collide** on runs inside the same second, and the timestamps stay legal on NTFS.


- New specs for engine acquisition (`docs/15`), custom types (`docs/16`) and range types (`docs/17`); docs 3 and 5 dropped their stale "DEFERRED / not implemented" headers now that standalone reconstruction and the whole safety layer have shipped.
- The README's CLI table now matches the actual flag set, including the six that shipped undocumented.
- The shipped `--backup` posture is documented as opt-in (there is no `--no-backup`), and the validation report shapes in `docs/13` were corrected to match `src/types.ts`.


- `npm run release` now seeds the release-notes editor from the curated `## Unreleased` changelog section and resets it to `_Nothing yet._` afterward, so hand-written entries actually ship instead of silently accumulating across releases. `--beta` leaves the section untouched.
- New `npm run changelog-analysis` script producing a diff-grounded analysis (line delta by area, exported-name/CLI-flag/dependency deltas) between the last production tag and HEAD.

## [1.0.0] - 2026-06-20

- Initial development release. The app-driven, data-only migration path
  (introspect → topological sort → COPY-text transfer → sequence realignment)
  runs end to end across a real PG17 → PG18 pair, alongside standalone schema
  reconstruction, FK-cycle handling, and the backup / dry-run / validation /
  atomic-swap safety layer.
- Updated gitgist to 1.0.0.

## [0.0.2] - 2026-06-17


- Validation can now optionally throw on failure instead of only reporting (opt-in)
- Backup retention via `--keep <n>` to prune older backups automatically
- Schema reconstruction gains an `onUnsupported` option for handling out-of-scope objects

## [0.0.1] - 2026-06-17


- COPY-text data transfer for higher fidelity, with a per-table INSERT fallback
- Correct row ordering and cyclic foreign keys via topological sort + deferred constraints
- Standalone schema reconstruction (`--reconstruct-schema`) rebuilds app-class DDL
- Safety layer: source backup, atomic swap, `--dry-run`, and post-migration validation
- Re-run safety via `onExisting`, plus generated/identity column support
- Fixed a public-schema foreign-key bug that broke insert ordering and cycles
- Verified cross-major migrations against real PG17 → PG18 PGlite engines
