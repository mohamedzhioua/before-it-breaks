# Changelog

All notable changes to this project are written down here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First public version.

### Added

- **Claude Code plugin** (`.claude-plugin/plugin.json`, `marketplace.json`): the repository root is the plugin, installable from its own marketplace.
- **Seven agents** (`agents/`): mapper, hunter, rule writer, skeptic, verifier, architect and docs writer, each read-only with written safety rules; `kit install-agents` copies them into a workspace for use without the plugin.
- **Three skills** (`skills/`): `start-audit` (plain-language interview, workspace creation, pinning), `run-phase` (one gated step at a time, saving and logging every result) and `audit-status` (where the audit stands and what gate comes next).
- **Five workflows** (`workflows/`): `map`, `hunt`, `verify`, `report-inputs` and `recommend` (experimental), each with argument checks and a dry-run mode.
- **Method files** (`method/`): five lenses (performance, reliability, data, infra, frontend), three skeptic briefs (reach, mechanism, math) and the phase-1 map checklists.
- **One command line, `kit.js`**, over the tools in `tooling/`: `init`, `doctor`, `pin`, `args`, `batches`, `evidence`, `synthesize`, `save`, `log`, `validate`, `install-agents`, `build <log|report|measurements|recommendations|issues|explorer>` and `check <links|mermaid|unchanged|secrets|workflows|clean>`. Node 20 or later, no npm dependencies.
- **Evidence runner** (`kit evidence`): re-runs agent-written evidence commands at the pinned commits through a shell-free allowlist of read-only programs, with a dry-run list and masked receipts. It is an allowlist, not a sandbox.
- **Verdict synthesis** (`kit synthesize`): three skeptic votes and one verifier check per candidate become a verdict; lead overrides may only remove, merge, re-scope or hold a finding, and each needs a reason and a named approver.
- **Builders** for the verification log, the audit report, the measurement plan (designed, not yet proven), the recommendations, tracker issues and findings-explorer data; re-running a builder on the same data gives the same bytes.
- **Configuration**: one `audit.config.json` per audit, a JSON schema, defaults, three presets (scalability, reliability, performance) and audit sizes, checked by `kit validate`.
- **Workspace templates and prompts** (`templates/`, `prompts/`): the workspace README, HANDOFF, read-only Claude Code settings, report and system-doc outlines, finding and decision records, meeting and kickoff outlines, and the lead and launcher prompts.
- **Fifteen Semgrep rules** (`rules/semgrep/typescript/`, prefix `scale-`) for Node.js/TypeScript growth problems, each with invented test cases and documented false positives and negatives.
- **Checks for maintainers**: the leak gate `check-clean` (generic patterns, an optional private denylist, history scanning through `--stdin`, and shared-phrase detection), `check-plugin`, `check-workflows` and `check-links`.
- **Examples**: an invented demo config, and a planned worked example on a pinned open-source application (configuration only; not run yet).
- **Docs** (`docs/`): decision guide, how it works, method, verification, running an audit, tools, models and effort, severity and sizes, presenting results, measuring, config reference, lessons learned, limits, security and glossary.
- `SECURITY.md`, `CONTRIBUTING.md` (DCO sign-off, invented code only), `tests/run-all.js` and a CI workflow.

[0.1.0]: https://github.com/mohamedzhioua/before-it-breaks/releases/tag/v0.1.0
