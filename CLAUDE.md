# pglite-migrate

## Project Overview

A small library + CLI for migrating [PGlite](https://github.com/electric-sql/pglite) data across PostgreSQL **major** versions (e.g. PG17 → PG18). PGlite is PostgreSQL compiled to WASM; its on-disk data directory is a real PGDATA cluster, so when PGlite bumps the underlying Postgres major, an existing data directory can no longer be opened by the new engine. Native Postgres solves this with `pg_upgrade`, but that requires native server binaries of both majors — a non-starter for an embedded WASM database.

`pglite-migrate` takes the **logical** route instead: it runs two PGlite engines side by side (an old-version engine on the source data, a new-version engine on the target) and transfers data between them at the SQL level, so the on-disk format never has to be understood. No native binaries, no `pg_upgrade`.

### Why this exists

The ecosystem already provides the hard pieces — portable Postgres binaries (`zonkyio/embedded-postgres-binaries` and friends) for the native-cluster case, and pure-JS catalog introspection (`pg-introspection`) and schema dumping (`pg-schema-dump`) for the logical case. What does **not** exist is the connective tissue for the PGlite, data-directory, cross-major case. That glue is this package.

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode, ESM)
- **Build**: tsup (library + CLI bundle, emits `.d.ts`)
- **Test**: vitest (unit) + vitest e2e config (two-version round-trip)
- **Lint**: ESLint flat config, `typescript-eslint` strictTypeChecked
- **Peer dep**: `@electric-sql/pglite` (never bundled — the host supplies the engine versions)

## Architecture

The core never imports `@electric-sql/pglite` directly. It speaks to a minimal structural interface, `PGliteLike` (`src/types.ts`), so a caller can hand in two **different** PGlite major versions at once. That single decision is what makes cross-major migration possible without the library pinning an engine.

### v1 scope — app-driven, data-only

The shipped path assumes the **target schema already exists** — created by the host application's own startup migrations (`CREATE TABLE …`). `pglite-migrate` then:

1. Introspects the **source** schema from the system catalogs (`src/introspect.ts`).
2. Topologically sorts tables so parents are inserted before children (`src/transfer.ts`).
3. Transfers rows table-by-table, then realigns sequences with `setval` (`src/transfer.ts`).
4. Returns a `MigrationReport` (`src/migrate.ts`).

This deliberately avoids reconstructing DDL — the single largest source of complexity (it is what makes `pg_dump` a 15k-line C program). Letting the host app own its schema deletes that problem for the common case.

### Deferred — standalone DDL reconstruction

For the no-host-app case (migrating a data directory with no application present), the target schema must be reconstructed from the source. That is **not** implemented in v1. The intended approach is to lean on Postgres's own `pg_get_*def()` functions (which run inside PGlite, so no `pg_dump` binary is needed) and/or the `pg-introspection` / `pg-schema-dump` libraries, drawing a hard line at "app-class schemas" (tables, columns, sequences, enums, PK/FK/unique/check, indexes) versus full `pg_dump` parity (views, triggers, functions, RLS policies, partitioning), which is explicitly out of scope. See `docs/3-schema-reconstruction.md`.

### Key files

- `src/index.ts` — public API barrel (the only thing consumers import).
- `src/types.ts` — `PGliteLike` structural interface + all result/option types. The SSOT for shapes.
- `src/introspect.ts` — `introspectSchema(db)`: tables, columns, foreign keys, sequences via system-catalog SQL. Version-agnostic (only stable catalog relations + `format_type`).
- `src/transfer.ts` — `topologicalSort` (pure, FK insert ordering), `transferTable` (row copy), `applySequences` (`setval`).
- `src/migrate.ts` — `migrate(options)`: the orchestrator; introspect source → sort → transfer → sequences → report.
- `src/loader.ts` — `openDataDir(dir, modulePath)`: opens a data dir with a chosen PGlite package/alias (for the CLI and cross-major engine loading).
- `src/version.ts` — `readClusterVersion(dataDir)`: reads the major version from the `PG_VERSION` file without booting the cluster.
- `src/cli.ts` — the `pglite-migrate` bin (leading shebang; esbuild preserves it).
- `src/ident.ts` — SQL identifier/literal quoting helpers.

### Documentation

