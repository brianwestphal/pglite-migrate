# Changelog

All notable changes to **pglite-migrate** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Initial development release. The app-driven, data-only migration path
  (introspect → topological sort → COPY-text transfer → sequence realignment)
  runs end to end across a real PG17 → PG18 pair, alongside standalone schema
  reconstruction, FK-cycle handling, and the backup / dry-run / validation /
  atomic-swap safety layer.
