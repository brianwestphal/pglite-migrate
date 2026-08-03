# Code Summary (AI orientation)

> Fastest way to orient in this codebase. Keep in sync when the code changes (see triggers at the end).

## What it is

A library + CLI that migrates PGlite data across PostgreSQL major versions by running two PGlite engines side by side and transferring data at the SQL level. No native binaries, no `pg_upgrade`. See `CLAUDE.md` and `docs/1-overview.md`.

## Directory tree

```
src/
  index.ts        Public API barrel — the only import surface for consumers
  types.ts        PGliteLike structural interface + all result/option types (SSOT for shapes)
  ident.ts        SQL identifier/literal quoting helpers
  fsutil.ts       Shared filesystem/error building blocks (the catalog.ts of the fs side): exists, sanitizedTimestamp (NTFS-safe `:`→`-`, keeps ms), errorCode
  catalog.ts      Shared catalog-SQL building blocks: tableKey, objectKey (schema.table.object), systemSchemaFilter(alias), regclassLiteral, countRows (bigint-safe via ::text), hasRows (bounded LIMIT 1 probe), tableKeys (every user table's key; lighter than introspectSchema)
  introspect.ts   introspectSchema(db): tables, columns (+ generated/identity), FKs, sequences via catalog SQL
  transfer.ts     topologicalSort (pure), transferTable (COPY-first + INSERT fallback; names BOTH errors if the fallback also fails), transferCycle, applySequences
  migrate.ts      migrate(options) orchestrator + planMigration (dry-run); reconstruct → prepare(onExisting) → transfer → sequences → validate → report. Report echoes onExisting + truncatedTables
  validate.ts     validateMigration(source, target, schema, level): counts / sequence / full-digest checks; exports ValidationError (thrown by migrate when onValidationFailure: 'throw'). The `full` digest is CONTENT-only, never layout: it projects the source∩target column intersection name-sorted on both sides (PGLM-99), introspecting the target once. missingColumns fail the table (and suppress the digest); extraColumns are reported only. targetTableMap reads the target's table set at EVERY level (3 states: key absent = no such table / null = present, columns unread / Set = present + columns), so a table the target lacks is a reported missingTable failure instead of an exception that killed the whole report (PGLM-101)
  backup.ts       backupDataDir(dir, {backupDir,timestamp,keep}): verified, timestamped copy of a data dir (rollback); keep prunes oldest .bak-* siblings
  swap.ts         swapIntoPlace(canonical, new): atomic write-new-then-rename swap primitive
  reconstruct.ts  reconstructSchema(source, target, {onUnsupported}): rebuild app-class DDL via pg_get_*def (standalone mode); schemas → custom types → sequences(+params) → tables → OWNED BY → constraints → indexes; onUnsupported 'error' throws before any DDL. reconstructCustomTypes emits enums+domains+composites+ranges in ONE pg_type.oid-ordered pass (OID order IS dependency order — docs 16/17). detectUnsupported is table-driven (DETECTORS) and covers every remaining NG-9.10 class
  loader.ts       openDataDir(dir, modulePath, options): open a data dir with a chosen PGlite package/alias; resolve-first, then optional acquisition; absolute paths go through pathToFileURL. OpenOptions.pgliteOptions is forwarded verbatim as the PGlite constructor's 2nd arg on BOTH construction sites via construct() (PGLM-100 — chiefly `{database:'template1'}` for pre-0.4.0 clusters); omitting it constructs with one argument, not an explicit undefined
  version.ts      readClusterVersion(dataDir): read PG_VERSION without booting the cluster; readEngineMajor(db): ask a running engine which major it IS
  precheck.ts     assertEngineMatchesDataDir(db, {dataDir, expectedMajor, side, engine}): fail early when an engine can't serve the dir; exports EngineMismatchError. expectedMajor must be the PRE-open PG_VERSION (a fresh dir is initialized at the engine's own major, so a post-open read is vacuous); null skips without querying
  engines.ts      Second public entry point (`pglite-migrate/engines`) — the opt-in acquisition API; the ONLY network surface
  engines/
    registry.ts   Pinned Postgres-major → PGlite version + sha512 table; resolveEngine / knownMajors / UnknownMajorError
    acquire.ts    acquireEngine(major) / acquireRelease(release): download → verify pinned hash → extract → resolveEntry; cache 'keep' (default) | 'ephemeral'
    tar.ts        extractTarGz: hand-rolled, zero-dep, security-hardened (refuses links/devices/traversal/bad checksums; ignores archive modes)
  cli.ts          pglite-migrate bin; exports parseArgs + run(argv, io) + CliIO; entry-guarded so importing it does not auto-run. reportValidation prints per-table/per-sequence detail on failure only (incl. missingColumns). --source-database/--target-database map to pgliteOptions.database (PGLM-100); --source-option/--target-option k=v (repeatable) set any key, value = JSON.parse or the raw string on failure, split on the FIRST = (PGLM-102). Both accumulate into CliArgs.sourceOptions/targetOptions, left undefined when no flag was passed so construct() still uses one argument
tests/
  topo / version / ident / catalog / fsutil .test.ts   Pure unit tests (catalog: tableKey/objectKey/systemSchemaFilter/regclassLiteral + countRows/hasRows/tableKeys; fsutil: exists/sanitizedTimestamp/errorCode)
  introspect(.edge).test.ts              Introspection (basic + edge: multi-schema, dropped/qualified FK/composite, generated/identity, type qualifiers)
  transfer.test.ts                       transferTable (COPY + INSERT fallback + generated exclusion + both-paths-fail error), applySequences, transferCycle failure/retry + fallback-inside-cycle
  migrate.test.ts                        Orchestrator: totals, FK ordering, cycle handling, validation, onExisting re-run safety (incl. a PARTIALLY-populated target: mixed skip-some/fill-others + FK integrity), dry-run
  validate.test.ts                       counts / full-digest / sequence checks + column layout (PGLM-99: reordered columns pass, target-only reported, source-only fails, swapped values + real drift still fail, zero-column table, counts stays column-free) + missing table at BOTH levels reported without aborting the rest (PGLM-101)
  backup.test.ts / swap.test.ts          Backup copy+verify (incl. PG_VERSION/file-count mismatch, no-PG_VERSION dir); atomic swap + crash-before-swap + EXDEV/restore-on-failure (fs mocked) + SEQUENTIAL swaps (swap→swap, same-second collision, retry-after-restore, keepOld:false→swap)
  reconstruct.test.ts                    Standalone DDL rebuild + unsupported-object reporting + audit regressions (multi-schema, sequence params, OWNED BY) + custom types (domains w/ enforced CHECKs, composites, COLLATE, cross-kind ordering, range still reported)
  loader.test.ts / cli.test.ts           openDataDir (resolve-first, missing-engine errors, acquired-engine lifecycle, pgliteOptions on BOTH paths + the template1 bug and its negative); parseArgs + run() over real temp dirs (incl. engine/dir major mismatch, --source-database migrating a template1-era cluster)
  precheck.test.ts                       readEngineMajor + assertEngineMatchesDataDir: match, mismatch, unpinned major, no-PG_VERSION skip (asserts NO query is issued), refusing engine
  engines/registry.test.ts               Pinned table: lookup, unknown major, one-release-per-major, `15devel` parse
  engines/tar.test.ts                    Extractor + hostile archives (traversal, links, devices, bad checksum, pax/GNU overrides)
  engines/acquire.test.ts                Acquisition against a local HTTP server: integrity, cache hit/miss, both retention modes, races, mode transitions
  engines/fixtures.ts                    Synthetic tar/tgz builder (incl. hostile entries) + a stand-in engine package
  diagram-svg.test.ts                    Layout guard: parses assets/diagram.svg, asserts the README diagram's flow labels don't crowd/overlap (PGLM-36)
  demo-caret.test.ts                     Caret-tracking guard: parses assets/demos/*.svg, asserts the typing caret and text-reveal share a constant-speed (linear) timing so the caret can't lag the typed text (PGLM-37 / DM-1204)
  demo-loop.test.ts                      Loop-boundary guard: parses assets/demos/*.svg, asserts the output is revealed then hidden and never outlives the typed command at the loop cut (PGLM-46)
  helpers.ts                             Shared SCHEMA_SQL + SEED_SQL fixtures
  tempdir.ts / tempdir.test.ts           makeTempDir/removeTempDir — every test scratch dir goes through these; removeTempDir retries ENOTEMPTY and never throws, so teardown can't bury a real failure (PGLM-93)
  e2e/roundtrip / fidelity / fk-cycle / standalone / cross-major .test.ts   Cross-major (PG17→PG18) runs via pglite-old/pglite-new aliases; cross-major asserts a PG18 engine refuses a PG17 dir
  e2e/column-drift.test.ts               The app-driven layout case (PGLM-99): target declares the same columns in a different order + one extra; `full` passes, extraColumns reported, real drift still fails
  e2e/acquired-engine.test.ts            Migration whose SOURCE engine is downloaded, not installed. The only network-dependent suite — self-gates and ctx.skip()s offline
  e2e/engine-mismatch.test.ts            Real PG18 engine on a real PG17 dir: the precheck's actionable error replaces PGlite's opaque init failure
docs/                 Requirements (1–18), ARCHITECTURE.md, ai/ summaries
```

