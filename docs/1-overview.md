# 1 — Overview

## Problem

[PGlite](https://github.com/electric-sql/pglite) is PostgreSQL compiled to WebAssembly. Its persisted data directory is a genuine PostgreSQL `PGDATA` cluster, stamped with the major version of the Postgres the WASM was built from. PostgreSQL's on-disk catalog format changes between **major** versions, so when PGlite ships a build based on a newer Postgres major (e.g. PG18 after PG17), an existing data directory can no longer be opened by the new engine.

Native PostgreSQL solves this with `pg_upgrade`, which rewrites a stopped cluster in place. But `pg_upgrade` requires the native server binaries of **both** the old and new major versions, and briefly boots each. An embedded WASM database ships neither, and cannot run two native server processes. So the native physical-upgrade path is unavailable.

## Approach

Take the **logical** route. Run two PGlite engines at once — an old-version engine opened on the source data, a new-version engine for the target — and move data between them at the SQL level. Because the data crosses the boundary as SQL/values, the on-disk format never has to be parsed or rewritten, and no native binaries are involved.

The library's defining design choice: the core speaks only to a minimal structural interface (`PGliteLike`), never importing `@electric-sql/pglite` directly. That is what lets a caller supply two different PGlite majors simultaneously.

## Goals

- **FR-1.1** Migrate user data from a PGlite data directory created by an older Postgres major into one served by a newer Postgres major.
- **FR-1.2** Work with no native binaries and no `pg_upgrade` — purely via two PGlite engines.
- **FR-1.3** Be reusable across multiple host projects (a published npm package: library + CLI).
- **FR-1.4** Detect whether a migration is even needed by reading the cluster major version without booting it.
- **NFR-1.5** Be version-agnostic in its catalog queries — rely only on stable catalog relations and `format_type`, so the same code works across majors.
- **NFR-1.6** Keep the dependency surface minimal; `@electric-sql/pglite` is a peer dependency, not a hard one.

## Non-goals (v1)

- **NG-1.1** Reconstructing arbitrary schemas (the no-host-app case). v1 is app-driven: the host app creates the target schema. See `3-schema-reconstruction.md`.
- **NG-1.2** Full `pg_dump` parity — views, functions, triggers, RLS policies, partitioning, comments, grants. Out of scope; the line is drawn at app-class schema objects.
- **NG-1.3** Migrating *native* (non-PGlite) clusters. For that, `pg_upgrade` with portable binaries (`embedded-postgres`) is the right tool, not this package.
- **NG-1.4** Same-major minor upgrades — PGlite's own `dumpDataDir`/`loadDataDir` already handles those (format-coupled, same-major only).

## Glossary

- **PGDATA / data directory** — the on-disk directory holding a PostgreSQL cluster's files, including `PG_VERSION`.
- **Major version** — the Postgres major (17, 18, …); the boundary across which the on-disk format may change.
- **App-driven migration** — the host application creates its own schema on the new cluster; this library transfers data only.
- **Standalone migration** — migrating a data directory with no host app present, requiring schema reconstruction (deferred).
- **`PGliteLike`** — the minimal structural query interface the core depends on, decoupling it from any specific PGlite version.
