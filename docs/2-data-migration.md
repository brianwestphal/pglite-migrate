# 2 — Data Migration (app-driven, data-only)

The v1 core. The host application has already created its schema on the target engine (via its normal startup migrations); this library introspects the source and transfers data into the target.

## Entry point

- **FR-2.1** `migrate(options: MigrateOptions): Promise<MigrationReport>` (`src/migrate.ts`) is the primary API. It takes an already-open `source` and `target` (`PGliteLike`), introspects the source, transfers data in FK-safe order, realigns sequences, and returns a report.
- **FR-2.2** `migrate` performs **no DDL** on the target by default, and never touches on-disk files directly. Both clusters are passed in already open, which is what permits two different PGlite majors. Two sanctioned exceptions exist, both narrow and explicit: the opt-in standalone rebuild (`reconstructSchema: true`, [`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md)) and the transient FK-deferrability flip inside `transferCycle`, which is reverted before returning ([`8-fk-cycle-deferred-constraints.md`](8-fk-cycle-deferred-constraints.md) NFR-8.9).
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
- **FR-2.11** Tables in a foreign-key **cycle** cannot be linearized; `topologicalSort` appends them in original order and names them in `TopoResult.cycles`. **Resolved** — `migrate` transfers that subset through `transferCycle`, inside one target transaction with the cyclic FKs deferred to commit (flipping any `NOT DEFERRABLE` constraint transiently and restoring it afterward), and reports them in `MigrationReport.deferredTables`. The old "may violate constraints" warning is gone. Full spec: [`8-fk-cycle-deferred-constraints.md`](8-fk-cycle-deferred-constraints.md).
- **FR-2.12** `transferTable(source, target, table, onProgress?)` copies all rows of a table from source to target.
- **FR-2.13** `applySequences(target, sequences)` calls `setval(seq, lastValue, true)` for each sequence with a non-null `lastValue`, so `nextval` continues past migrated rows. Never-advanced sequences are left fresh.

## Data fidelity

- **FR-2.14** Rows transfer over a `COPY … TO/FROM '/dev/blob'` **TEXT** path: the source engine emits its own text representation and the target re-parses those exact bytes, so no value round-trips through a JavaScript representation. The row-by-row parameterized `INSERT` remains as a **per-table fallback** when COPY is unavailable for a table; the fallback is recorded on `TableResult.method`/`fallbackReason` and surfaced as a warning.
- **NFR-2.15** **Resolved.** Empirical comparison across the two engines showed the `INSERT` path already preserved `jsonb`, `numeric`, `bytea`, and array types exactly; the one confirmed loss was plain `json` source text (whitespace and key order), which COPY-text fixes. COPY-text is also the general insurance for text-significant types not yet exercised. Full spec and spike findings: [`7-copy-text-transfer.md`](7-copy-text-transfer.md).
- Stored generated columns (`GENERATED ALWAYS AS (…) STORED`) are excluded from both paths — the target recomputes them, and supplying a value errors.

## Report

- **FR-2.16** `MigrationReport` contains `tables: TableResult[]`, `sequencesSet`, `totalRows`, `warnings: string[]`, `deferredTables: string[]` (FK-cycle subset, FR-2.11), and `skippedTables: string[]` (`onExisting: 'skip'`, [`14-idempotence.md`](14-idempotence.md)), plus optional `validation` ([`13-post-migration-validation.md`](13-post-migration-validation.md)) and `reconstruction` ([`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md)) sections. `src/types.ts` is the SSOT for the shape.

## Acceptance

- A source seeded with related tables (parent + child via FK), a serial sequence, and a `timestamptz` migrates into a fresh-schema target such that: all rows are present, no FK violation occurs, the timestamp value is preserved, and a subsequent insert receives an id past the migrated maximum. (Covered by `tests/e2e/roundtrip.test.ts`.)
