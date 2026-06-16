# 7 — COPY-text Data Transfer

**Status: deferred / planned.** Tracked as PGLM-1 (the implementation of `NFR-2.15` from [`2-data-migration.md`](2-data-migration.md)). The v1 row-by-row `INSERT` path ships and is correct for the common case; this document specifies the fidelity upgrade and the spike that must precede it.

## Motivation / Problem

The v1 transfer path (`transferTable` in [`src/transfer.ts`](../src/transfer.ts)) reads rows from the source with `SELECT` and re-inserts them into the target with parameterized `INSERT`. Every value therefore round-trips through a JavaScript representation: source text → PGlite's JS deserialization → JS value → PGlite's JS serialization → target storage. Any time that round trip is not the identity function, the migrated value can differ from the source.

`NFR-2.15` originally listed `json`/`jsonb`, `numeric`, `bytea`, and array types as at-risk. **Empirical testing in this session narrows that list sharply.** Comparing the Postgres `::text` rendering of each column on the source vs. the target across two PGlite engines (see [`tests/e2e/fidelity.test.ts`](../tests/e2e/fidelity.test.ts)) shows the current path **already preserves**, exactly:

- `jsonb` (canonicalized identically on both sides, so JS round-trip is a no-op),
- `numeric` (full precision and scale; no float coercion observed),
- `bytea` (byte-for-byte),
- `integer[]` and `text[]` (elements, order, embedded NULLs, commas, and quotes).

The **only** observed fidelity loss is plain **`json`** (not `jsonb`). Postgres stores a `json` value as the *exact input text*, whitespace and key order included; round-tripping it through JS re-serializes it and discards that text. For example a source value of `{"b":1,  "a":2}` is stored verbatim by Postgres but arrives at the target as `{"b":1,"a":2}` — same semantic value, different bytes.

So the corrected, narrowed scope is:

- **Confirmed-lost today:** plain `json` source text (whitespace, key order, duplicate-key text).
- **Already correct today:** `jsonb`, `numeric`, `bytea`, `int[]`, `text[]`.
- **Plausibly at risk but unconfirmed:** other text-significant or exotic types not yet exercised (e.g. `xml`, `money`, ranges, `citext`, domains, composite/row types, `tsvector`, geometric types, `interval` display variants). The COPY-text path is the general fix for *all* of these, not only the one confirmed case.

The general fix is to stop round-tripping values through JS at all: keep each value in **Postgres's own text representation** end to end, so the source engine emits exactly the bytes the target engine will re-parse. That is what `COPY … TO/FROM` in TEXT format does.

## Goal

Add a transfer path that copies a table by streaming its rows in Postgres **COPY TEXT** format directly from the source engine to the target engine:

```
COPY <table> (<cols>) TO STDOUT          -- on source, TEXT format
COPY <table> (<cols>) FROM STDIN         -- on target, TEXT format, fed the source's output
```

No value is ever converted to a JS value in between; the text payload produced by the source's `COPY … TO STDOUT` is handed verbatim to the target's `COPY … FROM STDIN`. This preserves `json` source text and provides general fidelity insurance for the unconfirmed-but-at-risk types above, with the additional benefit of being far faster than per-row `INSERT` for large tables.

## Requirements

### Spike (must precede implementation)

- **FR-7.1 (spike) COPY capability across two majors.** Before any implementation, run a spike that confirms PGlite supports server-side COPY through whatever API surface it exposes, on **both** engine aliases (`pglite-old` and `pglite-new` — see [`6-testing.md`](6-testing.md)). The spike must determine, for each engine:
  - which call shape works — e.g. `query("COPY … TO STDOUT")` returning the payload, a dedicated `copyTo` / `copyFrom` method, or a blob/`Blob` parameter on `query`/`exec` (PGlite has historically used a `blob` option on `query` for COPY);
  - the data type of the COPY payload (string vs. `Blob`/`Uint8Array`) and whether it must be passed back through the same shape on the target;
  - that a payload produced by `COPY … TO STDOUT` on `pglite-old` can be consumed by `COPY … FROM STDIN` on `pglite-new` unchanged.
