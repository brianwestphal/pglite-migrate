# 12 — Dry-Run Mode

**Status: Implemented (PGLM-28).** This is the requirements spec for the `--dry-run` capability promised by `5-safety-and-rollback.md` (FR-5.3) and `4-cli.md` (NG-4.9). It is tracked as ticket **PGLM-6**. Dry-run is the cheapest, lowest-risk slice of the safety layer — it writes nothing, so it can land ahead of backup/atomic-swap/validation.

## Motivation / Problem

A migration mutates the operator's only copy of their data (the source is read; the target is written into, in place, since v1 assumes the target schema already exists). Before committing to that, an operator wants to **see the plan**: which tables will be transferred, in what order, how many rows each holds, which sequences will be realigned, and what warnings (e.g. foreign-key cycles) the run will raise — all **without touching the target**.

Today there is no way to preview a run. The only way to learn what `migrate` will do is to run it, which already mutates the target. A dry-run closes that gap: it produces a plan whose shape matches the real run's `MigrationReport`, so the preview an operator approves is consistent with the report the real run later returns.

This mirrors the `pg_dump --schema-only` / `terraform plan` ergonomic: a read-only preview that is structurally identical to what the apply step reports.

## Requirements

- **FR-12.1 Read-only preview** Dry-run introspects the **source** and reports what *would* be transferred without executing any `INSERT`, `setval`, or DDL against the **target**. The target data directory must be **byte-for-byte unchanged** after a dry-run.
- **FR-12.2 Report shape parity** The dry-run result reuses the real run's `MigrationReport` shape (`src/types.ts`) so the preview and the eventual real report are directly comparable. `tables` lists the tables in FK-safe insert order; `totalRows` is the sum of planned per-table row counts; `warnings` carries the same messages a real run would (notably the FK-cycle warning); `sequencesSet` reports how many sequences *would* be realigned.
- **FR-12.3 Per-table row counts** For each table, the plan reports the number of rows that would be copied (`TableResult.rowsCopied`), computed cheaply via `SELECT count(*)` rather than by selecting or copying rows (FR-12.7).
- **FR-12.4 FK-safe ordering** The planned table order is the same `topologicalSort` order a real run uses, so the operator sees the genuine insert sequence (parents before children).
- **FR-12.5 Sequence plan** The plan reports which sequences would be realigned and to what value — i.e. the sequences with a non-null `lastValue` that `applySequences` would touch — and `sequencesSet` counts them. Never-advanced sequences (null `lastValue`) are excluded, matching `applySequences`.
- **FR-12.6 Warnings without execution** Warnings that depend only on schema shape (FK cycles) are computed during planning, from the same `topologicalSort` result, with no row transfer.
- **NFR-12.7 Cheap counting** Row counts use `SELECT count(*) FROM <table>` per table (one query per table), not a full `SELECT *`. A dry-run must not materialize or transfer row data.
- **NFR-12.8 No new mutation surface** Dry-run introduces no code path that writes to the target. It must be impossible for a dry-run to call `transferTable` / `applySequences` against the target in a way that mutates it.
- **NG-12.9 Out of scope (v1 dry-run)** Validating that the **target schema** can accept the source rows (column/type compatibility, missing tables) is *not* part of dry-run v1 — that overlaps post-migration validation (`5-safety-and-rollback.md` FR-5.4) and standalone schema reconstruction (`3-schema-reconstruction.md`). Dry-run reports the source-side plan only. A future enhancement may cross-check the target schema; see Open Questions.
- **NG-12.10 Out of scope (v1 dry-run)** Estimating wall-clock duration or byte volume of the transfer is not in scope; row counts are the planning unit.

## Design / Approach

### Where the dry-run logic lives — recommended: a `planMigration` function plus a `dryRun` option on `migrate`

There are two natural homes; the recommendation is to implement **both, with one as the implementation of the other**:

