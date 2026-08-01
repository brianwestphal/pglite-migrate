# 16 — Custom Types (enums, domains, composites)

**Status: Implemented (PGLM-92).** Resolves **OQ-9.5** in [`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md), which left open whether standalone reconstruction should rebuild domain and composite types or only report them. This document is the answer and the spec.

## Motivation

Standalone reconstruction ([`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md)) rebuilds the source's app-class schema on an empty target. Enums were in scope from the start. Domains and composites were not — and the PGLM-74 audit found that this was worse than a plain omission:

```sql
CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
CREATE TABLE d (x posint);
```

`format_type` renders the column's type faithfully as `posint`, so `CREATE TABLE` failed with `type "posint" does not exist` — **after** enums and sequences were already on the target. PGLM-79 fixed the reporting half: both kinds are now detected, so `onUnsupported: 'error'` refuses with the target untouched. This document covers the other half.

## The scope decision (OQ-9.5, resolved)

**Both domains and composites are reconstructed.**

The original recommendation was "emit composite/domain only if trivially derivable, otherwise treat as unsupported-and-reported". Probing the catalogs against a live PGlite settled it: **both are trivially derivable**, so the qualifier is satisfied for both and there is no principled reason to include one and not the other.

- A domain needs `format_type(typbasetype, typtypmod)`, `typnotnull`, `pg_get_expr(typdefaultbin, 0)`, `typcollation`, and its CHECK constraints — one query plus one for the constraints.
- A composite needs `pg_attribute` over `typrelid` — one query, and no default/constraint handling at all, so it is *simpler* than a domain.

This does not move the line drawn by **NG-3.5** / **NG-9.10**. Custom types were already inside the app-class boundary via enums; this completes that category rather than widening it. Views, matviews, functions, triggers, RLS, partitioning, rules, opclasses, comments, grants and extensions all remain out of scope and reported.

## Requirements