## Public API (`src/index.ts`)

- `migrate(options)` → `MigrationReport` — primary entry point (orchestrator)
- `planMigration(source, onProgress?)` → `MigrationReport` — dry-run plan (writes nothing)
- `introspectSchema(db)`, `validateMigration(...)`, `reconstructSchema(source, target, options?)`
- `topologicalSort`, `transferTable`, `transferCycle`, `applySequences`
- `MigrationReport` now also carries `onExisting` (resolved policy) and `truncatedTables` (destructive re-run record); `ReconstructionReport` carries `schemas`, `domains`, `composites`, `ranges`
- `backupDataDir(dir, opts?)`, `swapIntoPlace(canonical, new, opts?)` — safety primitives
- `openDataDir(dir, modulePath?, options?)`, `readClusterVersion(dataDir)`, `readEngineMajor(db)`
- `assertEngineMatchesDataDir(db, options)` + `EngineMismatchError` — engine/data-directory major precheck
- `resolveEngine(major)`, `knownMajors()`, `PGLITE_PACKAGE`, `UnknownMajorError` — the pinned registry (pure data, no network)
- **`pglite-migrate/engines`** (second entry point, the only network surface): `acquireEngine(major, opts?)`, `acquireRelease(release, opts?)`, `defaultCacheDir()`, `resolveEntry(dir)`, `extractTarGz`, `safeEntryPath`, `EngineFetchError`, `IntegrityError`, `TarError`
- Types: `PGliteLike`, `QueryOptions`, `MigrateOptions` (+ `validate`/`onValidationFailure`/`onExisting`/`dryRun`/`reconstructSchema`/`onUnsupported`), `MigrationReport`, `SchemaInfo`, `TableInfo`, `ColumnInfo`, `ForeignKey`, `SequenceInfo`, `ProgressEvent`, `TableResult`, `ValidationLevel`/`OnValidationFailure`/`ValidationReport`/`TableValidation`/`SequenceValidation`, `OnExisting`, `OnUnsupported`/`ReconstructOptions`, `ReconstructionReport`/`UnsupportedObject`, `BackupOptions`, `SwapOptions`/`SwapResult`, `TopoResult`, `OpenedCluster`, `OpenOptions`, `EngineCacheMode`, `EngineRelease`; value export `ValidationError`

