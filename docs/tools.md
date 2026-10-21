# Tools, by kind of evidence

For engineers adapting the kit or deciding what to install. Each tier below names a kind of evidence; higher rows are worth more than lower ones, because measured and deterministic evidence beats a model's judgement.

| Tier | What it gives | In the kit | Required? |
|---|---|---|---|
| **Measure** | Facts from a running system: query plans, sizes, memory, backlog, latency under load | Database, cache, queue and cluster clients and load-test tools of your choice, run by a person with agreed access. The kit only lists the checks (`kit build measurements`); its runner never starts them ([measuring](measuring.md)) | optional |
| **Deterministic** | The same answer every run | `git` read commands re-run by `kit evidence` at the pins; the bundled Semgrep rules ([rules](../rules/semgrep/README.md)); the kit's own scripts for pins, synthesis, reports and checks | git yes; Semgrep optional |
| **Find** | Candidates, from reading the code | The mapper, hunter and rule-writer agents, started by the plugin workflows (or one at a time) | yes |
| **Verify** | Attempts to disprove a candidate, and a mechanical evidence check | Three skeptic agents and one verifier agent per batch; fixed synthesis rules | yes |
| **Docs** | Readable output | The builders (`kit build ...`), the link check, and an optional Mermaid parse check (`kit check mermaid`, with Mermaid installed in a folder outside the kit) | link check yes |

Library behaviour that a finding rests on should come from the repo's lockfile and the package source or documentation for that version. When an agent could not check it, the candidate says "unverified" and the matching gate stays UNKNOWN. A documentation lookup tool helps if your agents have one; the kit does not depend on it.

## Deliberately not used, and why

| Kind of tool | Why not |
|---|---|
| Generic "audit my codebase" skill packs and agent bundles | Checklists without an evidence contract: nothing makes a finding cite code or survive a challenge |
| Review tools built for pull-request diffs | They judge a change, not a whole system; a set of findings needs its own skeptic step |
| Database or cloud integrations that can change things | The audit needs read access only; a tool that can change clusters, users or networks is a risk with no benefit here |
| `awk`, `jq` and Semgrep as evidence programs | Their languages can reach files or programs in ways the evidence runner cannot check, so they are never run as evidence. Semgrep runs as a separate rules stage instead |
| Unmaintained profilers and copied community skills | Low credibility; prefer official documentation and maintained tools |

## Installed but optional

Nothing beyond Node.js and git is needed to run the method. Semgrep makes the rules stage work; the measure-tier tools only matter if you run Phase 4. A tool you name in the plan but do not use should be reported as unused, never as part of the method ([lessons learned](lessons-learned.md)).
