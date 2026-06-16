# 11 — Atomic Swap

**Status: design only. Not implemented in v1.** This is the detailed spec for the atomic-swap requirement (PGLM-5 / FR-5.2) under the safety umbrella in [`5-safety-and-rollback.md`](./5-safety-and-rollback.md). Atomic swap is what lets a migration write the new cluster without ever putting the canonical location into a half-written state — file as tickets.

## Motivation / Problem

A migration ultimately has to produce a data directory at the location the host application (or operator) will open next time. The naive approach — migrate *into* that canonical location directly — is unsafe: a crash, power loss, or thrown error partway through transfer leaves the canonical directory partially populated. On the next boot the engine opens a cluster that is missing rows, missing sequences, or otherwise internally inconsistent, and there is no clean signal that it is broken. The user's data is now silently corrupt.

The non-negotiable rule is: **the canonical location is only ever updated by an atomic rename of a fully written, validated directory.** Until that rename happens, the canonical location holds the original, untouched cluster; after it happens, it holds the complete, validated new cluster. There is no in-between state that an engine can observe.

This mirrors exactly the shape a host application wants on startup (see [`5-safety-and-rollback.md`](./5-safety-and-rollback.md) Notes): detect an old `PG_VERSION` via `readClusterVersion` (`src/version.ts`), migrate into a **sibling** directory, validate, then **swap** the sibling into the canonical location and keep the displaced old directory as a timestamped backup. The atomicity is what makes that flow safe to run unattended on every startup — a crash at any point either leaves the old cluster in place (so the app retries the upgrade next boot) or leaves the new cluster fully in place, never a corrupt hybrid.

## Requirements