1. **`planMigration(options): Promise<MigrationReport>`** (new export from `src/migrate.ts`) — the canonical read-only path. It does exactly the source-side work of `migrate` up to but excluding any target write: introspect the source, `topologicalSort`, compute per-table counts, compute the sequence plan and warnings, and assemble a `MigrationReport`. It receives the same `MigrateOptions` (it needs `source`; it accepts `target` for forward-compatibility with the deferred target cross-check, but in v1 must not write to it).
2. **`migrate(options)` gains a `dryRun?: boolean` flag** (added to `MigrateOptions` in `src/types.ts`). When `dryRun` is true, `migrate` delegates to `planMigration` and returns its report; when false/absent it runs the real transfer exactly as today.

Rationale for both:

- The **boolean flag** is the ergonomic the CLI and most callers want — one entry point, one report type, a single switch. It keeps the call site identical between preview and apply.
- The **named function** is the testable, composable core. It guarantees (NFR-12.8) that the preview path is *physically* incapable of writing to the target, because it never calls `transferTable`/`applySequences`. Tests assert on `planMigration` directly; `migrate(dryRun:true)` is then a thin delegation that needs only a smoke test.

This avoids the failure mode of a single `migrate` body littered with `if (!dryRun)` guards around every write, where a future edit can accidentally let a write slip through in dry-run.

### Report shape reuse

`planMigration` returns the **existing** `MigrationReport` (`src/types.ts`) unchanged — `{ tables, sequencesSet, totalRows, warnings }`. No new result type is introduced for v1. This is the property that makes preview and apply comparable (FR-12.2) and lets the CLI print both with the same formatter.

The only **additive** type changes are:

- `MigrateOptions.dryRun?: boolean` (default `false`).
- Optionally, to satisfy FR-12.5's "to what value", a richer sequence view. v1 recommendation: keep `MigrationReport` unchanged and surface per-sequence target values only in the **CLI text output** (computed from the introspected `SequenceInfo[]`), not in the typed report, to avoid a breaking shape change. If structured sequence detail is wanted in the report later, add an optional `sequences?: SequencePlan[]` field rather than altering existing fields. See Open Questions.

### Cheap per-table counting

A new pure-ish helper alongside the transfer code — recommended `countTable(source, table): Promise<TableResult>` in `src/transfer.ts`, next to `transferTable` so the counting and copying logic stay co-located. It runs a single:

```sql
SELECT count(*) AS n FROM <quoted schema.table>
```

using the same `quoteQualified` helper `transferTable` uses, reads `n`, and returns `{ table: tableKey(table), rowsCopied: Number(n) }`. `count(*)` returns `bigint` (rendered as a string by PGlite); coerce defensively at the trust boundary (read the field, parse it) rather than blind-casting. `planMigration` calls `countTable` once per table in topo order and sums into `totalRows`, mirroring how `migrate` sums `transferTable` results — so the two totals line up by construction (FR-12.2).

> Note: `count(*)` reflects live visible rows at plan time and could drift if the source is written between plan and apply. In the intended usage (offline upgrade of a quiescent data directory) the source is not being written, so plan and apply agree. This assumption is called out in Open Questions.

### Warnings and FK cycles without transfer

`planMigration` runs the identical `topologicalSort(schema.tables, schema.foreignKeys)` call `migrate` runs and reuses its `{ ordered, cycles }` result. The FK-cycle warning string is produced from `cycles` with the **same wording** `migrate` uses today, so a previewed warning is exactly the warning the real run will emit (FR-12.6). To avoid drift, factor the warning-assembly into a shared helper used by both `migrate` and `planMigration` rather than duplicating the message text.

### Sequence plan without writing

`planMigration` calls `introspectSequences` (via `introspectSchema`) and filters to sequences with a non-null `lastValue` — the exact set `applySequences` would act on (it `continue`s past null). `sequencesSet` is the size of that filtered set. No `setval` is issued. (See `applySequences` in `src/transfer.ts` for the null-skipping contract being mirrored.)

