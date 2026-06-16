# 2 — Data Migration (app-driven, data-only)

The v1 core. The host application has already created its schema on the target engine (via its normal startup migrations); this library introspects the source and transfers data into the target.

## Entry point

- **FR-2.1** `migrate(options: MigrateOptions): Promise<MigrationReport>` (`src/migrate.ts`) is the primary API. It takes an already-open `source` and `target` (`PGliteLike`), introspects the source, transfers data in FK-safe order, realigns sequences, and returns a report.
- **FR-2.2** `migrate` performs **no DDL** on the target and never touches on-disk files directly. Both clusters are passed in already open, which is what permits two different PGlite majors.
- **FR-2.3** An optional `onProgress` callback is invoked once per table with `{ table, rowsCopied }`.

## Introspection

- **FR-2.4** `introspectSchema(db)` (`src/introspect.ts`) returns `{ tables, foreignKeys, sequences }` from the source's system catalogs.
- **FR-2.5** Tables are user tables (`relkind='r'`) outside system schemas (`pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*`).
- **FR-2.6** Columns are returned in physical order (`pg_attribute.attnum`, dropped columns excluded) with their rendered type via `format_type`.
- **FR-2.7** Foreign keys are collected from `pg_constraint` (`contype='f'`), excluding self-references, as `{ child, parent }` qualified-name edges.
- **FR-2.8** Sequences and their current values are read from `pg_sequences` (`schemaname`, `sequencename`, `last_value`).
- **NFR-2.9** All catalog queries use only stable relations + `format_type`, keeping them portable across majors.

## Transfer

- **FR-2.10** `topologicalSort(tables, foreignKeys)` (`src/transfer.ts`) orders tables so every parent precedes its children. It is pure and unit-tested directly.
- **FR-2.11** Tables in a foreign-key **cycle** cannot be linearized; they are appended in original order and reported in `MigrationReport.warnings`. Proper handling (deferred constraints) is deferred — see `5-safety-and-rollback.md`.
- **FR-2.12** `transferTable(source, target, table, onProgress?)` copies all rows of a table from source to target.
- **FR-2.13** `applySequences(target, sequences)` calls `setval(seq, lastValue, true)` for each sequence with a non-null `lastValue`, so `nextval` continues past migrated rows. Never-advanced sequences are left fresh.

## Data fidelity — current limitation and target

- **FR-2.14 (current)** v1 transfers rows via row-by-row parameterized `INSERT`: `SELECT` the rows from source, then `INSERT` each into target. This is correct for common app schemas (integers, text, booleans, timestamps).
- **NFR-2.15 (target, deferred)** Round-tripping values through JavaScript can lose fidelity on `json`/`jsonb` (whitespace/key order), `numeric` (precision), `bytea`, and array types. The target is a `COPY … TO/FROM` **text** path that keeps each value in Postgres's own text representation end to end. File as a follow-up ticket; until then, document the limitation in release notes.

## Report

- **FR-2.16** `MigrationReport` contains `tables: TableResult[]`, `sequencesSet`, `totalRows`, and `warnings: string[]`.

## Acceptance

- A source seeded with related tables (parent + child via FK), a serial sequence, and a `timestamptz` migrates into a fresh-schema target such that: all rows are present, no FK violation occurs, the timestamp value is preserved, and a subsequent insert receives an id past the migrated maximum. (Covered by `tests/e2e/roundtrip.test.ts`.)
