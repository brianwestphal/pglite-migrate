# 6 — Testing

## Structure

- **Unit** (`tests/*.test.ts`, `vitest.config.ts`) — fast, isolated. Pure logic (`topologicalSort`, `readClusterVersion`) needs no cluster. Module-level behavior that genuinely requires a cluster (introspection) uses a single in-memory `new PGlite()`.
- **E2E** (`tests/e2e/*.test.ts`, `vitest.e2e.config.ts`) — the two-version round-trip. Loads two independently-resolved PGlite engines, on **two different Postgres majors**, and migrates real data between them.

## The npm-alias matrix

The e2e harness loads two engines via aliases declared in `package.json`:

```jsonc
"pglite-old": "npm:@electric-sql/pglite@0.4.3",  // PG17
"pglite-new": "npm:@electric-sql/pglite@0.5.3"   // PG18
```

PGlite's bundled Postgres major tracks its minor line: `0.4.x` → **PG17**, `0.5.x` → **PG18** (`0.3.x` was PG17, `0.2.x` PG16). Pointing the two aliases at 0.4.x and 0.5.x makes the suite a real cross-major migration.

- **FR-6.1 / FR-6.2** The aliases resolve to **two different majors**, so the suite is a **genuine cross-major run** (`new PGliteOld()` is PG17 → migrate → `new PGliteNew()` is PG18), not just a same-major round-trip. This is now satisfied (PGLM-19), no longer pending a second build. When a future PGlite ships PG19, bump **only** `pglite-new`; the identical suite re-targets the new pair with no other change.
- **NFR-6.3** Do not collapse the two aliases into one shared import — the two-distinct-engine, two-major shape is the property under test.
- **`tests/e2e/cross-major.test.ts`** materializes a real PG17 cluster on disk and asserts that (a) the new (PG18) engine genuinely **refuses** to open it — the motivating failure, coordinated with PGLM-9 — and (b) `migrate` copies the data into a PG18 target whose schema the host app created up front. The cross-major assertions self-gate on the engines actually differing, so the suite stays green even if the aliases are temporarily aligned.

### The one network-dependent suite

`tests/e2e/acquired-engine.test.ts` (engine acquisition — [`15-engine-acquisition.md`](15-engine-acquisition.md)) is the **only** suite in the repo that needs network access. It materializes a PG17 directory with `pglite-old` but deliberately does *not* use that alias as the migration's source engine: the specifier is unresolvable, forcing a real download-verify-extract-import before any data moves.

- **NFR-6.4** It self-gates on the npm registry being reachable (a `HEAD` with a 10 s timeout) and uses vitest's `ctx.skip()` when offline, so `npm run test:e2e` stays green on a disconnected machine and honestly reports **skipped** rather than passing tests that did nothing. One case — a missing engine with acquisition *off* — needs no network and runs either way.

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
- ~~A true cross-major run once a second Postgres major is available as a PGlite build.~~ **Done (PGLM-19)** — the aliases resolve to PG17 (0.4.3) and PG18 (0.5.3); the whole suite is cross-major and `cross-major.test.ts` proves the new-engine-refuses-old-dir failure on disk.
- ~~A migration whose source engine is acquired rather than installed.~~ **Done (PGLM-67)** — `acquired-engine.test.ts`, network-gated per NFR-6.4.

## Commands

```bash
npm run test        # unit + coverage
npm run test:e2e    # two-version round-trip
npm run test:all    # both
```
