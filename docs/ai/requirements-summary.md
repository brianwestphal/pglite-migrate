# Requirements Summary (AI orientation)

> Synthesized view of every requirements doc with status markers. Keep in sync when requirements or implementation change.

Status legend: **Shipped** · **Partial** · **Design only** · **Deferred**

## 1 — Overview (`docs/1-overview.md`) — Shipped (framing)

The problem (PGlite can't open an old-major data dir after a major bump) and the logical, two-engine approach. Goals FR-1.1–1.4 met for the app-driven path; NFR-1.5/1.6 (version-agnostic catalog queries, peer-dep PGlite) **Shipped**. Non-goals 1.1–1.4 hold.

## 2 — Data Migration, app-driven (`docs/2-data-migration.md`) — Shipped, one Partial

- FR-2.1–2.3 `migrate` + progress — **Shipped**
- FR-2.4–2.9 introspection (tables/columns/FKs/sequences, version-agnostic) — **Shipped**
- FR-2.10–2.13 topo sort, transfer, sequence realign — **Shipped**
- FR-2.11 FK-cycle handling — **Partial** (cycle *detection* now correct after the PGLM-20 fix; *handling* still warns + inserts in original order. Deferred-constraint handling specified in doc 8)
- FR-2.7 FK introspection — **Shipped**, hardened: edges are now schema-qualified (PGLM-20) so insert ordering + cycle detection work for `public`-schema tables (previously silently dropped)
- FR-2.14 row-by-row INSERT transfer — **Shipped**
- NFR-2.15 COPY-text fidelity path — **Deferred**

## 3 — Schema Reconstruction, standalone (`docs/3-schema-reconstruction.md`) — Design only

The no-host-app DDL path. Approach specified (`pg_get_*def`, optional `pg-introspection`/`pg-schema-dump`), scope boundary drawn (app-class objects in; full pg_dump parity out). **Not implemented.**

## 4 — CLI (`docs/4-cli.md`) — Partial

- FR-4.1–4.6 arg parsing, version reporting, progress, errors — **Shipped**
- NG-4.7 target-schema-must-exist assumption — current limitation (lifted by doc 3)
- NG-4.8 two-engine cross-major wiring — **Partial** (`--source-engine`/`--target-engine` exist; genuine cross-major loading unverified pending a second major)
- NG-4.9 dry-run/backup/swap flags — **Deferred** (doc 5)

## 5 — Safety & Rollback (`docs/5-safety-and-rollback.md`) — Deferred

Backup, atomic swap, dry-run, post-migration validation, FK-cycle correctness, idempotence. All **design only** — essential before production data use.

## 6 — Testing (`docs/6-testing.md`) — Shipped

Unit (pure + in-memory introspection) and two-version e2e round-trip via npm aliases. Matrix is **Shipped**; becomes a true cross-major test by bumping the `pglite-new` alias when a second major ships.

## 7–14 — Detailed feature specs (design only)

Each expands a brief mention from docs 1–6 into an implementation-ready requirements doc (FR/NFR/NG markers, design, acceptance, testing, open questions). All **design only** — none implemented yet.

- `docs/7-copy-text-transfer.md` — COPY-text fidelity path (NFR-2.15). Key finding: current INSERT path already preserves `jsonb`/`numeric`/`bytea`/arrays; only plain `json` source text (whitespace) is lost.
- `docs/8-fk-cycle-deferred-constraints.md` — correct cyclic transfer (FR-2.11 / FR-5.5) via a deferred-constraint transaction over the cyclic subset.
- `docs/9-standalone-schema-reconstruction.md` — detailed spec for the no-host-app DDL path (expands doc 3).
- `docs/10-backup.md` — source-dir backup (FR-5.1).
- `docs/11-atomic-swap.md` — write-new-then-rename swap (FR-5.2).
- `docs/12-dry-run.md` — read-only plan/report (FR-5.3).
- `docs/13-post-migration-validation.md` — count/sequence/digest validation, gates the swap (FR-5.4).
- `docs/14-idempotence.md` — re-run safety; recommended default is refuse-if-non-empty (FR-5.6).

## Top follow-ups (file as tickets)

Design is captured in docs 7–14; the remaining work is implementation:

1. COPY-text data path — doc 7 (spike first)
2. FK-cycle correctness via deferred constraints — doc 8
3. Standalone schema reconstruction — docs 3 + 9 (spike libraries first)
4. Safety layer: backup (10) + atomic swap (11) + dry-run (12) + validation (13) + idempotence (14)
5. Verified cross-major CLI engine loading — NG-4.8 (blocked on a second major)

## Maintenance triggers

Update this file when: a requirement's implementation status changes; a requirements doc is added/renumbered; or a follow-up is completed.
