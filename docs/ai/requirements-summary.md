# Requirements Summary (AI orientation)

> Synthesized view of every requirements doc with status markers. Keep in sync when requirements or implementation change.

Status legend: **Shipped** · **Partial** · **Design only** · **Deferred**

## 1 — Overview (`docs/1-overview.md`) — Shipped (framing)

The problem (PGlite can't open an old-major data dir after a major bump) and the logical, two-engine approach. Goals FR-1.1–1.4 met for the app-driven path; NFR-1.5/1.6 (version-agnostic catalog queries, peer-dep PGlite) **Shipped**. Non-goals 1.1–1.4 hold.

## 2 — Data Migration, app-driven (`docs/2-data-migration.md`) — Shipped, one Partial

- FR-2.1–2.3 `migrate` + progress — **Shipped**
- FR-2.4–2.9 introspection (tables/columns/FKs/sequences, version-agnostic) — **Shipped**
- FR-2.10–2.13 topo sort, transfer, sequence realign — **Shipped**
- FR-2.11 FK-cycle handling — **Partial** (warns + inserts in original order; proper deferred-constraint handling is in doc 5)
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

## Top follow-ups (file as tickets)

1. COPY-text data path (fidelity) — NFR-2.15
2. Standalone schema reconstruction — doc 3
3. Safety layer: backup + atomic swap + dry-run + validation — doc 5
4. FK-cycle correctness via deferred constraints — FR-2.11 / FR-5.5
5. Verified cross-major CLI engine loading — NG-4.8

## Maintenance triggers

Update this file when: a requirement's implementation status changes; a requirements doc is added/renumbered; or a follow-up is completed.
