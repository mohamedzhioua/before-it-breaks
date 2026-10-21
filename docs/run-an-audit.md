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

`doctor` prints one line per check (Node, git, config, repos, pins, clean trees, optional Semgrep and `claude`) and then the `claude --add-dir ...` line that opens a session with read access to every repo. Before Phase 0 only the pins check may fail.

**No plugin?** Run `kit install-agents <ws>` and set `"agents": { "namespace": "" }` in the config.

## 2. Open the audit session

Run the line `doctor` printed from inside the workspace, then `/hooks` (check that no other plugin adds a Stop hook that waits for a record this audit never writes). With the plugin, every later step is `/before-it-breaks:run-phase <step>`; without it, paste the start prompt from `<ws>/LAUNCHER-PROMPT.md`.

## 3. The steps

| Step | Command | Writes |
|---|---|---|
| pin | `kit pin <ws>` (`--allow-dirty` only if the user agrees; it is recorded) | `work/pins.json`, `work/phase0-baseline.md` |
| map | agent phase `map` | `work/phase1/<repo>-map.md` |
| hunt | agent phase `hunt`, one run per `--run N` | `work/candidates.json` |
| evidence | `kit evidence <ws> --dry-run`, show it to the user, then `kit evidence <ws>` | `work/phase3/receipts/` |
| batches | `kit batches <ws>` | `work/phase3/batches/`, `work/phase3/runs.json` |
| verify | agent phase `verify`, one run per entry in `runs.json` | `work/phase3/votes-<N>.json` |
| synthesize | `kit synthesize <ws>` | `work/phase3/verdicts.json` |
| overrides | write `work/phase3/master-overrides.json`, get approval, `kit synthesize <ws>` again | the same |
| build log | `kit build log <ws>` | `03-verification-log.md`, plus `claim-verdicts.json` and `final-verdicts.json` in `work/phase3/` |
| report-inputs | agent phase `report-inputs` | `work/phase5/report-inputs.json` |
| build report | `kit build report <ws>`, then as wanted `kit build issues <ws>` and `kit build explorer <ws>` | `02-audit-report.md`, `work/phase6/issues.*`, `work/explorer-data.json` |
| recommend (experimental) | agent phase `recommend` | `work/phase6/recs/`, `work/phase6/cross-cutting.json` |
| build recommendations | `kit build recommendations <ws>` | `05-recommendations.md`, the target-architecture page |
| measure (optional) | `kit build measurements <ws>`; run only the checks access was agreed for | `04-measurements.md`, `work/phase4/` |
| closing checks | `kit check secrets <ws>`, `kit check unchanged <ws>`, `kit check links <ws>` | `work/secrets-scan.json` and `.md` |

Run `kit build issues` after `kit build recommendations`: it reads the roadmap and the finding-to-module file that step writes. `kit build explorer` needs that file too. A person, not the kit, writes `01-executive-summary.md`.

### An agent phase, step by step

```
kit args <phase> --run <N> <ws> > <ws>/work/args/<phase>-<N>.json
```

1. Pass the object in that file, unchanged, as the `args` of the plugin workflow `/before-it-breaks:<phase>`. Add `"dryRun": true` once to see the rendered prompts without starting any agent. Without the Workflow tool, read `workflows/<phase>.js` and start the same agents one at a time.
2. Save the result to a file as soon as it returns, then put it in place:

   ```
   kit save <phase> <result-file> --run <N> <ws>
   ```

   `save` checks the result against the kit's data shapes and refuses a malformed one; re-run the agent rather than editing the result by hand.
3. Record what actually ran:

   ```
   kit log <phase> --agents <count> --agent-type <type> --model <model> --effort <effort> [--wall-clock <s>] [--tokens <n>] [--run <N>] [--note "<text>"] <ws>
   ```

4. Append a dated entry to `HANDOFF.md` with the next step.

`args` for verify reads `runs.json`; `args recommend` accepts `--target-design <file>`; `--date YYYY-MM-DD` overrides the audit date.

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
