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

## 3 / 9 / 16 / 17 — Schema Reconstruction, standalone — Shipped

The no-host-app DDL path. `reconstructSchema(source, target, { onUnsupported })` rebuilds app-class objects (enums → sequences → tables+defaults → constraints → indexes) via `pg_get_*def`; out-of-scope objects are detected & reported. `onUnsupported` (default `warn`) escalates to `error` (throws before any DDL) — surfaced on `MigrateOptions` and CLI `--on-unsupported` (PGLM-38). Opt-in via `migrate({ reconstructSchema: true })` / CLI `--reconstruct-schema`. (PGLM-25/doc 9; spike PGLM-24 chose hand-rolled.)

The PGLM-74 audit found four gaps (reproduced against a real PGlite pair); **all four are fixed** in PGLM-76…80, each with a regression test in `tests/reconstruct.test.ts` § "audit regressions":

1. ~~Multi-schema sources fail outright.~~ **Fixed** — `reconstructSchemas` emits `CREATE SCHEMA IF NOT EXISTS` first; reported as `ReconstructionReport.schemas` (PGLM-76).
2. ~~Sequence parameters dropped.~~ **Fixed** — full `AS <type> INCREMENT BY … MINVALUE … MAXVALUE … START WITH … [NO] CYCLE` from `pg_sequence`, bounds validated before splicing (PGLM-77).
3. ~~`OWNED BY` never re-established.~~ **Fixed** — `reconstructSequenceOwnership` replays `pg_depend` deptype `'a'` after tables exist; identity columns untouched (PGLM-78).
4. ~~Domain/composite types neither rebuilt nor reported.~~ **Fully fixed** — detected in PGLM-79, then **reconstructed** in PGLM-92, which resolves **OQ-9.5** and adds [`docs/16-custom-types.md`](../16-custom-types.md). `reconstructCustomTypes` emits enums, domains and composites in one `pg_type.oid`-ordered pass (OID order is a genuine dependency order), so cross-kind cases work; domains carry their base type, `DEFAULT`, `NOT NULL`, `COLLATE` and every CHECK. Reconstructed types are no longer listed as unsupported. **Ranges followed in PGLM-95** ([`docs/17`](../17-range-types.md)): function-free ranges are reconstructed (subtype, collation, non-default opclass, explicit multirange name); only a range depending on a canonical/subdiff *function* is still reported — and that state is unreachable through PGlite DDL anyway. PGLM-95 also fixed a pre-existing detector defect: a range's five auto-created constructor functions were being reported as user functions.

`detectUnsupported` is now table-driven and covers **every** NG-9.10 class — views, matviews, partitioned + foreign tables, domains, composites, functions, triggers, policies, rules, opclasses, collations, comments, grants, extensions — without double-reporting a view's implicit `_RETURN` rule or row type (PGLM-80).

## 4 — CLI (`docs/4-cli.md`) — Shipped (one blocked)

- FR-4.1–4.6 arg parsing, version reporting, progress, errors — **Shipped**
- NG-4.7 target-schema-must-exist — **lifted** by `--reconstruct-schema`
- FR-4.2a engine-acquisition flags — **Shipped** (`--fetch-missing-engine`, `--engine-cache`, `--engine-cache-dir`; PGLM-65, doc 15)
- NG-4.8 two-engine cross-major wiring — **Shipped/verified**, including the genuine cross-major refusal: the aliases now resolve to PG17 (0.4.3) / PG18 (0.5.3) and `tests/e2e/cross-major.test.ts` asserts a PG18 engine refuses a PG17 dir (PGLM-19, PGLM-9). Installing both engines is **no longer the only option** — acquisition can supply the missing side (doc 15)
- FR-4.7 engine/data-directory major precheck — **Shipped** (PGLM-68). Compares the engine's own major against the **pre-open** `PG_VERSION`; names both majors + the install line from the pinned registry instead of PGlite's opaque init failure. Skipped when there is no `PG_VERSION`, and for the target under `--dry-run` (FR-12.1). Also fixed a latent defect: a failing `close()` in the CLI's `finally` used to append a second error and bypass `run()`'s exit code.
- FR-4.2b database selection + general engine-option passthrough — **Shipped** (`--source-database`/`--target-database`, PGLM-100; `--source-option`/`--target-option k=v`, PGLM-102; doc 18). Needed for a cluster written before PGlite 0.4.0 moved the default working database from `template1` to `postgres`; without it such a source opens empty and migrates 0 rows *successfully*, which reads as data loss and is not
- NG-4.9 dry-run/backup/validate flags — **Shipped** (`--dry-run`, `--backup`/`--backup-dir`, `--validate`, `--on-existing`)

