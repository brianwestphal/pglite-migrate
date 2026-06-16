---
name: check-code-hygiene
description: Check code for standardization, readability, maintenance complexity, and defensive coding
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Review the source for hygiene issues: standardization, readability, maintenance complexity, and defensive coding. This is a quality review, not a bug hunt — focus on consistency and maintainability.

## Process

1. **Standardization** — scan `src/` and `tests/` for inconsistencies:
   - Mixed import styles or missing `.js` extensions on relative imports
   - Inconsistent error handling (thrown `Error` vs returned nulls) across modules
   - Naming that drifts from the established vocabulary (`source`/`target`, `schema`/`table`, `PGliteLike`)
   - British vs American spelling (American required)

2. **Readability** — flag functions doing too much, unclear names, missing TSDoc on exported API, and SQL strings that would read better split or commented. Each `src/` file should have one primary export.

3. **Maintenance complexity** — identify files growing too long or mixing concerns (candidates to split into sub-modules), and duplicated logic that should be shared (e.g. identifier quoting, qualified-name construction).

4. **Defensive coding** — check trust boundaries:
   - Catalog/row data typed via interfaces, not blind `as` casts (the only sanctioned cast is `PGlite` → `PGliteLike` in tests)
   - SQL identifiers always quoted via `src/ident.ts`
   - The core never imports `@electric-sql/pglite` directly (structural `PGliteLike` only)
   - Unparseable/missing inputs (e.g. `PG_VERSION`) fail loudly with a clear message
   - No unhandled promise rejections; async errors surface

5. **Report** findings grouped by category (Standardization / Readability / Maintenance / Defensive), each with file:line and a concrete suggested fix. Lead with the highest-impact items. If a category is clean, say so in one line.
