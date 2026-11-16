# Add `<owner>/residency-history-taking-internal-medicine`

## What it is

A DeepSeek Harness plugin for one station of China's residency graduation OSCE — **Patient Encounter · History Taking** (internal medicine):

- The assistant first becomes the **standardized patient** and waits for the candidate to interview it;
- On 「结束考试」/ "end exam" it switches to **examiner**, replays what was actually asked, and scores item by item against the official **100-point rubric** (18 rows) with per-item deductions and ready-to-copy replacement questions;
- The score is appended to an append-only training log, and the next exam prefers cases the user has not practised.

## What ships

- **Skill** `history-taking-exam` — full SOP plus **32 case scripts** (29 in-scope, 3 out-of-scope hematology extras) and 4 handbooks, all bundled verbatim.
- **5 tools** — `osce_start`, `osce_get_case`, `osce_rubric`, `osce_finish`, `osce_record`. The three-stage state machine (IDLE → SP → GRADING), case drawing, stage isolation and score logging are implemented as mechanism, not left to model memory.
- **A short stage constraint** injected into the system prompt **only while an exam is running**.

Stage isolation is enforced in code: during the SP stage `osce_get_case` strips the standard medical record and examiner notes, so the answer cannot leak mid-interview.

## Category

`skill` — the plugin's core is a bundled skill (SOP + 32 scripts + handbooks) plus tools that implement it. It is not a UI plugin and ships no browser surface.

## Submission checklist

- [x] `package.json` declares `dsh.bundle` (`{ "bundle": { "patch": "./cordis.patch.yml" } }`) and `cordis.patch.yml` is at the repo root
- [x] Real, working code — `lib/` built from `src/` with `tsc`; 12 end-to-end self-checks pass (`node --test test/selfcheck.mjs`)
- [x] No build step needed to install — `lib/` is committed
- [x] Description is factual and checkable — 5 tools, 32 cases, 100-point rubric, all present in the code
- [x] Only one entry added; no other entry touched
- [x] `description.en` quoted (contains `: `)

## Notes

- Zero runtime dependencies: the host does not install `@deepseek-ai/*` into the profile, so the plugin uses type-only imports and registers tools with plain `ToolDefinition` objects.
- MIT. Cases and handbooks ship from the same author's history-taking expert pack; patients and results are fictional teaching material, not real patient data.