## Interaction with existing code

- **`src/migrate.ts`** — `migrate` gains the `dryRun` branch and a new sibling export `planMigration`. The non-dry path is unchanged. The FK-cycle warning text currently inlined in `migrate` should be extracted into a shared helper consumed by both.
- **`src/introspect.ts`** — reused as-is. `planMigration` calls `introspectSchema(source)` exactly like `migrate`. No catalog changes.
- **`src/transfer.ts`** — `topologicalSort` reused unchanged (pure, already unit-tested). New `countTable` helper added next to `transferTable`. `transferTable` and `applySequences` are **not** called by the dry-run path (NFR-12.8).
- **`src/types.ts`** — add `MigrateOptions.dryRun?: boolean`. `MigrationReport` reused unchanged.
- **`src/index.ts`** — export `planMigration` (and `countTable` if it is to be public; recommend keeping `countTable` internal unless a consumer needs it).
- **`src/cli.ts`** — add the `--dry-run` flag (below). No change to `openDataDir`/`loader.ts` — both engines still open; the target simply is not written to.

## CLI surface

- **FR-12.11** `pglite-migrate <source> <target> --dry-run` introspects the source, prints the plan, exits **0**, and writes nothing to the target.
- **FR-12.12** `parseArgs` gains a `dryRun: boolean` field (default `false`), set by a `--dry-run` flag (a boolean switch consuming no value, parsed like `-h`/`--help` in `src/cli.ts`).
- **FR-12.13** In dry-run, `run` calls `migrate({ source, target, dryRun: true, onProgress })` (or `planMigration` directly) and prints the plan. The version banner (FR-4.4) still prints. The target engine is still opened (so the operator learns it is openable) but never written to.
- **FR-12.14** Output is human-readable text on stderr/stdout consistent with the existing CLI style: a header noting this is a dry-run / preview, one line per table with its planned row count in FK-safe order, the count of sequences that would be realigned, and any warnings. The closing summary mirrors the real run's `Done: N rows across M tables, K sequences aligned` line but phrased as a plan (e.g. `Plan: N rows across M tables, K sequences would be aligned (dry-run, nothing written).`).
- **FR-12.15** Help text (`USAGE` in `src/cli.ts`) documents `--dry-run`.
- **NG-12.16** A machine-readable `--json` output is **not** required for v1 dry-run but is the obvious follow-up; see Open Questions and Follow-up tickets. If added, it should serialize the `MigrationReport` directly (FR-12.2 already guarantees a stable shape).

## Acceptance

- `pglite-migrate <source> <target> --dry-run` prints a plan listing every user table in FK-safe order with a per-table row count, the number of sequences that would be realigned, and any FK-cycle warning, then exits 0.
- **The target data directory is byte-for-byte identical before and after the dry-run** (no file mtime/content change attributable to the run).
- For a given source/target pair, the dry-run plan's `tables` (names + order), `totalRows`, `sequencesSet`, and `warnings` **equal** the corresponding fields of the `MigrationReport` returned by a subsequent **real** `migrate` of the same pair (assuming the source is unchanged between the two).
- `pglite-migrate --help` lists `--dry-run`.

## Testing requirements

Follow the double-coverage rule in `6-testing.md` (unit for extractable logic; e2e against real PGlite for anything touching a cluster).

**Unit (`tests/`, `vitest.config.ts`):**

- `countTable` against an in-memory `new PGlite()` returns the correct count for a seeded table and `0` for an empty one, and copies no data (it issues only `count(*)`).
- `parseArgs` sets `dryRun: true` for `--dry-run` and `false` when absent (pure, alongside existing `cli`/arg tests).
- The shared FK-cycle warning helper produces the identical string for `migrate` and `planMigration` (guards against message drift).

**E2E (`tests/e2e/`, `vitest.e2e.config.ts`) — the two-version round-trip:**

