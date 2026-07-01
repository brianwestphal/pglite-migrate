---
name: analyze-code-quality
description: Run all tests and linters, check for anti-patterns, generate a quality report
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the overall quality of the source code by running all available checks and looking for known anti-patterns. Generate a comprehensive quality report.

## Process

### 1. Run automated checks

```bash
npm test 2>&1            # unit tests with coverage
npm run test:e2e 2>&1    # two-version round-trip
npm run lint 2>&1        # eslint src/ tests/
npm run typecheck 2>&1   # tsc --noEmit
```

### 2. Analyze test coverage

Read the coverage output. Identify files with <50% line coverage, files with 0% coverage, and logic that has unit coverage but no e2e assertion (or vice versa). Per the testing philosophy (CLAUDE.md), pure logic should have focused unit tests and anything touching a real cluster should be proven in the e2e round-trip.

**Coverage is a floor, not a ceiling.** 100% line/branch/function/statement coverage means every line *ran* during the suite — it does **not** mean every behavior is asserted, nor that the *sequences between states* were exercised. A stateful module can sit at 100% coverage while a critical transition bug ships, because each operation was tested once from a clean initial state and the transitions between states never were. Treat full coverage as the **trigger** for the behavioral audit in step 3, not as a stopping point. Report the coverage numbers, but never conclude "well tested" from coverage alone.

### 3. Behavioral / state-transition audit

Line coverage cannot see a *missing* behavior or a *missing* transition. This step audits behavior directly.

**Identify the stateful modules.** Scan `src/` for modules that carry internal state or branch on it — heuristics:

- multiple code paths keyed on an internal mode / flag / phase (e.g. `onExisting` re-run modes in `migrate.ts`, COPY-text-first with the per-table INSERT fallback and the cyclic-subset path in `transfer.ts`);
- a lifecycle with ordered transitions (e.g. write-new → validate → rename in `swap.ts`; backup → migrate → validate → swap orchestration);
- a cache or resolver with hit/miss/fallback paths (e.g. engine/module resolution in `loader.ts`);
- anything where the *result of one call changes what the next call does* (idempotence / re-run safety).

**For each stateful module, enumerate its states and the transitions between them**, then check whether the test suite exercises the *transitions* — multi-step sequences that cross state boundaries — rather than only each operation from a clean initial state.

**Flag** any stateful module whose tests only cover single-operation-from-clean-state, and recommend an **adversarial transition-matrix test**. Concrete sequences worth trying:

- **out-of-order** — invoke steps in an order the happy path never produces (validate before write, swap before backup);
- **interleaved** — two flows overlapping (a second migrate against a dir mid-swap; a stale `.new` left by a prior run);
- **repeated** — run the same operation twice (idempotence / re-run safety, `onExisting`);
- **empty-then-refill** — operate on an empty source/target, then a populated one, then empty again;
- **failure-then-retry** — force a mid-flow failure, then re-run and assert clean recovery (no half-swapped dir, no partial rows).

Report, per stateful module, a **transition-coverage assessment**: the states, which transitions the suite already exercises, and which are untested. This assessment must flag a module whose transitions are untested **even when its line/branch coverage is 100%**.

### 4. Check for documented anti-patterns

Read `CLAUDE.md` and the requirements docs (`docs/*.md`) for conventions, then scan for violations:

- **Direct `@electric-sql/pglite` import in `src/`** (outside type-only usage) — the core must depend only on the `PGliteLike` structural interface
- **Blind `as` casts on catalog/network data** — type with an interface and read fields; the only sanctioned cast is bridging a concrete `PGlite` to `PGliteLike` in tests
- **SQL identifiers spliced without `src/ident.ts` quoting helpers**
- **Missing `.js` extension in relative imports** (ESM requirement)
- **ORM/query-builder usage** — raw SQL only
- **British spellings** — American English required throughout
- **Collapsing the `pglite-old`/`pglite-new` e2e aliases into one import** — the two-engine shape is the property under test
- **Placeholder text / TODO / FIXME without a follow-up ticket**
- **Excessively long or multi-export files** — keep one primary export per file

### 5. Generate the report

Present:
- **Automated check results** — tests passed/failed, lint errors/warnings, type errors, e2e passed/failed
- **Coverage gaps** — files below 50% (table), missing unit/e2e pairing
- **Behavioral / transition-coverage assessment** — per stateful module: its states, which transitions are exercised, which are untested (call out any at ≥100% line coverage with untested transitions), and the recommended adversarial sequences
- **Anti-pattern violations** — file:line, convention violated, suggested fix (group similar issues)
- **Quality metrics summary** — pass rate, line coverage %, lint error count, violation count, overall assessment (good / needs attention / critical)

Be concise; group similar issues rather than listing every instance.
