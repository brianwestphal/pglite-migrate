# 14 — Idempotence & Resumability

**Status: design only. Not implemented in v1.** This is the detailed spec for the idempotence / re-run-safety requirement (PGLM-8 / FR-5.6) under the safety umbrella in [`5-safety-and-rollback.md`](./5-safety-and-rollback.md). Today a second `migrate` run against a non-empty target double-inserts and almost certainly violates a primary key, so this behavior must be decided and documented before the tool is recommended for production data — file as tickets.

## Motivation / Problem

A migration can be interrupted. A process can crash mid-transfer, a host app can be killed during its startup upgrade, or an operator can simply run the command twice. When that happens, the target is left **partially populated** — some tables fully copied, one table half copied, the rest empty — and the next run has to do something sensible.

The current code does not. `transferTable` (`src/transfer.ts`) issues a plain row-by-row `INSERT` for every source row, with no check on what is already in the target:

```ts
const insertSql = `INSERT INTO ${qualified} (${colList}) VALUES (${placeholders})`;
for (const row of rows) {
  const values = table.columns.map((c) => row[c.name] ?? null);
  await target.query(insertSql, values);
}
```

`migrate` (`src/migrate.ts`) calls this for every table unconditionally — there is **no empty-target check anywhere**. So a second run:

- **Double-inserts** every already-copied row, and
- almost certainly **violates the primary key** (or a unique constraint) on the first such row, aborting the run with a raw Postgres error,
- or, for the rare table with no PK/unique constraint, **silently duplicates rows** — the worse outcome, because it corrupts data without failing.

Either way the result is wrong and the error message is opaque. The user-facing requirement is simple: **re-running `migrate` must be safe.** Running it twice must either reach the same correct end state (no duplicate rows) or stop with a clear, actionable error — never a half-applied mess or a cryptic constraint violation.

This is the natural complement to the rest of the safety layer. Backup ([`10-backup.md`](./10-backup.md)) and atomic swap (`docs/11`, when it lands) make a **fresh target** the normal operating mode; idempotence governs what happens when the target is *not* fresh — whether because swap is not in use, because a previous run was interrupted before the swap, or because the host app drives `migrate` directly against a live target it created on startup.

## Requirements

