# 9 — Standalone Schema Reconstruction (Detailed Spec)

**Status: design only. Not implemented. Ticket PGLM-3.** This document is the implementation-ready specification that expands the high-level overview in [`3-schema-reconstruction.md`](./3-schema-reconstruction.md); that doc stays as the short overview, this one drives the build.

## Motivation / Problem

The shipped v1 path ([`2-data-migration.md`](./2-data-migration.md)) is **app-driven, data-only**: it assumes the target schema already exists because the host application created it via its own startup migrations. `migrate` (`src/migrate.ts`) therefore performs **no DDL** on the target — it introspects the source, sorts tables, transfers rows, and realigns sequences.

The **standalone** case has no host app. An operator points the CLI at two bare PGlite data directories — an old-major source and a fresh, empty, new-major target — with no application present to create tables. Today this fails on the first `INSERT` because the target has no schema (see **NG-4.7** in [`4-cli.md`](./4-cli.md), and the same assumption noted for `migrate`). Standalone mode must **reconstruct the app-class schema on the target from the source** before the existing data transfer runs, then hand off to that transfer unchanged.

Reconstructing DDL is the single largest source of complexity in logical migration — it is what makes `pg_dump` a ~15k-line C program. The whole strategy of this spec is to **borrow Postgres's own DDL emitters**, which run inside PGlite, and to draw a **hard scope line** so the tool stays focused on app-class schemas instead of drifting into a `pg_dump` reimplementation.

## Spike (REQUIRED before any implementation)

Before depending on any third-party library, a time-boxed spike must answer one question: **do `pg-schema-dump` and/or `pg-introspection` run against a live PGlite connection, or do they assume a `node-postgres` (`pg`) client?**

- **SP-9.0 (spike, blocking)** Stand up an in-memory `new PGlite()`, create a representative app-class schema (tables, enums, sequences, PK/UNIQUE/CHECK/FK, indexes), and attempt to drive each candidate library:
  1. **`pg-introspection`** — typed catalog introspection. Determine whether it can issue its catalog queries through `PGliteLike.query` (or a thin shim) or whether it hard-requires a `pg.Client`/pool connection object and `pg`-specific result shapes.
  2. **`pg-schema-dump`** — emits `CREATE` SQL. Same question: does it accept an arbitrary query runner, or is it coupled to a `node-postgres` client/connection string?
- **Decision rule:** adopt a library **only** if it runs against `PGliteLike` (directly or via a trivial adapter) **and** its output respects our scope boundary (or can be filtered to it). If both libraries assume a `pg` client, **hand-roll** the reconstruction with direct catalog SQL plus the `pg_get_*def` functions (the approach below is written to stand on its own without either library). Record the spike outcome in this doc's Open Questions and in PGLM-3.
- The hand-rolled path is the **expected fallback** and the safe default — it reuses the exact catalog-SQL style already proven in `src/introspect.ts` and depends on nothing but PGlite's own functions.

## Requirements

- **FR-9.1** Provide a standalone reconstruction step that, given a source `PGliteLike` and an empty target `PGliteLike`, creates the source's **app-class** schema on the target before data transfer. New module: `src/reconstruct.ts`, primary export `reconstructSchema(source, target, options?) => ReconstructionReport`.
- **FR-9.2** Reconstruct DDL using PostgreSQL's own DDL-emitting functions, which run **inside** PGlite (no `pg_dump` binary — PGlite does not ship one):
  - `pg_get_constraintdef(oid[, pretty])` — PK / FK / UNIQUE / CHECK definitions.
  - `pg_get_indexdef(oid)` — index definitions (excluding indexes that back a constraint, which `pg_get_constraintdef` already emits).
  - `pg_get_expr(adbin, adrelid)` — column defaults, including `nextval(...)` for serial/identity-style columns.
  - `format_type(atttypid, atttypmod)` — column types (already used by `introspectSchema`).
