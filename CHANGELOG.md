# Changelog

All notable changes to **pglite-migrate** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

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

### Changed

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

### Fixed

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
