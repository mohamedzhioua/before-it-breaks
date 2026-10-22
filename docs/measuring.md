# Measuring (Phase 4)

> **Designed, not yet proven.** This phase ships so that the path from a calculated size to a measured one is written down, but it has not been run end to end in any audit yet. Treat it as a plan you check step by step, not as a tested procedure.

For engineers with access to a running system who want to confirm or correct the breaking sizes in a report.

## Why measure

Code reading gives PROVEN-STATIC findings: the mechanism is in the code and the breaking size is calculated. A calculation can be off by a lot (a wrong size per item, a limit that applies elsewhere). Only a measurement on a running system can confirm the size, and only a measurement settles an UNPROVEN finding: there the skeptics accept the mechanism, but the evidence could not be re-run here (for example, it needs a live system).

## What the kit does

- During the hunt and the verify step, agents write checks that need a live system as evidence commands starting with `LIVE` (or with a database, cache or cluster client named in `evidence.live_prefixes`). The evidence runner records them as `skipped-live` and **never runs them**.
- `kit build measurements <ws>` is a standard step with no agents, run right after `kit build log`. It collects those checks into `04-measurements.md`, sorted by kind with the regular expressions in `measure.kinds` (database, cache, queue, cluster, library, benchmark; anything else under "other"), and leaves out candidates that were refuted, out of scope, removed or merged. It lists the checks and never runs them, and it does not read `work/phase4/`; the optional measure phase is only running the checks access was agreed for.
- The same page prints the minimum-access table from `measure.access`: which access, given in which safe form, unlocks which checks.

The kit does not run any measurement, and in this version no kit step turns a verdict into PROVEN. Record measured results under `work/phase4/` with the command, the environment, the date and the output, and state in the report and summary which findings were measured.

## Safe access, in order

| Access | Safe form (default config) | Unlocks |
|---|---|---|
| Database | A read-only user on a replica, never the primary | Query plans, index lists, collection or table sizes |
| Cache | Pasted output of the cache's own stats command | Memory use, key counts, eviction settings |
| Queue | Pasted dashboard or stats output | Backlog, retries, stuck jobs |
| Cluster | Read-only access (get and describe), or pasted manifests | Real replica counts, limits, probes |
| Load test | A staging environment with an agreed load window | Latency and throughput under load: the only route to PROVEN for size claims |

Start with the cheapest access that settles the most findings; pasted output is often enough.

## Rules

- **Never put load on production.** Load tests run on staging, in an agreed window.
- Ask before anything that touches a shared environment, even read-only.
- Use read-only credentials, given as environment variable names, never written into the config or the workspace.
- A measurement that disagrees with the calculation wins; correct the finding through the normal route (an override may narrow it; a larger problem goes back through hunt and verify).
