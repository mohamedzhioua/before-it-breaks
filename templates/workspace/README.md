# {{config.audit.name}}

**Question:** {{config.audit.question}}

**Short answer:** _to write once the report is built: two or three plain sentences, the same answer as the executive summary. Until then: "in progress"._

| | |
|---|---|
| **Status** | Workspace created on {{date}}. Not yet pinned. Update this row after every phase. |
| **Size that matters** | {{config.scale.unit}}; target {{target}}; platform: {{platform_target}} |
| **Graded at** | {{tiers}} {{config.scale.unit_short}} |
| **Findings** | _after the report: total, then per severity, copied from `{{config.outputs.report}}`_ |
| **Confidence** | _after the report: what was proven on code, what was measured, what is still a calculation_ |
| **Repos** | {{repo_names}} |
| **Out of scope** | {{out_of_scope}} |

## Where to start, by reader

| Reader | Open | For |
|---|---|---|
| Manager or product owner | `{{config.outputs.summary}}` | The answer, what breaks first, the order of work |
| Engineer fixing things | `{{config.outputs.report}}` | Every finding with its mechanism, breaking size, code citation and fix direction |
| Architect or tech lead | `{{config.outputs.recommendations}}` and `{{config.outputs.docs_dir}}/` | Module plans, proposed decisions, roadmap, current and target design |
| New to the code | `{{config.outputs.docs_dir}}/` | How each repo works today |
| Database or operations, with access | `{{config.outputs.measurements}}` | Read-only checks that would turn calculated sizes into measured ones |
| Doubting a finding | `{{config.outputs.log}}` | The votes, gates and evidence receipt behind each verdict |
| Running the audit | `MASTER-PROMPT.md`, `LAUNCHER-PROMPT.md`, `HANDOFF.md` | The instructions, the session prompts and the current state |

Each file is shorter than the one below it in this table and points to it, so a reader can stop as soon as they have what they need.

## How this audit is produced

| Phase | What happens | Output |
|---|---|---|
| 0 Pin | The exact commit of every repo is recorded; every finding cites code at these commits | `{{config.outputs.work_dir}}/pins.json`, `{{config.outputs.work_dir}}/phase0-baseline.md` |
| 1 Map | One agent per repo describes how it works, with a citation for every fact | `{{config.outputs.work_dir}}/phase1/`, then `{{config.outputs.docs_dir}}/` |
| 2 Hunt | One agent per hunt group looks for problems through one lens ({{lenses}}) | `{{config.outputs.work_dir}}/candidates.json` |
| 3 Verify | A script re-runs every evidence command; one skeptic per lens ({{config.verify.skeptic_lenses}}) tries to refute each candidate; a verifier checks every receipt; a person approves every override | `{{config.outputs.log}}` |
| 4 Measure | Optional, **designed, not yet proven**: read-only live checks, only with the access agreed | `{{config.outputs.measurements}}` |
| 5 Report | Plain one-liners, breaking sizes, fix directions and effort for each finding | `{{config.outputs.report}}` |
| 6 Recommend | Experimental: module plans, proposed decisions and a roadmap | `{{config.outputs.recommendations}}` |

_After each phase, add what actually ran (agents, model and effort) from `{{config.outputs.work_dir}}/run-log.json`. Claim nothing that the run log or the work files do not show._

## Scope and limits

- In scope: {{repo_names}}, read at their pinned commits. Out of scope: {{out_of_scope}}.
- Breaking sizes are calculated from the code unless `{{config.outputs.measurements}}` shows a measurement.
- It does not cover security, load testing or code quality.
- _Add each repo's known gaps here (from `known_gaps` in `audit.config.json`)._

## Pinned commits

_Filled after Phase 0 from `{{config.outputs.work_dir}}/phase0-baseline.md`: repo, branch, short commit, commit date._

## Where everything is

| Path | What it holds |
|---|---|
| `audit.config.json` | The settings of this audit (written by people) |
| `HANDOFF.md` | The state between sessions: what is done, what is next, who approved what |
| `{{config.outputs.summary}}` to `{{config.outputs.recommendations}}` | The deliverables; all but the summary are generated from `{{config.outputs.work_dir}}/` |
| `{{config.outputs.docs_dir}}/` | System documentation per repo, and the target design |
| `rules/` | Static rules used in this audit and their results |
| `{{config.outputs.work_dir}}/` | Generated state and raw results: pins, candidates, receipts, votes, verdicts, overrides, run log |

## Keeping it true

- `.claude/settings.json` denies the session git commands that change a repo (commit, push, checkout, reset, stash, also after `git -C <dir>`), package installs, and edits or writes inside the audited repos. These rules reduce accidents; they are not a security boundary. A read-only git search for one of those words as a bare argument is blocked too: quote the word (`git log -S 'push'`).
- After editing `audit.config.json`, render the prompts again: `{{kit_cmd}} init "{{workspace}}" --refresh-prompts`.

- Do not edit generated files by hand. Change the data in `{{config.outputs.work_dir}}/` and rebuild with `{{kit_cmd}} build <log|report|recommendations|...> "{{workspace}}"`.
- To change a verdict, add an override with a reason and the approver's name to `{{config.outputs.work_dir}}/phase3/master-overrides.json`, run `synthesize` again, then rebuild. Overrides may remove, merge, re-scope or hold a finding; they never add one.
- Put finding ids in every ticket and merge request that fixes one.

## How the docs are organised

- **One page, one job:** this README guides; the summary explains; the report, the verification log, the recommendations and the system docs are reference; the measurements page is a how-to.
- **arc42, as a map rather than folders:** context and top-level building blocks = `{{config.outputs.docs_dir}}/platform-overview.md`; building blocks of one repo = `{{config.outputs.docs_dir}}/<repo>/architecture.md`; runtime = the request-flow and background-job pages; deployment = the overview's deployment section; cross-cutting concepts = the configuration pages; solution strategy = the target design page; risks and technical debt = the report and the recommendations.
- **Diagrams** are Mermaid flowcharts and sequence diagrams with C4-style names, at context and container level only.
- **Decisions** are short MADR-style records with status `proposed`: the audit proposes, the team decides.

Outlines for the system docs and the presentation material are in `{{kit_root}}/templates/`.
