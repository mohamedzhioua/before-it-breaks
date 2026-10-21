# Security policy

## Supported versions

Only the latest release gets fixes. Before reporting, check that the problem still happens on it.

## Reporting a vulnerability

Please report privately, not in a public issue or pull request: on this repository's GitHub page, open the **Security** tab and choose **Report a vulnerability**. That opens a private advisory that only you and the maintainer can see.

Include what you ran, what happened, what you expected, and the smallest input that shows it (an invented repo, config or candidate file, never someone's real code).

This is a project maintained on a best-effort basis: there is no guaranteed response time, but every private report is read, and a confirmed problem is fixed and credited (unless you ask not to be named) before it is described in public.

## In scope

- **Bypasses of the evidence runner's allowlist**: any way to get `kit evidence` to start a program or option it should refuse, to run anything through a shell, to write a file, or to read outside the pinned repos.
- **Prompt-injection paths that make an agent write or execute**: text in audited code, or in a workspace file, that gets one of the kit's agents or workflows to change files, run commands, or act outside the read-only role its instructions give it.
- **Leaks into published outputs**: secrets, home folders, email addresses or other private paths that reach a report, a receipt or another generated file despite the masking and the `kit check secrets` record.
- Flaws in the kit's own leak gate (`tooling/check-clean.js`) that let a must-zero pattern through.

## Out of scope

- Problems in the code you audit with the kit. The kit does not do security audits; its findings are about growth, load and reliability.
- Bugs in Claude Code, Semgrep, Node.js, git or the other programs the kit starts, unless the kit uses them in an unsafe way. Report those to their own projects.
- Results that are only possible after you have already given an attacker write access to your machine, the kit folder or the workspace.
- The deny rules in a workspace's `.claude/settings.json` failing on their own: they are a second layer, documented as not a guarantee. A bypass that also needs a flaw in the kit's own instructions or tools is in scope.

## Threat model and safe use

What the kit trusts, what it does not, and how to run it safely (read-only agents, the evidence dry-run, containers for untrusted repos, private workspaces) are in [docs/security.md](docs/security.md).
