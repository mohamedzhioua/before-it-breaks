# Run an audit

For the person running an audit: the commands for every step, the workspace layout and how to resume. The skills (`start-audit`, `run-phase`, `audit-status`) run these for you; this page is the same thing by hand. Why each step exists is in [the method](method.md).

Below, `kit` stands for `node <kit folder>/kit.js` (inside a plugin skill: `node "${CLAUDE_PLUGIN_ROOT}/kit.js"`), and `<ws>` for the workspace folder. The workspace is the first positional argument after any phase or sub-command (`args`, `save`, `log`, `build` and `check` take theirs first); left out, it is the current folder. `kit help` lists all commands; `kit <command> --help` prints the options of one.

## 1. Create the workspace

```
kit init <ws> --preset scalability --size standard --repo ../notes-api --repo ../notes-web
```

Options: `--preset scalability|reliability|performance`, `--size lite|standard|full`, one `--repo <folder>` per repository (it must exist), and optionally `--name`, `--question`, `--unit`, `--target <N>` (audit name, question, scale unit and target), `--no-rules` (switch the static rules off) and `--force` (add missing files to a non-empty folder, never overwriting). The workspace must lie outside the kit and outside every repo.

Then edit `<ws>/audit.config.json`: the question, date, scale, each repo's `role`, the hunt `groups` (init writes one per repo and lens, covering the whole repo; narrow them), `out_of_scope`, `known_limits`, `library_assumptions`, `publish.tracker`. After editing, re-render the prompts with `kit init <ws> --refresh-prompts`. Check with:

```
kit validate <ws>
kit doctor <ws>
```

`doctor` prints one line per check (Node, git 2.40 or newer, optional git 2.44, config, repos and their `.git` folders, pins, clean trees, optional Semgrep and `claude`) and then the `claude ...` line that opens a session with read access to every repo. The line starts with `--plugin-dir "<kit folder>"` when the kit is not an installed plugin (so the agents, skills and workflows load), then `--model` (the lead model, unless it is `inherit`) and `--effort`, and one `--add-dir` per repo. Before Phase 0 only the pins check may fail.

