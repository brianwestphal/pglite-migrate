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

### 3. Check for documented anti-patterns

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

### 4. Generate the report

Present:
- **Automated check results** — tests passed/failed, lint errors/warnings, type errors, e2e passed/failed
- **Coverage gaps** — files below 50% (table), missing unit/e2e pairing
- **Anti-pattern violations** — file:line, convention violated, suggested fix (group similar issues)
- **Quality metrics summary** — pass rate, line coverage %, lint error count, violation count, overall assessment (good / needs attention / critical)

Be concise; group similar issues rather than listing every instance.
