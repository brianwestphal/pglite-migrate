# 5 — Safety & Rollback — DEFERRED

**Status: design only. Not implemented in v1.** A real migration mutates a user's only copy of their data, so the safety layer is essential before this is recommended for production data — file as tickets.

## Requirements

- **FR-5.1 Backup** Before migrating, copy/snapshot the source data directory so a failed or unsatisfactory migration can be rolled back. Never mutate the source in place.
- **FR-5.2 Atomic swap** Migrate into a fresh target directory, then swap it into the canonical location atomically (write-new-then-rename), so a crash mid-migration never leaves a half-written canonical directory.
- **FR-5.3 Dry-run** A `--dry-run` mode that introspects and reports what *would* be transferred (tables, row counts, sequences, warnings) without writing to the target.
- **FR-5.4 Post-migration validation** After transfer, verify row counts per table match the source, sequence values are consistent, and (optionally) checksums/aggregates agree. Fail loudly on mismatch and do not swap.
- **FR-5.5 Foreign-key cycles** Replace the current "warn and insert in original order" behavior with correct handling: drop/defer constraints for the cyclic subset, insert, then re-add/validate. (Today's behavior risks a constraint violation on cyclic schemas — see `2-data-migration.md` FR-2.11.)
- **FR-5.6 Idempotence / resumability** Decide and document behavior when a target is partially populated (re-run safety): either require an empty target, or transfer idempotently.

## Notes

- The atomic-swap + backup pattern mirrors how a host app would want to wrap an upgrade on startup: detect old `PG_VERSION`, migrate into a sibling directory, validate, swap, keep the old as a timestamped backup.
- Validation is what lets a host app trust an automated on-startup upgrade without a human in the loop.
