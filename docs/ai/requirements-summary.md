# Requirements Summary (AI orientation)

> Synthesized view of every requirements doc with status markers. Keep in sync when requirements or implementation change.

Status legend: **Shipped** · **Partial** · **Design only** · **Deferred**

## 1 — Overview (`docs/1-overview.md`) — Shipped (framing)

The problem (PGlite can't open an old-major data dir after a major bump) and the logical, two-engine approach. Goals FR-1.1–1.4 met for the app-driven path; NFR-1.5/1.6 (version-agnostic catalog queries, peer-dep PGlite) **Shipped**. Non-goals 1.1–1.4 hold.

## 2 — Data Migration, app-driven (`docs/2-data-migration.md`) — Shipped, one Partial

- FR-2.1–2.3 `migrate` + progress — **Shipped**
- FR-2.4–2.9 introspection (tables/columns/FKs/sequences, version-agnostic) — **Shipped**
- FR-2.10–2.13 topo sort, transfer, sequence realign — **Shipped**
- FR-2.11 FK-cycle handling — **Shipped** (cyclic subset transferred with deferred constraints via `transferCycle`; `MigrationReport.deferredTables`; PGLM-23/doc 8)
- FR-2.7 FK introspection — **Shipped**, hardened: edges are schema-qualified (PGLM-20) so ordering + cycle detection work for `public`-schema tables (previously silently dropped)
- FR-2.14 / NFR-2.15 transfer — **Shipped**: COPY-text first (preserves `json` etc.) with per-table row-by-row INSERT fallback (PGLM-22/doc 7)

## 3 / 9 — Schema Reconstruction, standalone — Shipped

The no-host-app DDL path. `reconstructSchema(source, target)` rebuilds app-class objects (enums → sequences → tables+defaults → constraints → indexes) via `pg_get_*def`; out-of-scope objects are detected & reported. Opt-in via `migrate({ reconstructSchema: true })` / CLI `--reconstruct-schema`. (PGLM-25/doc 9; spike PGLM-24 chose hand-rolled.)

## 4 — CLI (`docs/4-cli.md`) — Shipped (one blocked)

- FR-4.1–4.6 arg parsing, version reporting, progress, errors — **Shipped**
- NG-4.7 target-schema-must-exist — **lifted** by `--reconstruct-schema`
- NG-4.8 two-engine cross-major wiring — **Shipped/verified**, including the genuine cross-major refusal: the aliases now resolve to PG17 (0.4.3) / PG18 (0.5.3) and `tests/e2e/cross-major.test.ts` asserts a PG18 engine refuses a PG17 dir (PGLM-19, PGLM-9)
- NG-4.9 dry-run/backup/validate flags — **Shipped** (`--dry-run`, `--backup`/`--backup-dir`, `--validate`, `--on-existing`)

## 5 — Safety & Rollback (`docs/5-safety-and-rollback.md`) — Shipped

Backup (FR-5.1), atomic swap (FR-5.2, library primitive), dry-run (FR-5.3), post-migration validation (FR-5.4), FK-cycle correctness (FR-5.5), idempotence (FR-5.6) — all **implemented**. CLI orchestration of the full backup→migrate→validate→swap flow is the host-app's to compose (swap is a primitive); see doc 11.

## 6 — Testing (`docs/6-testing.md`) — Shipped

Unit (pure + in-memory) and two-version e2e (roundtrip, fidelity, fk-cycle, standalone, **cross-major**) via npm aliases. The aliases resolve to two real majors — `pglite-old` = PG17 (0.4.3), `pglite-new` = PG18 (0.5.3) — so the whole e2e suite is a **genuine cross-major run**, and `cross-major.test.ts` proves on disk that a PG18 engine refuses a PG17 data dir (PGLM-19, done). A future PG19 needs only a `pglite-new` bump.

## 7–14 — Detailed feature specs — Implemented

Each doc expanded a brief mention into an implementation-ready spec, and all are now built (open questions in each doc remain documented product decisions):

- `docs/7` COPY-text — **done** (PGLM-22). Real gap was only `json` whitespace; everything else already round-tripped.
- `docs/8` FK-cycle deferred constraints — **done** (PGLM-23).
- `docs/9` standalone reconstruction — **done** (PGLM-25); the spec'd `onUnsupported: 'warn' | 'error'` option / `reconstructSchema` `options?` param is **not yet built** (warn-only today) and doc 9's report-shape field names are stale vs `types.ts`.
- `docs/10` backup — **done** (PGLM-26, opt-in CLI); `--keep <n>` retention (FR-10.6) is **not yet built**.
- `docs/11` atomic swap — **done** as `swapIntoPlace` primitive (PGLM-27).
- `docs/12` dry-run — **done** (PGLM-28).
- `docs/13` validation — **done** (PGLM-29, default `counts`); failure marks `validation.ok=false` and the CLI exits non-zero, but `migrate` does **not** throw a typed `ValidationError` (FR-13.4 open decision).
- `docs/14` idempotence — **done** (PGLM-30, default `error`).

## Remaining follow-ups

1. ~~Verified cross-major run + new-major-refuses-old-dir.~~ **Done (PGLM-19)** — aliases at PG17 (0.4.3) / PG18 (0.5.3); the e2e suite is cross-major and `cross-major.test.ts` proves the refusal on disk.
2. Upsert/`ON CONFLICT` re-run strategy — deferred (needs PK/unique introspection; doc 14).
3. CLI orchestration of swap into the on-startup-upgrade flow; stale-`.new` cleanup; reflink backup fast-path; `--keep <n>` backup retention (FR-10.6) — follow-ups in docs 10/11.
4. Open product decisions flagged in docs 7–14 (e.g. backup default-on, identity-vs-serial normalization, validation throw-vs-report, `reconstructSchema` `onUnsupported` error mode).

## Maintenance triggers

Update this file when: a requirement's implementation status changes; a requirements doc is added/renumbered; or a follow-up is completed.
