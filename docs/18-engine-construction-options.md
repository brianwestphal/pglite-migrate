# 18 — Engine construction options

**Status: Implemented (PGLM-100, PGLM-102).** Refines **FR-4.x** engine loading from [`4-cli.md`](./4-cli.md) and the loader contract described in [`15-engine-acquisition.md`](./15-engine-acquisition.md). Adds `OpenOptions.pgliteOptions` to `openDataDir`, the `--source-database` / `--target-database` CLI pair, and the general `--source-option` / `--target-option` form.

## The problem

`openDataDir` constructed the engine as `new PGlite(dataDir)` and offered no way to pass PGlite's own constructor options. Any host application that opens its cluster with non-default options therefore could not use `openDataDir` at all — it had to hand-roll the dynamic import and construction, reimplementing the resolve-then-acquire logic `openDataDir` exists to provide.

The motivating case is the **working database**. PGlite **0.4.0 changed the default working database from `template1` to `postgres`**. A cluster written by an older PGlite keeps its tables in `template1`, and to keep opening them the host must pin `new PGlite(dir, { database: 'template1' })`. Point `openDataDir` at such a directory and it opens the (empty) default database instead; the cluster is completely intact, but every query fails with:

```
relation "reviews" does not exist
```

That is the worst shape a failure can take here: it looks like data loss, and it is not. The migration then either transfers nothing (an empty source introspects to zero tables, so `migrate` reports `0 rows across 0 tables` and *succeeds*) or fails with an error that points at the schema rather than at the connection.

`database` is what motivated this, but the gap is general — the same applies to `relaxedDurability`, `extensions`, `debug`, and anything else the engine accepts.

## Requirements

- **FR-18.1 Constructor passthrough** `OpenOptions` carries `pgliteOptions?: Record<string, unknown>`, forwarded verbatim as the PGlite constructor's second argument. **Implemented.**
- **FR-18.2 Both construction sites** The passthrough applies on the **resolved** path (an engine found in `node_modules`) *and* the **acquired** path (`fetchMissingEngine`, via `openAcquired`). A host that relies on `database` on one path and not the other would fail in exactly the situation acquisition exists for. **Implemented**, and pinned by a test on each path.
- **FR-18.3 Exact no-op when omitted** Omitting `pgliteOptions` constructs the engine with a **single argument**, not an explicit `undefined` second one, so existing callers get byte-identical behavior. **Implemented** (`construct()` in `src/loader.ts` branches rather than always passing two arguments).
- **FR-18.4 CLI database selection** `--source-database <db>` and `--target-database <db>` set `pgliteOptions.database` for their side. Without either flag the CLI passes no options object at all, preserving FR-18.3 for the common invocation. **Implemented.**
- **NFR-18.5 No coupling to a PGlite version** The option bag is typed `Record<string, unknown>`, not against PGlite's own `PGliteOptions`. The core never imports `@electric-sql/pglite` (that is what allows two majors side by side — see [`ARCHITECTURE.md`](./ARCHITECTURE.md)), and the accepted option set legitimately differs between the two engine versions a cross-major run holds open at once. Validation is PGlite's job; it ignores keys it does not know.
- **NFR-18.6 Distinct key, no merging** `pgliteOptions` is a separate key rather than a spread of `OpenOptions` itself, so this library's options (`fetchMissingEngine`, `cache`, `cacheDir`, `major`, `release`, `registryUrl`) can never collide with the engine's, and a reader can tell at a glance which belong to which. **Implemented.**
- **FR-18.9 General CLI option passthrough** `--source-option <k=v>` / `--target-option <k=v>`, repeatable, set arbitrary keys on their side's `pgliteOptions`. `--source-database` is exactly sugar for `--source-option database=<v>` — both write the same key, so precedence is plain argv order with no special case. **Implemented (PGLM-102).**
- **FR-18.10 Value coercion is JSON-with-string-fallback** A `--source-option` value is read as JSON when it parses as JSON, and as the literal string otherwise. So `relaxedDurability=true` is a boolean, `debug=1` a number, `x=null` null, `nested={"a":1}` an object — while `database=template1` and `dataDir=/var/lib/pg` stay strings. The pair splits on the **first** `=`, so a value may contain one. A missing `=` or an empty key is an error, not a silently-ignored flag. **Implemented (PGLM-102).**
- **NG-18.7 Not a connection-string parser** No URL/DSN form and no per-key type table. Coercion is one uniform rule (FR-18.10), not per-option knowledge of PGlite's signature — which the library deliberately does not have (NFR-18.5) and which differs between the two majors a cross-major run holds open at once.
- **NG-18.11 Not full CLI/library parity** Options taking JavaScript *values* — `extensions`, most obviously, which takes module objects — cannot be expressed on a command line by any textual encoding. `--help` says so rather than implying the CLI can reach everything `pgliteOptions` can.
- **NG-18.8 Not auto-detection** The library does **not** probe for a `template1`-era cluster and silently switch databases. Which database holds the host's data is the host's knowledge, and guessing it would make a migration's source ambiguous. The CLI's `--help` names the 0.4.0 change so an operator hitting the symptom can recognize it.

## Design

`src/loader.ts` gains one helper, used by both construction sites:

```ts
function construct(
  mod: unknown,
  modulePath: string,
  dataDir: string,
  pgliteOptions: Record<string, unknown> | undefined,
): OpenedCluster {
  const Engine = constructorFrom(mod, modulePath);
  return pgliteOptions === undefined ? new Engine(dataDir) : new Engine(dataDir, pgliteOptions);
}
```