- **FR-16.1 Domains are reconstructed** with their base type, `NOT NULL`, `DEFAULT`, `COLLATE`, and every CHECK constraint, preserving constraint names.
- **FR-16.2 Composite types are reconstructed** with their attributes in physical (`attnum`) order and each attribute's rendered type.
- **FR-16.3 Reconstructed types are not reported as unsupported.** `detectUnsupported` no longer lists domains or composites. Reporting a type as "not recreated" while recreating it would be worse than either behavior alone.
- **FR-16.4 The report distinguishes them.** `ReconstructionReport` gains `domains: string[]` and `composites: string[]` alongside the existing `enums`, each holding qualified names.
- **FR-16.5 Multiple CHECKs per domain are preserved.** A domain may carry any number; each is emitted as a named `CONSTRAINT … CHECK (…)` so a later `ALTER DOMAIN … DROP CONSTRAINT` on the target still finds the name it expects.
- **FR-16.6 Collations are emitted** when the domain declares one (see [Collation](#collation-and-ng-910) for how this interacts with NG-9.10).
- **NFR-16.7 Dependency order is respected.** A domain may be defined over an enum or a composite, a composite may have a domain-typed attribute, and a domain may be defined over another domain. All custom types are therefore emitted in one pass in a dependency-safe order (see [Ordering](#ordering)).
- **NFR-16.8 System types are excluded.** `information_schema` ships built-in domains (`cardinal_number`, `yes_or_no`, …) and every table, view and sequence has an implicit composite row type in `pg_type`. Neither is a user-declared type and neither may be emitted.
- **NG-16.9 Not in scope: base types.** C-level base types (`typtype = 'b'` with no array parent) require a compiled extension and never make sense here. ~~Range types~~ — **now in scope**, see [`17-range-types.md`](17-range-types.md) (PGLM-95); only a range depending on a canonical/subdiff *function* is still reported.

## Design

### Ordering

Postgres forbids cycles among type dependencies — a type cannot be defined over one that does not yet exist — so a valid creation order always exists. All three custom-type kinds are emitted in **one pass ordered by `pg_type.oid`**.

That is a genuine topological order, not a heuristic: a type's dependencies must have existed when it was created, and creation assigns a monotonically increasing OID, so every dependency has a lower OID than its dependant. Sorting by OID therefore cannot place a type before something it references.

> The one theoretical exception is OID wraparound, which needs ~4 billion object creations in a single database. That is not reachable in an embedded PGlite instance, and a wrapped source would break far more than type ordering.

Emitting all three kinds in one pass is what makes the cross-kind cases work (`CREATE DOMAIN d AS pair`, or a composite with a domain-typed attribute); handling them in three separate name-ordered passes would not.

### Collation and NG-9.10

`NG-9.10` lists "collations beyond defaults" as out of scope, and `detectUnsupported` reports user-defined collations. A domain's `COLLATE` clause is nonetheless **emitted**, because dropping it would silently change comparison and sort semantics for every column of that domain — a quiet correctness change, which is precisely what FR-9.6 exists to prevent.

The two rules compose rather than conflict: the collation *object* is still reported as unsupported if the source defines one, so an operator is told it was not created; the domain's reference to it is preserved so that a target which does have that collation gets faithful behavior. A domain referencing a user-defined collation that the target lacks will fail loudly at `CREATE DOMAIN`, which is the honest outcome — better than a domain that silently sorts differently.

Built-in collations (`"C"`, `"POSIX"`, the database default) always exist on the target, which is the common case.

### Emitted DDL

```sql
CREATE DOMAIN <qualified> AS <format_type(typbasetype, typtypmod)>
  [COLLATE <collation>]
  [DEFAULT <pg_get_expr(typdefaultbin, 0)>]
  [NOT NULL]
  [CONSTRAINT <name> CHECK (<def>)]…

CREATE TYPE <qualified> AS (<col> <type>, …);
```

Domain CHECKs are read from `pg_constraint` joined on **`contypid`** (the type the constraint belongs to), not `conrelid` — the latter is for table constraints and is `0` here. The join must be filtered to non-system schemas via the *type's* namespace, or `information_schema`'s built-in domain checks leak in.

## Interaction with existing code

- **`src/reconstruct.ts`** — `reconstructEnums` is replaced by `reconstructCustomTypes`, which emits enums, domains and composites in one OID-ordered pass and returns the three buckets. `detectUnsupported`'s type detector narrows from `typtype IN ('d','c')` to the kinds still out of scope.
- **`src/types.ts`** — `ReconstructionReport` gains `domains` and `composites` (SSOT for shapes).
- **`src/introspect.ts`** — unchanged. Columns already render domain and composite types correctly through `format_type`; nothing about the *data* path changes.
- **Data transfer** — unchanged. A domain is its base type on the wire and a composite has a stable text representation, both of which the COPY-text path ([`7-copy-text-transfer.md`](7-copy-text-transfer.md)) carries verbatim.

## Acceptance

- A source with a domain (base type, `NOT NULL`, `DEFAULT`, two CHECKs) and a standalone composite reconstructs onto a bare target, and neither appears in `unsupported`.
- The domain's CHECKs are **enforced** on the target, not merely present — a domain reconstructed without its constraints is the quiet failure mode.
- A table with a domain-typed column and a composite-typed column reconstructs and accepts rows.
- A domain defined over an enum, and a composite with a domain-typed attribute, both reconstruct — proving the ordering.
- `information_schema`'s built-in domains and every table's implicit row type are absent from both the report and the emitted DDL.

## Testing

Per [`6-testing.md`](6-testing.md)'s double-coverage rule:

- **Unit** (`tests/reconstruct.test.ts`) — the acceptance cases above against an in-memory pair, including the enforcement check and the cross-kind ordering case.
- **E2E** (`tests/e2e/standalone.test.ts`) — a domain-typed column in the standalone fixture, proven across the real PG17 → PG18 pair (NFR-6.3: do not collapse the aliases).

## Follow-up

- ~~**Range types**~~ — **done (PGLM-95)**, see [`17-range-types.md`](17-range-types.md).
- **Domain-over-domain depth** is handled by the OID ordering, but is not exercised by a test; add one if it ever appears in a real source.
