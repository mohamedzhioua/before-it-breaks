# How it works, on one page

For managers, founders and anyone who will read the results without running the audit.

## The idea

An AI agent that reads code can find real problems, and it can also be confidently wrong. So the method separates **finding** from **believing**. Agents suggest problems ("candidates"); a candidate becomes a finding only after a script has re-run the evidence it cites and three separate reviewers have tried, and failed, to show it is wrong. Everything points at an exact line of code at a recorded version, so any engineer can check any finding.

## The steps (0 to 6)

| # | Step | In plain words | Gate before it |
|---|---|---|---|
| 0 | Pin | Freeze the version of the code being read | The set-up check passes |
| 1 | Map | Describe the system as it is | Nothing changed since the pin |
| 2 | Hunt | Look for what breaks as it grows, one area and angle at a time | A person who knows the system has skimmed the maps |
| 3 | Verify | Re-run the evidence; three skeptics and a mechanical check try to knock each candidate down | A person has seen which commands would run |
| 4 | Measure (optional) | Check calculated sizes on a live system, read-only. Designed, not yet proven | Access agreed; never production load |
| 5 | Report | Write every surviving finding in plain words | Every human decision has a reason and a named approver |
| 6 | Recommend | Plan the fixes and their order (experimental) | The report is built |

## What you receive

A short answer to your question, a ranked report (how bad, from what size, how much work to fix), a record of how each finding was checked, a fix plan with a roadmap, a description of the system, and an issue list for your tracker. [The README](../README.md#what-you-get) lists every file, with a sample entry, so you can see the format first.

## How far to trust it

- **Trust the code facts.** Each finding cites the code at a pinned commit, and a script re-ran the commands that show it.
- **Treat breaking sizes as estimates.** They are calculated from the code, the configuration and documented limits. The verdict word tells you which: PROVEN-STATIC is calculated, PROVEN is measured.
- **Human decisions are visible.** The audit lead may remove, merge, narrow or hold back a finding, never add one, and each such decision is listed with its reason and who approved it.

## What it does not tell you

- Whether the system is **secure**, whether the code is **clean**, or whether you are **compliant**.
- How the system behaves under real load, unless you run the measure step.
- Anything about parts of the system you left out of scope. Coverage equals scope.

More detail: [the method](method.md), [verification](verification.md), [limits](limits.md).