- **FR-9.3** Create objects on the target in strict dependency order (see Design): **types/enums → sequences → tables (columns + defaults) → constraints → indexes**.
- **FR-9.4** Reconstruct custom types — at minimum **enums** (`CREATE TYPE … AS ENUM (…)`, label order preserved) and **composite/domain** types if trivially emittable; anything beyond app-class custom types falls under FR-9.6 reporting.
- **FR-9.5** Reconstruct sequences with their defining parameters (start/increment/min/max/cycle) and re-establish column default `nextval` links and identity ownership so the existing sequence realignment in `applySequences` (`src/transfer.ts`) works unchanged after data load.
- **FR-9.6 (hard requirement — never silently drop)** Any object outside the scope boundary that exists in the source **must be detected and reported** as unsupported in the `ReconstructionReport` (and surfaced by the CLI). It must **never** be silently omitted. See NG-9.10.
- **FR-9.7** Reconstruction must be **idempotent-safe against a fresh target** and fail loudly (not partially) if the target is non-empty in a conflicting way; it must not attempt to mutate or drop pre-existing user objects on the target.
- **FR-9.8** All identifiers spliced into emitted DDL go through the quoting helpers in `src/ident.ts` (catalog names are trusted but can still need quoting), per project convention. DDL text returned by `pg_get_*def` is already correctly quoted by Postgres and is used verbatim.
- **NFR-9.9** Reconstruction queries must be **version-agnostic** in the same sense as `introspectSchema`: rely only on stable catalog relations and the `pg_get_*def`/`format_type` functions, which are present across all supported majors. No major-specific catalog columns without a documented fallback.
- **NG-9.10 (out of scope — detect and report only)** Full `pg_dump` parity is explicitly out: **views, materialized views, functions/procedures, triggers, RLS policies, partitioning, operator classes, collations beyond defaults, comments, grants/ownership/ACLs, extensions, foreign tables, rules**. If the source uses any of these, report them as unsupported (FR-9.6); do not attempt to reconstruct them.
- **NG-9.11** Standalone mode does **not** introduce a second data-transfer path. Once the schema exists, data is moved by the **existing** transfer (`transferTable`/`applySequences` via `migrate`). This spec only adds the schema-building front half.

## Design / Approach

### Object types (what is reconstructed)

In scope — the "app-class" set, matching **NFR-3.4**:

| Object | Source of truth | Emitter |
| --- | --- | --- |
| Tables + columns | `pg_class` (`relkind='r'`), `pg_attribute` | direct SQL + `format_type` |
| Column defaults | `pg_attrdef` | `pg_get_expr(adbin, adrelid)` |
| Custom enums (and trivial composite/domain) | `pg_type` / `pg_enum` | direct SQL (`CREATE TYPE … AS ENUM`) |
| Sequences | `pg_sequences` / `pg_sequence` | direct SQL (`CREATE SEQUENCE …`) + ownership link |
| PK / UNIQUE / CHECK / FK constraints | `pg_constraint` | `pg_get_constraintdef(oid)` |
| Indexes (non-constraint-backed) | `pg_index` / `pg_class` | `pg_get_indexdef(oid)` |

The existing `introspectSchema` (`src/introspect.ts`) already extracts tables, columns (via `format_type`), foreign keys, and sequences; reconstruction **extends** this catalog-reading layer rather than duplicating it (see Interaction below).

### Ordering (creation sequence)

Dependencies force a strict order; emit each phase fully before the next:

1. **Types / enums** — must exist before any column references them.
2. **Sequences** — must exist before a column default `nextval('…')` or identity references them. (Ownership re-link may need to wait until the owning table exists; if so, set `OWNED BY` after step 3.)
3. **Tables (columns + inline defaults)** — create tables with columns and `format_type` types; attach column defaults via `pg_get_expr`. **Do not** inline FK/CHECK here.
4. **Constraints** — apply PK, UNIQUE, CHECK, then FK via `ALTER TABLE … ADD CONSTRAINT …` using `pg_get_constraintdef`. Deferring FKs to a separate pass (rather than inline) lets all tables exist first, sidestepping ordering for mutual references and reusing the cycle-tolerant philosophy already in `topologicalSort`.
5. **Indexes** — create non-constraint-backed indexes via `pg_get_indexdef`. Skip indexes that implement a constraint already created in step 4 (filter `pg_index.indisprimary`/`indisunique` rows whose `pg_class` is owned by a `pg_constraint`).

This is the order named in **FR-3.3**, expanded with the FK-deferral and constraint-backed-index detail.

### Unsupported-object detection + reporting

A dedicated detector (e.g. `detectUnsupported(source) => UnsupportedObject[]`) runs **before** emitting DDL and enumerates every out-of-scope object class (NG-9.10) present in the source:

