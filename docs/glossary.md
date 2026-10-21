# Glossary

For anyone who meets an unfamiliar word in the reports or these docs. Plain meanings first; the exact rules are linked.

| Term | Meaning |
|---|---|
| **Agent** | An AI worker that Claude Code starts for one job (map one repo, hunt one group, vote on one batch) with its own instructions and context |
| **Area** | A report section that findings are filed under, such as "background jobs" or "database and indexes" (`areas`) |
| **Basis** | What a breaking size counts: for example items of one customer, items on the whole platform, rows in one file, or recipients of one send; or nothing, for a problem that is not size-driven |
| **Batch** | A set of candidates verified together by one set of skeptics and one verifier |
| **Breaking size** (`breaks_at`) | The size at which a finding is expected to fail. Calculated unless the verdict is PROVEN |
| **Candidate** | A suspected problem written up by a hunter. Not yet a finding |
| **Citation** | A pointer to code at the pinned commit: `repo@<first 10 characters of the commit>:path:line` |
| **Context-only repo** | A repo read for background (deployment files, say) but never hunted in |
| **Effort (fix)** | How much work a fix is: S, M or L ([severity and sizes](severity-and-sizes.md#effort)) |
| **Effort (model)** | How hard a model thinks before answering: low to max ([models and effort](models-and-effort.md)) |
| **Evidence command** | A read-only command that shows a candidate's code facts, re-run by the kit |
| **Finding** | A candidate that survived verification and is in the report |
| **Gate** | One of six questions a candidate must pass, or a check that must be met before the next step starts |
| **Group** (hunt group) | One slice of the code (a repo, a lens and a scope) given to one hunter |
| **HANDOFF** | The workspace file that records each step, decisions and the next step, so a new session can resume |
| **Hunter** | The agent that looks for candidates in one group |
| **Lead** | The main Claude Code session that runs the audit and proposes overrides |
| **Lens** | The angle a hunter or skeptic looks from: performance, reliability, data, infra, frontend for hunters; reach, mech, math for skeptics |
| **Mapper** | The agent that describes one repo before anyone hunts |
| **Maturity** | A word (Weak, Moderate, Satisfactory, Strong) given to an area by a fixed rule from its severity counts |
| **Override** | A recorded decision by the lead, approved by a named person, to remove, merge, re-scope or hold a finding. Never to add one |
| **Pin** | The exact commit of a repo recorded before the audit starts |
| **Preset** | A starting set of lenses, areas and settings: scalability, reliability or performance |
| **Receipt** | The file holding the output of a candidate's evidence commands, as re-run by the kit |
| **Rule** | A Semgrep pattern that flags a code shape; a hit is a lead, not a finding |
| **Skeptic** | An agent whose job is to refute candidates from one lens |
| **Target** | The size you want one customer (or the unit's owner) to reach (`scale.target`) |
| **Tier** | A band of sizes on the ladder (T0 to T4, plus "grows" and "n/s") used to group findings |
| **Verdict** | The outcome for a candidate: PROVEN, PROVEN-STATIC, UNPROVEN, REFUTED, OUT-OF-SCOPE, NEEDS-REVIEW, HELD, MERGED, REMOVED; and NOT-CHECKED for earlier claims ([verdicts](verification.md#verdicts)) |
| **Verifier** | The agent that checks, mechanically, that the receipts support the cited code facts |
| **Workflow** | A script the Claude Code Workflow tool runs to start many agents with fixed prompts and result shapes |
| **Workspace** | The folder, outside the kit and the repos, that holds one audit's config, files and results |
