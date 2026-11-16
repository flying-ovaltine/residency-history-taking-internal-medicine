# Residency OSCE History-Taking Trainer (Internal Medicine) · DSH plugin

English | [中文](README.md)

Runs one complete station of China's residency graduation OSCE — **Patient Encounter · History Taking** — inside the chat:

1. Say **"start exam"**: the plugin draws a case and the assistant immediately becomes the **standardized patient (SP)**. You are the candidate.
2. Say **"end exam"**: the plugin closes the station, computes the elapsed time, replays everything you actually asked, and the assistant switches to **examiner** — scoring item by item against the official 100-point rubric (18 rows), listing deductions with ready-to-copy replacement questions, and finally showing that case's standard medical record.
3. The score is appended to a training log; the next exam reads it first and prefers cases you have not practised.

**The pass mark is 80, not 60.**

> For exam practice and teaching simulation only. Not medical advice. Patients, cases and results are fictional teaching scripts, not leaked exam material.

## What gets installed

| Installed | Content |
|---|---|
| **Skill** `history-taking-exam` | Full SOP (trigger phrases, four modes, opening template, examiner output order) plus **32 case scripts** and 4 handbooks (rubric / SP playbook / examiner playbook / cheat sheet), shipped verbatim |
| **5 tools** | `osce_start`, `osce_get_case`, `osce_rubric`, `osce_finish`, `osce_record` — the state machine, case drawing, stage isolation and score logging are mechanisms, not model good intentions |
| **Examiner persona** | A short stage constraint is injected **only while an exam is running**; outside an exam it injects an empty string, so ordinary sessions are untouched |

### Install

```sh
# from the plugin marketplace: Plugins → Marketplace, search "OSCE history taking"
# or link a local checkout:
dsh plugin --profile web add link:/absolute/path/to/residency-history-taking-internal-medicine
```

Or merge the `insert` block of `cordis.patch.yml` into your profile's patch layer. The patch `name` must equal the package name or the row is silently skipped.

## Usage

| You say | What happens |
|---|---|
| start exam / 开始考试 / 出题 / 来一道 | Draw a case, load it, enter the SP role immediately — no confirmation, no "are you ready?" |
| end exam / 结束考试 / 交卷 / 问完了 / 打分吧 | Stop acting, switch to examiner, produce the report. Not a single patient line afterwards |
| keep asking questions | Stays in the exam; it will not close the station on its own |
| "a hematology case" / "diabetes" | Draws inside that subset, preferring unpractised cases |
| "an extra hematology case" / 清单外的 | Draws case-30–32 and marks the opening as an extra, out-of-syllabus case |

Modes: **A** full simulation (default) · **B** single-skill drill · **C** case only, no role-play · **D** rubric walkthrough only.

| Tool | Purpose |
|---|---|
| `osce_start` | Draw, load, stamp the start time, switch to SP; returns the opening block and the SP-visible part of the case |
| `osce_get_case` | Reload a case; **during SP it strips the standard record and examiner notes** (requested `part` is downgraded to `sp`) |
| `osce_rubric` | Official rubric slices: full / station rules / 18 rows / technique scale / common misses / high-score profile |
| `osce_finish` | Close the station, compute elapsed time, replay the interview, return the standard record + examiner notes + full rubric, move to GRADING |
| `osce_record` | Write score and verdict into the training log, return sessions/average/practised cases/chronic weak spots |

Drawing rules are enforced in code: the random pool is **case-01 … case-29**; case-30–32 are out-of-syllabus hematology extras and never enter it unless explicitly requested.

## Session history — no invented API

`osce_finish` uses the official `ctx.sessions` service: `Session.snapshotEvents(offset captured at exam start)`, filtered to `user/message` and `assistant/message`. If that is unavailable, it falls back to the `questions` argument, where the model passes the reconstructed list. Both paths exist; history wins, and the tool result states which source was used.

## Training log

`~/.workbuddy/history-taking-records.md` (append-only Markdown table). Falls back to `训练记录.md` in the session directory; if neither is writable it degrades silently — no error, no interruption, just one line in the report saying the round was not saved.

## Build

```sh
pnpm install
pnpm build        # tsc -p tsconfig.json → lib/
pnpm typecheck
node --test test/selfcheck.mjs
```

## Deliberate trade-offs

1. **Zero runtime dependencies, type-only imports.** This host packs `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` inside the application bundle and does not install them into the profile's `node_modules` (verified on this machine), so a runtime `import` would fail to resolve and break host startup. The source uses `import type` only (erased at compile time) and registers tools with plain objects matching `ToolDefinition` — the same approach the installed `dsh-ppt` plugin takes.
2. **Exam state is in-memory only.** A half-finished exam that survives a restart misleads more than it helps. Scores live on disk; the in-flight station does not.

## License

MIT © Yang Yang. Cases, handbooks and persona ship with this plugin from the same author's residency OSCE history-taking expert pack.
