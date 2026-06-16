# 10 — Backup (Source Data Directory)

**Status: design only. Not implemented in v1.** This is the detailed spec for the backup requirement (PGLM-4 / FR-5.1) under the safety umbrella in [`5-safety-and-rollback.md`](./5-safety-and-rollback.md). Backup is the first line of defense for the whole safety layer and should land before the tool is recommended for production data — file as tickets.

## Motivation / Problem

A migration mutates a user's **only** copy of their data. The source data directory is a real PGDATA cluster created by an old-major PGlite engine; once a new-major engine has touched the on-disk format, an old-major engine can no longer open it (that incompatibility is the entire reason this tool exists). If a migration fails partway, or the operator decides the result is unsatisfactory, there must be an untouched copy of the original to fall back to.

The non-negotiable rule is: **never mutate the source in place.** The v1 data path only ever *reads* the source (`introspectSchema` + `SELECT`), so the source is already read-only by construction — but that is an implementation detail today, not a guaranteed and verified property. Backup makes the guarantee explicit and durable: before any migration begins, the source data directory is copied (or snapshotted) so a failed or unsatisfactory run can be rolled back to a known-good state.

This also matches the shape a host application wants on startup: detect an old `PG_VERSION`, take a backup, migrate into a sibling directory, validate, swap, and keep the old directory as a timestamped backup (see [`5-safety-and-rollback.md`](./5-safety-and-rollback.md) Notes).

## Requirements

