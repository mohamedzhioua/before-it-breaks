# Examples

This folder holds example configurations and one excerpt of real output from a pilot run. The demo config is invented; the Novu example is a plan that has not been run.

| Folder | What it is | Status |
|---|---|---|
| [`demo-config/`](demo-config/audit.config.json) | An invented "notes platform" (workspaces, notes, users, imports, notifications). It shows every config field in use and is the config the tests check. There is no code behind it. | Invented; used by the tests |
| [`novu-v3.19.0/`](novu-v3.19.0/README.md) | A plan for a public worked example on the open-source notification platform Novu, at one release tag. It shows how a real project would be set up: scope, question, size tiers, hunt groups. | Planned, not run yet |
| [`pilot-connect-mongo/`](pilot-connect-mongo/README.md) | Excerpt of the first real-agent pilot on connect-mongo@182cfb09ad (lite, scalability, code only): one High finding, its verification record and evidence receipt. | Real output; run 2026-10-22 |

## The demo config and the worked example are different things

- **`demo-config/`** is made up from start to finish. It exists so that the
  kit has one complete, valid config to test against and to copy from. Its
  repos, numbers and limits describe no real system.
- **`novu-v3.19.0/`** points at a real public repository. Today it holds only
  the plan: a config in example mode (the repo is given as a URL and a tag,
  and its pin is still `"TODO"`) and a README with the exact commands to run
  it. No code has been downloaded and no agent has read it, so the folder
  makes no claim about that project's code.

Check either config with:

```
node kit.js validate examples/demo-config
node kit.js validate examples/novu-v3.19.0 --example
```

The `--example` flag lets a repo be named by `url` + `ref` instead of a local
`path`, and lets `pin` be `"TODO"`. A config used for a real run needs a
`path` and no `"TODO"`, so the second command fails without the flag.

## How examples are run

Examples are **never run inside this repository**.

1. Clone the project into a folder outside the kit.
2. Create the audit workspace outside the kit as well (`node kit.js init`).
3. Run the phases there.
4. Copy only the results (reports, receipts, verdicts, run log) back into
   `examples/<name>/`, together with the licence of any project whose code it quotes (see `pilot-connect-mongo/LICENSE-connect-mongo`).

This keeps third-party code out of the kit's history, and keeps the kit's own
checks (`node kit.js check clean`) meaningful.
