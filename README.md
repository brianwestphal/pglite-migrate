# pglite-migrate

Migrate [PGlite](https://github.com/electric-sql/pglite) data across PostgreSQL **major** versions (e.g. PG17 → PG18) — without native binaries or `pg_upgrade`.

PGlite is PostgreSQL compiled to WASM. Its data directory is a real PostgreSQL cluster, so when PGlite bumps the underlying Postgres major, an existing data directory can no longer be opened by the new engine. Native Postgres fixes this with `pg_upgrade`, but that needs native server binaries of *both* majors — which an embedded WASM database doesn't have.

`pglite-migrate` takes the logical route: run two PGlite engines side by side (old engine on the source, new engine on the target) and transfer data between them at the SQL level. The on-disk format never has to be understood.

> **Status: early scaffold.** The v1 app-driven, data-only path works and is tested end to end. Standalone schema reconstruction, COPY-text fidelity, and the safety/rollback layer are specified in [`docs/`](./docs) but not yet built.

## Install

```bash
npm install pglite-migrate @electric-sql/pglite
```

`@electric-sql/pglite` is a peer dependency — your app supplies the engine version(s).

## Usage (library, app-driven)

The recommended path. Your app already knows how to create its own schema, so let it: create the schema on the new engine, then transfer the data.

```ts
import { migrate } from 'pglite-migrate';
import { PGlite as PGliteOld } from 'pglite-old'; // npm alias of the old version
import { PGlite as PGliteNew } from 'pglite-new'; // npm alias of the new version

const source = new PGliteOld('/path/to/old-data');
const target = new PGliteNew('/path/to/new-data');
await createSchema(target);        // your app's normal startup migrations

const report = await migrate({ source, target });
console.log(`${report.totalRows} rows across ${report.tables.length} tables`);
```

## Usage (CLI)

```bash
pglite-migrate <source-data-dir> <target-data-dir>
```

The CLI transfers data only and assumes the target schema already exists. Standalone schema reconstruction is planned — see [`docs/3-schema-reconstruction.md`](./docs/3-schema-reconstruction.md).

## How it compares

| Need | Tool |
| --- | --- |
| Migrate a *native* Postgres cluster, files in place | `pg_upgrade` (+ portable binaries via `embedded-postgres` / `zonkyio/embedded-postgres-binaries`) |
| Pure-JS schema introspection | [`pg-introspection`](https://www.npmjs.com/package/pg-introspection) |
| Pure-JS schema dump (DDL) | [`pg-schema-dump`](https://github.com/seveibar/pg-schema-dump) |
| **Migrate *PGlite* data across a major version** | **this package** |

## License

MIT
