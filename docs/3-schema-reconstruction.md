# 3 — Schema Reconstruction (standalone mode)

**Status: Implemented (PGLM-25), opt-in.** `reconstructSchema(source, target, { onUnsupported })` (`src/reconstruct.ts`) rebuilds the app-class schema; `migrate({ reconstructSchema: true })` and the CLI's `--reconstruct-schema` turn it on. This page stays the short overview — the implementation-ready spec is [`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md).

**Known gaps in the shipped implementation** (each has a follow-up ticket): non-`public` schemas are not created on the target, so a multi-schema source fails; `CREATE SEQUENCE` is emitted without the source's start/increment/min/max/cycle parameters and without re-establishing `OWNED BY`; and domain/composite types are neither reconstructed nor reported as unsupported. See doc 9 for detail.

The app-driven path (`2-data-migration.md`) assumes the target schema already exists because the host application created it. The **standalone** case — migrating a PGlite data directory with no host app present (e.g. the CLI pointed at two bare directories) — has no app to create the schema, so the migrator must reconstruct it on the target from the source.

## Why this is separated out

Reconstructing DDL is the single largest source of complexity in logical migration — it is what makes `pg_dump` a ~15k-line C program. Keeping it off the *default* path is deliberate: the app-driven path covers the common embedded-app case without it, and reconstruction is the only thing in the library that issues DDL against the target.

## Approach

- **FR-3.1** Reconstruct schema using PostgreSQL's own DDL-emitting functions, which run **inside** PGlite (no `pg_dump` binary, which PGlite doesn't ship):
  - `pg_get_constraintdef(oid)` — PK / FK / UNIQUE / CHECK
  - `pg_get_indexdef(oid)` — indexes
  - `pg_get_expr(adbin, adrelid)` — column defaults (incl. `nextval`)
  - `format_type(...)` — column types
- **FR-3.2** ~~Optionally lean on existing pure-JS libraries~~ — **Resolved (spike PGLM-24): hand-rolled.** `pg-schema-dump` is built around a `node-postgres` client and emits a broader dump than the scope line allows; `pg-introspection` only *reads* the catalog and would not remove the `CREATE` generation that is the actual work. Both were rejected in favor of direct catalog SQL + `pg_get_*def`, which adds zero runtime dependencies (NFR-1.6). See doc 9 for the full rationale.
- **FR-3.3** Create objects on the target in dependency order: types/enums → sequences → tables → defaults → constraints → indexes.

## Scope boundary (hard line)

- **NFR-3.4 (in scope)** App-class schema objects: tables, columns, custom types/enums, sequences, primary/unique/check/foreign-key constraints, indexes.
- **NG-3.5 (out of scope)** Full `pg_dump` parity: views, functions, triggers, RLS policies, partitioning, operator classes, comments, grants. These form a long tail that turns a focused tool into a `pg_dump` reimplementation. If a source uses them, the standalone migrator **detects and reports** them as unsupported rather than silently dropping them — `ReconstructionReport.unsupported`, folded into `MigrationReport.warnings`, and escalated to a pre-DDL throw under `onUnsupported: 'error'`. *Detection is currently partial*: views, materialized views, partitioned tables, functions, triggers, and RLS policies are reported; operator classes, non-default collations, comments, grants, extensions, foreign tables, rules, and domain/composite types are not.

## Resolved questions

- ~~Does `pg-schema-dump` run cleanly against a PGlite connection?~~ **No** — it assumes a node-postgres client. Hand-rolled instead (FR-3.2, spike PGLM-24).
- ~~Should standalone mode reuse the app-driven data transfer verbatim once the schema exists?~~ **Yes.** `reconstructSchema` runs first and the run becomes app-driven from there: the existing introspect → sort → transfer → sequences pipeline is unchanged (NG-9.11).
