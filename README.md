# Before It Breaks

**Find out what in your software gives way first as it grows, and at what size, before your users find out for you.**

Before It Breaks is a step-by-step audit method plus a kit for Claude Code (Anthropic's AI coding assistant). AI agents read your code and look for problems that appear as data and traffic grow. Nothing they report counts until a script has tried to re-run its evidence and three separate AI reviewers ("skeptics") have tried to disprove it. What survives goes into a plain-language report, with the exact line of code and the size at which it is expected to break.

It audits **scalability** (what breaks first as you grow), **reliability under load** (work that is lost, duplicated or stuck) and **performance you can see in the code** (slow queries, loops that call the database once per item). It is **not** a security audit, a code-quality review or a load test.

- [Is this for you?](#is-this-for-you)
- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Start in ten minutes](#start-in-ten-minutes)
- [Requirements](#requirements)
- [Limits](#limits) · [Security](#security) · [Credits](#credits) · [Licence](#licence)

## Is this for you?

Yes, if:

- you expect a lot more customers, data or traffic and want to know what will fail on the way;
- your system keeps losing, repeating or stalling background work and nobody knows why;
- you need a written, checkable answer for a manager, an investor or a team, not an opinion.

Not yet, if you need a security audit, a review of code style or a measured load test. Use a dedicated tool or specialist for those; this kit says so and stops.

> **If you are not an engineer**
>
> - **What you get:** a short answer to your question ("can it reach the size we want, and what breaks first?"), a report that ranks every problem by how bad it is and at what size it bites, a record of how each problem was checked, and a step-by-step plan of fixes. See [What you get](#what-you-get).
> - **What it takes:** someone comfortable with a terminal and Claude Code runs it, and someone who knows the system answers questions and approves decisions. A small codebase can be done in one working session; expect a large one to take several sessions over a few days (an estimate). Many AI agents work in parallel, so it uses far more of your Claude plan than ordinary chat; a tight budget cuts the *scope* (fewer parts of the system), never the checks. See [the decision guide](docs/decision-guide.md).
> - **What to hand to an engineer:** your answers to the nine questions in [the decision guide](docs/decision-guide.md) (what you want to know, the size that matters, the stack, and so on) and a link to this page. They start from [Start in ten minutes](#start-in-ten-minutes).
> - **How far to trust it:** every finding points at an exact line of code at a recorded version, and was challenged before it was kept. Breaking sizes are *calculated from the code*, not measured, unless your team measures them later. [The limits](docs/limits.md) are written down plainly.

A one-page overview for managers is in [How it works, for managers](docs/how-it-works.md).

## What you get

All results are written into a separate **workspace** folder that the kit creates for one audit (never into the kit or your repos):

| File | For | What it is |
|---|---|---|
| `01-executive-summary.md` | managers | Written by a person from a template: the answer to the audit question, the first thing to fail, and the order of fixes |
| `02-audit-report.md` | engineers, leads | Every finding that survived, in plain words: what happens, at what size, why, how to fix it, how much work it is |
| `03-verification-log.md` | anyone who doubts a finding | How every candidate was checked: votes, gates, re-run evidence, overrides with who approved them |
| `04-measurements.md` | engineers with access | The read-only live checks that would turn a calculated size into a measured one (designed, not yet proven) |
| `05-recommendations.md` | leads, architects | Change plans per module, decision records and a now / next / later roadmap (experimental) |
| `system-docs/` | new team members | A description of the system as it is, with diagrams |
| issues file | the team | One issue per change, as a GitLab CSV import or a Markdown checklist for any tracker |

In short, a report entry says this (an invented example, shortened; the kit's examples use a made-up "notes platform"):

> **SVC-JOBS-03 · high · breaks at about 200k notes per workspace** (PROVEN-STATIC)
> The nightly digest job loads every note of a workspace into memory at once before sending notifications, so a large workspace exhausts the worker's memory limit and nobody in it gets a digest.
> *Fix direction:* stream the notes with a cursor and send in pages. *Effort:* M.
> Cited: `notes-api@1a2b3c4d5e:src/jobs/digest.job.ts:42`

PROVEN-STATIC means: the code was re-read at the recorded commit, a script re-ran the evidence, and the skeptics failed to knock it down; it was not measured. Every verdict word is explained in [the verification guide](docs/verification.md#verdicts) and [the glossary](docs/glossary.md).

## How it works

Seven steps, numbered 0 to 6. The lead checks each gate before the next step; person gates rely on the skills, not on code, and are recorded with who confirmed them and when.

| # | Step | What happens | Gate before it |
|---|---|---|---|
| 0 | **Pin** | Record the exact commit of every repo, so every finding points at code anyone can check out | The set-up check (`doctor`) passes |
| 1 | **Map** | One agent per repo describes the system: modules, data, background jobs, heavy flows | Every repo is pinned and unchanged |
| 2 | **Hunt** | One agent per module group and lens looks for problems and writes each one up with citations, the arithmetic and commands that show the evidence | Someone who knows the system has skimmed the maps |
| 3 | **Verify** | A script re-runs every evidence command (read-only); three skeptics try to refute each candidate; a verifier on another model checks the evidence; fixed rules turn the votes into verdicts | A person has reviewed the list of commands the script would run |
| 4 | **Measure** (optional) | Read-only checks on a live system turn calculated sizes into measured ones. *Designed, not yet proven* | Access is agreed in writing; never production load |
| 5 | **Report** | Plain-language write-up of every surviving finding, rebuilt from data | Every lead override has a reason and a named approver |
| 6 | **Recommend** | Module plans, decision records and a roadmap (experimental) | The report is built |

More: [How it works, for managers](docs/how-it-works.md) · [the method in full](docs/method.md) · [how findings are verified](docs/verification.md).

## Start in ten minutes

1. **Decide what you want** (a few minutes): read [the decision guide](docs/decision-guide.md) and choose a size (`lite`, `standard`, `full`) and a preset (`scalability`, `reliability`, `performance`).
2. **Install the plugin.** Inside Claude Code:

   ```
   /plugin marketplace add mohamedzhioua/before-it-breaks
   /plugin install before-it-breaks@before-it-breaks
   ```

   Or from a terminal:

   ```
   claude plugin marketplace add mohamedzhioua/before-it-breaks
   claude plugin install before-it-breaks@before-it-breaks
   ```

   Or in one step: `claude plugin install before-it-breaks --marketplace mohamedzhioua/before-it-breaks`.
3. **Start the audit.** Open Claude Code anywhere and run `/before-it-breaks:start-audit`. It asks the decision-guide questions in one message, creates the workspace, checks the set-up and pins every repo.
4. **Open the audit session.** The set-up prints a `claude --add-dir ...` line; run it in a terminal from the workspace folder, run `/hooks` once (see [lessons learned](docs/lessons-learned.md)), then `/before-it-breaks:run-phase map`. Check progress any time with `/before-it-breaks:audit-status`.

**Without the plugin.** Clone this repo and drive the same steps with the kit's command line:

```
git clone https://github.com/mohamedzhioua/before-it-breaks.git
node before-it-breaks/kit.js init ../audits/notes-growth --preset scalability --size lite --repo ../notes-api
node before-it-breaks/kit.js install-agents ../audits/notes-growth
node before-it-breaks/kit.js doctor ../audits/notes-growth
```

`install-agents` copies the agent definitions into the workspace's `.claude/agents/`; then set `"agents": { "namespace": "" }` in its `audit.config.json` and run `node before-it-breaks/kit.js init ../audits/notes-growth --refresh-prompts`. Without the plugin the workflows are not registered, so each agent phase runs by dispatching its agents one at a time (see "Without the Workflow tool" in [run-phase](skills/run-phase/SKILL.md)). `init` writes one default module rule per repo (check it), and `doctor` warns when `kit.root` is stale (run `--refresh-prompts` after a plugin update). `check secrets` applies home-path and email rules to the published files only and secret patterns to everything; `check mermaid` needs `--modules <dir>`; `build report` and `build recommendations` take `--strict`, which exits 1 on any `check:` warning (for `build report`, that includes a finding whose report input is not drafted yet); hunt summaries are saved to `work/phase2/hunt-<N>.json`. `kit args recommend` needs `kit synthesize` to have run first; it starts one planner per module that holds surviving findings, and finding ids that map to no module go to the cross-cutting agent. `doctor` has a required "method files" line (lens and skeptic briefs exist). Every step after that is in [Run an audit](docs/run-an-audit.md); `node kit.js help` lists all commands.

## Requirements

| Need | Version or note | Required? |
|---|---|---|
| Claude Code | A recent version with plugins and subagents. The **Workflow tool** runs the agent phases; without it the lead session starts the same agents one at a time | yes |
| Claude plan | Multi-agent phases use much more than ordinary chat; expect to meet usage limits on a large audit and spread it over sessions | yes |
| Node.js | 20 or newer. The kit has no npm dependencies | yes |
| git | 2.40 or newer (the evidence runner relies on it to stop a repo's `.gitattributes` from naming programs to run). 2.44 or newer is optional: it adds `GIT_NO_LAZY_FETCH`; without it fetching is still blocked by `GIT_ALLOW_PROTOCOL`, and `kit pin` refuses partial clones either way | yes |
| bash | Linux and macOS: the system bash. Windows: Git Bash, found automatically | for the rule tests |
| Semgrep | Optional, for the bundled static rules ([rules](rules/semgrep/README.md)) | optional |
| Database, cache or cluster tools | Only for the measure step, with access you agree | optional |

**Today the kit fits best on Node.js or TypeScript back ends that use MongoDB or Redis** (the lenses also cover SQL databases). For other stacks the method still works, but the bundled rules will not: switch them off and bring your own, and expect the hunters to rely on reading alone.

## Limits

In short: findings are proven on code, not measured; the method has been used end to end on one private system only (a multi-repository Node.js/TypeScript system using MongoDB, Redis and Kubernetes); two runs will not give identical results; the skeptics share one model family; coverage is only as wide as the scope you set; one run is not exhaustive and repeated runs find more (an observation also made by [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) for its own audits); the measure step is designed but not yet proven. Full list: [docs/limits.md](docs/limits.md).

## Security

The agents read code nobody has vetted, so instructions hidden in that code can try to steer them. The evidence runner re-runs commands that agents wrote; it accepts only a short list of read-only programs and options, and **it is an allowlist, not a sandbox**. A repo's `.git` folder is trusted input too: `kit pin` and `kit doctor` refuse one that can start a program or fetch, unless you pass `--trust-git-dir`, which skips that check entirely. The deny rules written into the workspace are a layer, not a boundary. Run the kit only on code you may read, clone from a remote you trust, keep workspaces private, never put secrets in the config, and use a container, a VM or Claude Code's sandbox with the network off for repos you do not trust. Threat model and safe use: [docs/security.md](docs/security.md).

## Documentation

| Page | For |
|---|---|
| [Decision guide](docs/decision-guide.md) | anyone choosing the settings |
| [How it works](docs/how-it-works.md) | managers |
| [Method](docs/method.md) · [Verification](docs/verification.md) | anyone who wants to know why to trust a finding |
| [Run an audit](docs/run-an-audit.md) · [Config reference](docs/config-reference.md) | the person running it |
| [Tools](docs/tools.md) · [Models and effort](docs/models-and-effort.md) | engineers adapting the kit |
| [Severity and sizes](docs/severity-and-sizes.md) · [Presenting results](docs/presenting-results.md) · [Measuring](docs/measuring.md) | whoever writes up and shares the results |
| [Lessons learned](docs/lessons-learned.md) · [Limits](docs/limits.md) · [Security](docs/security.md) · [Glossary](docs/glossary.md) | everyone |

## Credits

Methods adapted, text not copied. This project is not affiliated with or endorsed by Trail of Bits.

- [Trail of Bits](https://github.com/trailofbits/skills): the **fp-check** false-positive protocol (its gates are recast for performance and reliability claims, see [verification](docs/verification.md#how-the-gates-map-onto-fp-check)) and the **semgrep-rule-creator** test-first way of writing rules.
- Documentation conventions: [C4](https://c4model.com/) (diagram levels and naming), [arc42](https://arc42.org/) (system-doc sections), [MADR](https://adr.github.io/madr/) (decision records) and [Diátaxis](https://diataxis.fr/) (how these docs are split).

External tools, used but not bundled: [Semgrep](https://semgrep.dev/) and [Mermaid](https://mermaid.js.org/).

## Licence

MIT. See [LICENSE](LICENSE).