- **FR-7.2 (spike) TEXT format, not BINARY.** The spike and implementation use COPY **TEXT** format (the default), not BINARY. BINARY format is not guaranteed wire-compatible across Postgres majors and defeats the cross-major goal; TEXT format is the portable, human-auditable representation. CSV format is also out of scope (TEXT's escaping rules are simpler and lossless for our needs).
- **FR-7.3 (spike) Record findings.** The spike's findings (working API shape per engine, payload type, any version differences) must be written back into this document before the implementation ticket is closed, so the chosen approach is captured next to its rationale.

### Transfer behavior

- **FR-7.4 COPY-text transfer for a table.** `transferTable` (or a new helper it delegates to) copies a table by issuing `COPY <qualified> (<colList>) TO STDOUT` on the source, capturing the TEXT payload, and issuing `COPY <qualified> (<colList>) FROM STDIN` on the target fed with that exact payload. The explicit column list must match the introspected column order (`TableInfo.columns`, physical `attnum` order — `FR-2.6`) on both sides so columns line up positionally.
- **FR-7.5 Identifier quoting.** All schema/table/column identifiers spliced into the COPY statements go through the existing helpers in [`src/ident.ts`](../src/ident.ts) (`quoteIdent`, `quoteQualified`), consistent with the rest of the codebase — no ad-hoc interpolation.
- **FR-7.6 NULL handling.** Rely on COPY TEXT's native NULL marker (the unquoted token `\N` by default) rather than any JS-level null substitution. Because the payload is never deserialized in JS, NULLs are carried as-is in the text stream. Do **not** override the `NULL` option unless the spike shows a cross-version mismatch in the default marker.
- **FR-7.7 Escape format is COPY's, not ours.** The library must not parse, rewrite, or re-escape the COPY TEXT payload. COPY TEXT's escaping (tab-delimited columns; backslash escapes for tab, newline, carriage return, backslash, and `\N`) is produced by the source engine and consumed by the target engine; treating the payload as an opaque blob between the two engines is what guarantees fidelity. The only thing the library constructs is the two `COPY` statements (table + column list).
- **FR-7.8 Generated and identity columns.** Columns that the target cannot accept a value for under normal COPY must be handled explicitly:
  - **`GENERATED ALWAYS AS (…) STORED`** (computed) columns: exclude them from the COPY column list. Their values are recomputed by the target from the other columns; attempting to supply them errors. (This matches the v1 `INSERT` behavior's assumptions and must be made explicit here.)
  - **`GENERATED ALWAYS AS IDENTITY`** columns: a plain `COPY … FROM` supplies the stored value directly and does **not** trip the `GENERATED ALWAYS` insert guard (unlike `INSERT`, which needs `OVERRIDING SYSTEM VALUE`), so identity values transfer verbatim. The spike must confirm this holds on both engines; if it does not, the COPY statement must add the appropriate override or the column must be set via the sequence-realignment path (`applySequences`, `FR-2.13`).
  - Introspection currently does not flag generated/identity columns; see Follow-up tickets and Open Questions.
- **FR-7.9 Empty tables.** A table with zero rows must be a no-op that still reports `rowsCopied: 0` and fires `onProgress` once, matching current `transferTable` semantics (`FR-2.12`, `FR-2.3`).
- **FR-7.10 Row count reporting.** `TableResult.rowsCopied` must remain accurate. With COPY, the row count comes from the target's COPY result (rows affected) or from counting payload lines; the spike determines which is reliable. The returned `MigrationReport` shape (`FR-2.16`) is unchanged.

### Fallback

- **FR-7.11 Per-table fallback to INSERT.** If COPY is unsupported for a given table (e.g. the spike reveals an engine, version, or type combination where COPY fails), the transfer falls back to the existing row-by-row `INSERT` path for **that table** and records a warning in `MigrationReport.warnings` naming the table and reason. Fallback is per-table, not global, so one unsupported table does not force every table back onto the slow path.
- **FR-7.12 INSERT path is retained, not deleted.** The current `INSERT` implementation remains in the codebase as the fallback (`FR-7.11`) and as the path for environments where COPY is unavailable. COPY-text **augments** the transfer; it does not remove the existing behavior.

### Non-functional / non-goals

- **NFR-7.13 No new runtime dependency.** The COPY payload is moved with built-in primitives (string or `Blob`/`Uint8Array`, per the spike). No streaming/copy library is added; PGlite is and stays a peer dependency (`NFR-1.6`).
- **NFR-7.14 Cross-major portability preserved.** The COPY statements use only stable, version-agnostic syntax (`COPY <table> (<cols>) TO STDOUT` / `FROM STDIN`, TEXT format), consistent with the catalog-query portability rule (`NFR-2.9`).
- **NG-7.15 Not BINARY/CSV COPY.** See `FR-7.2`. Only COPY TEXT is in scope.
- **NG-7.16 Not a streaming/chunked API.** v1 of this path may buffer a table's COPY payload in memory in one piece (the same memory profile as today's "`SELECT` all rows"). True streaming/back-pressure for very large tables is a separate, later concern — file as a follow-up if it becomes necessary.
- **NG-7.17 Not a fix for cross-major *semantic* changes.** COPY-text preserves the source's text representation; it does not reconcile cases where a type's *meaning* or accepted text changed between majors. Such cases (if any arise) are out of scope here and would be handled per-type.

## Design / Approach

1. **Spike first (`FR-7.1`–`FR-7.3`).** Establish the working COPY call shape on both aliases and the payload type. Everything below is contingent on the spike.
2. **A new internal helper.** Add e.g. `transferTableCopy(source, target, table, onProgress?)` alongside `transferTable` in [`src/transfer.ts`](../src/transfer.ts). It builds the two COPY statements from `TableInfo` (using [`src/ident.ts`](../src/ident.ts)), runs `COPY … TO STDOUT` on `source`, hands the opaque payload to `COPY … FROM STDIN` on `target`, and returns a `TableResult`.
3. **`transferTable` becomes a dispatcher.** `transferTable` tries the COPY helper and, on an unsupported-COPY error, falls back to the existing INSERT body for that table (`FR-7.11`/`FR-7.12`), pushing a warning. Keeping the public function name stable means [`src/migrate.ts`](../src/migrate.ts) (the orchestrator) needs no change to its call site.
4. **Column list from introspection.** Reuse the existing `table.columns` ordering; once generated/identity flags exist in introspection, filter generated-stored columns out of the COPY column list (`FR-7.8`).
5. **Opaque payload.** Between the two `query`/`copyTo`/`copyFrom` calls the payload is never inspected — this is the core property that delivers fidelity (`FR-7.7`).
6. **Sequences unchanged.** Sequence realignment (`applySequences`, `FR-2.13`) is independent of the row-copy mechanism and is untouched.

## Interaction with existing code

- [`src/transfer.ts`](../src/transfer.ts) — `transferTable` is modified to dispatch COPY-with-INSERT-fallback; the new `transferTableCopy` helper lives here. `topologicalSort` and `applySequences` are unchanged.
- [`src/migrate.ts`](../src/migrate.ts) — the orchestrator's call into `transferTable` is unchanged; warnings from per-table fallback flow into the existing `MigrationReport.warnings` array (`FR-2.16`).
- [`src/introspect.ts`](../src/introspect.ts) — must be extended to surface generated/identity column attributes (`pg_attribute.attgenerated`, `pg_attribute.attidentity`) so the column list can exclude generated-stored columns (`FR-7.8`). This is the one introspection change required.
- [`src/types.ts`](../src/types.ts) — `ColumnInfo` gains the generated/identity flags (SSOT for shapes).
- [`src/ident.ts`](../src/ident.ts) — reused as-is for quoting in COPY statements (`FR-7.5`).
- No change to [`src/index.ts`](../src/index.ts)'s public surface is required; `transferTable` keeps its signature.

## Acceptance

- The `json`-verbatim case in [`tests/e2e/fidelity.test.ts`](../tests/e2e/fidelity.test.ts) — currently `it.fails('preserves json source text verbatim (whitespace) — PGLM-1', …)` — passes once this lands; the test is flipped from `it.fails` to `it`.
- The already-passing fidelity cases (`jsonb`, `numeric`, `bytea`, `int[]`, `text[]`) continue to pass.
- The full app-driven round-trip acceptance from [`2-data-migration.md`](2-data-migration.md) (related tables in FK-safe order, `timestamptz` preserved, sequence realigned past the migrated max) continues to pass with COPY as the row-copy mechanism.
- A table whose COPY is forced to fail falls back to INSERT, migrates correctly, and produces a warning naming the table (`FR-7.11`).
- Generated-stored and identity columns migrate to the correct values (`FR-7.8`).

## Testing requirements

Per the project's double-coverage philosophy ([`6-testing.md`](6-testing.md), `CLAUDE.md`): pure logic gets focused unit tests; anything touching a real cluster is proven end to end against real PGlite. There is no meaningful DB mock — the interaction *is* the system under test.

**Unit**

- COPY-statement construction: given a `TableInfo`, assert the exact `COPY … TO STDOUT` / `FROM STDIN` SQL (correct qualified name, column list, identifier quoting, generated-stored columns excluded). This is the extractable pure logic.
- Fallback selection: assert that an unsupported-COPY signal routes a table to the INSERT path and records a warning (can be exercised with an injected `PGliteLike` whose COPY call throws).
- Introspection of generated/identity flags (against an in-memory `new PGlite()`, consistent with the existing `introspect.test.ts` pattern).

**E2E (two-version round-trip)**

- Flip the existing `json`-verbatim case in `tests/e2e/fidelity.test.ts` to a passing `it` and keep the other fidelity assertions green.
- Add fidelity assertions for at least one currently-unconfirmed at-risk type once exercised (e.g. `xml` or `money`), comparing `::text` source vs. target.
- A table forced onto the INSERT fallback still round-trips correctly and the warning is asserted.
- Generated-stored and identity columns assert correct target values after migration.
- Re-run against both aliases; when a genuine second major ships (`FR-6.2`), the same suite becomes the real cross-major fidelity proof.

## Open Questions

- **OQ-7.1 — PGlite's COPY API shape.** Which exact call works (`query("COPY … TO STDOUT")` returning a payload, a `blob` option, or `copyTo`/`copyFrom`), and is it identical across the two majors? *Recommended default:* resolve in the spike (`FR-7.1`); prefer the simplest shape that works identically on both engines, and abstract it behind the `transferTableCopy` helper so a per-engine difference stays contained.
- **OQ-7.2 — Payload type (string vs. Blob).** Is the COPY payload a string or a binary `Blob`/`Uint8Array`? *Recommended default:* whatever the source emits, pass back to the target verbatim without conversion; never decode it to inspect it.
- **OQ-7.3 — Identity-column override.** Does `COPY … FROM STDIN` populate `GENERATED ALWAYS AS IDENTITY` columns without an explicit override on both engines? *Recommended default:* assume yes (COPY bypasses the `INSERT` guard), verify in the spike, and add `OVERRIDING SYSTEM VALUE`-equivalent handling only if a target rejects the value.
- **OQ-7.4 — Should COPY become the default, or opt-in?** *Recommended default:* make COPY the default once the spike confirms support on both engines, with automatic per-table fallback to INSERT (`FR-7.11`); do not add a user-facing flag in v1 (avoid speccing UI without need — see `CLAUDE.md`).
- **OQ-7.5 — In-memory buffering of large tables.** Buffering a whole table's COPY payload mirrors today's "`SELECT` all rows" memory profile, but a chunked/streaming COPY would scale better. *Recommended default:* buffer in v1 (`NG-7.16`); file a follow-up for streaming if a real workload hits a memory ceiling.
- **OQ-7.6 — Scope of generated/identity introspection.** How much of the column-attribute matrix to surface (just `attgenerated`/`attidentity`, or also defaults)? *Recommended default:* add only `attgenerated` and `attidentity` now — the minimum needed for `FR-7.8` — and defer broader column metadata to the schema-reconstruction work ([`3-schema-reconstruction.md`](3-schema-reconstruction.md)).

## Follow-up tickets

- **Streaming COPY for large tables** — chunked/back-pressured transfer if buffering proves insufficient (`NG-7.16`, `OQ-7.5`).
- **Fidelity coverage for additional at-risk types** — extend `tests/e2e/fidelity.test.ts` to `xml`, `money`, ranges, composite types, etc., as they are encountered.
- **Generated/identity column introspection** — the `ColumnInfo` + `introspectSchema` extension (`FR-7.8`), which also feeds [`3-schema-reconstruction.md`](3-schema-reconstruction.md); may be split out if it lands ahead of the COPY work.
