# 5 — Safety & Rollback

**Status: Implemented.** This page is the safety umbrella — each requirement below now has a shipped implementation and a detailed spec of its own (docs 10–14). One piece remains outstanding: the CLI does not yet orchestrate the full backup → migrate → validate → **swap** flow, so `swapIntoPlace` is a library primitive a host composes itself.

## Requirements

- **FR-5.1 Backup** — **Shipped.** `backupDataDir(dir, { backupDir, timestamp, keep })` (`src/backup.ts`) writes to a `.partial` sibling, renames it into place, then verifies `PG_VERSION` plus recursive file and byte counts, and optionally prunes older backups. CLI: `--backup` / `--backup-dir` / `--keep` (opt-in). The source is only ever read. Spec: [`10-backup.md`](10-backup.md).
- **FR-5.2 Atomic swap** — **Shipped as a primitive.** `swapIntoPlace(canonical, newDir, { keepOld, timestamp })` (`src/swap.ts`) moves the original aside to `<canonical>.old-<ts>`, renames the new cluster in, restores the original if that second rename fails, and reports a cross-filesystem move rather than silently degrading to a copy. **Not yet wired into the CLI** — staging, stale-`.new` cleanup, and validation-gated swapping are follow-ups. Spec: [`11-atomic-swap.md`](11-atomic-swap.md).
- **FR-5.3 Dry-run** — **Shipped.** `planMigration(source, onProgress?)` is a structurally write-free path that `migrate({ dryRun: true })` delegates to, returning the same `MigrationReport` shape; CLI `--dry-run`. Spec: [`12-dry-run.md`](12-dry-run.md).
- **FR-5.4 Post-migration validation** — **Shipped.** `validateMigration(source, target, schema, level)` (`src/validate.ts`) at level `counts` (default: per-table row-count parity + `target.last_value >= source`) or `full` (adds an order-independent md5 row digest). `onValidationFailure: 'report' | 'throw'` decides whether a failure marks the report or raises the typed `ValidationError`; CLI `--validate` / `--strict`, non-zero exit either way. Spec: [`13-post-migration-validation.md`](13-post-migration-validation.md).
- **FR-5.5 Foreign-key cycles** — **Shipped.** `transferCycle` moves the cyclic subset inside one target transaction with `SET CONSTRAINTS ALL DEFERRED`, transiently flipping any `NOT DEFERRABLE` FK and restoring it in a `finally`. The misleading "may violate constraints" warning is gone; handled cycles surface as `MigrationReport.deferredTables`. Spec: [`8-fk-cycle-deferred-constraints.md`](8-fk-cycle-deferred-constraints.md).
- **FR-5.6 Idempotence / resumability** — **Shipped (partial).** `onExisting: 'error' | 'truncate' | 'skip'` (default `error`) decides what a non-empty target means; `applySequences` is idempotent by construction (absolute `setval`). Still open: the `ON CONFLICT`/upsert strategy, which needs PK/unique introspection the catalogs layer does not yet collect. Spec: [`14-idempotence.md`](14-idempotence.md).

## Notes

- The atomic-swap + backup pattern mirrors how a host app would want to wrap an upgrade on startup: detect old `PG_VERSION`, migrate into a sibling directory, validate, swap, keep the old as a timestamped backup.
- Validation is what lets a host app trust an automated on-startup upgrade without a human in the loop.
- Every piece of that pattern now exists as a composable primitive, but the *composition* is still the host's to write. Until the CLI orchestration lands, `pglite-migrate <src> <dst> --backup --validate counts` migrates directly into the target; staging-plus-swap requires calling `backupDataDir` → `migrate` → `swapIntoPlace` from a host app.
