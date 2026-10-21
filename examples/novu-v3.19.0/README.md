# Worked example plan: Novu at v3.19.0

**Status: planned — not run yet.** No code has been downloaded and no agent
has read the project. This folder holds a plan only, so it contains no
findings and makes no statement about the quality of the project's code.

Every page this example publishes later will start with this label:

> Demo of the method at tag v3.19.0; not reviewed by the project's
> maintainers; sizes are calculated, not measured.

## Why this project

[Novu](https://github.com/novuhq/novu) is an open-source notification
platform. It is a good subject for showing the whole method because it has
the parts the kit's scalability preset is built for:

- services written in TypeScript (an API and a background worker);
- MongoDB for data and Redis-backed job queues;
- one clear growth question that anyone can follow: **what happens when one
  notification is sent to N subscribers?**

The project is named here only as the subject of a planned demo.

## The question and the size that matters

- **Question:** Can one notification be sent to a million subscribers in one
  go, and what gives way first on the way there?
- **Scale unit:** subscribers in one send.
- **Tiers:** 10,000 · 100,000 · 1,000,000 (the target). These are chosen for
  the demo, not taken from the project.

## Scope

One repository, at the release tag `v3.19.0`.

| In scope | Out of scope |
|---|---|
| `apps/api/` | `enterprise/**` and any other separately licensed package |
| `apps/worker/` | `apps/dashboard/` (web front end) |
| `libs/dal/` | tests, specs and end-to-end folders |
| `libs/application-generic/` | security (see below) |

Hunt groups (see [`audit.config.json`](audit.config.json)):

| Key | Lens | Folders |
|---|---|---|
| `SVC-TRIGGER` | performance | `apps/api/`, `libs/application-generic/` |
| `WRK-QUEUE` | reliability | `apps/worker/`, queue code in `libs/application-generic/` |
| `WRK-RUNTIME` | infra | start-up, health and shutdown of `apps/api/` and `apps/worker/` |
| `DATA-DAL` | data | `libs/dal/` |

The group scopes describe where to look. Phase 1 maps confirm or correct
them before any hunt starts.

## What was observed, and when

Observed on 2026-10-21 from the public GitHub API, without cloning:

- the default branch is `next`;
- the tag `v3.19.0` points at commit
  `fe53c481acb005925b990fe2484fcb6aea396e28`;
- the repository root carries `LICENSE-MIT`, `LICENSE-ENTERPRISE` and
  `EE-PACKAGES-LICENSE`, and an `enterprise/` folder.

The config keeps `"pin": "TODO"` on purpose. The commit that counts is the
one `kit pin` records in `work/pins.json` from the actual clone; if it differs
from the commit above, the tag has moved and the plan must be checked again.

## How to run it later

Run everything **outside** this repository. `<kit>` is the folder of the kit,
`<base>` any folder outside it.

```
# 1. Clone at the tag, outside the kit
git clone --branch v3.19.0 https://github.com/novuhq/novu <base>/repos/novu
git -C <base>/repos/novu rev-parse HEAD        # compare with the commit above

# 2. Create the workspace and copy this plan into it
node <kit>/kit.js init <base>/novu-audit --preset scalability --size standard --repo <base>/repos/novu
#    Then put the fields of examples/novu-v3.19.0/audit.config.json into
#    <base>/novu-audit/audit.config.json, replacing url / ref / pin with
#    "path": "../repos/novu" (or whatever path init wrote).
node <kit>/kit.js validate <base>/novu-audit   # must print OK, without --example

# 3. Check the set-up and pin the commit (Phase 0)
node <kit>/kit.js doctor <base>/novu-audit
node <kit>/kit.js pin <base>/novu-audit

# 4. Run the phases from Claude Code, in the workspace
/before-it-breaks:run-phase map
/before-it-breaks:run-phase hunt
/before-it-breaks:run-phase evidence
/before-it-breaks:run-phase batches
/before-it-breaks:run-phase verify
/before-it-breaks:run-phase synthesize
/before-it-breaks:run-phase overrides
/before-it-breaks:run-phase build log
/before-it-breaks:run-phase report-inputs
/before-it-breaks:run-phase build report
/before-it-breaks:run-phase recommend        # optional, experimental
/before-it-breaks:run-phase build recommendations
/before-it-breaks:run-phase close            # secrets, unchanged, links
```

`/before-it-breaks:audit-status` shows which step is next and which gate is
open. Check the exact `init` options with `node <kit>/kit.js init --help`
before running.

Afterwards copy only the results into this folder (reports `01`–`05`,
maps, receipts, verdicts, `work/run-log.json` with the models, effort,
wall-clock and tokens actually used) and add a `THIRD-PARTY.md`.

## Rules for the run

- **Security issues are never published.** If any agent or person notices a
  possible security issue, it is left out of every result and reported
  privately to the maintainers as the project's `SECURITY.md` describes.
- **Heads-up first.** Before publishing, send the maintainers a short,
  courteous note with a link to the draft, and give them time to reply.
- **Licence.** Most of the repository is under the MIT licence; the
  enterprise folders are under a separate enterprise licence. Read both
  `LICENSE-MIT` and `LICENSE-ENTERPRISE` (and `EE-PACKAGES-LICENSE`) before
  publishing anything. Any quoted code excerpt keeps its licence and notice,
  listed in a `THIRD-PARTY.md` in this folder.
- **No branding.** Results name the project in text only; no logos.

## Needs approval before anything happens

1. The download (cloning the repository).
2. The agent budget for one run of about "standard" size.
3. Publication of the results.
