# 15 — Engine acquisition

Detailed spec for the opt-in path that **downloads a missing PGlite engine** instead of requiring the host application to install one. Expands on the engine-selection mechanics in [`4-cli.md`](4-cli.md) (FR-4.2 / NG-4.8) and the alias matrix in [`6-testing.md`](6-testing.md).

Status: **Shipped** (PGLM-62 … PGLM-67).

## The problem

A cross-major migration needs **two** engines at once — one that can read the old on-disk format, one that writes the new. Until now both had to be installed by the host, under npm aliases:

```bash
npm install pglite-old@npm:@electric-sql/pglite@0.4.6   # PG17
npm install pglite-new@npm:@electric-sql/pglite@0.5.4   # PG18
```

That is a poor fit for the actual situation. An application that wants to upgrade bundles **only the destination** engine — the version it was built against. The *source* version is not a property of the application at all; it is a property of data sitting on a user's disk, possibly written by a release shipped years earlier. Requiring every consumer to discover which old engine a given data directory needs, and to wire up an alias for it, pushes identical error-prone logic into every consumer.

The library already knows how to answer that question: `readClusterVersion` reads the major straight out of `PG_VERSION`. Acquisition closes the loop.

## Why this is tractable for PGlite specifically

Four properties, each verified empirically rather than assumed — they are not true of most packages, and if they stop being true this design needs revisiting:

1. **Zero dependencies.** `@electric-sql/pglite` declares no `dependencies`, `peerDependencies`, or `optionalDependencies`. There is no dependency tree to resolve — it is one tarball, so no package manager is needed.
2. **No install scripts.** The published `scripts` block is entirely dev-time. Extraction *is* installation; nothing executes as a side effect of unpacking.
3. **Published integrity.** npm serves a sha512 `dist.integrity` per version, so the checksum primitive already exists.
4. **Modest size.** ~8–9 MB compressed, ~23 MB unpacked per engine.

## Requirements

### The pinned registry

- **FR-15.1** The package ships a table mapping each supported Postgres major to exactly one known-good `@electric-sql/pglite` version and its sha512 integrity (`src/engines/registry.ts`).
- **FR-15.2** Lookup is keyed by the major returned by `readClusterVersion`. An unsupported major raises `UnknownMajorError` naming the majors that *are* known.
- **NFR-15.3** Entries are verified empirically before being pinned — download, hash-check, extract, boot, and read the engine's own `server_version` — not transcribed from release notes.
- **NFR-15.4** One release per major. Any patch in a PGlite minor line opens a data directory written by any other patch in that line, so the newest patch (most fixes) is the right known-good. Where two lines bundle the same major, the newer line wins.

Currently pinned:

| Postgres major | PGlite version | Notes |
| --- | --- | --- |
| 15 | 0.1.5 | Stamps the non-numeric `15devel` into `PG_VERSION` |
| 16 | 0.2.17 | |
| 17 | 0.4.6 | Also served by the 0.3.x line; newer line pinned |
| 18 | 0.5.4 | |

> **`15devel`.** PGlite 0.1.x bundles a Postgres *development* snapshot, so its `PG_VERSION` is not a plain integer. `readClusterVersion`'s `parseInt` stops at the first non-digit and yields `15`, which is what makes the registry key line up. That is load-bearing behavior with a dedicated regression test — do not "fix" the parse to be stricter without updating this.

- **NFR-15.5** Pinning does **not** rot the way version allowlists usually do, and this is what makes the whole approach viable. Only the *source* side is ever acquired (the host supplies the destination it was built against), and old majors are frozen history: PG17's known-good 0.4.x will never change now that PG18 has shipped. The table only ever grows.

### Acquisition

- **FR-15.6** `acquireEngine(major, options)` resolves the pin, downloads the tarball, verifies it, extracts it, and returns a path importable by `openDataDir`. `acquireRelease(release, options)` does the same for an explicitly chosen release.
- **FR-15.7** Verification happens **before** anything executable is written. A hash mismatch raises `IntegrityError` and leaves the filesystem untouched.
- **NFR-15.8** Integrity is checked against the hash **pinned in this build**, not the one the registry serves alongside the download. A compromised or spoofed registry response therefore cannot get code past verification.
- **FR-15.9** An unreachable registry raises `EngineFetchError` whose message names the offline/proxy case and gives the manual `npm install` fallback.
- **NFR-15.10** Concurrent runs are safe: extraction goes to a staging directory that is renamed into place atomically, so a crashed or racing run can never leave a half-populated cache entry. A run that loses the race adopts the winner's copy rather than failing.

### Retention (caller's choice)

