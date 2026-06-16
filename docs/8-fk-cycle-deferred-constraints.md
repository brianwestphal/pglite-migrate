# 8 — Foreign-Key Cycle Handling (Deferred Constraints)

**Status: design only. Not implemented.** Tracks ticket **PGLM-2** and supersedes the "warn and insert in original order" stopgap of `2-data-migration.md` **FR-2.11** / `5-safety-and-rollback.md` **FR-5.5**. Cross-links: `2-data-migration.md` (the data path being extended), `5-safety-and-rollback.md` (the broader safety layer this belongs to), `6-testing.md` (the unit + e2e contract).

## Motivation / Problem

The transfer path orders tables with `topologicalSort` (`src/transfer.ts`) so every parent is inserted before its children, which keeps a plain per-row `INSERT` FK-safe. Some schemas, however, contain a foreign-key **cycle** — two or more tables that reference each other (`a.b_id → b.id` and `b.a_id → a.id`), or a longer ring. A cycle has no valid linear insert order: whichever table is inserted first, its rows reference rows that do not yet exist in the other table.

`topologicalSort` already **detects** cycles correctly and returns the participating tables in its `cycles` field. As of the PGLM-20 fix, `introspectForeignKeys` emits schema-qualified edge names (`public.a`, `public.b`), so cycle detection is reliable even for public-schema tables — previously those edges were dropped and cycles went undetected. Detection is therefore a solved problem; **handling** is not.

What `migrate` (`src/migrate.ts`) does today with a detected cycle:

1. Appends the cyclic tables to `ordered` in their original introspection order.
2. Pushes a single warning naming the tables and noting that the order "may violate constraints."
3. Transfers each table with `transferTable`, which issues plain per-row `INSERT`s **with no surrounding transaction**.

For an **empty** cycle this is harmless (no rows, no violation). For a **populated** cycle it throws a real foreign-key violation: the first `INSERT` into the first table references a not-yet-present row in the second. The existing e2e at `tests/e2e/fk-cycle.test.ts` captures exactly this split — the empty-cycle case passes, and the populated-cycle case is marked `it.fails` pending this work.

The warning is also misleading once handling exists: it tells the operator that data "may violate constraints" even in the common case where we can migrate the cycle cleanly.

## Requirements

- **FR-8.1 Correct populated-cycle transfer.** A migration of a source containing a populated FK cycle must complete without a foreign-key violation, with every row of every cyclic table present on the target. The acyclic case must be byte-for-byte unaffected.

- **FR-8.2 Scoped special handling.** Only the tables identified in `TopoResult.cycles` receive cycle-specific treatment. Tables that topologically sorted cleanly continue through the unchanged fast path (ordered per-row `INSERT`, no transaction wrapping required by this feature).

- **FR-8.3 Transactional, constraint-deferred insert for the cyclic subset.** The cyclic subset's rows are inserted inside a single transaction on the **target** with foreign-key constraint checking deferred to commit time (`SET CONSTRAINTS ALL DEFERRED`), so intra-cycle references are only validated once all participating rows exist. The transaction commits atomically: either the whole cyclic subset lands or none of it does.

- **FR-8.4 Deferrability is established, not assumed.** Because the target schema is created by the host app, its FK constraints may be declared `NOT DEFERRABLE` (the Postgres default), in which case `SET CONSTRAINTS` is a no-op and the deferral silently fails to take effect. The implementation must guarantee the cyclic subset's FKs are actually deferrable during the transfer (see Design), rather than trusting that the app declared them `DEFERRABLE`.

- **FR-8.5 Re-validation after transfer.** After the cyclic subset is inserted, the target's FK constraints for those tables must be in a fully **validated** state — every transferred row's references confirmed. A successful commit of a `DEFERRABLE` transaction validates them inherently; any path that disables/drops constraints (Design option B) must explicitly re-validate (`VALIDATE CONSTRAINT`) and fail the migration if validation does not pass.

- **FR-8.6 Restore original constraint definitions.** If the implementation alters or drops/re-adds constraints to make them deferrable (Design option B), the target schema must end in a state semantically equivalent to before the migration — constraints present, validated, and with their original deferrability characteristics restored. The migration must not silently leave the host app's schema more permissive (e.g. left `DEFERRABLE` when it was authored `NOT DEFERRABLE`) than it found it.