All docs live in `docs/`. Requirements are numbered for linear reading (`docs/N-topic.md`) and use `FR-`/`NFR-` markers. The two AI-oriented summaries (`docs/ai/`) are the fastest way for a fresh session to orient — read them first, and keep them in sync when you change the code.

- `docs/1-overview.md` — problem statement, goals, non-goals, glossary
- `docs/2-data-migration.md` — the app-driven data-only path (the v1 core)
- `docs/3-schema-reconstruction.md` — deferred standalone/DDL-reconstruction mode (overview)
- `docs/4-cli.md` — the `pglite-migrate` bin
- `docs/5-safety-and-rollback.md` — safety umbrella: atomic swap, backups, dry-run, validation
- `docs/6-testing.md` — unit + two-version e2e harness, the npm-alias matrix
- `docs/7-copy-text-transfer.md` — detailed spec: COPY-text fidelity path (NFR-2.15)
- `docs/8-fk-cycle-deferred-constraints.md` — detailed spec: cyclic transfer via deferred constraints
- `docs/9-standalone-schema-reconstruction.md` — detailed spec: the no-host-app DDL path (expands doc 3)
- `docs/10-backup.md` — detailed spec: source-dir backup (FR-5.1)
- `docs/11-atomic-swap.md` — detailed spec: write-new-then-rename swap (FR-5.2)
- `docs/12-dry-run.md` — detailed spec: read-only plan/report (FR-5.3)
- `docs/13-post-migration-validation.md` — detailed spec: validation that gates the swap (FR-5.4)
- `docs/14-idempotence.md` — detailed spec: re-run safety (FR-5.6)
- `docs/ARCHITECTURE.md` — components and data flow
- `docs/ai/code-summary.md` — codebase map + "where do I look to…" index
- `docs/ai/requirements-summary.md` — synthesized requirements view with status markers

Docs 7–14 are **detailed, design-only specs** for deferred capabilities; docs 1–6 remain the high-level overview. Keep both in sync when implementing.

**When making changes, keep docs in sync** — update the relevant requirements doc and both AI summaries in the same pass.

## Build & Test

```bash
npm run build       # tsup -> dist/index.js + dist/cli.js (+ .d.ts)
npm run test        # unit tests with coverage (vitest)
npm run test:e2e    # two-version round-trip (vitest.e2e.config.ts)
npm run test:all    # unit + e2e
npm run lint        # eslint src/ tests/
npm run typecheck   # tsc --noEmit
npm run demo        # build + render the animated terminal demos -> assets/demos/*.svg
npm run diagram     # render the README architecture diagram -> assets/diagram.svg
npm run commit-message  # draft a Conventional Commit message from staged changes (gitgist)
```

