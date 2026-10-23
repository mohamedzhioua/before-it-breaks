# Changelog

All notable changes to this project are written down here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-23

A fix release: two evidence-runner gaps, the `--trust-git-dir` re-check, safer generated pages, and docs.

### Security

- **Evidence runner, `.env` in history and diffs:** `git show` and `git diff` always get the `.env` exclude pathspecs, as `git grep` already did; `git log` gets them when it prints patches or file lists (`-p`, `--patch`, `--stat`, `--numstat`, `--shortstat`, `--name-only`, `--name-status`, `--unified`), not with `-L` or `--follow`, where git takes no extra pathspec. Option order cannot turn them off (`show -s -p` still gets them). A file operand that resolves through a link, a linked folder or a chain of links to a `.env` file is refused. Still relying on the output detectors, and listed in limits and security: reading a `.env` blob by its object id, and `git log --follow` or `-L`.
- **`--trust-git-dir` is re-checked:** `kit pin --trust-git-dir` now records the problems it accepted and a digest of the repo's `.git` control files (following one `gitdir:` and one `commondir` pointer) in `pins.json`. `kit doctor`, `kit evidence` and `kit check unchanged` refuse the repo when any of those files changed since pinning, until it is cloned again or re-pinned; before, the flag skipped the check entirely. A pointer that cannot be resolved is refused at pin time. A file named by an include is not in the digest (see security).
- **Generated pages:** agent-written text keeps a Markdown link only when its target starts with `http://`, `https://`, `mailto:` or `#`, or is a plain relative path; any other link (`javascript:`, `data:`, a scheme spelled with an HTML entity or a backslash-escaped colon) is shown as plain text.

### Upgrading

- A repo pinned with `--trust-git-dir` by 0.1.0 has no digest and is refused until it is re-pinned with `--trust-git-dir` (re-pinning at the same commit rewrites `pins.json` and the baseline; receipts and verdicts, which name the commit, stay valid). Other pins are unaffected.
- A `pins.json` written by 0.1.1 with `--trust-git-dir` carries `git_dir_digest` and `git_dir_problems`, which 0.1.0 rejects.

### Fixed

- The verification log's excerpts never cut an emoji in half.
- `kit build issues --tracker github` is accepted as another name for `markdown`.
- `.claude-plugin/marketplace.json` names the plugin source as `"."`, the documented spelling for the repository root.

### Docs

- README: the reason for the `/hooks` step, and the Claude Code version (2.1.292 or later) that the one-step install command needs.
- security.md: the evidence-runner paragraph is split into bullets; the deny-rule groups no longer carry hard-coded counts (`config/defaults.json` is the list); the full `--trust-git-dir` text lives there (including the include-file gap), and limits, run-an-audit, method and the config reference link to it.
- run-an-audit.md: after `kit batches` is re-cut, save the next verify run as a new number.

## [0.1.0] - 2026-10-22

First public version.

### Added