- views/matviews (`pg_class.relkind in ('v','m')`), functions/procedures (`pg_proc`, excluding built-ins), triggers (`pg_trigger`, non-internal), RLS policies (`pg_policy`), partitioned tables/children (`pg_class.relkind in ('p')` / `pg_inherits`), operator classes, non-default collations, comments (`pg_description`), grants/ownership (`pg_class.relacl`), extensions (`pg_extension`, excluding always-present ones), foreign tables, rules (`pg_rewrite`, excluding the implicit `_RETURN` of views).

Each detected object becomes an `UnsupportedObject { kind, schema, name, detail }` entry in the `ReconstructionReport`. The CLI prints these prominently (see CLI integration). Per **FR-9.6** they are never dropped silently. An option (`onUnsupported: 'warn' | 'error'`, default `'warn'`) controls whether their presence is fatal — recommended default is `'warn'` so a schema that merely *has* a view but whose **data** is all app-class still migrates, with the operator clearly told what was not reconstructed.

### Report shape

`ReconstructionReport` (declared in `src/types.ts`, the SSOT for shapes) should carry at least: `typesCreated`, `sequencesCreated`, `tablesCreated`, `constraintsCreated`, `indexesCreated`, and `unsupported: UnsupportedObject[]`, plus `warnings: string[]`. This composes naturally into `MigrationReport`.

## Interaction with existing code

- **`src/introspect.ts`** — `introspectSchema` is the existing catalog-reading layer (tables, columns, FKs, sequences) and uses the exact SQL style and `SYSTEM_SCHEMA_FILTER` to reuse. Reconstruction adds the missing reads (enum labels, constraint defs, index defs, attrdef expressions) either by extending `SchemaInfo` or in a sibling `src/reconstruct.ts`. Reuse `SYSTEM_SCHEMA_FILTER` and the explicit-join pattern from `introspectForeignKeys` (which deliberately avoids search-path-sensitive `regclass::text`).
- **`src/transfer.ts`** — unchanged. After reconstruction, `topologicalSort` orders inserts and `transferTable` copies rows exactly as in the app-driven path; `applySequences` realigns sequences (FR-9.5 ensures the sequences and their ownership exist for it to target).
- **`src/migrate.ts`** — gains an opt-in step. Recommended shape: a `reconstructSchema?: boolean` (or `mode: 'app-driven' | 'standalone'`) field on `MigrateOptions`. When set, `migrate` calls `reconstructSchema(source, target, …)` **first**, merges its `ReconstructionReport` (especially `unsupported`/`warnings`) into the returned `MigrationReport`, then proceeds into the existing introspect → sort → transfer → sequences flow untouched. Default stays app-driven so v1 behavior is unchanged.
- **`src/ident.ts`** — reused for all identifier quoting in any hand-emitted DDL (FR-9.8).
- **`src/types.ts`** — add `ReconstructionReport`, `UnsupportedObject`, and the new `MigrateOptions` field; extend `MigrationReport` to surface reconstruction results.

## CLI integration

This lifts **NG-4.7** in [`4-cli.md`](./4-cli.md) (the "target schema must already exist" limitation).

- **FR-9.12** Add a flag to `src/cli.ts` enabling standalone reconstruction, e.g. `--reconstruct-schema` (alias `--standalone`). When passed, the CLI reconstructs the source's app-class schema on the (expected-empty) target before transferring data.
- **FR-9.13** Without the flag, behavior is unchanged (app-driven; fails on the first insert against an empty target, as documented). The flag is the explicit opt-in into DDL-on-target.
- **FR-9.14** When reconstruction runs, the CLI must print the **unsupported-object report** to stderr prominently (count + per-object `kind schema.name`), consistent with FR-4.5 progress/warning output, so the operator knows exactly what was not reconstructed before any data lands.
- **FR-9.15** Respect `--source-engine`/`--target-engine` (FR-4.2) so reconstruction and transfer both run across two distinct engines once a second major is wired (relates to NG-4.8).
- Update **NG-4.7** in `4-cli.md` to "lifted by `9-standalone-schema-reconstruction.md`" when this ships.

## Acceptance