- **FR-10.1 Pre-migration backup** Before any migration step runs, copy or snapshot the source data directory to a separate location so the original is recoverable. No migration work may begin until the backup is complete and verified.
- **FR-10.2 Source is never mutated** The source data directory MUST be byte-for-byte unchanged after a run (success or failure). Backup is the safety net; read-only access is the design contract.
- **FR-10.3 Default backup location and naming** The default backup is a sibling of the source: `<dir>.bak-<ISO-8601 timestamp>` (e.g. `pgdata.bak-2026-06-16T14-30-05Z`). Colons are replaced so the name is valid on all target filesystems (notably Windows/NTFS). The location MUST be overridable.
- **FR-10.4 Timestamped, non-clobbering** Each run produces a distinct, timestamped backup. An existing backup directory is never overwritten; if a name collision occurs (same-second runs), the operation fails or disambiguates rather than clobbering.
- **FR-10.5 Verified backup** After copying, the backup is verified for completeness (at minimum: the backup contains a readable `PG_VERSION` matching the source, and the file/byte counts match). A backup that cannot be verified aborts the migration.
- **FR-10.6 Retention** A retention policy bounds how many timestamped backups accumulate. Default: keep all backups (no automatic deletion), with an opt-in `--keep <n>` to prune the oldest beyond `n`. Pruning never deletes a backup created in the current run.
- **FR-10.7 CLI surface** The CLI exposes backup behavior via flags (see [CLI surface](#cli-surface)) and reports the backup path it created on stderr.
- **FR-10.8 Failure isolation** If the backup step fails (no disk space, permission denied, source unreadable), the migration aborts before opening either engine, and the error is reported clearly. A partially written backup is cleaned up or clearly marked incomplete.
- **NFR-10.9 Cross-platform** Backup uses Node's `fs` APIs and works on Linux, macOS, and Windows without native tools. No shell-out to `cp`/`rsync`/`robocopy`.
- **NFR-10.10 Atomicity of the backup itself** A backup directory becomes visible under its final name only once the copy is complete and verified — write to a temp name, then rename — so a crash mid-copy never leaves a half-written directory that looks like a valid backup.
- **NFR-10.11 No engine running during backup** The backup is taken with no PGlite engine attached to the source, so the on-disk files are quiescent and internally consistent (no concurrent writes from a live cluster).
- **NG-10.12 Not a general backup tool** This is a one-shot pre-migration snapshot, not scheduled backups, incremental/differential backups, compression, or remote/offsite storage. Those are out of scope.
- **NG-10.13 No backup of the target** This requirement covers the *source* only. Protecting the canonical/target location is the job of atomic swap (PGLM-5, `docs/11`), which writes a fresh directory and swaps it in.

## Design / Approach

### Copy strategy

Two strategies, in order of portability:

1. **Full directory copy (default, portable).** Recursively copy the entire source data directory tree to the backup location using `fs.cp(src, dst, { recursive: true })` (Node 16.7+). This is the only strategy that works identically on every platform and filesystem, so it is the default. A PGlite data directory is small relative to a native cluster, so a full copy is acceptable.

   - Write to a temporary sibling name first (e.g. `<dir>.bak-<ts>.partial`), then `fs.rename` to the final `<dir>.bak-<ts>` once verified (NFR-10.10). `rename` within the same filesystem is atomic.
   - Preserve timestamps where possible; metadata fidelity is not required for correctness (PGlite re-reads file contents, not mtimes), but a faithful copy is preferred.

2. **Filesystem snapshot (opt-in optimization, deferred).** On filesystems that support reflinks/copy-on-write (APFS clone on macOS, Btrfs/XFS reflink on Linux), a near-instant, space-efficient clone is possible. This is an optimization, not a requirement; it is **deferred** because it is platform- and filesystem-dependent and cannot be the default. If pursued, it must fall back to a full copy when the source/destination do not support reflinks.

### Cross-platform considerations (Node `fs`)

- Use `node:fs/promises` (`fs.cp`, `fs.rename`, `fs.stat`, `fs.readdir`, `fs.rm`) — no shell-out, satisfying NFR-10.9.
- **Filename safety:** ISO timestamps contain `:`, which is illegal on NTFS. Sanitize to `2026-06-16T14-30-05Z` form (replace `:` with `-`, drop sub-second precision) for FR-10.3.
- **Same-filesystem rename:** the `.partial` → final rename (NFR-10.10) is atomic only within one filesystem. Since the default backup is a sibling of the source, this holds. If a custom `--backup-dir` lands on a different volume, fall back to copy-then-verify without relying on rename atomicity, and document the weaker guarantee.
- **Path handling:** derive the default backup path from the source with `path.dirname`/`path.basename` so it is a true sibling regardless of trailing slashes or relative paths.
- **Symlinks / special files:** a PGDATA tree is plain files and directories; copy them as-is. Be deliberate about `fs.cp`'s symlink behavior so a backup is a real copy, not a tree of dangling links.

### Verification

Minimal, cheap, and meaningful (FR-10.5): after the copy, read the backup's `PG_VERSION` via the existing `readClusterVersion` (`src/version.ts`) and assert it equals the source's; compare the recursive file count and total byte size of source vs. backup. This catches truncated or partial copies without hashing every file. A deeper per-file checksum mode can be a follow-up.

## Interaction with existing code

- **`src/cli.ts`** — the backup step is wired into `run()` **before** `openDataDir` is called for either side (FR-10.8, NFR-10.11). The CLI already reads `PG_VERSION` for both sides up front via `readClusterVersion`; the backup runs immediately after that and before engines are opened. New flags are parsed in `parseArgs` and threaded through `CliArgs`. The created backup path is reported through the existing `CliIO.err` channel alongside the current `Migrating … -> …` line.
- **`src/version.ts`** — `readClusterVersion(dataDir)` is reused to verify the backup's `PG_VERSION` matches the source's (FR-10.5).
- **`src/loader.ts`** — unchanged; backup happens before `openDataDir`. The ordering matters: never open the source engine (or any engine) until the backup exists and is verified.
- **New module** — a focused `src/backup.ts` exporting a single primary function (e.g. `backupDataDir(source, options)` → resolved backup path), per the one-primary-export-per-file convention. Pure-ish I/O logic kept here so it is unit-testable independent of the CLI. The library API (`src/index.ts`) should export it so host apps can take a backup programmatically before calling `migrate`.
- **Composition with atomic swap (`docs/11`, PGLM-5)** — backup protects the *source*; atomic swap protects the *canonical/target* location by writing a fresh directory and renaming it into place. The full safe sequence is: **backup source → migrate into fresh target → validate → atomic-swap target into canonical → (optionally) retain old canonical as its own timestamped backup.** Backup and swap are independent and stackable; backup does not depend on swap and vice versa.
- **Composition with validation (`docs/13`, PGLM-7)** — validation runs after transfer and gates the swap. If validation fails, the freshly written target is discarded and the source (untouched, plus its backup) remains the source of truth. Backup is what makes a validation-driven abort safe: there is always a recoverable original.

## CLI surface

Proposed flags for `src/cli.ts` (see [`4-cli.md`](./4-cli.md) NG-4.9, which currently lists `--backup` as not-yet-implemented):

```
  --backup                Take a timestamped backup of the source before migrating.
  --no-backup             Skip the backup (explicit opt-out).
  --backup-dir <path>     Backup location (default: <source>.bak-<timestamp> sibling).
  --keep <n>              Retain at most n timestamped backups; prune the oldest. (default: keep all)
```

Recommended default: **backup on by default** for the CLI (safety-first; the operator must explicitly `--no-backup` to skip). The library function stays explicit/opt-in so host apps compose it deliberately. See [Open Questions](#open-questions).

On a successful backup the CLI prints, to stderr, the path it created, e.g.:

```
Backed up source to /data/pgdata.bak-2026-06-16T14-30-05Z
```

## Acceptance

- Running the CLI against a source with data creates a backup directory at the documented default location, and that directory contains a complete, openable copy of the source (its `PG_VERSION` matches and it can be opened by the old engine).
- After a successful run, the **source** directory is byte-for-byte identical to its pre-run state.
- After a **failed** run (e.g. a transfer error), the source is still byte-for-byte identical and the backup exists, so the operator can recover.
- `--no-backup` skips backup creation; `--backup-dir` redirects the backup; `--keep <n>` bounds the number of retained backups and never deletes the current run's backup.
- A backup that fails verification (or fails to copy) aborts the run before any engine is opened, with a clear error and no half-written final backup directory.

## Testing requirements

Per [`6-testing.md`](./6-testing.md): pure/extractable logic gets focused unit tests; anything touching a real cluster is proven end to end.

**Unit (`tests/*.test.ts`):**
- Default backup path derivation from a source path (sibling, sanitized ISO timestamp, no illegal `:` characters).
- Name collision / non-clobber behavior (FR-10.4): two backups in the same second do not overwrite each other.
- Retention pruning math (FR-10.6): given a set of timestamped backups and `--keep n`, the correct oldest ones are selected for deletion and the current backup is always retained.
- Copy + verify against a temp directory tree (no PGlite needed): assert the copy is complete, verification catches a truncated/partial copy, and the `.partial` → final rename only exposes a verified backup.
- CLI arg parsing for `--backup` / `--no-backup` / `--backup-dir` / `--keep` (extend the existing `parseArgs` tests).

**E2E (`tests/e2e/*.test.ts`):**
- Run a real migration through the two-version harness with backup enabled; assert a backup directory exists, opens under the old engine, and its `PG_VERSION` matches the source.
- Capture the source directory's recursive file list + byte contents (or a content hash) before and after the run; assert they are **unchanged** (proves FR-10.2 against a real engine, not just by inspection).
- Inject a transfer failure and assert the source is still unchanged and the backup is present (rollback is possible).

## Open Questions

- **Default-on vs. opt-in (recommend: on by default in the CLI).** Safety-first argues for backup by default with an explicit `--no-backup`. The counter-argument is disk usage and surprise on large directories. Recommendation: **on by default for the CLI**, explicit/opt-in for the library API. Needs a human decision.
- **Retention default (recommend: keep all).** Keep every backup unless `--keep <n>` is given? Or default to a small `n` (e.g. 3) to bound disk growth? Recommendation: **keep all by default** (least surprising; never silently delete a user's data), with `--keep` as the opt-in pruner. Needs a human decision.
- **Backup vs. atomic-swap "retain old" — one mechanism or two?** When atomic swap (PGLM-5) keeps the displaced canonical directory as its own timestamped backup, does that subsume the pre-migration source backup, or are they distinct artifacts? Recommendation: keep them **distinct** — the pre-migration backup (this doc) is taken before anything runs; the swap's retained-old is a post-success artifact. Confirm during PGLM-5 design.
- **Verification depth (recommend: cheap checks for v1).** Is `PG_VERSION` match + file/byte-count comparison sufficient, or is a per-file content hash required? Recommendation: cheap checks for v1; full-hash mode as a follow-up flag.
- **Reflink/snapshot strategy — pursue now or defer?** Recommendation: **defer**; ship the portable full copy first, add reflink as an opt-in optimization later.
- **Custom `--backup-dir` on a different volume.** Cross-volume defeats atomic rename (NFR-10.10). Document the weaker guarantee, or refuse a cross-volume backup dir? Needs a decision.

## Follow-up tickets

- **PGLM-4 (this doc):** Implement source backup (`src/backup.ts` + CLI wiring in `src/cli.ts`, export from `src/index.ts`).
- Filesystem-snapshot/reflink fast path with full-copy fallback (deferred optimization).
- Per-file checksum verification mode (`--verify-hash` or similar).
- Coordinate the "retain displaced canonical as timestamped backup" behavior with atomic swap (PGLM-5, `docs/11`).