- **Claude Code plugin** (`.claude-plugin/plugin.json`, `marketplace.json`): the repository root is the plugin, installable from its own marketplace.
- **Seven agents** (`agents/`): mapper, hunter, rule writer, skeptic, verifier, architect and docs writer, with written safety rules; five are read-only, and the rule writer and docs writer write only inside the workspace; `kit install-agents` copies them into a workspace for use without the plugin.
- **Three skills** (`skills/`): `start-audit` (plain-language interview, workspace creation, pinning), `run-phase` (one gated step at a time, saving and logging every result) and `audit-status` (where the audit stands and what gate comes next).
- **Five workflows** (`workflows/`): `map`, `hunt`, `verify`, `report-inputs` and `recommend` (experimental), each with argument checks and a dry-run mode.
- **Method files** (`method/`): five lenses (performance, reliability, data, infra, frontend), three skeptic briefs (reach, mechanism, math) and the phase-1 map checklists.
- **One command line, `kit.js`**, over the tools in `tooling/`: `init`, `doctor`, `pin`, `args`, `batches`, `evidence`, `synthesize`, `save`, `log`, `validate`, `install-agents`, `build <log|report|measurements|recommendations|issues|explorer>` and `check <links|mermaid|unchanged|secrets|workflows|clean>`. Node 20 or later, no npm dependencies.
- **Evidence runner** (`kit evidence`): re-runs agent-written evidence commands at the pinned commits through a shell-free allowlist of read-only programs, with a dry-run list and masked receipts. It is an allowlist, not a sandbox.
- **Verdict synthesis** (`kit synthesize`): a vote from every configured skeptic lens and one verifier check per candidate become a verdict; lead overrides may only remove, merge, re-scope or hold a finding, and each needs a reason and a named approver.
- **Builders** for the verification log, the audit report, the measurement plan (designed, not yet proven), the recommendations, tracker issues and findings-explorer data; re-running a builder on the same data gives the same bytes.
- **Configuration**: one `audit.config.json` per audit, a JSON schema, defaults, three presets (scalability, reliability, performance) and audit sizes, checked by `kit validate`.
- **Workspace templates and prompts** (`templates/`, `prompts/`): the workspace README, HANDOFF, read-only Claude Code settings, report and system-doc outlines, finding and decision records, meeting and kickoff outlines, and the lead and launcher prompts.
- **Fifteen Semgrep rules** (`rules/semgrep/typescript/`, prefix `scale-`) for Node.js/TypeScript growth problems, each with invented test cases and documented false positives and negatives.
- **Checks for maintainers**: the leak gate `check-clean` (generic patterns, an optional private denylist, history scanning through `--stdin`, and shared-phrase detection), `check-plugin`, `check-workflows` and `check-links`.
- **Examples**: an invented demo config, and a planned worked example on a pinned open-source application (configuration only; not run yet).
- **Docs** (`docs/`): decision guide, how it works, method, verification, running an audit, tools, models and effort, severity and sizes, presenting results, measuring, config reference, lessons learned, limits, security and glossary.
- `--strict` on `build report` and `build recommendations` (exit 1 on `check:` warnings); `doctor` checks that method files exist and warns when `kit.root` differs from the running kit; `init` writes one starting module rule per repo; 68 default deny rules (see below).
- `kit args recommend` requires synthesis first and starts one planner per module with surviving findings, sending unmapped ids to the cross-cutting agent.
- `check secrets` splits its rules: home-path and email rules for the published set, secret patterns for every workspace file, recorded per hit.
- The verification log and report gain a "Notes for the audit team" section and the NOT-CHECKED (hunter: unresolved) verdict.
- **`.git` folder check** (`tooling/lib/git-env.js`): `kit pin` and `kit doctor` read a repo's `.git/config` and `info/attributes` as text before the first git call and refuse a repo that can start a program, fetch or send git elsewhere (including worktree and submodule checkouts, includes, filter and diff drivers); `kit evidence` and `kit check unchanged` check again. `kit pin --trust-git-dir` pins anyway and is recorded in `pins.json` and the baseline; it skips the .git-folder check entirely (a .git file, commondir, alternates, core.worktree, includes, filter and diff drivers are then all allowed), and the isolated git environment still applies. git runs without global or system config (`kit pin`, `kit doctor` and `kit check unchanged` carry over only `core.autocrlf` and `core.eol`; the evidence runner carries none), without fetching and without looking into submodules.
- git 2.40 is required; 2.44 is optional (`GIT_NO_LAZY_FETCH`). `doctor` reports both.
- 68 default deny rules (was 28): new are download and remote tools, interpreters and shells, package runners and git commands that reach out (the git writes, including `git rm` and `git mv`, and the package installs were already there). Groups: 17 git writes, 11 package installs, 7 download and remote tools, 18 interpreters and shells, 10 package runners, 5 git commands that reach out. A rule such as `Bash(git * <sub>)` blocks an unquoted search word that is a git subcommand; the agent briefs and hunt prompts say to quote it or use `rg`. Bare `node` cannot be denied. The rules are a layer, not a boundary.
- **Evidence runner**: a file or folder named .env, or .env followed by '.', '-' or '_' (any case), is never read by name and is excluded from folder searches (grep, rg, git grep); history and diff output and links under other names rely on the output detectors, and the kit never promises a secret cannot reach a receipt; search patterns may still name `.env`; wildcard git pathspecs after `--` run unless they could match an `.env` file; grep and rg get `.env` excludes just before their first operand (the search pattern or the first path); `sed` runs with `--sandbox` when supported; the output detectors gain JWTs, payment keys, cloud keys and credentialed web URLs.
- **Verdicts bound to content**: `kit batches` writes a batch plan and a hash per candidate; `kit save verify` keeps them in `votes-<N>.json` as `bound_to`. A vote counts only when it is bound to the candidate's current content; otherwise the verdict is NEEDS-REVIEW ("changed after batching", "votes not saved with `kit save verify`", "no receipt", "changed after receipt", "different receipt"). Two votes files conflict only on substance (vote, severity, gate results, corrected threshold, `duplicate_of`, the verifier's verdict); free text from the later file wins, with a note. `verdicts.json` records the hashes of candidates, overrides, pins and receipts, and `kit build log` and the builders exit 1 until `kit synthesize` and `kit build log` are run again after a change. Editing `severity_guess` alone gives NEEDS-REVIEW (strict by design).
- `kit save --force` only replaces another run's file, or report-inputs run 1; a same-run hunt re-save is noted. `build report --strict` also exits 1 when a finding has no drafted report input.
- Agent-written text in generated pages has `<` and `![` escaped; the tracker CSV prefixes cells that start with `=`, `+`, `-` or `@` with a quote.
- CI: a `macos-latest` job that runs only when started by hand (`workflow_dispatch`); push and pull-request runs stay on Ubuntu and Windows.
- Docs: security (`.git` is trusted input, the `.env` rule, deny groups), limits (one run is not exhaustive, as also observed by [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill); known gaps such as `javascript:` link targets not being removed), verification (batch plan, binding, stale verdicts), run order in "Run an audit".
- **Pilot**: a real-agent pilot on connect-mongo found and fixed five kit issues: the relaunch line (now starts with `--plugin-dir` when the kit is not an installed plugin), saving the Workflow tool's output file as it is, the steering-note excerpt, the corrected-size check in the report, and links to pages of skipped phases. `build measurements` is now a standard step after `build log`.
- `examples/pilot-connect-mongo/`: an excerpt of that pilot (one High finding, its verification record and evidence receipt), real output; the finding text is not edited.
- `tests/run-all.js` adds an end-to-end builder step with `--strict` and a Semgrep fixture test.
- Lenses gain seven items with sums, mitigations, false positives and evidence commands (reliability: poison records, detached work, unsafe recovery or replay; performance: aggregate against per-item limits, cache stampede, key cardinality, superlinear regex or parsing); the arithmetic skeptic refutes a missing limit as `hardening:` when no breaking size can be derived at all (a size above the target stays `beyond target:`, one only a measurement could give stays unknown), and the mechanism and reach skeptics do the same for a defence-in-depth gap alone; each hunter may return the files it read as `reviewed`, kept per hunter in the hunt summary. Ideas from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT).
- `SECURITY.md`, `CONTRIBUTING.md` (DCO sign-off, invented code only), `tests/run-all.js` and a CI workflow.
- `tests/run-all.js` prints every failing test with its error block above the tail of a failed step; CI keeps the full output of failed steps as an artifact.

### Fixed

Found by the first CI runs on Windows and macOS:

- The leak gate's `@except` and allow rules on a single file no longer miss when the path holds a Windows 8.3 short name; both the file and the git root are resolved to real paths first.
- On Windows, a work-tree link is scanned as its target with forward slashes, as git records it, so a home path in a link target is caught.
- A test now accepts the padded count that BSD `wc` prints on macOS.

[0.1.1]: https://github.com/mohamedzhioua/before-it-breaks/releases/tag/v0.1.1
[0.1.0]: https://github.com/mohamedzhioua/before-it-breaks/releases/tag/v0.1.0
