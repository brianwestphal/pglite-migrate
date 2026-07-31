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

## Test-directory hygiene

Twelve test files materialize a real data directory under the OS temp dir. They all go through `tests/tempdir.ts` — `makeTempDir(prefix)` / `removeTempDir(dir)` — rather than calling `mkdtemp`/`rm` directly, for one specific reason (PGLM-93).

- **`removeTempDir` retries and never throws.** When a test times out, vitest runs `afterEach` while the test's own async work is still in flight, so a PGlite instance may still be writing into the directory being removed. `rm` then walks a tree that repopulates underneath it and throws `ENOTEMPTY`. The result was that a timeout surfaced *twice* — once as the genuine `Test timed out in 30000ms`, and again as an `ENOTEMPTY` from teardown that buried it. Node's `rm` retries exactly this error class when given `maxRetries`, and anything surviving that is swallowed: cleanup says nothing about the system under test, so it must never be what fails a test.
- The one `rm` that is deliberately **not** routed through the helper is in `tests/engines/acquire.test.ts` — deleting a cache entry there is a test *action* (proving re-download), not cleanup, so it must stay strict.

> **Running two full suites concurrently is not supported.** Both write `coverage/.tmp` (`reportsDirectory: 'coverage'` is a fixed path), so they delete each other's temp coverage files and fail with an unrelated `ENOENT`. Use `--coverage.enabled=false` on one of them if you ever need to.

## Philosophy (see CLAUDE.md)

- **Double coverage** — pure logic gets focused unit tests; anything touching a real cluster is proven end to end.
- **No DB mocking** — there is no meaningful mock for catalog SQL or row transfer; the interaction with a real PGlite *is* the system under test.
- **Every new capability** gets a unit test for its logic (where extractable) plus an e2e assertion that a real migration produces the right rows/sequences/constraints.

## What the e2e currently asserts

- All rows copied, in FK-safe order, with no constraint violation (`roundtrip.test.ts`).
- `timestamptz` values preserved; `json` source text preserved verbatim, plus `jsonb`/`numeric`/`bytea`/array fidelity across the two majors (`fidelity.test.ts`).
- Sequences realigned so a post-migration insert receives an id past the migrated maximum.
- A populated FK cycle transfers with no violation and leaves the target's constraints in their original deferrability (`fk-cycle.test.ts`).
- A bare target reconstructed from the source, then loaded (`standalone.test.ts`).
- A PG18 engine genuinely refusing a PG17 data directory, and the actionable precheck error that replaces PGlite's opaque failure (`cross-major.test.ts`, `engine-mismatch.test.ts`).
- A migration whose source engine is downloaded rather than installed (`acquired-engine.test.ts`, network-gated).

## Gaps to add as the library grows

- ~~Fidelity cases for `json`/`jsonb`, `numeric`, `bytea`, arrays.~~ **Done (PGLM-22)** — `fidelity.test.ts` compares each column's `::text` rendering across the two engines; COPY-text closed the one real gap (plain `json` whitespace).
- ~~FK-cycle handling once deferred constraints are implemented.~~ **Done (PGLM-23)** — `fk-cycle.test.ts`, including the `NOT DEFERRABLE` variant.
- ~~Standalone schema-reconstruction e2e once that mode exists.~~ **Done (PGLM-25/PGLM-18)** — `standalone.test.ts`.
- ~~A true cross-major run once a second Postgres major is available as a PGlite build.~~ **Done (PGLM-19)** — the aliases resolve to PG17 (0.4.3) and PG18 (0.5.3); the whole suite is cross-major and `cross-major.test.ts` proves the new-engine-refuses-old-dir failure on disk.
- ~~A migration whose source engine is acquired rather than installed.~~ **Done (PGLM-67)** — `acquired-engine.test.ts`, network-gated per NFR-6.4.
- **Still open:** fidelity coverage for the unconfirmed at-risk types listed in [`7-copy-text-transfer.md`](7-copy-text-transfer.md) (`xml`, `money`, ranges, composite/domain types, `tsvector`); a standalone-reconstruction case over a **multi-schema** source; and an end-to-end backup → migrate → validate → `swapIntoPlace` composition once the CLI orchestrates it ([`11-atomic-swap.md`](11-atomic-swap.md)).

## Commands

```bash
npm run test        # unit + coverage
npm run test:e2e    # two-version round-trip
npm run test:all    # both
```
