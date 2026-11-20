# Residency OSCE History-Taking Trainer (Internal Medicine) · DSH plugin

English | [中文](README.md) · **v1.4.0**

Runs one complete station of China's residency graduation OSCE — **Patient Encounter · History Taking** — inside the chat:

1. Say **"start exam"**: the plugin draws a case and the assistant immediately becomes the **standardized patient (SP)**.
2. Say **"end exam"**: the plugin closes the station, computes the elapsed time, writes the score to the training log, and the assistant switches to **examiner** — scoring item by item against the official 100-point rubric (18 rows), listing deductions with ready-to-copy replacement questions, and showing that case's standard medical record.

**The pass mark is 80, not 60.**

> For exam practice and teaching simulation only. Patients, cases and results are fictional teaching scripts, not leaked exam material.

## New in v1.4.0 — the concealment "combat" mode

Normal mode simulates the station; **combat mode** simulates a real clinic, where the patient hides things:

- Opening is a bare greeting — no case number, no specialty, no chief complaint.
- Only the latest episode is offered; earlier history is peeled back one layer at a time ("cough for 5 years, worse for 1 day" → first only "cough, started yesterday").
- Chronic disease / medication / family / infectious history: first asked, minimized or denied; acknowledged only when pressed.
- Lab sheets are produced only when asked for; anything absent from the case script is "not tested", never invented.
- No timer, no prompting; the patient is in a hurry, not unfriendly.

The log gains a **mode** column, so normal and combat scores are tracked separately. Older 8-column files get the header upgraded in place; existing rows are never rewritten.

## What ships

| Installed | Content |
|---|---|
| **Skill** `history-taking-exam` | Full SOP — searchable in the skill catalog, callable via `/history-taking-exam` |
| **5 tools** | `osce_start` / `osce_get_case` / `osce_rules` / `osce_finish` / `osce_stats` |
| **Content** | 32 case scripts (29 in-scope + 3 hematology extras), the official 100-point rubric, 5 handbooks |

## Tools

| Tool | Purpose |
|---|---|
| `osce_start` | Draws a case, reads it, stamps the start time, returns the opening block plus the SP-visible script (never the standard record). `mode: 'combat'` selects combat mode |
| `osce_get_case` | Reads a case; **requesting the post-exam part of the case being examined is refused** — a hard anti-spoiler rule |
| `osce_rules` | On-demand handbooks: `persona` / `sp` / `combat` / `examiner` / `rubric` / `quick` / `skill` |
| `osce_finish` | Closes the station, writes the log row, returns the standard record + full rubric + verdict rules |
| `osce_stats` | Sessions, overall average, per-mode averages, practised case numbers, chronic weak spots (same item ≥3 times) |

## Training log

Default `~/.workbuddy/history-taking-records.md` (override with `config.recordsFile`). Append-only, 9 columns with the last one carrying the mode. If the write fails, the report still renders and says the round was not saved.

## Install

```sh
dsh plugin --profile web add "https://github.com/flying-ovaltine/residency-history-taking-internal-medicine/releases/latest/download/dsh-osce-history-internal-medicine.tgz"
```

## Deliberate host adaptations (three, no business-logic change)

1. **No `@deepseek-ai/schemastery`, no `export const Config`** — this profile does not install `@deepseek-ai/*` into `node_modules`, so a runtime import fails with `ERR_MODULE_NOT_FOUND` (verified: install activates and immediately fails). Defaults live in `apply`, overridable through the patch `config`.
2. **`defineTool` replaced by a local identity helper** — the host only validates the `ToolDefinition` shape.
3. **The log path returns to `~/.workbuddy/history-taking-records.md`**, matching the spec and keeping existing history (old 8-column rows) readable.

Plus one optional extra: `SKILL.md` is also registered as a DSH skill, so the catalog and `/history-taking-exam` work (silently skipped when the host has no `skills` service).

## License

MIT © Yang Yang