- **No rows written:** open source (seeded) and a target whose schema exists but is empty; run `planMigration` (or `migrate(dryRun:true)`); assert `SELECT count(*)` on every target table is still `0` and every target sequence is at its fresh value (no `setval` took effect).
- **Plan matches the real run:** capture the dry-run `MigrationReport`; then run a real `migrate` on the same source/target; assert the dry-run report's `tables` (names + order), `totalRows`, `sequencesSet`, and `warnings` equal the real report's. (Run the real migration into a *fresh* empty-schema target so the dry-run did not pre-populate it.)
- **Target unchanged:** assert the target is byte-for-byte / row-count unchanged after the dry-run (a row-count check per table is sufficient at the SQL level; a stronger directory-hash check may be added once the loader exposes paths).
- Reuse the shared `SCHEMA_SQL` / `SEED_SQL` fixtures in `tests/helpers.ts`, including the parent+child FK and serial sequence already exercised by `roundtrip.test.ts`.

Add these to the "Gaps to add as the library grows" list in `6-testing.md` when implemented.

## Open Questions (with recommended defaults)

1. **Boolean flag vs separate public function.** *Recommendation:* ship **both** — `planMigration` as the canonical read-only core (tested directly, structurally write-free) and `migrate({ dryRun: true })` as a thin delegation for ergonomic parity. This is the spec above. Confirm we want `planMigration` in the public API barrel (`src/index.ts`) vs keeping it internal and exposing only the flag.
2. **Output format: text vs JSON.** *Recommendation:* **text by default** for v1 (matches the current CLI), with `--json` as a fast follow that serializes the `MigrationReport` verbatim. Decide whether `--json` is in-scope for the initial ticket or split out.
3. **Sequence detail in the typed report.** FR-12.5 wants "to what value." *Recommendation:* keep `MigrationReport` unchanged for v1 (avoid a breaking shape change) and show per-sequence target values only in CLI text; add an optional `sequences?: SequencePlan[]` field later if a consumer needs structured detail. Confirm acceptable.
4. **Source mutation between plan and apply.** `count(*)` is a point-in-time read; if the source is written between dry-run and real run, totals can diverge. *Recommendation:* document that dry-run assumes a **quiescent source** (the intended offline-upgrade scenario) and treat divergence as out of scope for v1. Confirm no concurrent-source guarantee is expected.
5. **Target schema cross-check (NG-12.9).** Should dry-run optionally verify the target schema can accept the plan (missing tables / incompatible columns)? *Recommendation:* **defer** — it belongs with post-migration validation (`5-safety-and-rollback.md` FR-5.4) and schema reconstruction (`3-schema-reconstruction.md`). File as its own ticket.

## Follow-up tickets

- **`--json` dry-run output** — serialize the `MigrationReport` for tooling/CI consumption (NG-12.16, Open Question 2).
- **Dry-run target schema cross-check** — verify the target can accept the plan (missing tables, column/type mismatch); coordinate with FR-5.4 and `3-schema-reconstruction.md` (NG-12.9, Open Question 5).
- **Structured sequence plan in the report** — optional `sequences?: SequencePlan[]` field if a consumer needs target values programmatically (Open Question 3).
- **Plan/apply consistency guard for a live source** — only if a concurrent-source scenario is ever in scope (Open Question 4).

## Cross-references

- `5-safety-and-rollback.md` — FR-5.3 (dry-run) within the broader safety layer (backup, atomic swap, validation, FK-cycle correctness).
- `4-cli.md` — NG-4.9 (no dry-run flag yet); this doc specifies the flag.
- `2-data-migration.md` — the real-run pipeline (`migrate`, `introspectSchema`, `topologicalSort`, `transferTable`, `applySequences`) that dry-run previews; FR-2.11 (FK-cycle warning) is the warning reused here.
- `6-testing.md` — double-coverage philosophy and the two-version e2e harness used for the tests above.
