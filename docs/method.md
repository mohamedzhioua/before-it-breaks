# The method, step by step

For the person who runs an audit, and for anyone who wants to know why each step exists. The commands for each step are in [Run an audit](run-an-audit.md); how a candidate is judged is in [Verification](verification.md).

## Principles

- **Without evidence, a claim stays a hypothesis.** Every finding cites `repo@<10-character commit>:path:line` and carries read-only commands that show its code facts.
- **Pin before you look.** Everything refers to one recorded commit per repo; a repo that moves afterwards stops the audit.
- **Finding and judging are separate jobs**, done by different agents with different instructions.
- **Scripts, not models, do the bookkeeping.** Pinning, re-running evidence, turning votes into verdicts and building the reports are deterministic scripts; the same inputs give byte-identical outputs.
- **Files are the memory.** Every result is saved to a named file at once; the session's chat is not a record.
- **People approve, in writing.** Gates that need a person are met only when `HANDOFF.md` records who confirmed and when.

## Phases

### Phase 0: pin

- **Input:** the repos named in `audit.config.json`.
- **Output:** `work/pins.json` and `work/phase0-baseline.md` (commit, branch, commit date, uncommitted-change count per repo).
- **Gate before:** `doctor` passes everything except the pins check.
- **Why:** a finding has to point at code anyone can check out later. A repo with uncommitted changes is refused unless `--allow-dirty` is given, and that choice is recorded. A repo's `.git` folder is trusted input, so before git runs the kit reads it as text and refuses one that can start a program or fetch (including worktree and submodule checkouts) unless `--trust-git-dir` is given; that choice is recorded too and skips the .git-folder check entirely (see [security](security.md)).

### Phase 1: map

- **Input:** the pinned repos and the mapper checklist for each repo role ([`method/phase1-map-checklists.md`](../method/phase1-map-checklists.md)).
- **Output:** `work/phase1/<repo>-map.md` per repo that is not `context_only`: modules, entry points, data model, background work, heavy flows, configuration, each fact cited.
- **Gate before:** every repo is unchanged since its pin, with no uncommitted edits.
- **Why:** hunters who start from a map look in the right places, and the person who knows the system can correct a wrong picture before it shapes the hunt.

### Phase 2: hunt

- **Input:** the maps, the hunt `groups` (one repo, one lens, one scope each) and the lens files in [`method/lenses/`](../method/lenses/).
- **Output:** `work/candidates.json`. Each candidate has citations, the mechanism, the arithmetic that leads to a breaking size, and evidence commands. When rules are on, a rule writer turns repeated patterns into Semgrep rules and their hits become candidates too.
- **Gate before:** the person who knows the system has skimmed the maps.
- **Why:** one hunter per group and lens keeps each agent's context small and makes coverage explicit: what is not in a group is not hunted.

### Phase 3: verify

1. **Evidence.** `kit evidence` re-runs every evidence command at the pins through an allowlist and keeps a receipt per candidate; run it once, before verify. Gate before it: the user has reviewed the `--dry-run` list of what would run and what is refused.
2. **Batches.** `kit batches` cuts the candidates into batches and plans workflow runs within the agent cap.
3. **Skeptics and verifier.** Per batch, one skeptic per lens (`reach`, `mech`, `math`) tries to refute each candidate; a verifier checks the receipts.
4. **Synthesis.** `kit synthesize` turns votes, checks and receipts into verdicts by fixed rules.
5. **Overrides.** The lead and the person who knows the system decide what the rules could not; each override has a reason and an approver; synthesis runs again, then `kit build log`.

- **Output:** `work/phase3/verdicts.json`, then `03-verification-log.md` and `final-verdicts.json` from `kit build log`.
- **Gate after:** every candidate has three votes and one verifier check, each bound to the candidate's current content (or the gap is explained as NEEDS-REVIEW), and every override is approved.
- **Why:** this is the trust core. See [Verification](verification.md).

### Phase 4: measure (optional; designed, not yet proven)

- **Input:** the evidence commands that need a live system, and the access the user agrees to.
- **Output:** the results of the checks you ran, under `work/phase4/`. The catalogue of checks, `04-measurements.md`, is a standard step: `kit build measurements` builds it right after `kit build log`, with no agents; it lists the checks, never runs them and does not read `work/phase4/`.
- **Gate before:** access agreed in writing; never load on production; ask before touching any shared environment.
- **Why:** it is the only route from a calculated size to a measured one. See [Measuring](measuring.md).

### Phase 5: report

- **Input:** the final verdicts and the system docs written so far.
- **Output:** `work/phase5/report-inputs.json` (plain one-liner, threshold, breaking size and what it grows with, fix direction, effort, area per finding), then `02-audit-report.md`, built after the recommend steps (or when recommend is skipped). The docs writer tidies `system-docs/` and normalises its citations.
- **Gate before:** overrides approved and synthesis re-run.
- **Why:** the report is rebuilt from data every time, so it can never disagree with the verdicts.

### Phase 6: recommend (experimental)

- **Gate before:** synthesis has run and the report inputs are saved.
- **Input:** the report inputs and the module rules in `modules`.
- **Output:** `work/phase6/recs/<module>.json`, `work/phase6/cross-cutting.json` (decision records and a now / next / later roadmap), then `05-recommendations.md` and the target-architecture page; the issues file and the explorer data come from the same step. Build it before `kit build report`: the report links the recommendations only when a recommend result was saved, and otherwise says "There are no recommendations in this audit."
- **Why:** findings say what breaks; engineers also need an order of work. Architects plan; they never re-argue verdicts.

### Closing checks

`kit check secrets` (keeps a record file whether clean or not), `kit check unchanged` (every repo still at its pin) and `kit check links`. Then a person writes `01-executive-summary.md` from the template.

## Stop rule

If an agent or a step fails the same task three times, stop that leg. Keep its output and errors, record it as failed in `HANDOFF.md` and the run log with the reason, and move on or ask. Do not retry forever and do not hide the gap: a missing result is reported as missing.

## Working across sessions

A large audit spans several sessions. Resuming relies only on files:

- `HANDOFF.md` in the workspace: one dated entry per step with what was saved, counts, failures, gate confirmations and the next step.
- `work/run-log.json`: which agents ran, on which model and effort.
- The phase files themselves. If the HANDOFF and the files disagree, trust the files.

A new session starts with `/before-it-breaks:audit-status`, which reads these and names the next command. Workflow runs cannot be resumed in a later session, which is why every run is saved the moment it returns.