## Key design points

- Core depends on `PGliteLike` (structural), never on `@electric-sql/pglite` — enables two different majors at once. PGlite is a **peer dependency**, external in the tsup build. `PGliteLike.query` carries an optional `{ blob }` option/result for COPY.
- Default path is **app-driven, data-only** (target schema pre-exists); `reconstructSchema: true` adds the **standalone** path that rebuilds app-class DDL first (the only place that does DDL on the target, plus the transient FK-deferrability flip in `transferCycle`).
- Catalog queries are version-agnostic (stable relations + `format_type`). FK edges are schema-qualified (`nspname || '.' || relname`, not `regclass::text`) so they match the qualified table keys used in `topologicalSort` (PGLM-20 fix).
- Data transfer is **COPY-text first** (`COPY … TO/FROM '/dev/blob'`, preserves `json`/etc.) with a per-table **row-by-row INSERT fallback**; generated-stored columns are excluded.
- `migrate` runs validation by default (`counts`), refuses a populated target by default (`onExisting: 'error'`), and never mutates the source.
- **Engine acquisition is opt-in and resolve-first.** An installed engine always wins; a download is considered only when the specifier does not resolve *and* the failure names it (so a module that breaks on its own imports surfaces its own error). Hashes are pinned in-package, not read from the registry, so a spoofed response cannot get code past verification. Network code is reached only through a dynamic `import()` on the opt-in path: importing `pglite-migrate` makes no network call, does not evaluate the acquisition module, and does not export `acquireEngine`. (The build uses `splitting: false`, so the bytes are inlined into `dist/index.js` but wrapped in esbuild's lazy `__esm` initializer — non-evaluation, not byte-level absence.) Package still has **zero runtime dependencies**, which is why the tar extractor is hand-rolled.

## Where do I look to…

- **…change what's introspected** → `src/introspect.ts`
- **…change shared catalog-SQL helpers (schema filter / qualified keys / row count)** → `src/catalog.ts`
- **…change insert ordering / cycle handling** → `topologicalSort` / `transferCycle` in `src/transfer.ts`
- **…change how rows are copied** → `transferTable` (COPY/INSERT) in `src/transfer.ts`
- **…change sequence handling** → `applySequences` in `src/transfer.ts`
- **…change orchestration / dry-run / re-run safety** → `src/migrate.ts`
- **…change validation** → `src/validate.ts`
- **…change standalone schema rebuild** → `src/reconstruct.ts`
- **…change backup / atomic swap** → `src/backup.ts` / `src/swap.ts`
- **…add a CLI flag** → `src/cli.ts`
- **…open an engine version / alias, or pass options to the PGlite constructor** → `src/loader.ts`; **…detect major version** → `src/version.ts`
- **…pin a new Postgres major's engine** → `src/engines/registry.ts` (verify empirically first — download, hash, boot, read `server_version`)
- **…change downloading / caching an engine** → `src/engines/acquire.ts`; **…change archive-extraction safety** → `src/engines/tar.ts`
- **…add/adjust types** → `src/types.ts`
- **…change the e2e version matrix** → `pglite-old` (0.4.x/PG17) / `pglite-new` (0.5.x/PG18) aliases in `package.json` (PGlite minor line ↔ PG major: 0.2→16, 0.3/0.4→17, 0.5→18)

## Build / test

- Build: `npm run build` (tsup → `dist/index.js` + `dist/engines.js` + `dist/cli.js` + `.d.ts`)
- Unit: `npm run test` · E2E: `npm run test:e2e` · Both: `npm run test:all`
- Lint: `npm run lint` · Types: `npm run typecheck`
- **Formatting is enforced by ESLint, not a formatter.** `eslint.config.mjs` owns import ordering/placement (`simple-import-sort`, `import/first`, `import/newline-after-import`, `import/no-duplicates`, `consistent-type-imports`) plus `max-len` at 100 columns, ignoring strings, template literals and regex literals (PGLM-88). There is deliberately no prettier/`.prettierrc`. CI enforces it via the existing `npm run lint` step — no separate format gate.
- Release-adjacent: `npm run commit-message` (gitgist) · `npm run changelog-analysis -- --next <ver>` (diff analysis feeding the `technical-changelog` skill; prints only, writes nothing)
- `gitgist.config.json` — repo-level gitgist config. Excludes the generated SVGs (`assets/demos/*`, `assets/diagram.svg`) from the diff *body* fed to the model; they were 52% of the release-notes budget. The files still appear in the changed-file list and diffstat, so "demos regenerated" is still reportable. Bypass with `--no-config`.

## Maintenance triggers

Update this file when: a `src/` file is added/renamed/removed; the public API in `index.ts` changes; the directory tree changes; or the build/test commands change.
