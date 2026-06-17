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
  catalog.ts      Shared catalog-SQL building blocks: tableKey, systemSchemaFilter(alias), regclassLiteral, countRows
  introspect.ts   introspectSchema(db): tables, columns (+ generated/identity), FKs, sequences via catalog SQL
  transfer.ts     topologicalSort (pure), transferTable (COPY-first + INSERT fallback), transferCycle, applySequences
  migrate.ts      migrate(options) orchestrator + planMigration (dry-run); reconstruct → prepare(onExisting) → transfer → sequences → validate → report
  validate.ts     validateMigration(source, target, schema, level): counts / sequence / full-digest checks
  backup.ts       backupDataDir(dir): verified, timestamped copy of a data dir (rollback)
  swap.ts         swapIntoPlace(canonical, new): atomic write-new-then-rename swap primitive
  reconstruct.ts  reconstructSchema(source, target, {onUnsupported}): rebuild app-class DDL via pg_get_*def (standalone mode); onUnsupported 'error' throws before any DDL
  loader.ts       openDataDir(dir, modulePath): open a data dir with a chosen PGlite package/alias
  version.ts      readClusterVersion(dataDir): read PG_VERSION without booting the cluster
  cli.ts          pglite-migrate bin; exports parseArgs + run(argv, io) + CliIO; entry-guarded so importing it does not auto-run
tests/
  topo / version / ident / catalog .test.ts   Pure unit tests (catalog: tableKey/systemSchemaFilter/regclassLiteral + countRows)
  introspect(.edge).test.ts              Introspection (basic + edge: multi-schema, dropped/qualified FK/composite, generated/identity, type qualifiers)
  transfer.test.ts                       transferTable (COPY + INSERT fallback + generated exclusion), applySequences
  migrate.test.ts                        Orchestrator: totals, FK ordering, cycle handling, validation, onExisting re-run safety, dry-run
  validate.test.ts                       counts / full-digest / sequence checks
  backup.test.ts / swap.test.ts          Backup copy+verify (incl. PG_VERSION/file-count mismatch); atomic swap + crash-before-swap + EXDEV/restore-on-failure (fs mocked)
  reconstruct.test.ts                    Standalone DDL rebuild + unsupported-object reporting
  loader.test.ts / cli.test.ts           openDataDir; parseArgs + run() over real temp dirs
  diagram-svg.test.ts                    Layout guard: parses assets/diagram.svg, asserts the README diagram's flow labels don't crowd/overlap (PGLM-36)
  demo-caret.test.ts                     Caret-tracking guard: parses assets/demos/*.svg, asserts the typing caret and text-reveal share a constant-speed (linear) timing so the caret can't lag the typed text (PGLM-37 / DM-1204)
  helpers.ts                             Shared SCHEMA_SQL + SEED_SQL fixtures
  e2e/roundtrip / fidelity / fk-cycle / standalone / cross-major .test.ts   Cross-major (PG17→PG18) runs via pglite-old/pglite-new aliases; cross-major asserts a PG18 engine refuses a PG17 dir
docs/                 Requirements (1–14), ARCHITECTURE.md, ai/ summaries
```

## Public API (`src/index.ts`)

- `migrate(options)` → `MigrationReport` — primary entry point (orchestrator)
- `planMigration(source, onProgress?)` → `MigrationReport` — dry-run plan (writes nothing)
- `introspectSchema(db)`, `validateMigration(...)`, `reconstructSchema(source, target, options?)`
- `topologicalSort`, `transferTable`, `transferCycle`, `applySequences`
- `backupDataDir(dir, opts?)`, `swapIntoPlace(canonical, new, opts?)` — safety primitives
- `openDataDir(dir, modulePath?)`, `readClusterVersion(dataDir)`
- Types: `PGliteLike`, `QueryOptions`, `MigrateOptions` (+ `validate`/`onExisting`/`dryRun`/`reconstructSchema`/`onUnsupported`), `MigrationReport`, `SchemaInfo`, `TableInfo`, `ColumnInfo`, `ForeignKey`, `SequenceInfo`, `ProgressEvent`, `TableResult`, `ValidationLevel`/`ValidationReport`/`TableValidation`/`SequenceValidation`, `OnExisting`, `OnUnsupported`/`ReconstructOptions`, `ReconstructionReport`/`UnsupportedObject`, `BackupOptions`, `SwapOptions`/`SwapResult`, `TopoResult`, `OpenedCluster`

## Key design points

- Core depends on `PGliteLike` (structural), never on `@electric-sql/pglite` — enables two different majors at once. PGlite is a **peer dependency**, external in the tsup build. `PGliteLike.query` carries an optional `{ blob }` option/result for COPY.
- Default path is **app-driven, data-only** (target schema pre-exists); `reconstructSchema: true` adds the **standalone** path that rebuilds app-class DDL first (the only place that does DDL on the target, plus the transient FK-deferrability flip in `transferCycle`).
- Catalog queries are version-agnostic (stable relations + `format_type`). FK edges are schema-qualified (`nspname || '.' || relname`, not `regclass::text`) so they match the qualified table keys used in `topologicalSort` (PGLM-20 fix).
- Data transfer is **COPY-text first** (`COPY … TO/FROM '/dev/blob'`, preserves `json`/etc.) with a per-table **row-by-row INSERT fallback**; generated-stored columns are excluded.
- `migrate` runs validation by default (`counts`), refuses a populated target by default (`onExisting: 'error'`), and never mutates the source.

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
- **…open an engine version / alias** → `src/loader.ts`; **…detect major version** → `src/version.ts`
- **…add/adjust types** → `src/types.ts`
- **…change the e2e version matrix** → `pglite-old` (0.4.x/PG17) / `pglite-new` (0.5.x/PG18) aliases in `package.json` (PGlite minor line ↔ PG major: 0.2→16, 0.3/0.4→17, 0.5→18)

## Build / test

- Build: `npm run build` (tsup → `dist/index.js` + `dist/cli.js` + `.d.ts`)
- Unit: `npm run test` · E2E: `npm run test:e2e` · Both: `npm run test:all`
- Lint: `npm run lint` · Types: `npm run typecheck`

## Maintenance triggers

Update this file when: a `src/` file is added/renamed/removed; the public API in `index.ts` changes; the directory tree changes; or the build/test commands change.