`constructorFrom`'s return type widened from `new (dir: string) => OpenedCluster` to a named `PGliteConstructor` taking the optional second argument. Nothing else in the loader changed: resolution is still tried first, acquisition is still opt-in and still reached only through the dynamic import, and the `acquired` / `cleanup` wiring on the acquired path is untouched.

On the CLI side, `parseArgs` accumulates `sourceOptions` / `targetOptions` lazily — they stay `undefined` until a flag writes the first key, so the flagless invocation still reaches `construct` with `undefined` and satisfies FR-18.3. `openOptions(args, major, pgliteOptions?)` passes the bag straight through.

### Why JSON-with-string-fallback (FR-18.10)

Three encodings were weighed:

1. **JSON per value** *(chosen)* — `JSON.parse` the value, fall back to the raw string when it does not parse. Covers every scalar PGlite takes with syntax operators already know, and degrades usefully: a bare word is the string it looks like.
2. **One whole JSON object** — `--source-pglite-options '{"relaxedDurability":true}'`. Unambiguous, but pushes shell-quoting pain onto the single most common case (`database=template1`) to serve the rare one.
3. **A named flag per option** — repeating the `--source-database` pattern. Precise, but it grows with PGlite's option set and would need tracking across two majors, which is exactly the coupling NFR-18.5 exists to avoid.

Option 1 leaves one ambiguity: a value whose text happens to be valid JSON but is meant as a string. That is why the rule falls back to the raw string rather than rejecting a failed parse, and why an explicit JSON string is the escape hatch — `--source-option label='"true"'` yields the string `true`. Documented in `--help` and pinned by a test.

Getting coercion wrong here would fail *quietly* — PGlite ignores options it does not recognize, so a mis-typed value looks like it worked — which is why the rule is one line of behavior with tests on every branch rather than a heuristic.

### What this replaces

Before, a host with non-default options had to write this itself — and remember the `cleanup()` the loader would otherwise own:

```js
const acq = await acquireEngine(await readClusterVersion(dir), { cache: 'ephemeral' });
const mod = await import(pathToFileURL(acq.entry).href);
const db  = new mod.PGlite(dir, { database: 'template1' });
await db.waitReady;
// …and call acq.cleanup() afterward
```

Now:

```js
const db = await openDataDir(dir, '@electric-sql/pglite', {
  fetchMissingEngine: true,
  pgliteOptions: { database: 'template1' },
});
// db.close() releases the acquired engine too
```

## CLI

```
--source-database <db>  Database to open on the source (PGlite's own default otherwise).
--target-database <db>  Database to open on the target (PGlite's own default otherwise).
--source-option <k=v>   Any other PGlite constructor option for the source. Repeatable.
--target-option <k=v>   Any other PGlite constructor option for the target. Repeatable.
```

`--help` carries the explanatory note, since the symptom (`relation "…" does not exist` against a directory that plainly has data in it) does not point at the cause on its own:

> PGlite 0.4.0 changed the default working database from template1 to postgres. If a cluster was written by an older PGlite, its tables live in template1 and a default open finds nothing — pass `--source-database template1` for that side.

## Testing

Per [`6-testing.md`](./6-testing.md):

- **`tests/loader.test.ts`**
  - Seeds a real data directory whose table lives in `template1`, then opens it with `pgliteOptions: { database: 'template1' }` and reads the rows back (FR-18.1).
  - The paired negative: the same directory opened *without* the option raises `relation "legacy" does not exist` — the exact reported bug, pinned so a regression is unambiguous.
  - The acquired path forwards the same options (FR-18.2), asserted against the synthetic engine in `tests/engines/fixtures.ts`, which now records the options it was constructed with.
  - Omitting `pgliteOptions` constructs with `arguments.length === 1` (FR-18.3) — checking `options === undefined` would not distinguish "no second argument" from "an explicit `undefined`".
- **`tests/cli.test.ts`** — `parseArgs` maps the two database flags; and a real `run()` migration of a `template1`-era source that transfers **0 rows without the flag** and all 4 rows with it (FR-18.4). The zero-row half is the important assertion: it shows the failure mode is a silent success, not an error.
- **`tests/cli.test.ts`, `--source-option` (FR-18.9/FR-18.10)** — every branch of the coercion rule: JSON scalars (`true` / `false` / `1` / `1.5` / `null`), objects and arrays, non-JSON values left as strings (including the empty value), the `'"true"'` string escape hatch, splitting on the *first* `=` so `conn=host=local` survives, repeatability accumulating per side independently, `--source-database` losing to a later `--source-option database=` and vice versa, and the `nokey` / `=novalue` errors. Plus a real `run()` migration driven through the general form.
- **The acquired path is covered at the loader, not the CLI.** `--fetch-missing-engine` has no registry-URL flag to point at a test server, so a CLI-level acquired-path test is not expressible; `tests/loader.test.ts` pins that `pgliteOptions` reaches the acquired construction site (FR-18.2), and the CLI's only job is to hand the same bag to `openDataDir`.

## Follow-ups

- **`readClusterVersion` is unaffected** but `assertEngineMatchesDataDir` queries the *opened* database; it reads `server_version`, which is cluster-wide, so a non-default database does not change its verdict. No change was needed, recorded here so a future reader does not re-derive it.
