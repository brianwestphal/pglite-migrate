# Changelog

All notable changes to **pglite-migrate** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Initial development release. The app-driven, data-only migration path
  (introspect → topological sort → COPY-text transfer → sequence realignment)
  runs end to end across a real PG17 → PG18 pair, alongside standalone schema
  reconstruction, FK-cycle handling, and the backup / dry-run / validation /
  atomic-swap safety layer.

## [1.0.0] - 2026-06-20


Updated gitgist to 1.0.0

## [0.0.2] - 2026-06-17


- Validation can now optionally throw on failure instead of only reporting (opt-in)
- Backup retention via `--keep <n>` to prune older backups automatically
- Schema reconstruction gains an `onUnsupported` option for handling out-of-scope objects

## [0.0.1] - 2026-06-17


- COPY-text data transfer for higher fidelity, with a per-table INSERT fallback
- Correct row ordering and cyclic foreign keys via topological sort + deferred constraints
- Standalone schema reconstruction (`--reconstruct-schema`) rebuilds app-class DDL
- Safety layer: source backup, atomic swap, `--dry-run`, and post-migration validation
- Re-run safety via `onExisting`, plus generated/identity column support
- Fixed a public-schema foreign-key bug that broke insert ordering and cycles
- Verified cross-major migrations against real PG17 → PG18 PGlite engines
