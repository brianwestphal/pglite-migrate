# 13 — Post-Migration Validation

**Status: Implemented (PGLM-29), default level `counts`.** Tracked as **PGLM-7** (refines **FR-5.4** from [`5-safety-and-rollback.md`](./5-safety-and-rollback.md)). This is the check that lets a host app trust an automated, on-startup upgrade without a human in the loop. It must land before — and is gated together with — the atomic swap ([`11-atomic-swap.md`](./11-atomic-swap.md) / PGLM-5).

## Motivation / Problem

A migration mutates the user's only copy of their data. The data-only transfer path ([`2-data-migration.md`](./2-data-migration.md)) reads rows from the source engine, round-trips each value through JavaScript, and re-inserts it into the target engine (`transferTable` in `src/transfer.ts`). Several things can go wrong silently:

- **Dropped rows** — a partial failure, a swallowed error, or a schema mismatch (e.g. the host app's target schema is missing a table the source has) leaves a table short.
- **Type-fidelity loss** — round-tripping through JS values can corrupt `json`/`jsonb`, `numeric`, `bytea`, and array values (NFR-2.15). The row *count* can be correct while the *contents* are wrong.
- **Stale sequences** — if `applySequences` is skipped or a sequence is missed, the next insert collides with a migrated primary key.

Today `migrate` returns a `MigrationReport` describing what it *did*, but performs **no independent check that the result matches the source**. For an unattended startup upgrade — detect old `PG_VERSION`, migrate into a sibling directory, swap, keep the old as backup — that is not good enough. The host needs a positive signal: *the target faithfully reproduces the source; it is safe to swap.* Post-migration validation produces that signal, and its absence must **block the swap**.

## Requirements

- **FR-13.1 Row-count parity** For every table transferred, validation re-counts rows on the **target** and compares against an independent count of the **source**. A mismatch is a validation failure. Counts are taken after transfer completes, before any swap.
- **FR-13.2 Sequence consistency** For every source sequence with a non-null `lastValue` (the ones `applySequences` acts on), validation confirms the target sequence's current value is *consistent* with the source — i.e. the target's `nextval` will not re-issue a value already present in the migrated data. See Design for the exact "consistent" predicate.
- **FR-13.3 Optional content agreement (aggregate/checksum)** An opt-in level that computes a cheap-but-strong digest per table on both engines (e.g. a count plus an aggregate/hash over deterministically ordered rows) and compares them, catching content corruption that a row count alone cannot. Must be version-agnostic and degrade gracefully (skip + warn) where a primitive is unavailable. Off by default in v1; see Open Questions.
- **FR-13.4 Fail loudly, do not swap** On any validation failure, `migrate` (when validation is enabled) raises a typed error / returns a report marked `validation.ok === false`. The orchestration **must not** proceed to an atomic swap (PGLM-5); the freshly written target directory is discarded and the source is left untouched. No silent best-effort.
- **FR-13.5 Surface results in the report** Validation results are attached to `MigrationReport` (new `validation` field, see Report/CLI surface) as structured, per-table data: which checks ran, per-table source vs target counts, sequence comparisons, any digest comparisons, and a flat list of mismatches. This holds whether validation passed or failed.
- **FR-13.6 Run after transfer, before swap** Validation runs inside the orchestrator (`src/migrate.ts`) after `transferTable`/`applySequences` complete and **before** control returns to any swap step. It reads only — it performs no DDL and no writes on either engine.
- **FR-13.7 Selectable level** The caller chooses the validation level via `MigrateOptions` (see Open Questions for the default): `'off'`, `'counts'` (FR-13.1 + FR-13.2), or `'full'` (adds FR-13.3). `'counts'` is cheap enough to be the recommended default for unattended upgrades.
- **NFR-13.8 Version-agnostic** Like introspection (`src/introspect.ts`), validation SQL must use only stable, cross-major primitives (`count(*)`, `pg_sequences`, `setval`/`currval` semantics, and for digests only widely portable aggregates). It runs against two *different* Postgres majors at once, so it must not depend on major-specific functions or output formats.
- **NFR-13.9 Bounded cost** The default level must be cheap relative to the transfer itself (a `count(*)` per table is one sequential scan; the transfer already read every row). The `'full'` level may be markedly more expensive and is opt-in for that reason.
- **NFR-13.10 Deterministic & reproducible** A given source/target pair must produce the same validation verdict on repeat runs. Any ordering used for digests must be fully determined (see Design) so the digest is stable across engines and runs.
- **NG-13.11 Not a schema diff** Validation checks that *data* was faithfully transferred for the tables that were migrated. It does **not** verify that the target schema matches the source (column types, constraints, indexes). That belongs to standalone schema reconstruction ([`3-schema-reconstruction.md`](./3-schema-reconstruction.md)) and is out of scope here.
- **NG-13.12 Not a continuous integrity monitor** This is a one-shot, post-migration gate, not an ongoing checksum/consistency service.

## Design / Approach

Validation is layered so the host can trade cost for assurance. Each level is a superset of the one below.

### Level 0 — `off`

No validation. Equivalent to today's behavior. Provided for callers who do their own checking or are running an exploratory/dry-run flow. The orchestration must then *not* claim a validated result (an unvalidated migration must never be auto-swapped without an explicit caller opt-out — see Open Questions).

### Level 1 — `counts` (recommended default)

Two checks, both cheap:

1. **Row counts (FR-13.1).** For each table in the introspected source schema (the same list `migrate` already iterates), run `SELECT count(*) FROM <qualified>` against the source and against the target and compare. Use the existing qualified-name machinery (`quoteQualified` in `src/ident.ts`). `count(*)` returns `bigint`; compare as strings/BigInt to avoid `Number` precision loss on very large tables. The per-table source count is already implied by `TableResult.rowsCopied` from the transfer, but validation re-counts **independently on both engines** rather than trusting the transfer's own tally — the whole point is to catch a transfer that miscounted or silently dropped rows.

2. **Sequence consistency (FR-13.2).** For each `SequenceInfo` with a non-null `lastValue`, read the target sequence's current value and confirm it is consistent. "Consistent" is defined as: the target sequence is positioned at or past the source's captured `last_value`, so the next `nextval` cannot collide with a migrated key. Concretely, read `last_value` from the target's `pg_sequences` (same query shape as `introspectSequences`) and assert `target.last_value >= source.lastValue`. Reading `pg_sequences.last_value` is non-mutating, unlike `nextval`/`currval`, which is why it is preferred here. Sequences the source never advanced (null `lastValue`) are not checked — `applySequences` deliberately leaves them fresh (FR-2.13), and a fresh target sequence is correct.

### Level 2 — `full` (opt-in content agreement)

Adds a per-table digest (FR-13.3) to catch corruption that counts miss. The design constraint is **cheap, strong, and portable across majors** — and reproducible on two different engines.

Recommended primitive: a **per-table aggregate over a stable row encoding**. For each table:

```sql
SELECT count(*) AS n,
       md5(string_agg(t.row_text, E'\n' ORDER BY t.row_text)) AS digest
  FROM (
    SELECT (<qualified> r)::text AS row_text FROM <qualified> r
  ) t;
```

Notes on the choices:

- **Order independence.** Aggregating with `ORDER BY t.row_text` makes the digest independent of physical row order, which differs between source and target after a fresh re-insert. This avoids needing a primary key to sort by, and works for tables without one. (Cost: a sort over the encoded rows.)
- **Row encoding via `::text` of the row type.** Casting the whole row to `text` uses Postgres's own composite output. This is portable and requires no per-column logic. Its weakness is exactly the fidelity gap we care about: `json` whitespace/key-order and `numeric`/`bytea`/array text forms must render identically on both engines for the digest to match. Across two *different* majors, those text representations are **not guaranteed identical**, so a `full` digest mismatch is "investigate," not necessarily "data is corrupt." This caveat is why `full` is opt-in and why the report must show *which* tables disagreed rather than only a pass/fail bit.
- **Hash choice.** `md5` is available everywhere and is sufficient for accidental-corruption detection (this is not a security context). It returns a short hex string that is trivial to compare and to print in the report.
- **Cost.** This reads every row again and sorts the encoded form — roughly the cost of the transfer plus a sort, per table. That is why it is not the default (NFR-13.9).

A cheaper-but-weaker alternative worth noting: per-column aggregates such as `sum`/`count`/`min`/`max` over numeric and date columns. These are O(scan) with no sort, but require per-column type logic and miss reorderings within a row. The row-digest approach is recommended as the single, type-agnostic `full` primitive; per-column aggregates can be a future refinement if `full` proves too slow on large tables.

### Where it runs (orchestration)

Validation is a new step in `migrate` (`src/migrate.ts`), inserted **after** the transfer loop and `applySequences`, and **before** any swap. Sketch:

```
introspect source
topologically sort
transfer tables          (existing)
applySequences           (existing)
── validate(level) ──    (new: reads source + target, builds ValidationReport)
if !validation.ok: throw / mark report; caller MUST NOT swap   (FR-13.4)
return MigrationReport { …, validation }
```

The validation function lives in a new module (proposed `src/validate.ts`, primary export `validateMigration(source, target, schema, level)`), mirroring how `transfer.ts` and `introspect.ts` factor pure-ish, separately-testable units out of the orchestrator. It consumes the already-introspected `SchemaInfo` so it does not re-introspect.

## Interaction with existing code

- **`src/migrate.ts`** — `migrate` gains the validation step described above. It already holds `schema` (from `introspectSchema`) and both engine handles, so validation needs no new inputs beyond the chosen level. On failure it must surface the result and **not** hand off to the swap step (which is itself being added under PGLM-5 / [`11-atomic-swap.md`](./11-atomic-swap.md)).
- **`src/introspect.ts`** — validation reuses the same notions: the table list to count, and the `pg_sequences` shape used by `introspectSequences` (for the target-side sequence read in FR-13.2). Keep both queries version-agnostic in the same spirit (NFR-2.9 / NFR-13.8).
- **`src/transfer.ts`** — `TableResult.rowsCopied` (from `transferTable`) is the transfer's *self-reported* count; FR-13.1 validates it against an *independent* re-count on both engines rather than trusting it. `applySequences` (FR-2.13) defines what FR-13.2 checks: only sequences with non-null `lastValue` are touched, so only those are validated.
- **`src/ident.ts`** — all table/sequence names spliced into validation SQL go through `quoteQualified`/`quoteIdent`/`quoteLiteral`, same as everywhere else.
- **`src/types.ts`** — add `validation?` (level + result) to `MigrateOptions` and a `validation` field to `MigrationReport`; add the new result interfaces (below). `types.ts` is the SSOT for these shapes.

## Report / CLI surface

### `MigrationReport` (`src/types.ts`)

Add an optional `validation` field plus supporting interfaces:

```ts
export type ValidationLevel = 'off' | 'counts' | 'full';

export interface TableValidation {
  table: string;            // qualified schema.name
  sourceRows: string;       // count(*) as string/BigInt-safe
  targetRows: string;
  rowsMatch: boolean;
  sourceDigest?: string;    // present only at level 'full'
  targetDigest?: string;
  digestMatch?: boolean;
}

export interface SequenceValidation {
  sequence: string;         // qualified schema.name
  sourceLastValue: string;
  targetLastValue: string;
  consistent: boolean;      // target >= source
}

export interface ValidationReport {
  level: ValidationLevel;
  ok: boolean;              // false ⇒ caller MUST NOT swap (FR-13.4)
  tables: TableValidation[];
  sequences: SequenceValidation[];
  mismatches: string[];     // flat, human-readable list of every failure
}

export interface MigrationReport {
  tables: TableResult[];
  sequencesSet: number;
  totalRows: number;
  warnings: string[];
  validation?: ValidationReport;   // present when level !== 'off'
}
```

`MigrateOptions` gains `validation?: ValidationLevel` (default per Open Questions). Existing fields are unchanged, so current callers compile unmodified.

### CLI (`src/cli.ts`)

- A `--validate <level>` flag (`off` | `counts` | `full`), defaulting to the library default.
- After a successful migration, print a one-line-per-table validation summary (e.g. `users: 1234 = 1234 ✓`) and an overall `Validation: OK (counts)` line.
- On validation failure: print every entry in `validation.mismatches`, print `Validation: FAILED — target not swapped`, and exit non-zero. This is the unattended-upgrade signal: a non-zero exit means the host must keep running on the old data dir / restore the backup, never swap.

## Acceptance

- **Happy path.** A source seeded with related tables, a serial sequence, and a `timestamptz` migrates into a fresh-schema target with `validation: 'counts'`. The report shows `validation.ok === true`, per-table `rowsMatch === true`, and each touched sequence `consistent === true`. (Extends the existing `tests/e2e/roundtrip.test.ts` scenario.)
- **Deliberate mismatch → fail, no swap.** With a target whose schema exists but where validation is configured to run, inject a discrepancy (e.g. delete a row from the target after transfer but before validation, or transfer into a target missing one expected row) and assert: `validateMigration` reports `ok === false`, the offending table appears in `mismatches`, `migrate` raises / marks the report accordingly, and **the swap step is not invoked** (assert via a swap spy / by confirming the canonical directory is unchanged once PGLM-5 lands). This is the core safety guarantee.
- **`full` digest agreement.** A `full` run produces matching per-table digests for at least one table containing `json`, `numeric`, and a `bytea`/array column, demonstrating content-level agreement when the engines agree on text form. **Confirmed across the real cross-major pair (PG17 0.4.3 → PG18 0.5.3, PGLM-19):** a fidelity table with `json`/`jsonb`/`numeric`/`bytea`/`integer[]`/`timestamptz` digests `digestMatch === true` — because the COPY-text path preserves the source's text representation (`docs/7`), the digests do not diverge across these two majors.

## Testing requirements

Per [`6-testing.md`](./6-testing.md), every new capability gets a unit test for its logic plus an e2e assertion against a real migration.

- **Unit (`tests/*.test.ts`, `vitest.config.ts`).**
  - The pure verdict logic — given source/target counts and sequence values, `ok`, `mismatches`, and per-table booleans are computed correctly (parity, off-by-one short, target sequence behind source). Extract this comparison logic so it is testable without a cluster, mirroring `topologicalSort`.
  - Sequence "consistent" predicate: `target >= source` passes, `target < source` fails, null-`lastValue` sequences are skipped.
  - Count comparison uses BigInt/string compare (large-count sanity, no `Number` overflow).
- **E2E (`tests/e2e/*.test.ts`, `vitest.e2e.config.ts`).** Using the two-version `pglite-old`/`pglite-new` aliases (do not collapse them — NFR-6.3):
  - Happy-path `counts` validation passes on the existing round-trip fixture.
  - The deliberate-mismatch case above fails and blocks the swap.
  - A `full` run agrees on a fidelity-heavy table across the cross-major matrix (PG17→PG18) — verified during PGLM-19 (digests match because COPY-text preserves text form). Any future digest divergence on a differing text form remains "investigate," per Design.
- Add validation cases to the "What the e2e asserts" / "Gaps" lists in `6-testing.md` when implemented.

## Open Questions

- **Default level — recommend `'counts'`.** Cheap (one `count(*)` per table, which the host already paid for during transfer) and strong enough to catch dropped rows and stale sequences, the two highest-probability failures. `'full'` stays opt-in because its cost is unbounded and, across two majors, its digest can disagree on representation alone. `'off'` exists but an *auto-swap* should refuse to proceed on an unvalidated migration unless the caller explicitly opts out.
- **What "consistent" means for sequences — recommend `target.last_value >= source.lastValue`.** Strictly greater is too strict (equal is fine — `nextval` still advances first), and exact equality is too strict the other way (the target may legitimately be ahead if the host app inserted rows before migration; though for a fresh target that should not happen). `>=` is the safe collision-avoidance predicate. Confirm whether `is_called` semantics need to factor in for edge cases (a target sequence at `last_value` with `is_called=false`).
- **Should validation failure throw or return a marked report?** Recommend **throw a typed `ValidationError`** that carries the `ValidationReport`, so an unattended host cannot accidentally ignore a falsy `ok`. The report is still attached for inspection. Decide the exact error type/shape with PGLM-5 so the swap orchestration treats it uniformly.
- **Digest hash + encoding.** `md5(string_agg(row::text ORDER BY row::text))` is the recommended single primitive. Open: whether to offer a per-column-aggregate fast path for very large tables, and how to document the cross-major text-form caveat in release notes.
- **Scope of counted tables.** Count exactly the tables `migrate` transferred (the introspected source set). A table that exists on the target but not the source is out of scope here (it is a schema concern, NG-13.11) — but consider warning if the target is missing a table the source has, since that surfaces as a count failure anyway.

## Follow-up tickets

- **PGLM-7 (this doc)** — implement post-migration validation: `validateMigration`, the `'off' | 'counts' | 'full'` levels, report/CLI surface, unit + e2e.
- **Gate with PGLM-5 (atomic swap, [`11-atomic-swap.md`](./11-atomic-swap.md))** — wire "validation failed ⇒ do not swap, discard target, keep source" into the swap orchestration; agree the `ValidationError` contract.
- **Cross-major digest fidelity** — once a second Postgres major ships as a PGlite build, characterize where `full` digests legitimately diverge by text representation and refine `full` (e.g. per-column-aggregate fast path, normalized `json` encoding). Ties into the COPY-text fidelity work (NFR-2.15, [`2-data-migration.md`](./2-data-migration.md)).
- **Dry-run integration (FR-5.3)** — surface the count/digest comparison as part of `--dry-run` reporting so a host can preview parity expectations before committing.