- **FR-8.7 Replace the misleading warning.** When a cycle is detected **and successfully handled**, no warning claiming a possible constraint violation is emitted. A warning is appropriate only when the library genuinely cannot guarantee correctness (e.g. it could not establish deferrability and had to fall back — see Open Questions).

- **FR-8.8 Honest failure.** If the cyclic subset cannot be migrated correctly (deferral could not be established and no fallback succeeds), the migration must fail loudly with an actionable error naming the tables and the reason, rather than committing a partial or constraint-violating result. This mirrors the "fail loudly, do not swap" stance of `5-safety-and-rollback.md` FR-5.4.

- **NFR-8.9 No DDL on the target in the default path.** Consistent with `2-data-migration.md` FR-2.2 (the library performs no DDL on the target), the **recommended** approach (Design option A) must work without issuing DDL. DDL-based handling (option B) is a fallback that, if implemented, is opt-in and clearly documented as a deviation from FR-2.2.

- **NFR-8.10 Engine-version agnostic.** `SET CONSTRAINTS`, `DEFERRABLE`, and `ALTER CONSTRAINT` are stable, long-standing Postgres features. The implementation must not depend on engine-major-specific syntax, preserving the cross-major property (`1-overview.md` NFR-1.5).

- **NG-8.11 Not a general dependency resolver.** This feature handles FK *cycles* among the app-class tables already in scope. It does not attempt to resolve cycles introduced by triggers, deferred check constraints other than FKs, or partitioning — those remain out of scope per `3-schema-reconstruction.md`.

## Design / Approach

Two viable strategies. They differ chiefly in whether the library touches the target's DDL.

### Option A (recommended default) — Deferred constraints, no DDL

Wrap the cyclic subset's inserts in one target transaction and defer FK checks to commit:

```sql
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
-- per-row INSERTs for every table in the cyclic subset, any order
COMMIT;   -- all FKs validated here, atomically
```

- **Pro:** Honors NFR-8.9 (no DDL on the target). Atomic. Simple. The transaction's commit *is* the re-validation (FR-8.5).
- **Pro:** Matches how a correct cyclic dataset must already have been inserted on the source in the first place (the e2e seed does exactly this), so the source is known to be self-consistent.
- **The catch (FR-8.4):** `SET CONSTRAINTS ALL DEFERRED` only affects constraints declared `DEFERRABLE`. A `NOT DEFERRABLE` FK (the Postgres default, and what a host app gets unless it opted in) is checked **per statement** regardless, and the deferral is silently ignored. So option A alone works **only if** the app authored the cyclic FKs as `DEFERRABLE`.

To make option A robust we must first ensure the relevant constraints are deferrable. The least-invasive way to do that without dropping the constraint is `ALTER TABLE … ALTER CONSTRAINT … DEFERRABLE INITIALLY IMMEDIATE`, which flips deferrability **without re-validating existing data** (it is a catalog-only change). The sequence becomes:

```sql
-- for each FK constraint among the cyclic subset that is NOT DEFERRABLE:
ALTER TABLE child ALTER CONSTRAINT fk_name DEFERRABLE INITIALLY IMMEDIATE;  -- cheap, catalog-only
BEGIN;
  SET CONSTRAINTS ALL DEFERRED;
  -- inserts
COMMIT;
-- restore: ALTER TABLE child ALTER CONSTRAINT fk_name NOT DEFERRABLE;  (FR-8.6)
```

`ALTER CONSTRAINT … DEFERRABLE` is technically DDL, so strictly speaking this nuance crosses NFR-8.9 only when the app did **not** already make the FK deferrable. The cost is negligible (no table scan), and it is far cheaper and safer than dropping/re-adding. This is the recommended default: pure `SET CONSTRAINTS` when the FK is already deferrable; a transient `ALTER CONSTRAINT` flip (then restore) when it is not.

### Option B (fallback) — Drop constraints, insert, re-add + VALIDATE

For the cyclic subset only: drop the FK constraints, insert all rows, then re-add each constraint and rely on the re-add's implicit validation (or `ADD CONSTRAINT … NOT VALID` followed by `VALIDATE CONSTRAINT`):

```sql
ALTER TABLE child DROP CONSTRAINT fk_name;
-- inserts for the whole subset
ALTER TABLE child ADD CONSTRAINT fk_name FOREIGN KEY (...) REFERENCES parent (...);  -- validates on add
```

