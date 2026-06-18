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

## Testing Philosophy

- **Double coverage**: pure logic (e.g. `topologicalSort`, `readClusterVersion`) gets focused unit tests; anything that touches a real cluster is proven end to end against real PGlite in the e2e round-trip. Unit tests alone can pass while catalog SQL is subtly wrong against a real engine.
- **No mocking the database**: there is no meaningful mock for catalog SQL or row transfer — the system under test *is* the interaction with a real PGlite. Unit tests that need a cluster use an in-memory `new PGlite()`; the e2e uses two aliased versions.
- **Every new migration capability needs both**: a pure unit test for its logic where possible, and an e2e assertion that a real migration produces the right rows/sequences/constraints.

## Conventions

- ESM modules (`"type": "module"`); import paths use the `.js` extension (TypeScript ESM convention).
- **Validate at trust boundaries, don't assert.** Data from the catalogs/network is shaped by the query; type it with an interface and read fields, never blind-cast untrusted shapes. The one sanctioned cast is bridging a concrete `PGlite` instance to the structural `PGliteLike` in tests.
- Raw SQL only — no ORM. All identifiers spliced into SQL go through `src/ident.ts` quoting helpers (catalog names are trusted but can still need quoting).
- One primary export per file; keep files focused and short. Use sub-folders when a concern grows.
- **Always use American-English spelling** in code, comments, identifiers, messages, docs, and commit messages (`color`, `behavior`, `canceled`, `analyze`, `initialize`, `gray`).

## Ticket-Driven Work

This project is intended to be driven via Hot Sheet tickets once its dedicated channel/instance is set up. When given substantial work directly, create tickets before implementing; always file follow-up tickets for known gaps (e.g. the deferred schema-reconstruction mode, COPY-text fidelity) rather than leaving them undocumented. Don't leave placeholder UI/text, TODO/FIXME comments, or specced-but-unbuilt requirements without a corresponding follow-up ticket.

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
