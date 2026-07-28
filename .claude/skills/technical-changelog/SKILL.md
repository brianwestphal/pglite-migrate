---
name: technical-changelog
description: Generate a diff-grounded, one-page technical changelog for a release — from the actual code changes between the last production tag and HEAD (the next, still-unreleased version). Asks for the next version number, since HEAD is not yet in package.json.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

Produce a **one-page technical report** of what changed for a release, stored in
`docs/technical-changelog/<base>-<next>.md`. The report must be grounded in the **real
diff** — added/modified/removed code, API/flag/dep deltas — **not** commit messages or the
requirements docs (those describe the *end state* and the *whole* feature history, so they
routinely credit the range with work that predates it, or describe posture that was already
true). Every claim is a verified delta between the base tag and HEAD.

## The two facts that make this skill necessary

1. **HEAD is the next, unreleased version.** `package.json` still holds the *last* released
   version, so the release number can't be read from the repo — **you must ask the user**
   what the next planned version is.
2. **The base is always the most recent production release tag** (e.g. `v1.0.0`), and the
   range is `<base>..HEAD`. Pre-release tags (`-beta`, `-rc`) are never the base.

## Steps

1. **Ask for the next release number first.** Use `AskUserQuestion` (or ask in prose):
   *"What's the next planned release version for this changelog?"* Do not guess and do not
   read it from `package.json` (that's the previous release). Accept e.g. `1.1.0` / `v1.1.0`.

2. **Run the analysis script** — it does the deterministic git work:
   ```bash
   npm run changelog-analysis -- --next <version>
   # or: node scripts/changelog-analysis.mjs --next <version>
   ```
   It auto-detects the base as the newest production `vX.Y.Z` tag that is an ancestor of
   HEAD, buckets the line delta **by area** (product vs docs vs agent/skill scaffolding vs
   generated assets), gives a **product-only** total, lists **added/removed** files, new
   numbered requirements docs, and candidate **new subsystems**, and extracts the
   **API-export** delta *per entry point*, the **package `exports` subpath** delta, the
   **CLI-flag** delta, and **dependency** changes (including `peerDependencies` — PGlite is
   a peer dep here, so a bump there is user-visible). Override the base with `--base <tag>`
   only if the user asks (it warns if a newer production tag exists than the one it picked).

   Export and flag deltas are **set comparisons** between the base and head trees, not diff
   scraping — so a re-sorted or re-wrapped export block produces no phantom "change".

3. **Read the real diffs — do not stop at the script.** The script tells you *where* to
   look; the narrative comes from the actual changes. For each non-trivial area:
   ```bash
   git diff <base>..HEAD -- <path>          # what actually changed
   ```
   And **verify every "new" claim against the base tree** rather than trusting a commit
   subject:
   ```bash
   git cat-file -e <base>:<file>            # non-zero exit → file is genuinely new
   git show <base>:<file> | grep -c <sym>   # 0 → the symbol/behavior was added in range
   git ls-tree -r --name-only <base> -- src/   # what the tree looked like at the base
   ```

   **Traps specific to this repo — check each before writing:**
   - **The cross-major PG17 → PG18 capability is the headline feature and it is old.**
     `tests/e2e/cross-major.test.ts` and the two-alias harness shipped well before v1.0.0.
     Never let a range inherit credit for "makes cross-major migration possible" unless the
     diff actually shows it.
   - **Posture claims that were already true**: *zero runtime dependencies*, *never imports
     `@electric-sql/pglite` directly*, *peer-dependency engine*, *validates at trust
     boundaries*. These are baseline unless the diff shows them being established. Probe
     with `git show <base>:package.json` / `git show <base>:src/types.ts`.
   - **Docs 7–14 were design-only specs before they were implemented.** A doc existing at
     the base does **not** mean the feature shipped at the base, and vice versa. Check the
     `src/` side, not just `docs/`.
   - **Generated assets are regenerated wholesale.** `assets/demos/*.svg` and
     `assets/diagram.svg` come from `npm run demo` / `npm run diagram`; their line delta
     reflects a re-render, not authored work. The script already buckets them as
     non-product — keep them out of the effort narrative.
   - **`.hotsheet/`, `.claude/`, `.agents/`, `.gemini/` churn is scaffolding**, often the
     largest single bucket. Never present it as engineering.
   - A feature added **and removed within the same range** (nets to zero at HEAD — say so),
     and a dependency bumped in **two hops** (report the full base→HEAD delta).

4. **Write the report** to `docs/technical-changelog/<base>-<next>.md` (the script prints
   the exact suggested path). Keep it to ~one page. It must contain, in this spirit:
   - **Header:** the range (`<base>..HEAD`), commit count, and a note that HEAD is untagged
     / the "next" number is a label. State it's derived from the diff, not commit prose.
   - **Honest size:** the area-by-area split from the script, and the **product-only**
     +/- total called out separately from the raw total (which is inflated by docs and
     `.claude`/`.agents`/`.gemini`/`.hotsheet` scaffolding and re-rendered SVGs — never
     present the raw number as engineering effort).
   - **Baseline note:** one line on what already shipped at the base (so nothing
     pre-existing reads as new) — for this repo that usually means naming the cross-major
     path, COPY-text transfer, reconstruction, and the safety layer as prior art.
   - **Per-change sections** for the genuine deltas, each carrying its **diff evidence**
     (new files, the export/subpath/flag/dep delta, `0-hits → present` for behavior). Order
     by significance (a net-new subsystem before a doc sync).
   - **Mermaid diagrams as needed** (not gratuitously): a component/flow diagram for a new
     subsystem, a sequence diagram for a new round-trip/interaction. Use `<br/>` for line
     breaks in node labels (not `\n`) and quote labels containing spaces/punctuation.

5. **Validate + finish.**
   - Sanity-check the mermaid blocks (balanced `[]`/quotes; standard `flowchart` /
     `sequenceDiagram` syntax). If a renderer is available, render to confirm; otherwise a
     structural check is fine.
   - Re-read the draft against the script output and your `git show <base>:…` probes: is
     **every** claim a real delta? Cut or re-label anything that describes the baseline.
   - Committing is optional and follows the repo's git rules (commit when it's a clean unit;
     never `git push` without explicit permission).

## Guardrails

- **Diff over prose.** If a claim isn't backed by a file/line change you actually read,
  don't make it. Commit subjects and `docs/` are leads to verify, not sources to quote.
- **Never inflate.** Lead with product-only line counts; label docs, agent/skill
  scaffolding and regenerated assets as non-engineering.
- **Attribute to the range only.** When unsure whether something is new, run the
  `git cat-file -e <base>:<file>` / `git show <base>:<file>` probe before writing it up.