Both the release-notes draft and `commit-message` are generated by [`gitgist`](https://github.com/brianwestphal/gitgist) (a dev dependency). It auto-selects an AI provider — the signed-in `claude` CLI, then the Anthropic API (`ANTHROPIC_API_KEY`), then on-device Apple models — so neither flow pins a provider. Stage your changes, then `npm run commit-message` for a draft commit subject/body.

The README's "Demos" section embeds **animated terminal SVGs** under `assets/demos/`, generated by `npm run demo`: it runs the real CLI against a live PG17 → PG18 pair and renders each transcript into a title card + terminal clip with [`domotion-svg`](https://www.npmjs.com/package/domotion-svg) (a dev dependency; it drives headless Chromium via Playwright). The output text in each clip is the **verbatim** CLI transcript, so re-run `npm run demo` whenever CLI output changes. The architecture diagram (`assets/diagram.svg`) is authored as HTML/CSS in `scripts/diagram.mjs` and captured the same way — re-run `npm run diagram` after editing it. Terminal HTML scaffolding lives in `scripts/lib/terminal.mjs`.

## CI & Release

- **CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`: unit tests (Node 20 + 22 matrix), the cross-major e2e (PG17 → PG18), lint, typecheck, and `build` + `npm pack --dry-run`.
- **Release** is tag-driven. `npm run release` (interactive, `scripts/release.sh`) bumps the version, drafts the release notes with `gitgist` (commits since the last tag → user-facing notes; the draft opens in `$EDITOR` for review), updates `CHANGELOG.md`, runs the local gate (typecheck/lint/test/e2e/build), commits `release: v{ver}`, and pushes an annotated `v{ver}` tag. `npm run release:beta` is tag-only (no version bump/commit) and pushes `v{ver}-beta.{N}`.
- **Publish** (`.github/workflows/release.yml`) triggers on those tags: it re-validates, creates a GitHub Release (stable → `latest`; beta → `prerelease`), and publishes to npm via OIDC trusted publishing (`--provenance`). A stable tag publishes to `latest`; a `-beta.N` tag publishes to `--tag beta`. Requires an `npm-publish` GitHub environment and an npm trusted-publisher rule for `v*`.
- `CHANGELOG.md` keeps an `## Unreleased` section on top; release entries are inserted newest-first below it (the CI extracts the matching `## [version]` block as the GitHub Release body).

### The two-version e2e harness

`tests/e2e/` loads two independently-resolved PGlite engines via npm aliases declared in `package.json`:

```jsonc
"pglite-old": "npm:@electric-sql/pglite@0.4.3",  // PG17
"pglite-new": "npm:@electric-sql/pglite@0.5.3"   // PG18
```

The two aliases now resolve to **two different Postgres majors** — `@electric-sql/pglite@0.4.x` bundles PG17, `@0.5.x` bundles PG18 — so the e2e suite is a **genuine cross-major run** (PG17 → PG18), not a same-major round-trip. `tests/e2e/cross-major.test.ts` additionally proves the motivating failure on disk: a PG18 engine genuinely refuses to open a PG17 data directory. **Do not** collapse the two aliases into one import — the two-engine, two-major shape is the whole point (NFR-6.3). When a future PGlite ships PG19, bump only `pglite-new` and the identical suite re-targets the new pair.

## Testing Notes

- Pure logic (e.g. `topologicalSort`, `readClusterVersion`) gets focused unit tests; anything that touches a real cluster is proven end to end against real PGlite in the e2e round-trip — unit tests alone can pass while catalog SQL is subtly wrong against a real engine.
- **No mocking the database**: there is no meaningful mock for catalog SQL or row transfer — the system under test *is* the interaction with a real PGlite. Unit tests that need a cluster use an in-memory `new PGlite()`; the e2e uses two aliased versions.
- **Every new migration capability needs both**: a pure unit test for its logic where possible, and an e2e assertion that a real migration produces the right rows/sequences/constraints.

## Code Search

### Code search (prefer ast-grep for structure)

For **structural / syntax-aware** searches over source (this codebase is TypeScript-only — `.ts`), use **ast-grep** (the `ast-grep` skill, or the CLI: `ast-grep run --lang ts -p '<pattern>' src/`) rather than text grep — it matches the AST, so it skips comments/strings and catches multi-line/nested shapes. This is the same mindset as the project's "**validate at trust boundaries, don't assert**" and "**all SQL identifiers go through `src/ident.ts`**" conventions (§ Conventions): the things worth policing are *shapes*, not strings. Good fits here: `$A as $B` and `$A as unknown as $B` casts (the only sanctioned cast is the `db as unknown as PGliteLike` test bridge — ast-grep makes every other cast visible), `JSON.parse($X) as $T`, inline `query<{ … }>()` row-type literals on `PGliteLike`, raw-SQL template literals that splice an identifier without an `src/ident.ts` quoting helper, specific call/await shapes (`db.query(...)`, `db.exec(...)`), and codemod-style rewrites. There is no `.tsx` or `.rs` here, so **always `--lang ts`**.

Keep **text search** (ripgrep / the editor's grep / the Explore agent) for what it's best at: literal strings (e.g. `FEEDBACK NEEDED`, `COPY`, SQL keywords), identifier/symbol lookups, **filenames**, and **non-code files** (the numbered `docs/*.md`, `package.json`, `CHANGELOG.md`, logs) — there AST has nothing to match and text is simpler + faster.

## Conventions

- ESM modules (`"type": "module"`); import paths use the `.js` extension (TypeScript ESM convention).
- **Validate at trust boundaries, don't assert.** Data from the catalogs/network is shaped by the query; type it with an interface and read fields, never blind-cast untrusted shapes. The one sanctioned cast is bridging a concrete `PGlite` instance to the structural `PGliteLike` in tests.
- Raw SQL only — no ORM. All identifiers spliced into SQL go through `src/ident.ts` quoting helpers (catalog names are trusted but can still need quoting).
- One primary export per file; keep files focused and short. Use sub-folders when a concern grows.
- **Always use American-English spelling** in code, comments, identifiers, messages, docs, and commit messages (`color`, `behavior`, `canceled`, `analyze`, `initialize`, `gray`).

## Git Workflow

- **Commit as needed** without asking — commit freely whenever work reaches a sensible checkpoint. (Branch first if on `main` for substantial work.)
- **Never `git push` without explicit permission.** Pushing is outward-facing; always ask first.

## Implementation Status

### Implemented since v1 (see docs 7–14 and the matching tickets)

- **COPY-text data path** — `transferTable` is COPY-text-first with a per-table INSERT fallback (`docs/7`). The only fidelity gap COPY fixed was plain `json` whitespace.
- **FK-cycle correctness** — cyclic subsets transfer with deferred constraints via `transferCycle` (`docs/8`).
- **Standalone schema reconstruction** — `reconstructSchema` / `--reconstruct-schema` rebuilds app-class DDL; out-of-scope objects are reported (`docs/9`).
- **Safety layer** — source backup (`docs/10`), `swapIntoPlace` atomic-swap primitive (`docs/11`), `--dry-run` (`docs/12`), post-migration validation (`docs/13`), and `onExisting` re-run safety (`docs/14`).
- **generated/identity column introspection**, and the **public-schema FK qualification fix** (ordering/cycles were silently broken before).
- **True cross-major run (PGLM-19)** — the aliases now resolve to two real majors (`pglite-old` = PG17 via 0.4.3, `pglite-new` = PG18 via 0.5.3). The whole e2e suite is a genuine PG17 → PG18 migration, and `tests/e2e/cross-major.test.ts` asserts on disk that a PG18 engine refuses a PG17 data dir (the motivating failure, PGLM-9). Verified against a real PGlite 0.4 (PG17) data directory.

### Remaining follow-up work (file as tickets)

- **Upsert/`ON CONFLICT` re-run strategy** — needs PK/unique introspection (`docs/14`).
- **CLI orchestration of the full backup→migrate→validate→swap on-startup-upgrade flow**, stale-`.new` cleanup, reflink backup fast-path (`docs/10`/`docs/11`).
- **Open product decisions** flagged in docs 7–14 (backup default-on, identity-vs-serial normalization, validation throw-vs-report, etc.).

<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

<!-- hotsheet:begin section=testing-philosophy v=1 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

- **Unit tests** (`tests/**/*.test.ts`, excluding `tests/e2e/`): `vitest` (config `vitest.config.ts`, globals on, 30s timeout). Tests that need a cluster boot an in-memory `new PGlite()` rather than mocking. Shared schema/seed fixtures live in `tests/helpers.ts`.
- **E2E tests** (`tests/e2e/**/*.test.ts`, config `vitest.e2e.config.ts`): the two-version cross-major harness (`pglite-old` PG17 → `pglite-new` PG18, `forks` pool, 60s timeout). See **The two-version e2e harness** above for the alias mechanics.
- **Commands**: unit `npm run test` · E2E `npm run test:e2e` · both `npm run test:all` · lint `npm run lint` · types `npm run typecheck`.
- **Coverage**: emitted by the unit run only — `v8`, `text`+`lcov` into `coverage/`, over `src/**` minus `src/cli.ts` (the CLI is covered by `tests/cli.test.ts` behaviorally, not by line coverage). There is **no** merged unit+e2e coverage report.
- No `docs/manual-test-plan.md` exists yet — create one only if a feature ever resists automation.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

- **Requirements docs**: `docs/`, numbered for linear reading (`docs/N-topic.md`, e.g. `docs/2-data-migration.md`), with `FR-`/`NFR-` markers and relative cross-links. `docs/ARCHITECTURE.md` covers components and data flow. (See the **Documentation** list under Architecture above for the full index.)
- **Codebase map**: `docs/ai/code-summary.md` — directory tree, entry points, and a "where do I look for X" index.
- **Requirements summary**: `docs/ai/requirements-summary.md` — every requirements doc with Shipped / Partial / Design only / Deferred status markers.
- Keep both `docs/ai/` summaries in sync in the same change as the code (source doc/code wins on conflict).
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
