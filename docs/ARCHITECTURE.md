# Architecture

## Components

```
                ┌─────────────────────────────────────────────┐
   CLI  ───────▶│  migrate(options)            (src/migrate.ts) │
   or app       │                                               │
                │   1. introspectSchema(source) (introspect.ts) │
                │   2. topologicalSort(...)        (transfer.ts) │
                │   3. transferTable(...) per table(transfer.ts) │
                │   4. applySequences(...)         (transfer.ts) │
                │   5. MigrationReport                           │
                └───────▲──────────────────────────▲────────────┘
                        │ PGliteLike               │ PGliteLike
                ┌───────┴────────┐         ┌────────┴─────────┐
                │ source engine  │         │  target engine   │
                │ (old PG major) │         │  (new PG major)  │
                └────────────────┘         └──────────────────┘
```

## The decoupling that makes it work

`src/types.ts` defines `PGliteLike` — a minimal `{ query, exec }` interface. The core imports it, never `@electric-sql/pglite`. Because `migrate` receives two already-open `PGliteLike` instances, the caller can construct them from two *different* PGlite major versions (the old engine reads the existing data; the new engine receives it). This is the entire reason a cross-major migration is possible without native binaries.

`@electric-sql/pglite` is therefore a **peer dependency**, never bundled (`tsup.config.ts` marks it external). The CLI constructs engines via `openDataDir` (`src/loader.ts`), which dynamically imports a chosen module/alias.

## Data flow

1. Host app (or CLI) opens the **source** with the old engine and the **target** with the new engine. In the app-driven path the host creates the target schema first (the app-driven contract); the standalone path instead rebuilds the app-class schema with `reconstructSchema` (`src/reconstruct.ts`, opt-in via `migrate({ reconstructSchema: true })` / CLI `--reconstruct-schema`).
2. `migrate` introspects the source's catalogs into `{ tables, foreignKeys, sequences }`.
3. The target is prepared for the chosen `onExisting` policy (`error` / `truncate` / `skip`) for re-run safety.
4. Tables are topologically sorted so parents precede children; any FK cycle is transferred as a subset with deferred constraints (`transferCycle`).
5. Each table's rows are transferred COPY-text-first with a per-table INSERT fallback (`transferTable`).
6. Sequences are realigned with `setval`.
7. Optional post-migration validation (`counts` or `full`) checks the target against the source; on failure the report is marked `validation.ok === false`.
8. A `MigrationReport` summarizes rows, sequences, deferred tables, validation, and warnings.

A `--dry-run` produces the same plan/report read-only without writing the target. Backup (`backupDataDir`) and the atomic-swap primitive (`swapIntoPlace`) are separate library primitives the CLI/host composes around `migrate`.

## Build

`tsup` emits two entry points to `dist/`: `index.js` (library, with `.d.ts`) and `cli.js` (bin; shebang preserved). ESM only, Node 20 target. `@electric-sql/pglite` stays external.

## What's intentionally absent

Full `pg_dump`-parity DDL reconstruction — views, materialized views, triggers, functions, RLS policies, partitioning — stays out of scope; standalone reconstruction draws the line at app-class objects and **reports** out-of-scope objects rather than recreating them (`docs/9-standalone-schema-reconstruction.md`). The on-startup `backup → migrate → validate → swap` flow is composed by the host/CLI rather than owned by `migrate`; remaining orchestration follow-ups (swap wiring, stale-staging cleanup, `--keep` retention, upsert re-run) are tracked as tickets — see the requirements summary.