- **FR-14.1 Re-run safety** Running `migrate` a second time against a target that a previous run already (partially or fully) populated MUST NOT silently produce duplicate rows. The outcome MUST be one of: (a) a clear, actionable error that stops before mutating the target, or (b) a correct, idempotent transfer that converges on the same end state as a single clean run. The chosen behavior MUST be documented.
- **FR-14.2 Documented, single default** The library ships **one** well-documented default behavior (see [Design / Approach](#design--approach)), not silent best-effort. The default is discoverable from the report and/or the thrown error, never a surprise.
- **FR-14.3 Non-empty-target detection** Before transferring, `migrate` MUST be able to determine, per table, whether the target already contains rows (a per-table row count / existence probe — see [Detection mechanism](#detection-mechanism)). This detection is the precondition for every strategy below.
- **FR-14.4 Empty-target guard (default behavior).** By default, `migrate` checks each target table and **refuses to run** if any table it is about to populate already contains rows, raising a clear error that names the offending table(s) and points at the opt-in idempotent modes. This makes the dangerous case (double-insert / PK violation) impossible by default.
- **FR-14.5 Opt-in idempotent transfer.** A caller MAY opt into an idempotent strategy via `MigrateOptions` (e.g. `onExisting: 'error' | 'truncate' | 'skip'`, default `'error'`). The selected strategy is reported in the `MigrationReport` so the run is self-describing.
- **FR-14.6 `truncate` strategy.** When selected, each target table is emptied (`TRUNCATE`) immediately before its rows are transferred, in FK-safe order, so the run converges on a clean copy of the source regardless of prior contents.
- **FR-14.7 `skip` strategy.** When selected, a target table that already contains rows is left untouched and recorded as skipped in the report (`rowsCopied: 0`, marked skipped); only empty tables are populated. This supports coarse table-level resumability.
- **FR-14.8 Strategy is uniform and FK-aware.** Whichever strategy is chosen, it is applied consistently across all tables and respects foreign-key ordering (truncation and (re)insertion order must not transiently violate FK constraints — see [Interaction with FK order](#interaction-with-fk-order-and-sequences)).
- **FR-14.9 Sequence realignment is idempotent.** Sequence realignment (`applySequences`) MUST remain correct under re-run: it is already a `setval` to an absolute value (not an increment) and is therefore naturally idempotent, but the requirement is explicit so future changes preserve it. After any successful re-run, each sequence reflects the source's `last_value`.
- **FR-14.10 Report reflects what happened.** The `MigrationReport` distinguishes, per table, transferred vs. truncated-then-transferred vs. skipped, and surfaces the active strategy, so the caller can tell what a re-run actually did.
- **NFR-14.11 Detection is cheap and version-agnostic.** The non-empty probe uses only stable catalog/SQL surface (a bounded existence check, not a full count of huge tables where avoidable) so it stays portable across PGlite majors, consistent with [`2-data-migration.md`](./2-data-migration.md) NFR-2.9.
- **NFR-14.12 No partial idempotence claims.** v1 does **not** promise mid-table resumability (resuming a half-copied table from the exact row it stopped at). Resumability is **table-granular** at most (`skip`). Row-level checkpoint/resume is out of scope for v1.
- **NG-14.13 Not a sync/merge tool.** This is not a general upsert/replication/CDC mechanism. `truncate` is a wholesale replace and `skip` is coarse table-level; merging divergent target edits with source rows (true upsert with conflict resolution) is **not** a v1 goal. See [Open Questions](#open-questions).
- **NG-14.14 No cross-run locking.** v1 does not implement a lock/lease to prevent two concurrent `migrate` processes against the same target. Single-writer is assumed (consistent with NFR-10.11's "no engine running during backup" posture). Concurrency safety is a follow-up.

## Design / Approach

Three candidate behaviors were considered. They are not mutually exclusive — the recommendation is to make one the default and offer the others as explicit opt-ins.

### Option A — Require an empty target (refuse if non-empty)

Detect per-table row presence up front; if any target table already has rows, throw a clear error and transfer nothing.

- **Pros:** Safest and most predictable. Never destroys data the caller did not ask to destroy. Turns today's silent-double-insert / opaque-PK-violation failure into an explicit, named error *before* any mutation. Trivial to reason about and to test. Composes perfectly with atomic swap, where the target is a fresh directory and is therefore empty by construction.
- **Cons:** Not itself "resumable" — an interrupted run leaves a partially populated target that a bare re-run will refuse. Recovery requires either dropping/recreating the target schema (host app's job) or opting into a destructive/skip strategy. Pushes the resumability burden onto the caller.

### Option B — Truncate-first (idempotent replace)

Before copying each table, `TRUNCATE` it, then insert the source rows. The end state equals a clean single run regardless of prior contents.

- **Pros:** Genuinely idempotent — re-running always converges on a faithful copy of the source. Simple mental model ("the target becomes the source"). Naturally handles a partially populated target from an interrupted run.
- **Cons:** **Destructive.** If the host app put rows into the target that are *not* in the source (e.g. seed/reference data created by its startup migrations), truncate erases them. FK ordering matters: must truncate children before parents (or use `TRUNCATE … CASCADE`, which is broader and riskier). Must be explicit/opt-in precisely because it deletes target data.

### Option C — Upsert / skip-existing (`INSERT … ON CONFLICT` or skip)

Either `INSERT … ON CONFLICT DO NOTHING/UPDATE` per row, or skip whole tables that already have rows.

- **`ON CONFLICT DO NOTHING`:** requires every table to have a unique/PK target for the conflict to resolve; tables without one would still duplicate. Row-level, so it tolerates a half-copied table — but only correctly if the conflict target covers the real identity of each row.
- **`ON CONFLICT DO UPDATE` (upsert):** edges toward a sync/merge tool (NG-14.13); needs a per-table conflict key and an update column list, which is real complexity and a fidelity hazard (overwriting target-only edits).
- **`skip` (table-level):** if a target table already has rows, leave it alone; only fill empty tables. Coarse, simple, no conflict-key dependency, gives table-granular resumability — but cannot fix a table that stopped *mid-copy* (it is non-empty, so it is skipped while incomplete).

- **Pros:** Most flexible; `ON CONFLICT DO NOTHING` and `skip` are non-destructive.
- **Cons:** `ON CONFLICT` depends on every table having a usable conflict target, which the current introspection does not collect (`SchemaInfo` has FKs and sequences but no PK/unique metadata — see `src/types.ts`); building that is extra scope. Upsert verges on out-of-scope merge semantics. `skip` cannot repair a mid-copy interruption.

### Recommended default + rationale

**Default: Option A (require an empty target, refuse with a clear error).** Offer **Option B (`truncate`)** and the table-level **`skip`** variant of Option C as explicit, opt-in strategies via `MigrateOptions`. **Do not** ship row-level `ON CONFLICT`/upsert in v1.

Rationale:

1. **Safety-first and aligned with the rest of the layer.** The library's whole posture is "never destroy the user's only copy without asking." Defaulting to refuse-if-non-empty makes the destructive paths opt-in, mirroring backup being on-by-default but truncate being something you must request.
2. **It fixes the actual bug.** The concrete current failure is silent double-insert / opaque PK violation. The empty-target guard replaces that with a named, actionable error *before* any mutation — a strict improvement even before anyone opts into idempotent modes.
3. **Atomic swap makes "empty target" the normal case.** With swap (`docs/11`), `migrate` writes into a **fresh** directory, which is empty by construction, so the default guard never even trips on the happy path. Idempotence then only matters for the no-swap / interrupted-before-swap cases, which is exactly where an explicit choice belongs.
4. **`truncate` is the cleanest true-idempotent option, so it's the recommended opt-in.** When a caller genuinely wants "re-run until it works," `truncate` converges deterministically and needs no PK/unique metadata. It is destructive, so it stays opt-in.
5. **`ON CONFLICT`/upsert is deferred because it needs metadata we don't yet collect** (PK/unique constraints) and edges into merge semantics (NG-14.13). File it as a follow-up rather than half-building it.

### Detection mechanism

Non-empty detection (FR-14.3) reuses the introspection posture from [`2-data-migration.md`](./2-data-migration.md):

- For each target table to be populated, run a **bounded existence probe** rather than a full count where possible: `SELECT 1 FROM <qualified> LIMIT 1` answers "is this table non-empty?" in O(1)-ish time even for large tables. A full `COUNT(*)` is only needed when the report wants exact pre-existing counts.
- The probe runs against the **target** (the side being mutated), using the same `quoteQualified` helper from `src/ident.ts` already used by `transferTable`.
- For the default guard (FR-14.4), iterate the topologically-ordered tables, probe each, and collect every non-empty one; if the set is non-empty, throw a single error listing them all (don't fail on the first — a complete list is more actionable).
- The probe set is exactly the tables `migrate` is about to write (the introspected source tables that also exist on the target), so it never trips on unrelated target tables.

### Interaction with FK order and sequences

- **FK order (truncate).** Plain per-table `TRUNCATE` of a parent fails if a child still references it. Truncate must therefore run in **reverse topological order** (children before parents), the inverse of the insert order `topologicalSort` already produces (`src/transfer.ts`). The existing `ordered` list can be reversed for the truncate pass, then the normal forward order used for inserts. `TRUNCATE … CASCADE` would avoid the ordering concern but is broader (it would truncate referencing tables outside the migration set), so reverse-ordered plain `TRUNCATE` is preferred. FK **cycles** (already reported as warnings, FR-2.11) interact here too: a cyclic subset cannot be linearized for safe truncation either; `truncate` on a cyclic schema should either `TRUNCATE` the cyclic group together in one statement (Postgres allows multiple tables in one `TRUNCATE`, which defers the FK check) or surface a warning — see [Open Questions](#open-questions).
- **FK order (skip / guard).** The default guard and `skip` add no new ordering concern — they only read or no-op; inserts still go in forward topological order.
- **Sequences.** `applySequences` (`src/transfer.ts`) is already idempotent: it `setval`s each sequence to the source's absolute `last_value` (not a relative bump), so re-running lands on the same value (FR-14.9). Under `truncate`, sequences are realigned after the fresh inserts exactly as in a clean run. Under `skip`, a skipped table's sequence is still realigned to the source value, which is harmless (it only ever moves the sequence forward to match the source). No change to `applySequences` is required; the requirement just pins the property.

## Interaction with existing code

- **`src/migrate.ts`** — the orchestrator gains the pre-transfer detection pass and strategy dispatch. Today it unconditionally loops `transferTable` over `ordered`; it will first probe target tables (FR-14.3), then either throw the empty-target error (FR-14.4, default), truncate-then-transfer (FR-14.6), or skip-non-empty (FR-14.7), recording the outcome per table in the report (FR-14.10).
- **`src/transfer.ts`** — `transferTable` is the row-copy primitive and stays focused on copying; truncation and skip logic live in the orchestrator (or a small helper) so `transferTable` is not overloaded. A new `truncateTable(target, table)` helper (reverse-ordered caller) fits the one-primary-export-per-file style. `topologicalSort`'s `ordered` output is reversed for the truncate pass. `applySequences` is unchanged (already idempotent, FR-14.9).
- **`src/types.ts`** — `MigrateOptions` gains an opt-in field, e.g. `onExisting?: 'error' | 'truncate' | 'skip'` (default `'error'`). `TableResult` / `MigrationReport` gain fields to express truncated / skipped / strategy (FR-14.5, FR-14.10) — this is the SSOT for those shapes, so the change lands here.
- **`src/ident.ts`** — reused as-is (`quoteQualified`) for the probe and truncate SQL; no change.
- **`src/cli.ts`** — exposes the strategy as a flag (e.g. `--on-existing error|truncate|skip`, default `error`), parsed in `parseArgs` and threaded through to `migrate`, and reports the active strategy / any refusal on the existing stderr channel. The empty-target refusal becomes a clear CLI error rather than a raw PG constraint violation.
- **Composition with backup / atomic swap** — with atomic swap (`docs/11`) the target is a fresh, empty directory, so the default `error` strategy is satisfied trivially on the happy path; idempotence only governs the no-swap and interrupted-before-swap cases. Backup ([`10-backup.md`](./10-backup.md)) guarantees the *source* is recoverable, which is what makes an opt-in destructive `truncate` acceptable: even a wrong truncate of the target cannot lose the original data.

## Acceptance

- Running `migrate` **twice** with the default strategy against the same target: the first run succeeds; the second run **throws a clear error** naming the non-empty table(s) and **does not mutate** the target (no duplicate rows, no PK violation surfaced as a raw PG error). The target after the second (refused) run is byte-equivalent in row content to after the first.
- Running `migrate` twice with `onExisting: 'truncate'`: both runs succeed and the target after the second run has **exactly** the source's rows (no duplicates), sequences realigned, and a post-migration insert receives an id past the migrated maximum (as in [`2-data-migration.md`](./2-data-migration.md) Acceptance) — i.e. the second run is a no-op-equivalent convergence, not a doubling.
- Running `migrate` twice with `onExisting: 'skip'` after the first run partially populated the target: already-populated tables are reported skipped and unchanged; previously-empty tables are filled; no duplicates appear.
- In all cases the `MigrationReport` (or thrown error) makes the active strategy and the per-table outcome discoverable (FR-14.10).

## Testing requirements

Per [`6-testing.md`](./6-testing.md): pure/extractable logic gets focused unit tests; anything touching a real cluster is proven end to end. No DB mocking.

**Unit (`tests/*.test.ts`):**
- Reverse-topological truncate ordering derived from `topologicalSort` output (pure): given parent→child FKs, the truncate order is children-before-parents, the exact reverse of the insert order.
- Strategy dispatch logic (where extractable from `migrate`): `error` collects all non-empty tables and produces one combined error; `skip` partitions tables into skip vs. fill; `truncate` marks every table for truncate-then-fill.
- `MigrateOptions` / report shape: default `onExisting` is `'error'`; report fields for truncated / skipped / strategy are populated as specified.
- CLI arg parsing for `--on-existing` (extend the existing `parseArgs` tests): valid values accepted, invalid value rejected with a clear message, default is `error`.

**E2E (`tests/e2e/*.test.ts`)** — through the two-version (`pglite-old` / `pglite-new`) harness, on a real cluster:
- **Default refuse:** run once (succeeds), run again (default), assert it throws a clear error, the target row counts are unchanged, and no duplicate rows exist. Critically, assert this *instead of* the raw PK-violation path that the current code would hit — proving the guard fires before any insert.
- **Truncate convergence:** run twice with `truncate`; assert final row counts equal the source's (not doubled), sequences are realigned, and a subsequent insert gets an id past the migrated max.
- **Skip resumability:** simulate an interrupted run (populate a subset of target tables), then run with `skip`; assert populated tables are untouched, empty tables are filled, no duplicates.
- **Sequence idempotence (FR-14.9):** run twice (truncate); assert each sequence's `last_value` matches the source after both runs (not advanced twice).

## Open Questions

- **Default strategy — `error` vs. `truncate` (recommend: `error`).** Refuse-if-non-empty is the safest default and fixes the current bug; `truncate` is the most convenient for "re-run until it works" but is destructive. Recommendation: **default `error`**, with `truncate` and `skip` opt-in. Needs a human decision.
- **`TRUNCATE` vs. `DELETE` for the truncate strategy (recommend: `TRUNCATE`).** `TRUNCATE` is faster and resets nothing we rely on (sequences are realigned afterward anyway), but requires owner privileges and an `ACCESS EXCLUSIVE` lock; `DELETE` is slower but more permissive. Recommendation: **`TRUNCATE`** (single-writer, owner context assumed); confirm it behaves as expected inside PGlite.
- **Truncate ordering vs. `CASCADE` (recommend: reverse-topological plain `TRUNCATE`).** Reverse-ordered plain `TRUNCATE` keeps the blast radius inside the migration set; `CASCADE` is simpler but can truncate referencing tables outside the set. Recommendation: **reverse-ordered plain TRUNCATE**; use a multi-table `TRUNCATE` for any FK cycle. Confirm with PGLM-? (FK cycles, `docs/8`).
- **Ship `skip` in v1, or `error` + `truncate` only? (recommend: include `skip`).** `skip` adds table-level resumability cheaply and non-destructively. Recommendation: include it; it is low-cost and genuinely useful for interrupted-run recovery. Needs confirmation.
- **`ON CONFLICT` / upsert — when, if ever? (recommend: defer).** Requires collecting PK/unique metadata into `SchemaInfo` (not present today) and edges into merge semantics (NG-14.13). Recommendation: **defer** to a follow-up; reassess once PK/unique introspection exists.
- **Exact-count vs. existence probe in the report.** The guard only needs existence (`LIMIT 1`); a richer report could show pre-existing counts via `COUNT(*)`. Recommendation: existence probe for the guard, optional count only if the report demands it (avoid counting huge tables needlessly).
- **Concurrency / locking (NG-14.14).** v1 assumes a single writer. If host apps could race two upgrades, a lock/lease is needed. Needs a decision on whether that is in scope for the safety layer.

## Follow-up tickets

- **PGLM-8 (this doc):** Implement the empty-target guard as the default (`onExisting: 'error'`) in `src/migrate.ts` with the non-empty detection pass, plus the report/options shapes in `src/types.ts` and the CLI flag in `src/cli.ts`.
- **PGLM-8a:** Add the opt-in `truncate` strategy (`truncateTable` helper in `src/transfer.ts`, reverse-topological ordering, FK-cycle handling) and the `skip` strategy.
- **PGLM-8b (deferred):** `ON CONFLICT` / upsert strategy — gated on collecting PK/unique-constraint metadata into `SchemaInfo` (`src/introspect.ts` / `src/types.ts`).
- **PGLM-8c (deferred):** Row-level checkpoint/resume (mid-table resumability) — out of scope for v1 (NFR-14.12).
- **PGLM-8d (deferred):** Cross-run locking / single-writer enforcement (NG-14.14).
- Coordinate truncate ordering on cyclic schemas with FK-cycle deferred-constraint work ([`8-fk-cycle-deferred-constraints.md`](./8-fk-cycle-deferred-constraints.md)).