- **FR-11.1 Write-new-then-rename** The migration MUST write the new cluster into a fresh directory distinct from the canonical location, then move it into place with a single atomic `fs.rename`. The canonical location MUST never be written to incrementally.
- **FR-11.2 Crash safety** At every point before the final rename, the canonical location MUST still hold the original, openable cluster. At every point after the rename, it MUST hold the complete, validated new cluster. No observable intermediate state.
- **FR-11.3 Sibling staging directory** The new cluster is built in a sibling of the canonical location (default `<canonical>.new-<ISO-8601 timestamp>`) so the staging directory and the canonical location share a filesystem and the rename is atomic (see [Design](#design--approach)).
- **FR-11.4 Validation gates the swap** The swap MUST NOT happen unless post-migration validation passes (PGLM-7, [`13-post-migration-validation.md`](./13-post-migration-validation.md)). On validation failure, the staging directory is discarded and the canonical location is left untouched.
- **FR-11.5 Displaced-canonical retention** When swapping, the directory currently at the canonical location MUST be preserved (renamed aside to a timestamped name, e.g. `<canonical>.old-<timestamp>`), not deleted, so the swap itself is reversible. Deleting the displaced directory is a separate, opt-in step.
- **FR-11.6 Atomicity of the displacement** Moving the old canonical aside and moving the new cluster in MUST be ordered so that a crash between the two steps is recoverable: the canonical location either holds the original or the new cluster, and the displaced original is always findable.
- **FR-11.7 Stale staging cleanup** A failed or crashed run can leave a `.new-<ts>` staging directory behind. The tool MUST be able to detect and clean up stale staging directories from prior runs (and MUST NOT mistake one for a valid cluster).
- **FR-11.8 Same-filesystem requirement** The staging directory and the canonical location MUST be on the same filesystem. If they are not, the tool MUST detect this and either refuse or fall back to a non-atomic copy-then-replace with a clearly documented weaker guarantee (see [Design](#design--approach)).
- **FR-11.9 CLI surface** The CLI exposes swap behavior via flags (see [CLI surface](#cli-surface)) and reports the staging path, the swap, and the retained old path on stderr.
- **NFR-11.10 Cross-platform** Swap uses Node's `fs` APIs (`fs.rename`, `fs.stat`, `fs.rm`) — no shell-out. Rename semantics differ slightly across platforms (notably Windows; see [Design](#design--approach)); the implementation accounts for them.
- **NFR-11.11 No engine attached during the rename** The new cluster's engine MUST be closed (and the source engine closed) before any rename runs, so no process holds an open handle to a directory being moved. This matters especially on Windows, where renaming a directory with open handles fails.
- **NG-11.12 Not a transaction across both clusters** Atomic swap makes the *directory replacement* atomic; it does not make the data *transfer* a single transaction across two separate PGlite engines (that is impossible — they are independent clusters). Transfer integrity is the job of validation (PGLM-7); swap only guarantees all-or-nothing visibility of the result.
- **NG-11.13 Not in scope: in-place upgrade** This requirement never edits the on-disk format of the canonical cluster in place. The whole point is to avoid touching it until the new cluster is proven.

## Design / Approach

### Rename semantics and crash-safety reasoning

`fs.rename` (which maps to `rename(2)` on POSIX and `MoveFileEx`/`ReplaceFile` on Windows) is **atomic within a single filesystem**: the destination name flips from referring to the old inode to the new inode in one operation, with no observable partial state. That single property is the entire foundation of this design.

The safe sequence is:

1. **Stage.** Open a fresh new-major engine on the staging directory `<canonical>.new-<ts>`, create the target schema (host-app-driven in v1, or reconstructed — out of scope here), and run the migration into it. The canonical location is not touched.
2. **Close.** Close both engines (NFR-11.11) so no handle is open on the staging directory.
3. **Validate.** Run post-migration validation against the staged cluster (FR-11.4 / PGLM-7). If it fails, `fs.rm` the staging directory and stop — the canonical location was never touched.
4. **Swap.** Two ordered renames:
   - `rename(<canonical>, <canonical>.old-<ts>)` — move the original aside.
   - `rename(<canonical>.new-<ts>, <canonical>)` — move the new cluster into place.

Crash analysis of step 4:
- **Crash before either rename:** canonical = original (intact); staging = complete new cluster (recoverable on retry).
- **Crash after the first rename, before the second:** canonical does not exist, but `<canonical>.old-<ts>` (original) and `<canonical>.new-<ts>` (new) both exist. Recovery is deterministic — re-run completes the second rename, or restores `.old-<ts>` back to canonical. The window is a single rename wide, and both directories are intact and labeled.
- **Crash after the second rename:** canonical = new cluster (complete, already validated); `.old-<ts>` retained for rollback. Success.

> On platforms where `rename` can atomically replace a non-empty destination (POSIX), an alternative single-rename swap is possible if the displaced-original retention (FR-11.5) is handled by copying first — but the two-ordered-rename approach keeps the original on disk at all times and is preferred. The implementation should prefer the two-rename form for the recoverability guarantee.

### Where the canonical / staging / backup directories sit

- **Canonical** — the path the host app/operator opens (the CLI's target argument, or the app's configured data dir).
- **Staging** — a sibling: `<canonical>.new-<ISO-8601 timestamp>` (sanitized form `...new-2026-06-16T14-30-05Z`, `:` replaced, matching the convention in [`10-backup.md`](./10-backup.md) FR-10.3). Being a sibling guarantees same-filesystem (FR-11.3 / FR-11.8).
- **Displaced original** — a sibling: `<canonical>.old-<ISO-8601 timestamp>` (FR-11.5). This is distinct from the *source* backup of [`10-backup.md`](./10-backup.md): backup protects the source *before* anything runs; the displaced-original is a *post-swap* artifact of replacing the canonical location. See [Open Questions](#open-questions).

### Cross-filesystem caveat

Atomic rename holds **only within one filesystem.** Renaming across filesystems fails with `EXDEV` and, where libraries paper over it, degrades to a non-atomic copy-then-unlink — which reintroduces exactly the half-written-directory risk this requirement exists to eliminate. Mitigations:

- Default the staging and displaced-original directories to **siblings** of the canonical location so they are on the same volume by construction (FR-11.3).
- Before swapping, verify the staging directory and canonical location share a filesystem (compare `fs.stat().dev`, or attempt the rename and handle `EXDEV`).
- If a caller forces a staging/canonical pair on different volumes, **refuse by default** (clear error) rather than silently performing a non-atomic copy. A `--force-cross-fs` escape hatch may perform copy-then-replace with a documented weaker guarantee (FR-11.8). Needs a decision — see [Open Questions](#open-questions).

### Cleanup of stale temp dirs

A crash during staging leaves a `<canonical>.new-<ts>` directory. On a subsequent run the tool should:
- Detect sibling `.new-<ts>` directories and treat them as stale staging, not valid clusters (FR-11.7). They are never opened as the canonical cluster.
- Offer to remove them (`--clean-stale` or automatic removal of staging directories older than the current run), being careful never to remove a `.old-<ts>` retained original (that is a rollback artifact, governed by retention like [`10-backup.md`](./10-backup.md) FR-10.6).
- The recovery case (crash between the two renames) is distinguishable because the canonical location is missing while both `.old-<ts>` and `.new-<ts>` exist; this state triggers completion/rollback, not blind cleanup.

### Cross-platform considerations (Node `fs`)

- Use `node:fs/promises` (`fs.rename`, `fs.stat`, `fs.rm`, `fs.readdir`) — no shell-out, satisfying NFR-11.10.
- **Open handles (Windows):** close both PGlite engines before any rename (NFR-11.11); Windows refuses to rename a directory with open handles.
- **Replacing a non-empty destination:** POSIX `rename` can replace an empty dir but not a non-empty one; the two-ordered-rename design sidesteps this by emptying the canonical name (moving the original aside) before moving the new cluster in.
- **Filename safety:** sanitize ISO timestamps (`:` → `-`, drop sub-second) for `.new-`/`.old-` suffixes, as in [`10-backup.md`](./10-backup.md) FR-10.3 (NTFS rejects `:`).

## Interaction with existing code

- **`src/cli.ts`** — the swap is the final step of `run()`, after `migrate(...)` returns and **after** validation passes. Today `run()` opens `target` directly via `openDataDir(args.target, ...)` and migrates into it; under atomic swap, the CLI instead opens the engine on a **staging** path, migrates there, closes both engines (the existing `finally { source?.close(); target?.close(); }` block already closes them — the rename must run *after* that, so ordering changes), validates, then renames staging into `args.target`. New flags are parsed in `parseArgs` and threaded through `CliArgs`. The staging path, swap, and retained-old path are reported through the existing `CliIO.err` channel.
- **`src/version.ts`** — `readClusterVersion` is reused to detect that the canonical location is an old-major cluster worth upgrading (the host-app startup trigger) and, optionally, to sanity-check the staged cluster's `PG_VERSION` is the new major before swapping.
- **`src/loader.ts`** — `openDataDir` is pointed at the **staging** directory for the target engine instead of the canonical path. No change to its signature; only the path the caller passes changes.
- **New module** — a focused `src/swap.ts` exporting a single primary function (e.g. `swapIntoPlace({ canonical, staging, retainOld })` → resolved canonical path / retained-old path), per the one-primary-export-per-file convention. The pure path-derivation and ordering logic lives here so it is unit-testable independent of the CLI, and `src/index.ts` exports it so host apps can perform the swap programmatically after their own `migrate` + validate.
- **Composition with backup (`docs/10`, PGLM-4)** — backup protects the *source*; swap protects the *canonical/target* location. They are independent and stackable; neither depends on the other. The full safe sequence is: **backup source → migrate into fresh staging → validate → atomic-swap staging into canonical → retain displaced canonical as `.old-<ts>`.**
- **Composition with validation (`docs/13`, PGLM-7)** — validation runs against the staged cluster and **gates** the swap (FR-11.4). If validation fails, the staging directory is discarded (`fs.rm`) and the canonical location is left untouched. This is the only correct ordering: never swap an unvalidated cluster into the canonical location.

## CLI surface

Proposed flags for `src/cli.ts` (see [`4-cli.md`](./4-cli.md) NG-4.9, which currently lists atomic-swap as not-yet-implemented):

```
  --swap                  Migrate into a staging dir and atomically swap it into the target. (default: on)
  --no-swap               Migrate directly into the target (legacy v1 behavior; unsafe on crash).
  --staging-dir <path>    Staging location for the new cluster (default: <target>.new-<timestamp> sibling).
  --keep-old              Retain the displaced canonical directory as <target>.old-<timestamp>. (default: on)
  --no-keep-old           Delete the displaced canonical directory after a successful swap.
  --clean-stale           Remove stale .new-<timestamp> staging directories from prior failed runs.
  --force-cross-fs        Allow a staging/target pair on different filesystems (non-atomic; weaker guarantee).
```

Recommended defaults: **swap on by default** (safety-first; `--no-swap` reproduces the current direct-write behavior), and **retain the old canonical by default** (`--no-keep-old` to reclaim space). The library `swapIntoPlace` stays explicit so host apps compose it deliberately. See [Open Questions](#open-questions).

On a successful run the CLI prints, to stderr, the staging and swap details, e.g.:

```
Staged new cluster at /data/pgdata.new-2026-06-16T14-30-05Z
Validation passed; swapping into /data/pgdata
Retained previous cluster at /data/pgdata.old-2026-06-16T14-30-05Z
```

## Acceptance

- Running the CLI against a source with data and a target produces, in the canonical target location, the complete migrated cluster, openable by the new engine, while a `.old-<timestamp>` sibling holds the previous canonical contents.
- **Simulated mid-migration crash:** inject a failure during transfer (before the swap). After the failure, the canonical target location is **byte-for-byte identical** to its pre-run state and is openable by the appropriate engine; only a stale `.new-<timestamp>` staging directory remains, and it is never mistaken for the canonical cluster. Re-running succeeds.
- **Validation-gated swap:** force validation (PGLM-7) to fail. The swap does not happen, the canonical location is untouched and openable, and the staging directory is discarded with a clear error.
- **Crash between the two renames** (the one-rename-wide window): the canonical location is reconstructable — both `.old-<ts>` (original) and `.new-<ts>` (new) exist and are intact, and a recovery re-run completes the swap or restores the original.
- `--no-swap` reproduces direct-into-target behavior; `--staging-dir` redirects staging; `--no-keep-old` removes the displaced original after success; `--clean-stale` removes stale staging dirs but never a `.old-<ts>`.
- A staging/target pair on different filesystems is refused by default with a clear error (or, with `--force-cross-fs`, performs copy-then-replace with the weaker guarantee documented).

## Testing requirements

Per [`6-testing.md`](./6-testing.md): pure/extractable logic gets focused unit tests; anything touching a real cluster is proven end to end.

**Unit (`tests/*.test.ts`):**
- Staging and `.old-`/`.new-` path derivation from a canonical path (sibling, sanitized ISO timestamp, no illegal `:` characters).
- Two-rename ordering logic: given a fake `fs` (rename/stat/rm spies), assert the ordered sequence (move original aside → move new in) and that the new cluster is moved in only after the original is moved aside.
- Crash-window recovery decision: given the on-disk states (canonical present; canonical missing + both siblings present; canonical = new + `.old` present), assert the tool classifies each correctly (no-op / complete-or-rollback / success).
- Stale-staging detection: `.new-<ts>` directories are identified as staging and never returned as the canonical cluster; `.old-<ts>` is never selected for stale cleanup.
- Same-filesystem check / `EXDEV` handling: refuse (or fall back per `--force-cross-fs`) when staging and canonical differ by `dev`.
- CLI arg parsing for `--swap` / `--no-swap` / `--staging-dir` / `--keep-old` / `--no-keep-old` / `--clean-stale` / `--force-cross-fs` (extend the existing `parseArgs` tests).

**E2E (`tests/e2e/*.test.ts`):**
- Run a real migration through the two-version harness with swap enabled; assert the canonical target ends up with the migrated data and opens under the new engine, and a `.old-<ts>` sibling opens under the old engine.
- **Simulated mid-migration crash:** capture the canonical target's recursive file list + byte contents before the run; inject a transfer failure; assert the canonical location is unchanged and openable, and only a stale staging dir remains (proves FR-11.2 against a real engine).
- **Validation-gated swap:** force validation to fail and assert the canonical location is untouched and the staging dir is removed (proves FR-11.4 end to end once PGLM-7 lands).
- Round-trip after swap: open the swapped-in canonical cluster with the new engine and assert a post-migration insert receives an id past the migrated maximum (sequences survived the swap intact).

## Open Questions

- **Default-on vs. opt-in (recommend: on by default in the CLI).** Safety-first argues for swap by default with an explicit `--no-swap` for the legacy direct-write path. Recommendation: **on by default for the CLI**, explicit for the library API. Needs a human decision.
- **Retain displaced original by default? (recommend: yes).** Keeping `.old-<ts>` makes the swap reversible at the cost of disk. Recommendation: **retain by default**, with `--no-keep-old` to reclaim space and `--keep <n>`-style retention (shared with [`10-backup.md`](./10-backup.md) FR-10.6) to bound growth. Needs a human decision.
- **Backup vs. swap "retain old" — one mechanism or two?** Does the swap's `.old-<ts>` artifact subsume the pre-migration *source* backup (PGLM-4)? Recommendation: keep them **distinct** — the source backup is taken before anything runs; the displaced-original is a post-success artifact of replacing the canonical location. (Mirrors [`10-backup.md`](./10-backup.md) Open Questions; resolve jointly.)
- **Cross-filesystem behavior (recommend: refuse by default).** When staging/canonical are on different volumes, refuse with a clear error, or fall back to non-atomic copy-then-replace? Recommendation: **refuse by default**, `--force-cross-fs` opt-in with a documented weaker guarantee. Needs a decision.
- **Recovery on next run — automatic or prompted?** When the tool detects the crash-between-renames state, should it auto-complete/rollback, or require an explicit `--recover`/operator confirmation? Recommendation: detect and **report** by default, complete/rollback only with explicit intent (avoid surprising directory moves on a normal run). Needs a decision.
- **Two-rename vs. single replacing-rename.** On POSIX a single replacing `rename` is atomic; the two-rename form is chosen for the always-on-disk original (FR-11.5). Confirm the two-rename form is acceptable given its one-rename-wide recovery window, or require a different ordering. Confirm during implementation.

## Follow-up tickets

- **PGLM-5 (this doc):** Implement atomic swap (`src/swap.ts` + CLI wiring in `src/cli.ts`, export from `src/index.ts`); thread staging through the target engine open in `run()`.
- Crash-recovery handling for the between-renames window (detect `.old-<ts>` + `.new-<ts>` with missing canonical; complete or roll back). Could be its own ticket if it grows beyond the core swap.
- Stale-staging cleanup command/flag (`--clean-stale`) with retention shared with backup pruning ([`10-backup.md`](./10-backup.md) FR-10.6).
- Cross-filesystem `--force-cross-fs` copy-then-replace fallback with documented weaker guarantee (deferred; refuse by default first).
- Coordinate displaced-original retention with the source-backup retention model (PGLM-4, [`10-backup.md`](./10-backup.md)).
- Gate the swap on post-migration validation once PGLM-7 ([`13-post-migration-validation.md`](./13-post-migration-validation.md)) lands.
