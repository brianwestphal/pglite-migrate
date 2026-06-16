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
  introspect.ts   introspectSchema(db): tables, columns, FKs, sequences via catalog SQL
  transfer.ts     topologicalSort (pure), transferTable, applySequences
  migrate.ts      migrate(options): orchestrator (introspect → sort → transfer → sequences → report)
  loader.ts       openDataDir(dir, modulePath): open a data dir with a chosen PGlite package/alias
  version.ts      readClusterVersion(dataDir): read PG_VERSION without booting the cluster
  cli.ts          pglite-migrate bin; exports parseArgs + run(argv, io) + CliIO; entry-guarded so importing it does not auto-run
tests/
  topo.test.ts            Pure unit tests for topologicalSort
  version.test.ts         Pure unit tests for readClusterVersion (temp PG_VERSION files)
  ident.test.ts           Pure unit tests for the quoting helpers
  introspect.test.ts      Introspection against an in-memory PGlite (basic fixture)
  introspect.edge.test.ts Introspection edge cases (multi-schema, dropped cols, composite/self FK, qualified FK, null-seq, type qualifiers)
  transfer.test.ts        Unit tests for transferTable + applySequences (in-memory)
  migrate.test.ts         Orchestrator unit tests (totals, cycle warning, FK ordering, empty schema)
  loader.test.ts          Unit tests for openDataDir (default engine, alias, bad module)
  cli.test.ts             parseArgs units + run() integration over real temp data dirs
  helpers.ts              Shared SCHEMA_SQL + SEED_SQL fixtures
  e2e/roundtrip.test.ts   Two-version round-trip via pglite-old / pglite-new aliases
  e2e/fidelity.test.ts    Type-fidelity round-trip (json is it.fails until COPY-text lands)
  e2e/fk-cycle.test.ts    FK-cycle handling (empty passes; populated is it.fails until deferred constraints)
docs/                 Requirements (1–14), ARCHITECTURE.md, ai/ summaries
```

## Public API (`src/index.ts`)

- `migrate(options)` → `MigrationReport` — primary entry point (app-driven, data-only)
- `introspectSchema(db)` → `SchemaInfo`
- `topologicalSort(tables, fks)` → `TopoResult`; `transferTable(...)`; `applySequences(...)`
- `openDataDir(dir, modulePath?)` → `OpenedCluster`
- `readClusterVersion(dataDir)` → `number`
- Types: `PGliteLike`, `MigrateOptions`, `MigrationReport`, `SchemaInfo`, `TableInfo`, `ColumnInfo`, `ForeignKey`, `SequenceInfo`, `ProgressEvent`, `TableResult`

## Key design points

- Core depends on `PGliteLike` (structural), never on `@electric-sql/pglite` — enables two different majors at once. PGlite is a **peer dependency**, external in the tsup build.
- v1 is **app-driven, data-only**: the target schema is created by the host app; this library transfers data only. No DDL on the target.
- Catalog queries are version-agnostic (stable relations + `format_type`). FK edges are schema-qualified (`nspname || '.' || relname`, not `regclass::text`) so they match the qualified table keys used in `topologicalSort` — this is the PGLM-20 fix; using `regclass::text` silently dropped public-schema FK edges.
- Data transfer is row-by-row parameterized `INSERT` (COPY-text fidelity path is deferred).

## Where do I look to…

- **…change what's introspected** → `src/introspect.ts`
- **…change insert ordering / cycle handling** → `topologicalSort` in `src/transfer.ts`
- **…change how rows are copied** (e.g. add COPY-text) → `transferTable` in `src/transfer.ts`
- **…change sequence handling** → `applySequences` in `src/transfer.ts`
- **…change the orchestration / report** → `src/migrate.ts`
- **…add a CLI flag** → `src/cli.ts`
- **…open an engine version / alias** → `src/loader.ts`
- **…detect the cluster major version** → `src/version.ts`
- **…add/adjust types** → `src/types.ts`
- **…change the e2e version matrix** → `pglite-old`/`pglite-new` aliases in `package.json` + `tests/e2e/roundtrip.test.ts`

## Build / test

- Build: `npm run build` (tsup → `dist/index.js` + `dist/cli.js` + `.d.ts`)
- Unit: `npm run test` · E2E: `npm run test:e2e` · Both: `npm run test:all`
- Lint: `npm run lint` · Types: `npm run typecheck`

## Maintenance triggers

Update this file when: a `src/` file is added/renamed/removed; the public API in `index.ts` changes; the directory tree changes; or the build/test commands change.
