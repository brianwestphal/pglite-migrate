# pglite-migrate

Migrate [PGlite](https://github.com/electric-sql/pglite) data across PostgreSQL **major** versions (e.g. PG17 → PG18) — without native binaries or `pg_upgrade`.

PGlite is PostgreSQL compiled to WASM. Its data directory is a real PostgreSQL cluster, so when PGlite bumps the underlying Postgres major, an existing data directory can no longer be opened by the new engine. Native Postgres fixes this with `pg_upgrade`, but that needs native server binaries of *both* majors — which an embedded WASM database doesn't have.

`pglite-migrate` takes the **logical** route: it runs two PGlite engines side by side — the old engine on the source data, the new engine on the target — and transfers data between them at the SQL level. The on-disk format never has to be understood. No native binaries, no `pg_upgrade`.

```
   ┌─────────────────┐        introspect → topo-sort        ┌─────────────────┐
   │  old PGlite (PG17) │ ───────  COPY (text)  ───────────▶ │  new PGlite (PG18) │
   │  source data dir   │ ◀─ refuses to open across majors   │  target data dir   │
   └─────────────────┘        realign sequences · validate  └─────────────────┘
```

## Why you'd want this

A PG18 PGlite engine **physically cannot open** a PG17 data directory — that's the failure this library exists to bridge (and the e2e suite proves it on disk). `pglite-migrate` is the connective tissue for the PGlite, data-directory, cross-major case that the ecosystem doesn't otherwise cover.

- **Genuinely cross-major.** The test matrix runs a real **PG17 → PG18** migration (PGlite `0.4.x` → `0.5.x`), not a same-version round-trip.
- **App-driven or standalone.** Let your app create the target schema and just copy the data, *or* have pglite-migrate **reconstruct the app-class schema** (tables, columns, sequences, enums, PK/FK/unique/check, indexes) from the source when there's no host app.
- **Fidelity-first transfer.** Rows move via PostgreSQL **`COPY` (text format)** with a per-table `INSERT` fallback, preserving `json`/`jsonb`, `numeric`, `bytea`, arrays and `timestamptz` exactly. Sequences are realigned with `setval` so the next inserted id is correct.
- **Handles the hard cases.** Foreign keys are topologically ordered so parents load before children, and **FK cycles** transfer correctly inside a deferred-constraint transaction.
- **Safe by construction.** Optional source **backup**, a **dry-run** that provably writes nothing, post-migration **validation** (row-count parity, sequence consistency, or full content digests), **idempotent re-runs** (`error` / `truncate` / `skip`), and an atomic write-new-then-rename **swap** primitive.

## Install

```bash
npm install pglite-migrate @electric-sql/pglite
```

`@electric-sql/pglite` is a peer dependency — your app supplies the engine version(s). To open two majors at once, install both under npm aliases:

```bash
npm install pglite-old@npm:@electric-sql/pglite@0.4.3   # PG17
npm install pglite-new@npm:@electric-sql/pglite@0.5.3   # PG18
```

## Quick start (library, app-driven)

The recommended path. Your app already knows how to create its own schema, so let it: create the schema on the new engine, then transfer the data.

```ts
import { migrate } from 'pglite-migrate';
import { PGlite as PGliteOld } from 'pglite-old'; // npm alias of the old version (PG17)
import { PGlite as PGliteNew } from 'pglite-new'; // npm alias of the new version (PG18)

const source = new PGliteOld('/path/to/old-data');
const target = new PGliteNew('/path/to/new-data');
await createSchema(target);        // your app's normal startup migrations

const report = await migrate({ source, target });   // validates row counts by default
console.log(`${report.totalRows} rows across ${report.tables.length} tables`);
```

No host app? Let pglite-migrate rebuild the schema from the source first:

```ts
const report = await migrate({ source, target, reconstructSchema: true });
// Out-of-scope objects (views, triggers, functions, RLS, partitioning) are
// reported in report.reconstruction.unsupported, never silently dropped.
```

The core never imports `@electric-sql/pglite` directly — it speaks to a minimal `PGliteLike` interface, which is exactly what lets you hand it two different majors at once.

## CLI

```bash
pglite-migrate <source-data-dir> <target-data-dir> [options]
```

| Option | Description |
| --- | --- |
| `--source-engine <pkg>` / `--target-engine <pkg>` | npm module/alias for each engine (default `@electric-sql/pglite`) |
| `--validate <level>` | Post-migration check: `off` \| `counts` \| `full` (default `counts`) |
| `--on-existing <mode>` | Non-empty target: `error` \| `truncate` \| `skip` (default `error`) |
| `--reconstruct-schema` | Rebuild the source's app-class schema on an empty target first |
| `--dry-run` | Report the plan without writing anything |
| `--backup` / `--backup-dir <path>` | Back up the source data dir before migrating |

## Demos

Captured verbatim from the real CLI against a live **PG17 → PG18** pair. Regenerate them any time with `npm run demo`.

### App-driven migration (PG17 → PG18)

```console
$ pglite-migrate ./data-pg17 ./data-pg18 \
    --source-engine pglite-old --target-engine pglite-new
Migrating ./data-pg17 (PG 17) -> ./data-pg18 (PG 18)
  public.authors: 3 rows
  public.books: 5 rows
Done: 8 rows across 2 tables, 2 sequences aligned.
Validation (counts): OK.
```

### Dry run — preview the plan, write nothing

```console
$ pglite-migrate ./data-pg17 ./data-pg18 --dry-run \
    --source-engine pglite-old --target-engine pglite-new
Migrating ./data-pg17 (PG 17) -> ./data-pg18 (PG 18)
DRY RUN — no changes will be written to the target.
  public.authors: 3 rows
  public.books: 5 rows
Plan: 8 rows across 2 tables, 2 sequences aligned.
```

### Standalone — rebuild the schema, then migrate

```console
$ pglite-migrate ./data-pg17 ./data-pg18 --reconstruct-schema \
    --source-engine pglite-old --target-engine pglite-new
Migrating ./data-pg17 (PG 17) -> ./data-pg18 (PG 18)
  public.authors: 3 rows
  public.books: 5 rows
Done: 8 rows across 2 tables, 2 sequences aligned.
Validation (counts): OK.
```

### Safety — back up the source and validate every row

```console
$ pglite-migrate ./data-pg17 ./data-pg18 --backup --validate full \
    --source-engine pglite-old --target-engine pglite-new
Migrating ./data-pg17 (PG 17) -> ./data-pg18 (PG 18)
Backed up source to ./data-pg17.bak
  public.authors: 3 rows
  public.books: 5 rows
Done: 8 rows across 2 tables, 2 sequences aligned.
Validation (full): OK.
```

## Scope

**In scope — app-class schemas:** tables, columns (including generated/identity), sequences, enums, primary/foreign/unique/check constraints, and indexes; data fidelity for the common types.

**Out of scope — full `pg_dump` parity:** views, materialized views, triggers, functions, RLS policies, and partitioning. During standalone reconstruction these are **detected and reported**, never silently dropped.

## How it compares

| Need | Tool |
| --- | --- |
| Migrate a *native* Postgres cluster, files in place | `pg_upgrade` (+ portable binaries via `embedded-postgres` / `zonkyio/embedded-postgres-binaries`) |
| Pure-JS schema introspection | [`pg-introspection`](https://www.npmjs.com/package/pg-introspection) |
| Pure-JS schema dump (DDL) | [`pg-schema-dump`](https://github.com/seveibar/pg-schema-dump) |
| **Migrate *PGlite* data across a major version** | **this package** |

## Documentation

Full requirements and design specs live in [`docs/`](./docs) (numbered for linear reading). Start with [`docs/1-overview.md`](./docs/1-overview.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); the per-feature specs (COPY-text transfer, FK cycles, standalone reconstruction, backup, atomic swap, dry-run, validation, idempotence) are docs 7–14.

## License

MIT