- Pointing the CLI at an old-major source and a **fresh empty** target with `--reconstruct-schema` produces a target that has the source's tables, columns, custom enums, sequences, PK/UNIQUE/CHECK/FK constraints, and indexes, and then all rows transfer in FK-safe order with sequences realigned (i.e. the existing acceptance for `4-cli.md` now passes against an empty target).
- A source containing an out-of-scope object (e.g. a view or trigger) migrates its app-class data and **reports** that object as unsupported; the object is never silently dropped, and with `onUnsupported: 'error'` the run fails before touching the target.
- `reconstructSchema` against an in-memory PGlite reproduces a known schema such that `introspectSchema(target)` equals `introspectSchema(source)` for the app-class subset.
- Default (no flag / `mode: 'app-driven'`) behavior of `migrate` and the CLI is byte-for-byte unchanged from v1.

## Testing requirements

Following [`6-testing.md`](./6-testing.md)'s double-coverage philosophy (pure logic gets unit tests; anything touching a real cluster is proven end to end; no DB mocking):

- **Unit** (`tests/`, `vitest.config.ts`):
  - Pure DDL-assembly helpers where extractable (e.g. enum `CREATE TYPE` text builder, the constraint-backed-index filter, the FK-deferral ordering) tested directly.
  - `detectUnsupported` against an in-memory `new PGlite()` seeded with one of each out-of-scope object class — assert each is reported with correct `kind`/`schema`/`name`.
  - `reconstructSchema` against an in-memory PGlite: reconstruct a known app-class schema and assert `introspectSchema(target)` matches the source for tables/columns/FKs/sequences (the introspection round-trip), plus constraint/index presence checks via catalog queries.
- **E2E** (`tests/e2e/`, `vitest.e2e.config.ts`) — the two-version round-trip. **The paired e2e is ticket PGLM-18.** It must: start from a **bare** new-major target (no schema), run reconstruct-then-migrate across the `pglite-old`/`pglite-new` aliases, and assert the same properties the existing round-trip asserts (all rows copied, FK order respected, `timestamptz` preserved, sequences realigned) **plus** that constraints/indexes/enums exist on the target. Do **not** collapse the two aliases (NFR-6.3).
- Add a line to `6-testing.md`'s "Gaps to add" turning "Standalone schema-reconstruction e2e once that mode exists" into a satisfied item when PGLM-18 lands.

## Open Questions

- **OQ-9.1 — Spike outcome (libraries vs hand-rolled).** Does `pg-schema-dump`/`pg-introspection` run against `PGliteLike`? *Recommended default until SP-9.0 says otherwise:* assume **hand-rolled** with `pg_get_*def`, since both libraries are built around `node-postgres` clients and the hand-rolled path reuses our proven catalog-SQL style and adds zero runtime deps.
- **OQ-9.2 — `onUnsupported` default.** Fatal or warn-and-continue when an out-of-scope object is present? *Recommended:* default `'warn'` (still migrate app-class data), with `'error'` opt-in for strict environments. Never silent (FR-9.6).
- **OQ-9.3 — Options surface.** Boolean `reconstructSchema` vs a `mode: 'app-driven' | 'standalone'` enum on `MigrateOptions`? *Recommended:* `mode` enum — clearer intent and room for future modes; CLI flag `--reconstruct-schema`/`--standalone` maps onto it.
- **OQ-9.4 — Identity vs serial columns.** Reproduce `GENERATED … AS IDENTITY` faithfully, or normalize all auto-increment to `serial`-style `nextval` defaults? *Recommended:* preserve identity where the source uses it (it round-trips through `pg_get_*`), falling back to `nextval` defaults only if a major lacks the needed catalog support.
- **OQ-9.5 — Composite/domain types.** In scope as "custom types," or report-only beyond enums? *Recommended:* enums are firmly in; emit composite/domain only if trivially derivable, otherwise treat as unsupported-and-reported to keep the scope line crisp.
- **OQ-9.6 — Cross-schema scope.** Reconstruct every non-system schema, or only `public` / a caller-selected set? *Recommended:* mirror `introspectSchema` (all non-system schemas via `SYSTEM_SCHEMA_FILTER`), and create the schemas themselves (`CREATE SCHEMA IF NOT EXISTS`) as a pre-phase.

## Follow-up tickets

- **PGLM-3** (this doc) — standalone schema reconstruction, parent.
- **PGLM-18** — the paired standalone-reconstruction **e2e** (bare-target round-trip), per the Testing section.
- File on completion of the spike: an implementation ticket for the reconstruction engine, one for the unsupported-object detector/reporter, and one for the CLI flag wiring — split per the recommended-tickets list in the PGLM-3 thread.
- Relates to **NG-4.8** (verified cross-major engine loading) — standalone mode is the first flow that exercises DDL across two engines.
