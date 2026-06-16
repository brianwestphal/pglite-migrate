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

## Data flow (app-driven, v1)

1. Host app (or CLI) opens the **source** with the old engine and the **target** with the new engine, and creates the target schema (the app-driven contract).
2. `migrate` introspects the source's catalogs into `{ tables, foreignKeys, sequences }`.
3. Tables are topologically sorted so parents precede children.
4. Each table's rows are read from source and inserted into target.
5. Sequences are realigned with `setval`.
6. A `MigrationReport` summarizes rows, sequences, and warnings.

## Build

`tsup` emits two entry points to `dist/`: `index.js` (library, with `.d.ts`) and `cli.js` (bin; shebang preserved). ESM only, Node 20 target. `@electric-sql/pglite` stays external.

## What's intentionally absent in v1

- DDL reconstruction (deferred — `docs/3-schema-reconstruction.md`).
- Safety/rollback: backup, atomic swap, dry-run, validation (deferred — `docs/5-safety-and-rollback.md`).
- COPY-text high-fidelity transfer (deferred — `docs/2-data-migration.md`).
