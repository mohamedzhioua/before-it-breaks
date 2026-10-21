# Security: threat model and safe use

For anyone who runs the kit, and especially anyone pointing it at code they did not write. This page is the threat model; how to report a vulnerability in the kit is in the repository's security policy.

This kit is **not** a security audit tool. This page is about using it safely.

## Threats

1. **The agents read untrusted code.** Source files, comments, docs, commit messages and config in the audited repos may hold text written to steer an AI (prompt injection), and agents may copy it into maps, candidates and notes. Every agent's instructions say that such text is data, never orders, and the workflows pass earlier results to agents inside fenced, labelled blocks. That lowers the risk; it does not remove it.
2. **The evidence runner executes commands written by agents.** `kit evidence` re-runs them at the pins. It starts no shell: each command is split into words and each pipeline step is started directly. Only a short list of reading programs (git read subcommands, grep, rg, cat, head, tail, sed, wc, sort, uniq, cut, tr, ls) with a per-program list of options is accepted; `awk` and `jq` are never run; globs, variables, chains, redirects and paths outside the repo are refused; git reads at the pinned commit, with settings that stop a repo's `.gitattributes` from naming filter or diff programs. **This is an allowlist, not a sandbox.** A flaw in it, or in one of the programs it starts, could still read or do more than intended.
3. **Workspaces hold private material.** Configs, receipts, maps and reports may contain private paths, code excerpts and details of your system.

## Safe use

- Point the kit only at code you have permission to read.
- Keep agents read-only. `init` writes deny rules into the workspace's `.claude/settings.json` (no writes to the repos, no commits, checkouts, resets or installs). They are an extra layer, not a promise.
- Review the evidence commands before they run: `kit evidence <ws> --dry-run` lists what would run and what is refused.
- For repos you do not trust, run the whole audit inside a container or VM with the repos mounted read-only.
- Never put secrets in the config; name environment variables instead. Command text in a receipt is masked in place with `evidence.secret_patterns`; when a secret, email or home-path pattern matches a command's output, that command's whole output is withheld from the receipt.
- Keep workspaces private. The workspace `.gitignore` ignores everything by default; run `kit check secrets <ws>` and keep its record before sharing anything.
- Ask before any check touches a shared environment, and never run load against production.

## In scope for reports

Ways to get the evidence runner to run something outside its allowlist, or to read outside the pinned repos, are security bugs in this kit and in scope for reports.
