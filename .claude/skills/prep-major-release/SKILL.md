---
name: prep-major-release
description: Prep the repo for a major release — refresh README.md to stay compelling and accurate, then review/revise the demo modes and flag which screenshots to recapture
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent
---

Prepare the project for a major release. Two jobs: (1) make `README.md` accurate and compelling against everything that has shipped, and (2) review the demo modes (`scripts/demo.mjs` + the SVGs embedded in the README) and decide whether different / additional / fewer captures are warranted. **You revise the demo *definitions*; the maintainer captures the screenshots** (`npm run demo` needs Chromium and is run by the user). End by telling them exactly what to recapture.

## Process

### 1. Establish what changed

Build a picture of what's new since the last release so the README can advertise it:

```bash
git describe --tags --abbrev=0 2>/dev/null   # last release tag
git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null)"..HEAD   # commits since
```

Then read the sources of truth for current capabilities:
- `CLAUDE.md` → **Implementation Status** (what's shipped vs. deferred).
- `CHANGELOG.md` → the `## Unreleased` section.
- `docs/ai/requirements-summary.md` → Shipped / Partial / Design only / Deferred markers.
- `src/cli.ts` → the actual CLI flags (the README's CLI table must match these exactly).
- `src/index.ts` → the public API surface (the Quick start must match real exports).

### 2. Review and update README.md

Read `README.md` end to end and reconcile it with step 1. The README is the project's pitch — keep it **compelling and honest**:

- **Lead with the "why."** The motivating failure (a new-major PGlite engine physically can't open an old-major data dir) is the hook — keep it crisp and up front.
- **Advertise the most important / interesting features.** Make sure genuinely shipped capabilities are visible in "Why you'd want this" (cross-major proof, app-driven *and* standalone reconstruction, COPY-text fidelity, FK-cycle handling, the safety layer). Don't bury a flagship feature; don't oversell a deferred one.
- **Keep claims true.** Every feature the README implies is shipped must be backed by step 1. Demote or remove anything that regressed or is still design-only. Scope section must still match `docs` + Implementation Status (in scope = app-class schema; out of scope = full `pg_dump` parity).
- **Sync the mechanical bits.** CLI flag table ↔ `src/cli.ts`; Quick-start code ↔ real exports/signatures; install/alias versions ↔ `package.json` (`pglite-old` / `pglite-new`); doc links ↔ files in `docs/`.
- Prefer **small targeted edits** over a rewrite. Match the existing voice.

### 3. Review the demo modes

The demos live in `scripts/demo.mjs` (the `DEMOS` array: `app-driven`, `dry-run`, `standalone`, `safety`) and render to `assets/demos/*.svg`, embedded in the README's **Demos** section. Each demo = a title card + a verbatim capture of the real CLI against a live PG17 → PG18 pair.

Evaluate the **set** against what now matters most for the release:
- Does each demo still showcase a feature worth a slot? Is anything important (e.g. a flagship feature surfaced in step 2) **not** demoed but should be?
- Are any redundant or low-value — would **fewer, sharper** clips read better?
- Do the title cards (`eyebrow` / `headline` / `subtitle`) and commands still describe what the CLI actually does and prints?

Make the changes you're confident about **directly in `scripts/demo.mjs`** (add/remove/reorder a demo, fix a title card, adjust a command or its captured flags). For each demo you add/change/remove, also update the corresponding `<p align="center"><img …></p>` block in the README's Demos section — including the **alt text**, which must describe the (expected) captured output.

> Demo SVGs are the **verbatim** CLI transcript. Do **not** hand-edit the `.svg` files or invent output — they're regenerated from real runs. If you changed demo definitions or any CLI output, the existing SVGs are now stale and must be recaptured.

### 4. Hand off

Run the cheap gates on whatever you touched so you don't hand over a broken tree:

```bash
npm run typecheck && npm run lint
```

Then report:
- **README changes** — what you updated and why (bullet list).
- **Demo changes** — which demos you added / revised / removed in `scripts/demo.mjs`, and the matching README img/alt edits.
- **Recapture list** — the explicit set of demos (and/or the diagram) the maintainer must regenerate, with the commands: `npm run demo` (and `npm run diagram` if the architecture diagram changed). Note these need Chromium and are run by the user, not you.
- **Open questions** — anything you weren't sure should be advertised, demoted, or demoed (raise as `FEEDBACK NEEDED` on the ticket if it blocks).

Do **not** `git push`; commit only per the project's Git Workflow.
