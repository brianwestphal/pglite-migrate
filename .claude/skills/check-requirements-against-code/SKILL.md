---
name: check-requirements-against-code
description: Check requirements docs against implementation, report discrepancies and gaps
allowed-tools: Read, Grep, Glob, Bash, Edit, Agent
---

Check the requirements documents against the actual implementation, verify the AI-oriented summaries still match reality, and confirm the CLAUDE.md index is complete. Generate a report with recommendations and questions about any discrepancies.

## Process

1. **Read all requirements docs** in `docs/` (numbered `1-overview.md` … `6-testing.md`, plus `ARCHITECTURE.md`). Each contains FR-/NFR- requirements with status markers.

2. **For each requirement**, verify the implementation in `src/`:
   - Search for the relevant code
   - Confirm the described behavior is actually implemented
   - Note partial implementations or deviations. Pay special attention to items marked **Deferred** / **Design only** (docs 3 and 5, NFR-2.15) — confirm they are genuinely unbuilt and still want a follow-up ticket, not silently half-done.

3. **Check for undocumented features**: significant functionality in `src/` not covered by any requirement — intentional additions needing docs, or scope creep.

4. **Synchronize the AI summaries** (`docs/ai/code-summary.md`, `docs/ai/requirements-summary.md`):
   - For `code-summary.md`: confirm the directory tree, public-API list, and "where do I look to…" index match `src/`. Look for files listed that no longer exist, files not mentioned, and API entries pointing at moved/renamed exports.
   - For `requirements-summary.md`: confirm every requirements doc has a section, numbers match, and each status marker (Shipped / Partial / Design only / Deferred) still reflects what you found in step 2.
   - Fix drift directly with `Edit` — don't just report it.

5. **Verify the CLAUDE.md docs index**: every numbered doc in `docs/` appears in the CLAUDE.md "Documentation" list with the correct filename and a one-line description, and every listed entry is a real file. Fix mismatches directly.

6. **Generate the report**:
   - **Fully Implemented** — brief list
   - **Partially Implemented** — requirement ID, implemented vs missing, recommendation
   - **Not Implemented** — requirement ID, recommendation (implement / defer / remove)
   - **Undocumented Features** — description, location, recommendation
   - **Summary & Index Synchronization** — what you changed (or confirmed correct) in the two AI summaries and the CLAUDE.md index
   - **Questions** — ambiguities/contradictions

Focus on actionable findings; skip trivially correct implementations. If summaries and index were already in sync, say so in one line.
