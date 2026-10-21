# Contributing

Thank you for helping. This is maintained on a best-effort basis: there is no guaranteed response time for issues or pull requests, but every one is read.

## What is welcome

- **Lenses**: a new way of looking for problems (`method/lenses/`).
- **Stack packs**: Semgrep rules and lens hints for languages, frameworks, databases and queues the kit does not cover yet.
- **Rules**: new or sharper Semgrep rules for the stacks it does cover (`rules/semgrep/`).
- **Tool fixes**: bugs in `kit.js`, `tooling/` or `workflows/`, clearer error messages, better Windows or macOS support.
- **Docs in plain language**: anything that helps a newcomer, a manager or a founder understand a page without asking.

For a large change, open an issue first so the approach can be agreed before you spend time on it.

## Invented code only

**Never contribute code from your employer or your clients**: not in rules, tests, fixtures, examples or docs, not even a few lines, and not with the names changed. Write invented code instead. The kit's examples use an invented "notes platform" (workspaces, notes, users, imports, notifications); reuse it or invent your own.

Do not paste real findings, real numbers from a real system, internal hostnames, paths or names either.

## Rules: test first

1. Write the test file first, under `rules/semgrep/<set>/tests/`, with `// ruleid: <id>` above every line the rule must flag and `// ok: <id>` above lookalikes it must leave alone.
2. Then write the rule until the test passes: `bash rules/semgrep/run-tests.sh`.
3. Give the rule its own section in `rules/semgrep/README.md`, with its known **false positives** (what it flags that is fine) and **false negatives** (what it misses), like the existing rules. A rule without these notes will not be merged.

## Changes to verification

The gates, the skeptic votes, the verifier check and verdict synthesis (`tooling/synthesize-verdicts.js`, `method/skeptics/`, the workflows) decide what reaches a report. A change to any of them needs, in the pull request:

- a written rationale: what was wrong or missing, and why the new rule is better;
- a before/after on the fixture data under `tests/fixtures/`: which verdicts change, and why each change is right.

## Before you open a pull request

```
node tests/run-all.js
```

It runs `node --check` on every script, the unit tests, the workflow and plugin checks, the example configs, the link check and the leak check (`check-clean` with its generic patterns), plus the Semgrep rule tests when Semgrep is installed and `claude plugin validate` when Claude Code is. All of it must pass. Tests that build small git repos need a git identity (`git config --global user.name` and `user.email`).

Keep to the house rules of the code: Node 20 or later, CommonJS, no npm dependencies, every tool with a `main(argv)` and exit codes 0 (ok), 1 (check failed) and 2 (usage or config error).

## Sign-off (DCO)

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/): you certify that you wrote the change, or otherwise have the right to submit it under this project's licence. Add the sign-off with:

```
git commit -s
```

There is no CLA. By contributing you agree that your work is released under the project's [MIT licence](LICENSE).
