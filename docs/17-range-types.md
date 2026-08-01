# 17 — Range Types

**Status: Implemented (PGLM-95).** The detailed spec for the last custom-type kind. Completes the category opened by [`16-custom-types.md`](16-custom-types.md), which brought enums, domains and composites into scope and left ranges reported-only under **NG-16.9**.

Relationship to the other docs: [`3-schema-reconstruction.md`](3-schema-reconstruction.md) is the overview and holds the scope line (NG-3.5), [`9-standalone-schema-reconstruction.md`](9-standalone-schema-reconstruction.md) is the reconstruction engine's spec, [`16-custom-types.md`](16-custom-types.md) covers the other three type kinds, and this doc covers ranges.

## Why ranges were held back

PGLM-92 settled the custom-type scope question on "trivially derivable". Ranges *look* like they qualify — `pg_range` exposes everything in one row — but two of its columns are **function** references, and functions are firmly out of scope (NG-9.10):

| `pg_range` column | What it is | Reconstructable? |
| --- | --- | --- |
| `rngsubtype` | the element type | yes — `format_type` |
| `rngcollation` | collation for the subtype | yes — same treatment as a domain's `COLLATE` (doc 16) |
| `rngsubopc` | subtype operator class | yes, and usually the default, in which case it is omitted |
| `rngmultitypid` | the auto-created multirange type | yes — its *name*, see below |
| `rngcanonical` | **function** that canonicalizes a range | **no** |
| `rngsubdiff` | **function** giving the difference between two subtype values | **no** |

A second, independent obstacle turned up when probing: Postgres itself refuses to create a canonical range in one statement.

```
CREATE TYPE canonrange AS RANGE (subtype = integer, canonical = my_canon);
ERROR:  cannot specify a canonical function without a pre-created shell type
```

The canonical function's signature references the range type, so the real DDL is a three-step dance — `CREATE TYPE name;` (shell), then the function, then `CREATE TYPE name AS RANGE (…)`. That is not a single emittable statement even if functions *were* in scope. So the split below is forced by the type system, not just by policy.

## Requirements

- **FR-17.1 Function-free ranges are reconstructed.** A range whose `rngcanonical` and `rngsubdiff` are both `0` is emitted as `CREATE TYPE … AS RANGE (…)`. This is the overwhelmingly common case — `CREATE TYPE intrange AS RANGE (subtype = integer)` and anything like it.
- **FR-17.2 Function-bearing ranges are reported, not emitted.** When either function reference is non-zero the range is left in `ReconstructionReport.unsupported`, so it is never silently dropped (FR-9.6). It is the only remaining custom-type case that is reported.
- **FR-17.3 The subtype's collation is emitted** when the range declares one, on the same reasoning as a domain's `COLLATE` in [`16-custom-types.md`](16-custom-types.md) § Collation: dropping it would silently change ordering semantics for every value of the type.
- **FR-17.4 A non-default subtype operator class is emitted;** the default one is omitted. `pg_opclass.opcdefault` distinguishes them. Emitting the default would be noise, and naming an opclass that the target resolves differently is a risk for no benefit.
- **FR-17.5 The multirange type name is emitted explicitly.** Postgres auto-creates a multirange type alongside every range (PG14+) and derives its name. The derivation is not worth reimplementing, and a source may have overridden it with `multirange_type_name`, so the actual name from `pg_range.rngmultitypid` is always passed through.
- **FR-17.6 Multirange types are never emitted as types in their own right.** They have `pg_type.typtype = 'm'` and are created implicitly by the `CREATE TYPE … AS RANGE` above. Emitting one directly would fail, and reporting one as unsupported would be wrong — it is not missing. This mirrors NFR-16.8's exclusion of every table's implicit composite row type.
- **FR-17.7 Reported ranges say why.** The unsupported entry names the range and the fact that it depends on a canonical/subdiff function, so an operator can tell it apart from a kind that is simply out of scope.
- **NFR-17.8 Ordering is unchanged.** Ranges join the single `pg_type.oid`-ordered pass from `docs/16` NFR-16.7. A range's subtype may be a domain or enum (verified: `CREATE TYPE domrange AS RANGE (subtype = posint)` yields a higher OID than `posint`), so OID order already places it correctly with no structural change.

## Emitted DDL

```sql
CREATE TYPE <qualified> AS RANGE (
  subtype = <format_type(rngsubtype, NULL)>
  [, collation = <collation>]
  [, subtype_opclass = <opcname>]     -- only when not the subtype's default
  , multirange_type_name = <name>
);
```

## Interaction with existing code

- **`src/reconstruct.ts`** — `reconstructCustomTypes` gains `'r'` in its `typtype` filter and a `LEFT JOIN pg_range`; the range branch emits the statement above. `detectUnsupported`'s range detector narrows from *all* ranges to only those with a canonical or subdiff function.
- **`src/types.ts`** — `ReconstructionReport` gains `ranges: string[]`.
- Everything else is untouched. Range values have a stable text representation, so the COPY-text data path ([`7-copy-text-transfer.md`](7-copy-text-transfer.md)) already carries them.

## Acceptance

- `CREATE TYPE intrange AS RANGE (subtype = integer)` reconstructs, accepts a value on the target, and is **absent** from `unsupported`.
- A range over a **domain** subtype reconstructs, proving the OID ordering (NFR-17.8).
- A range with a non-default collation carries it.
- The auto-created multirange type is usable on the target and appears in **neither** `ranges` nor `unsupported`.
- A canonical-bearing range is reported with its reason and not emitted.

## Testing

Per [`6-testing.md`](6-testing.md): unit cases in `tests/reconstruct.test.ts` for each acceptance bullet. No e2e addition — `docs/16` already put a domain and a composite in the standalone cross-major fixture, which proves the custom-type pass end to end; a range would exercise the same code path for a type that is rare in the schemas this tool targets.

### A canonical range cannot be built in PGlite at all

Worth recording, because it makes FR-17.2 **defensive rather than reachable**. A canonical function has to accept the range's own shell type, and every language available in PGlite refuses:

| Language | Result |
| --- | --- |
| `sql` | `SQL function cannot accept shell type r_sql` |
| `plpgsql` | `PL/pgSQL functions cannot return type r_plpgsql` |
| `internal` / `c` | needs a real C function; unavailable in WASM |

So no PGlite-authored source can contain one through supported DDL. The filter is kept anyway — it costs one `AND`, and a catalog can arrive in that state by other means — but its test constructs the catalog row directly (`allow_system_table_mods`, then `UPDATE pg_range`) rather than pretending a user could reach it via DDL. The test says so.

### Range types auto-create five functions

`CREATE TYPE … AS RANGE` also creates constructor functions — `intrange(int,int)`, `intrange(int,int,text)`, and three `intmultirange(…)` overloads. They live in `pg_proc` in the user's schema, so the unsupported-object detector reported all five as user functions: a phantom warning on every source declaring a range.

They are distinguishable by an **INTERNAL** (`deptype = 'i'`) `pg_depend` entry pointing at their type, exactly as the implicit composite row type is distinguishable by its `pg_class` relkind. The function detector now excludes them. This was a pre-existing defect in the detector that only a range could expose.

## Follow-up

- **Canonical/subdiff ranges** stay reported. Reconstructing them means emitting a shell type, a function, and then the range — i.e. entering the function-reconstruction long tail that `docs/3` NG-3.5 exists to keep out. Revisit only if a real schema needs it, and treat it as a scope change rather than a bug fix.