**No plugin?** Run `kit install-agents <ws>` (it copies the agent definitions into the workspace's `.claude/agents/`), set `"agents": { "namespace": "" }` in the config, and run `kit init <ws> --refresh-prompts` again. Without the plugin the workflows are not registered, so each agent phase starts its agents one at a time (see "Without the Workflow tool" in [run-phase](../skills/run-phase/SKILL.md)).

## 2. Open the audit session

Run the line `doctor` printed from inside the workspace, then `/hooks` (check that no other plugin adds a Stop hook that waits for a record this audit never writes). With the plugin, every later step is `/before-it-breaks:run-phase <step>`; without it, paste the start prompt from `<ws>/LAUNCHER-PROMPT.md`.

## 3. The steps

| Step | Command | Writes |
|---|---|---|
| pin | `kit pin <ws>` (`--allow-dirty` only if the user agrees; it is recorded. `--trust-git-dir` only if the user agrees: see below) | `work/pins.json`, `work/phase0-baseline.md` |
| map | agent phase `map` | `work/phase1/<repo>-map.md` |
| hunt | agent phase `hunt`, one run per `--run N` | `work/candidates.json` |
| evidence | `kit evidence <ws> --dry-run`, show it to the user, then `kit evidence <ws>` once, before verify | `work/phase3/receipts/` |
| batches | `kit batches <ws>` (cuts the candidates into batches and writes the batch plan) | `work/phase3/batches/`, `work/phase3/runs.json` |
| verify | agent phase `verify`, one run per entry in `runs.json`; save each result with `kit save verify`; after `kit batches` is re-cut, save the next run as a new number | `work/phase3/votes-<N>.json` |
| synthesize | `kit synthesize <ws>` | `work/phase3/verdicts.json` |
| overrides | write `work/phase3/master-overrides.json`, get approval, `kit synthesize <ws>` again, then `kit build log <ws>` again if it was already built | the same |
| build log | `kit build log <ws>` | `03-verification-log.md`, plus `claim-verdicts.json` and `final-verdicts.json` in `work/phase3/` |
| build measurements | `kit build measurements <ws>`, right after build log and before build report. No agents: it lists the live checks from the candidates, the receipts index, the final verdicts and the config's `measure` section, and never reads `work/phase4/`. The report and the log always link this page, so a skipped build shows up as a broken link in `kit check links` | `04-measurements.md` |
| report-inputs | agent phase `report-inputs` | `work/phase5/report-inputs.json` |
| recommend (optional, experimental) | agent phase `recommend`; it needs only `kit synthesize` and the saved report inputs | `work/phase6/recs/`, `work/phase6/cross-cutting.json` |
| build recommendations (only after recommend) | `kit build recommendations <ws>`, then as wanted `kit build issues <ws>` and `kit build explorer <ws>` (both read `work/phase6/finding-modules.json`, which this step writes) | `05-recommendations.md`, the target-architecture page, `work/phase6/issues.*`, `work/explorer-data.json` |
| build report | `kit build report <ws>`, after the recommend steps (or when recommend is skipped): the report links `05-recommendations.md` only when a recommend result was saved, and otherwise says there are no recommendations | `02-audit-report.md` |
| measure (optional) | run only the checks in `04-measurements.md` that access was agreed for | `work/phase4/` |
| closing checks | `kit check secrets <ws>`, `kit check unchanged <ws>`, `kit check links <ws>` | `work/secrets-scan.json` and `.md` |

Run order matters, because the kit ties votes and verdicts to the exact content of each candidate, the pins and the receipts:

- Run `kit evidence` once, before verify; run it again only on purpose (after a candidate or a pin changed). A receipt made for a different version of the candidate (compared by content hash, not by date) makes its verdict NEEDS-REVIEW.
- After any change to the candidates (a new hunt run, an edit), the overrides, the pins or the receipts, re-run `kit synthesize` and then `kit build log`. The builders (`build log`, `build report` and the rest) exit 1 and say what to re-run when those inputs have changed since `verdicts.json` was made (compared by content hash, not by date); a changed candidate also needs `kit evidence`, `kit batches` and verify again before its votes count. See [verification](verification.md#when-a-verdict-goes-stale).
- If `kit args verify` says "batch files are from an older version: run `kit batches` again", do that; the same goes for receipts that say "run `kit evidence` again".
- A phase run ends complete, or `incomplete` with a reason written in `HANDOFF.md` and the run log; never leave it silently half done.

Run `kit build issues` after `kit build recommendations`: it reads the roadmap and the finding-to-module file that step writes. `kit build explorer` needs that file too. A person, not the kit, writes `01-executive-summary.md`.

### An agent phase, step by step

```
kit args <phase> --run <N> <ws> > <ws>/work/args/<phase>-<N>.json
```

1. Pass the object in that file, unchanged, as the `args` of the plugin workflow `/before-it-breaks:<phase>`. Add `"dryRun": true` once to see the rendered prompts without starting any agent. Without the Workflow tool, read `workflows/<phase>.js` and start the same agents one at a time.
2. Save the result to a file as soon as it returns (the Workflow tool's output file can be saved as it is: `kit save` unwraps `{ "result": ... }` and notes it), then put it in place:

   ```
   kit save <phase> <result-file> --run <N> <ws>
   ```

   `save` checks the result against the kit's data shapes and refuses a malformed one; re-run the agent rather than editing the result by hand. Save a verify result exactly as the workflow returned it: it carries `bound_to`, which ties the votes to the candidates the skeptics saw, and a file without it is saved with a note but none of its votes count. `--run` may be left out for a hunt when the result names its run. `--force` only replaces another run's file, or report-inputs run 1 (which is replaced whole); a same-run hunt re-save is noted, not refused.
3. Record what actually ran:

   ```
   kit log <phase> --agents <count> --agent-type <type> --model <model> --effort <effort> [--wall-clock <s>] [--tokens <n>] [--run <N>] [--note "<text>"] <ws>
   ```

4. Append a dated entry to `HANDOFF.md` with the next step.

Script notes: `kit init` writes one default module rule per repo (check it); `check secrets` applies the home-path and email rules to the published files only and the secret patterns to everything; `doctor` warns when `kit.root` is stale, so run `init <ws> --refresh-prompts` after a plugin update; `check mermaid` needs `--modules <dir>`; `build report` and `build recommendations` take `--strict`, which exits 1 on any `check:` warning (for `build report`, that includes a finding whose report input is not drafted yet, or a size conflict; a corrected finding whose report input follows the skeptics' corrected size raises no check); hunt summaries are saved to `work/phase2/hunt-<N>.json`.

`kit args recommend` needs `kit synthesize` to have run and the report inputs to be saved first; it starts one planner per module that holds surviving findings, and finding ids that map to no module go to the cross-cutting agent. `doctor` has a required "method files" line: every lens and skeptic brief in use must exist.

`kit pin` refuses a repo whose `.git` folder can start a program or fetch, and a repo that is a `git worktree` or submodule checkout (`.git` is a file); the reasons are printed. The refusal list is in [security](security.md). Clone the repo again from a remote you trust, or, only if the user agrees, pin with `--trust-git-dir` (recorded in `pins.json` and the baseline; what it allows, and how a later change to the .git folder is refused, is in [security](security.md#threats)).

`args` for verify reads `runs.json`; `args report-inputs` accepts `--target-design <file>`; `--date YYYY-MM-DD` overrides the audit date.

## Workspace layout

```
<ws>/
  audit.config.json        your settings; you edit it and HANDOFF.md by hand
  HANDOFF.md  README.md  LAUNCHER-PROMPT.md  MASTER-PROMPT.md
  01-executive-summary.md  (by a person)
  02-audit-report.md  04-measurements.md  03-verification-log.md  05-recommendations.md
  system-docs/             the system as it is, plus the target-architecture page
  rules/                   copied rule sets, run-tests.sh, results/
  work/
    pins.json  phase0-baseline.md  run-log.json  claims.json  candidates.json
    args/  phase1/  phase2/  phase4/  phase5/
    phase3/   runs.json  batches/  receipts/  votes-<N>.json  verdicts.json
              master-overrides.json  claim-verdicts.json  final-verdicts.json
    phase6/   recs/  diagrams/  cross-cutting.json  finding-modules.json  issues.*
  .claude/settings.json    deny rules for writes to the repos and risky commands
  .gitignore               ignores everything: results are private by default
```

Output names come from `outputs` in the config. The `.claude/settings.json` deny rules reduce accidents; they are not a security boundary.

## Resuming

Start a new session the same way (the `doctor` launch line), then run `/before-it-breaks:audit-status`. It reads `HANDOFF.md`, `work/run-log.json` and which phase files exist, runs `doctor`, and names the open gate and the next command. If a repo moved off its pin, every later step is blocked until it is restored or the audit is re-pinned, which restarts it from the map.