## 5 — Safety & Rollback (`docs/5-safety-and-rollback.md`) — Shipped

Backup (FR-5.1), atomic swap (FR-5.2, library primitive), dry-run (FR-5.3), post-migration validation (FR-5.4), FK-cycle correctness (FR-5.5), idempotence (FR-5.6) — all **implemented**. CLI orchestration of the full backup→migrate→validate→swap flow is the host-app's to compose (swap is a primitive); see doc 11. Doc 5 was rewritten from its stale "DEFERRED / design only" header to a per-FR status page in the PGLM-74 audit.

## 6 — Testing (`docs/6-testing.md`) — Shipped

Unit (pure + in-memory) and two-version e2e (roundtrip, fidelity, fk-cycle, standalone, **cross-major**, **acquired-engine**) via npm aliases. The aliases resolve to two real majors — `pglite-old` = PG17 (0.4.3), `pglite-new` = PG18 (0.5.3) — so the whole e2e suite is a **genuine cross-major run**, and `cross-major.test.ts` proves on disk that a PG18 engine refuses a PG17 data dir (PGLM-19, done). A future PG19 needs only a `pglite-new` bump. NFR-6.4: `acquired-engine.test.ts` is the **only network-dependent suite**; it self-gates on registry reachability and `ctx.skip()`s offline so a disconnected `test:e2e` stays green and reports skips honestly (PGLM-67).

## 15 — Engine Acquisition (`docs/15-engine-acquisition.md`) — Shipped

Opt-in downloading of a missing engine, so a host that bundles only the destination version can still migrate (PGLM-62…67).

- FR-15.1–15.5 pinned major → version + sha512 registry — **Shipped**. Every entry verified empirically (download → hash → extract → boot → read `server_version`): PG15→0.1.5, PG16→0.2.17, PG17→0.4.6, PG18→0.5.4. Pinning doesn't rot because only source-side majors are fetched and old majors are frozen.
- FR-15.6–15.10 acquire, verify-before-write, actionable offline error, atomic staging for concurrent runs — **Shipped**
- FR-15.11–15.15 retention: `keep` (**default**) / `ephemeral`, `cacheDir` override, release tied to `close()` — **Shipped**
- NFR-15.16–15.19 opt-in only, resolve-first, separate `pglite-migrate/engines` entry point + dynamic import, actionable missing-engine error — **Shipped**
- NFR-15.20–15.24 hand-rolled zero-dep extractor; refuses links/devices/traversal/bad checksums/base-256; checks apply to pax + GNU long-name overrides; archive modes ignored; byte-identical to `tar -xzf` on a real tarball — **Shipped**
- FR-15.25–15.27 CLI flags, either side may acquire, acquisition reported to stderr — **Shipped**

Known limitations recorded in the doc: offline/air-gapped/proxied runs gain a new failure mode (mitigated by opt-in default); packaged apps must point `cacheDir` somewhere writable; only pinned majors can be acquired.

## 18 — Engine Construction Options (`docs/18-engine-construction-options.md`) — Shipped

`openDataDir` had no way to reach PGlite's own constructor options, so a host with non-default options could not use it at all and had to hand-roll import + construction (PGLM-100).

- FR-18.1 `OpenOptions.pgliteOptions`, forwarded verbatim as the constructor's 2nd argument — **Shipped**
- FR-18.2 applied on **both** construction sites (resolved *and* acquired) — **Shipped**, one test per path; fixing one and missing the other is the easy mistake
- FR-18.3 omitting it constructs with a **single argument**, not an explicit `undefined` — **Shipped**, pinned via `arguments.length`
- FR-18.4 `--source-database` / `--target-database` — **Shipped**; the run test asserts the flagless case transfers **0 rows and exits 0**, i.e. the failure mode is a silent success
- NFR-18.5/18.6 typed `Record<string, unknown>` (no coupling to a PGlite version, since two majors are open at once) under a distinct key that cannot collide with this library's own options — **Shipped**
- FR-18.9 general `--source-option` / `--target-option k=v`, repeatable; `--source-database` is sugar for the same key, so precedence is plain argv order — **Shipped** (PGLM-102)
- FR-18.10 coercion is **JSON when it parses as JSON, the raw string otherwise** (`relaxedDurability=true` → boolean, `database=template1` → string), splitting on the first `=`; `'"true"'` is the escape hatch for a string that looks like JSON — **Shipped** (PGLM-102)
- NG-18.7 no connection-string/DSN parsing and no per-option type table; NG-18.8 no auto-detection of a `template1`-era cluster; NG-18.11 no full CLI/library parity — `extensions` takes module objects and cannot be expressed textually at all — **deliberate**