- **Pro:** Works regardless of the original deferrability and regardless of whether the engine honors `SET CONSTRAINTS` for a given constraint.
- **Con:** Requires reconstructing each FK's full definition (columns, referenced columns, `ON DELETE`/`ON UPDATE` actions, match type, original deferrability) to re-add it faithfully — that reaches into the DDL-reconstruction problem this project deliberately defers (`3-schema-reconstruction.md`), and getting it wrong leaves the schema subtly altered (violating FR-8.6).
- **Con:** Re-adding triggers a full validating scan of the table — more expensive than option A's commit-time check.
- **Con:** A crash between drop and re-add leaves the target's schema missing a constraint. The atomic-swap pattern of `5-safety-and-rollback.md` FR-5.2 mitigates this (we migrate into a throwaway target), but it is a real hazard absent that layer.

**Recommendation:** Implement **option A with the `ALTER CONSTRAINT` deferrability flip** as the default. Keep option B as a documented fallback only if a concrete schema is found where the engine refuses to defer an already-deferrable FK, or where `ALTER CONSTRAINT` is unavailable. Default to A; do not build B until a real case demands it (file as a follow-up ticket rather than speculatively building it).

### Boundary between the fast path and the cyclic path

`topologicalSort` already partitions tables for us: `ordered` minus the tables named in `cycles` is the acyclic set (transfer unchanged); `cycles` is the subset that goes through the transactional, constraint-deferred path. Acyclic tables are transferred first (so any FK from a cyclic table to an acyclic parent already has its target rows present), then the cyclic subset is transferred inside the single deferred transaction.

## Interaction with existing code

- **`src/transfer.ts` — `topologicalSort`.** No change to detection. The `cycles: string[]` field is already the exact subset this feature operates on. (Consider whether `transferTable` should optionally accept a caller-managed transaction/connection so the cyclic subset can share one transaction — see Open Questions.)
- **`src/transfer.ts` — `transferTable`.** Today it opens no transaction and issues per-row `INSERT`s. The cyclic path needs those inserts to run inside one shared, deferred transaction. The cleanest options are (a) a new `transferTablesDeferred(target, tables, ...)` that wraps the whole subset, or (b) threading an optional "already in a transaction, do not wrap" flag through `transferTable`. Either keeps the acyclic per-table call shape intact.
- **`src/migrate.ts` — `migrate`.** Replace the block that pushes the warning and falls through to the normal loop (lines ~24–28) with: transfer the acyclic tables as today, then, if `cycles.length > 0`, run the deferred-constraint path over the cyclic subset, ensuring deferrability per FR-8.4 and restoring it per FR-8.6. Only emit a warning if handling could not be guaranteed (FR-8.7).
- **`src/introspect.ts` — `introspectForeignKeys`.** Option A's `ALTER CONSTRAINT` flip needs the **constraint name** and its **table**, and restoring deferrability (FR-8.6) needs each constraint's **original deferrable / initially-deferred** flags. The current `ForeignKey` shape (`{ child, parent }`, see `src/types.ts`) carries neither. Extending introspection to capture FK constraint name + deferrability is a prerequisite; this also benefits option B (which needs the full definition). Add fields rather than changing the existing edge semantics used by `topologicalSort`.
- **`src/types.ts`.** Likely additions: constraint name and deferrability flags on `ForeignKey` (or a parallel `ForeignKeyConstraint` type), and possibly a `cyclesHandled`/`deferredTables` field on `MigrationReport` so the report records that a cycle was migrated via the deferred path rather than silently.
- **`PGliteLike` (`src/types.ts`).** `query`/`exec` are sufficient to run `BEGIN`/`SET CONSTRAINTS`/`COMMIT` and `ALTER`. No interface change required, though a transaction helper may be desirable.

## Acceptance

- A source seeded with a genuine populated FK cycle (`a(1)→b(1)`, `b(1)→a(1)`) migrates into a fresh-schema target with all rows present and **no** FK violation, and the target's FK constraints are valid afterward. This is the `it.fails` case in `tests/e2e/fk-cycle.test.ts` flipped to `it`, with added "constraints valid on target" assertions.
- The empty-cycle case still passes, but with the misleading "may violate constraints" warning **gone** for handled cycles (FR-8.7) — the test assertion for that warning is updated accordingly.
- When the target's cyclic FKs are authored `NOT DEFERRABLE`, the migration still succeeds (FR-8.4) and leaves them `NOT DEFERRABLE` afterward (FR-8.6).
- Acyclic migrations (`tests/e2e/roundtrip.test.ts`) are unchanged.
- A schema where the cycle genuinely cannot be handled fails loudly rather than committing a partial result (FR-8.8).

