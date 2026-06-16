# 6 — Testing

## Structure

- **Unit** (`tests/*.test.ts`, `vitest.config.ts`) — fast, isolated. Pure logic (`topologicalSort`, `readClusterVersion`) needs no cluster. Module-level behavior that genuinely requires a cluster (introspection) uses a single in-memory `new PGlite()`.
- **E2E** (`tests/e2e/*.test.ts`, `vitest.e2e.config.ts`) — the two-version round-trip. Loads two independently-resolved PGlite engines and migrates real data between them.

## The npm-alias matrix

The e2e harness loads two engines via aliases declared in `package.json`:

```jsonc
"pglite-old": "npm:@electric-sql/pglite@0.5.2",
"pglite-new": "npm:@electric-sql/pglite@0.5.2"   // bump to the next major's build when it ships
```

- **FR-6.1** Today both aliases resolve to the same version, so the suite proves the pipeline as a **same-major round-trip** (`new PGliteOld()` → migrate → `new PGliteNew()`).
- **FR-6.2** When PGlite ships a build on the next Postgres major, bump **only** the `pglite-new` alias; the identical suite becomes a genuine cross-major test with no other change.
- **NFR-6.3** Do not collapse the two aliases into one shared import — the two-distinct-engine shape is the property under test.

## Philosophy (see CLAUDE.md)

- **Double coverage** — pure logic gets focused unit tests; anything touching a real cluster is proven end to end.
- **No DB mocking** — there is no meaningful mock for catalog SQL or row transfer; the interaction with a real PGlite *is* the system under test.
- **Every new capability** gets a unit test for its logic (where extractable) plus an e2e assertion that a real migration produces the right rows/sequences/constraints.

## What the e2e currently asserts

- All rows copied, in FK-safe order, with no constraint violation.
- `timestamptz` values preserved.
- Sequences realigned so a post-migration insert receives an id past the migrated maximum.

## Gaps to add as the library grows

- Fidelity cases for `json`/`jsonb`, `numeric`, `bytea`, arrays (will harden once the COPY-text path lands — `2-data-migration.md`).
- FK-cycle handling once deferred constraints are implemented (`5-safety-and-rollback.md`).
- Standalone schema-reconstruction e2e once that mode exists (`3-schema-reconstruction.md`).
- A true cross-major run once a second Postgres major is available as a PGlite build.

## Commands

```bash
npm run test        # unit + coverage
npm run test:e2e    # two-version round-trip
npm run test:all    # both
```