## 7–14 — Detailed feature specs — Implemented

Each doc expanded a brief mention into an implementation-ready spec, and all are now built (open questions in each doc remain documented product decisions):

- `docs/7` COPY-text — **done** (PGLM-22). Real gap was only `json` whitespace; everything else already round-tripped.
- `docs/8` FK-cycle deferred constraints — **done** (PGLM-23).
- `docs/9` standalone reconstruction — **done** (PGLM-25); the `onUnsupported: 'warn' | 'error'` option (default `warn`, `error` throws before any DDL) is built and surfaced through `migrate`/CLI, and doc 9's report shape is reconciled with `types.ts` (PGLM-38).
- `docs/10` backup — **done** (PGLM-26, opt-in CLI); `--keep <n>` retention (FR-10.6) built (PGLM-39).
- `docs/11` atomic swap — **done** as `swapIntoPlace` primitive (PGLM-27).
- `docs/12` dry-run — **done** (PGLM-28).
- `docs/13` validation — **done** (PGLM-29, default `counts`); FR-13.4 resolved (PGLM-40) as opt-in `onValidationFailure: 'report' | 'throw'` (default `report`; `throw` raises the exported `ValidationError`), CLI `--strict` / exits non-zero. Counts are now bigint-safe (`count(*)::text`, PGLM-83). FR-13.13/FR-13.14 added by **PGLM-99**: the `full` digest now hashes **content, not layout** — it projects the source∩target column intersection, name-sorted identically on both sides, so a target whose columns sit in a different ordinal order (the norm in the app-driven path, where the source grew by appending `ALTER TABLE ADD COLUMN`s) no longer false-negatives. `TableValidation` gained `comparedColumns` / `missingColumns` (fails the table) / `extraColumns` (reported only). FR-13.15 added by **PGLM-101**: a table the target lacks is now a reported `missingTable` failure at **every** level instead of an escaping `relation "…" does not exist` — which produced no report at all, so one absent table hid every other table's result. Costs one `tableKeys` query per run, subsumed by the target introspection `full` already does. *Reduced surface:* no `mismatches[]` on the typed report (deliberate, doc 13 reconciled) and no per-table CLI summary (PGLM-85, open).
- `docs/14` idempotence — **done** (PGLM-30, default `error`). FR-14.5/FR-14.10 closed by PGLM-81 (`MigrationReport.onExisting` + `truncatedTables`); NFR-14.11 closed by PGLM-82 (`hasRows`, a bounded `LIMIT 1` probe).

## Remaining follow-ups

1. ~~Verified cross-major run + new-major-refuses-old-dir.~~ **Done (PGLM-19)** — aliases at PG17 (0.4.3) / PG18 (0.5.3); the e2e suite is cross-major and `cross-major.test.ts` proves the refusal on disk.
2. Upsert/`ON CONFLICT` re-run strategy — deferred (needs PK/unique introspection; doc 14).
3. CLI orchestration of swap into the on-startup-upgrade flow; stale-`.new` cleanup; reflink backup fast-path — follow-ups in docs 10/11.
4. Open product decisions flagged in docs 7–14 (e.g. backup default-on, identity-vs-serial normalization).
5. ~~Engine/cluster major precheck.~~ **Done (PGLM-68)** — see FR-4.7 above.
6. **Reconstruction gaps (PGLM-74 audit)** — multi-schema sources, sequence parameters, `OWNED BY`, domain/composite types, and the incomplete unsupported-object detector. See § 3/9 above and doc 9 § Known gaps.
7. ~~Report/probe edges (PGLM-74 audit).~~ **Done (PGLM-81/82/83)** — `MigrationReport` echoes `onExisting` and names `truncatedTables`; the non-empty probe is a bounded `hasRows`; row counts read `count(*)::text`.
8. ~~Reconstructing domains/composites (PGLM-92).~~ **Done** — see § 3/9/16 above and `docs/16`.

## Maintenance triggers

Update this file when: a requirement's implementation status changes; a requirements doc is added/renumbered; or a follow-up is completed.
