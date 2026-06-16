# 3 — Schema Reconstruction (standalone mode) — DEFERRED

**Status: design only. Not implemented in v1.**

The app-driven path (`2-data-migration.md`) assumes the target schema already exists because the host application created it. The **standalone** case — migrating a PGlite data directory with no host app present (e.g. the CLI pointed at two bare directories) — has no app to create the schema, so the migrator must reconstruct it on the target from the source.

## Why this is separated out

Reconstructing DDL is the single largest source of complexity in logical migration — it is what makes `pg_dump` a ~15k-line C program. Keeping it out of v1 is deliberate: the app-driven path covers the common embedded-app case without it.

## Intended approach

- **FR-3.1** Reconstruct schema using PostgreSQL's own DDL-emitting functions, which run **inside** PGlite (no `pg_dump` binary, which PGlite doesn't ship):
  - `pg_get_constraintdef(oid)` — PK / FK / UNIQUE / CHECK
  - `pg_get_indexdef(oid)` — indexes
  - `pg_get_expr(adbin, adrelid)` — column defaults (incl. `nextval`)
  - `format_type(...)` — column types
- **FR-3.2** Optionally lean on existing pure-JS libraries — [`pg-introspection`](https://www.npmjs.com/package/pg-introspection) (typed catalog introspection) and/or [`pg-schema-dump`](https://github.com/seveibar/pg-schema-dump) (emits `CREATE` SQL) — rather than hand-rolling catalog walks. Evaluate both against a live PGlite connection before adopting.
- **FR-3.3** Create objects on the target in dependency order: types/enums → sequences → tables → defaults → constraints → indexes.

## Scope boundary (hard line)

- **NFR-3.4 (in scope)** App-class schema objects: tables, columns, custom types/enums, sequences, primary/unique/check/foreign-key constraints, indexes.
- **NG-3.5 (out of scope)** Full `pg_dump` parity: views, functions, triggers, RLS policies, partitioning, operator classes, comments, grants. These form a long tail that turns a focused tool into a `pg_dump` reimplementation. If a source uses them, the standalone migrator should **detect and report** them as unsupported rather than silently dropping them.

## Open questions

- Does `pg-schema-dump` run cleanly against a PGlite connection, or does it assume a node-postgres client? (Spike before depending on it.)
- Should standalone mode reuse the app-driven data transfer verbatim once the schema exists? (Expected: yes — it becomes app-driven once the schema is built.)
