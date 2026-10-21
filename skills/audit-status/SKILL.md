---
name: audit-status
description: Report where a Before It Breaks audit stands - which phases are done, which gate is open, and the exact next command - by reading the workspace files. Read-only; changes nothing.
when_to_use: The user asks how far the audit is, what to do next, or resumes an audit in a new session.
argument-hint: "[workspace folder]"
---

# Audit status

Read the workspace (the current folder unless the user names another; `<ws>` below) and report its state. **Change nothing**: this skill only reads files and runs read-only checks.

## 1. Read

1. `<ws>/HANDOFF.md`: the last entry's "next step", gate confirmations, open questions and recorded failures.
2. `<ws>/audit.config.json`: the audit question, preset, repos and output names (`outputs`). Use the names from the config when they differ from the defaults below.
3. `<ws>/work/run-log.json`: which phases ran, with which agents, model and effort.
4. The existence (not the full content) of each phase's files, in the order of the table below.

## The phases and their gates

This table is also what `run-phase` checks before it starts a step: the gate of the row **before** that step must be met. A gate that needs a person is met only when the HANDOFF records who confirmed it and when.

| Step | Done when this exists | Gate before the next step |
|---|---|---|
| pin | `work/pins.json` | `doctor` shows every required line `ok` (every repo at its pin, clean tree) |
| map | `work/phase1/<repo>-map.md` for every repo that is not `context_only` | the person who knows the system has skimmed the maps (HANDOFF) |
| hunt | `work/candidates.json`, with every hunt run saved (one run-log entry per run) | run the read-only `evidence --dry-run` (that run is the gate check), show the user the list of what would run and what is refused, and get their OK (HANDOFF) before the real evidence step |
| evidence | `work/phase3/receipts/_index.json` | the user has seen the ran / skipped summary |
| batches | `work/phase3/runs.json` | — |
| verify | `work/phase3/votes-<N>.json` for every run in `runs.json` | every candidate has a vote from every configured skeptic lens and one verifier check (`synthesize` lists the incomplete ones) |
| synthesize | `work/phase3/verdicts.json` | — |
| overrides | an overrides review entry in the HANDOFF: who approved the list in `work/phase3/master-overrides.json` (an empty list is fine) and when. The file alone does not mean the step is done | every override has a reason and an `approved_by`, the approver's OK is in the HANDOFF, and `synthesize` ran again after the last change |
| build log | `03-verification-log.md` | — |
| report-inputs | `work/phase5/report-inputs.json` | — |
| build report | `02-audit-report.md` | — |
| recommend (experimental) | `work/phase6/cross-cutting.json` and `work/phase6/recs/` | — |
| build recommendations | `05-recommendations.md` (and, if built after it, `work/phase6/issues.csv` and `work/explorer-data.json`) | — |
| measure (optional; designed, not yet proven) | `04-measurements.md` and results under `work/phase4/` | access agreed with the user, never production load |
| closing checks | the `check secrets` record, `check unchanged` and `check links` all passing | a person writes `01-executive-summary.md` (the kit never generates it) |

Count files and entries with short commands (for example the number of candidates or verdicts) instead of reading large JSON into the conversation.

## 2. Check

Run `node "${CLAUDE_PLUGIN_ROOT}/kit.js" doctor <ws>` and report any line that is not `ok`. A repo that moved off its pin or has new uncommitted changes blocks every later step until the user restores it or the audit is re-pinned (which restarts it from the map step).

## 3. Report

Reply in a few lines, in plain language:

- **Done:** the steps completed, with counts (repos mapped, candidates, verdicts by kind, overrides).
- **Open gate:** the first gate in the table that is not met, and who must act (the user, the person who knows the system, or the session).
- **Gaps:** failed legs from the run log or HANDOFF, steps that ran without a recorded model and effort.
- **Next:** the one command to run next, for example `/before-it-breaks:run-phase verify --run 2`.

If the HANDOFF and the files disagree (the HANDOFF says a step is done but its file is missing, or the reverse), say so and trust the files.