## Testing requirements

Per `6-testing.md` (double coverage: pure logic unit-tested, anything touching a cluster proven e2e):

- **Unit (`tests/topo.test.ts` or a new file).** `topologicalSort` cycle **detection** is already unit-testable and should have explicit cases: a 2-table cycle, a 3+-table ring, a cycle plus surrounding acyclic tables (assert the acyclic ones sort cleanly and only the ring is reported in `cycles`), and a self-reference excluded from cycles. Any new pure helper (e.g. "compute the cyclic subset to wrap") gets a focused unit test. The transactional insert itself has no meaningful mock (per the no-DB-mocking rule) and is covered e2e.
- **E2E (`tests/e2e/fk-cycle.test.ts`).** Flip the populated-cycle `it.fails` to `it`; assert all rows present on the target **and** that the FK constraints are valid (e.g. a deferred-immediate re-check, or querying `pg_constraint.convalidated`). Add a variant where the target's cyclic FKs are `NOT DEFERRABLE` to exercise FR-8.4/FR-8.6, asserting both a clean migration and that deferrability is restored. Keep the empty-cycle case but update its warning assertion to match FR-8.7. Use the two-engine alias harness unchanged (NFR-6.3 — do not collapse `pglite-old`/`pglite-new`).
- **Regression.** Confirm `tests/e2e/roundtrip.test.ts` (the acyclic path) is untouched in behavior.

## Open Questions

1. **Default deferrability strategy when the app declared `NOT DEFERRABLE`.** Transiently `ALTER CONSTRAINT … DEFERRABLE` then restore (option A, recommended), or fall back to drop/re-add (option B)?
   *Recommended default:* the transient `ALTER CONSTRAINT` flip — catalog-only, no table scan, faithfully restorable — and only consider option B if a concrete engine/schema rejects it.

2. **Should the deferrability flip count as a violation of "no DDL on target" (FR-2.2)?**
   *Recommended default:* treat `ALTER CONSTRAINT` deferrability changes as an explicitly-sanctioned, transient exception scoped to the cyclic subset and reverted before return; document it in the report and release notes rather than expanding FR-2.2 wholesale.

3. **Report shape for handled cycles.** Should `MigrationReport` gain a field recording which tables were migrated via the deferred path?
   *Recommended default:* yes — add a `deferredTables: string[]` (or similar) so the outcome is observable and testable, replacing the lost information that the warning used to (poorly) convey.

4. **Transaction granularity.** Wrap only the cyclic subset, or the entire migration, in one transaction?
   *Recommended default:* wrap only the cyclic subset for now; a whole-migration transaction belongs with the broader atomicity work in `5-safety-and-rollback.md` (FR-5.2) and should be decided there to avoid two competing transaction strategies.

5. **Source self-consistency.** Do we trust that the source's cyclic data already satisfies its FKs (it must, to have been committed), or re-check on read?
   *Recommended default:* trust the source — it could not have committed an invalid cycle — and rely on the target's commit-time validation (FR-8.5) as the actual guarantee.

## Follow-up tickets

- **Introspect FK constraint name + deferrability** (`src/introspect.ts`, `src/types.ts`) — prerequisite for the deferrability flip and for restoring original characteristics (FR-8.4/FR-8.6).
- **Deferred-constraint transactional transfer for cyclic subset** (`src/transfer.ts`, `src/migrate.ts`) — the core of this doc (option A).
- **Option B drop/re-add fallback** — file only if a real schema/engine defeats option A; depends on FK definition reconstruction shared with `3-schema-reconstruction.md`.
- **Report cycle-handling outcome** (`MigrationReport` field) — Open Question 3.
- **Update `2-data-migration.md` FR-2.11 and `5-safety-and-rollback.md` FR-5.5** to reference this doc and mark them resolved once shipped, and refresh both `docs/ai/*` summaries (per CLAUDE.md doc-sync rule).