- **FR-15.11** `cache: 'keep'` — **the default when unspecified**. The engine is extracted into a shared, OS-appropriate cache directory and reused by later runs. A retried migration must not re-download. Measured: ~1.2 s cold versus ~0.7 ms warm.
- **FR-15.12** `cache: 'ephemeral'` — extracted into a fresh temporary directory and removed when the cluster is closed, successfully or not.
- **NFR-15.13** `ephemeral` neither reads nor writes the shared cache, so it always downloads. Predictable semantics were preferred over a marginal saving; a half-caching mode is harder to reason about than either extreme.
- **FR-15.14** `cacheDir` overrides the location. The default is `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, and `$XDG_CACHE_HOME` (falling back to `~/.cache`) elsewhere — all under `pglite-migrate/engines`.
- **FR-15.15** Releasing an acquired engine is tied to `close()` on the returned cluster, so an ephemeral copy is cleaned up by the same `finally` a caller already writes.

### Opt-in posture

- **NFR-15.16** Acquisition is **off by default** and never happens implicitly. Downloading and then executing ~23 MB from a registry is not something a library may do behind its caller's back.
- **FR-15.17** Resolution is always attempted first. An installed engine always wins; acquisition is considered only when the specifier does not resolve **and** the failure names that specifier. A module that resolves but throws while loading one of *its own* imports must surface its own error — silently downloading a replacement would bury the real failure.
- **NFR-15.18** The network code lives in a separate module, reached only through a dynamic `import()` on the opt-in path, and is additionally published as its own `pglite-migrate/engines` entry point. Importing `pglite-migrate` performs **no network call**, does **not evaluate** the acquisition module, and does **not** export `acquireEngine`.

  > **Precisely what this does and does not guarantee.** The build uses `splitting: false`, so esbuild *inlines* the dynamically-imported module into `dist/index.js` rather than emitting a separate chunk — the bytes (including the registry URL) are present in the main bundle. What the dynamic import buys is that esbuild wraps the module in a lazy `__esm` initializer, so its body is not evaluated until something actually imports it. Verified: importing `dist/index.js` makes zero `fetch` calls and leaves `acquireEngine` unexported. If byte-level absence from the main bundle is ever required (rather than non-evaluation), that needs `splitting: true`, which changes output layout and is not currently worth the churn.
- **FR-15.19** When an engine is missing and acquisition is off, the error names the engine, the detected major, the exact install command, and the opt-in flag — not a bare `ERR_MODULE_NOT_FOUND`.

### Extraction safety

- **NFR-15.20** The tar extractor is hand-rolled (`src/engines/tar.ts`) rather than shelling out to `tar` or taking a dependency. This preserves the package's **zero runtime dependencies** and makes the security rules explicit and testable instead of inherited from whichever `tar` happens to be on `PATH`.
- **FR-15.21** The extractor refuses symlink, hardlink, character-device, block-device and FIFO entries; rejects path traversal, absolute paths, backslashes and NUL bytes in entry names; verifies header checksums; and refuses GNU base-256 numeric fields.
- **FR-15.22** Path checks apply to pax and GNU long-name **overrides**, not only to the header name — an innocuous header with a hostile override is a real attack shape and is covered by a regression test.
- **NFR-15.23** Archive file modes are deliberately **not** applied. The extracted tree only needs to be readable, and honoring an attacker-supplied setuid or unreadable mode buys nothing.
- **NFR-15.24** Correctness is pinned against the genuine artifact: extracting a real PGlite tarball produces a tree byte-identical to `tar -xzf` across all 342 files.

## CLI

- **FR-15.25** `--fetch-missing-engine` opts in. `--engine-cache <keep|ephemeral>` selects retention (default `keep`). `--engine-cache-dir <path>` overrides the location. See [`4-cli.md`](4-cli.md).
- **FR-15.26** Either side may acquire, not just the source. The `PG_VERSION` the CLI already reads is passed through as the major, so a target directory that does not exist yet can still resolve an engine.
- **FR-15.27** An acquired engine is reported to stderr with its version and whether it came from cache or the network.

## Known limitations

- **Offline, air-gapped and proxied environments gain a new failure mode.** Migration often runs at application startup on an end user's machine. When acquisition is opted into and the registry is unreachable, the run fails where a bundled engine would have succeeded. Mitigated by the opt-in default and an actionable error, but it is a real trade and should be weighed before enabling the flag in an unattended startup path.
- **Packaged applications are the case this helps most.** In Electron, `node_modules` lives inside a read-only `asar`, so the alias approach forces bundling ~23 MB of an engine used exactly once. Acquiring into a writable cache directory is the better fit there — but `cacheDir` must point somewhere writable (`app.getPath('userData')`), not at the packaged tree.
- **Only the majors in the table can be acquired.** Anything else must be installed manually. This is a deliberate consequence of pinning rather than resolving versions at runtime.
- **A first run pays ~8–9 MB of download.** The `keep` default means only the first run pays it.

## Testing

Unit tests cover the registry, extractor and acquisition logic without touching the network — acquisition tests drive a local HTTP server rather than a mocked `fetch`, matching the project's no-mocking stance. Hostile archives are built as synthetic fixtures (`tests/engines/fixtures.ts`).

`tests/e2e/acquired-engine.test.ts` proves the real flow against the live registry: a genuine PG17 directory migrated into PG18 with the source engine *not installed*. It self-gates on registry reachability and reports skips honestly when offline — see [`6-testing.md`](6-testing.md).
