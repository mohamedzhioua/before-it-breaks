# {{config.audit.name}}: executive summary

<!--
Written by a person, not generated. Fill it once the report and the
verification log are built, and replace every line in italics.

Rules for this page:
- One to two pages, for managers. Plain words; finding ids, commits and model
  names go in brackets or in the report, not in the headlines.
- Every number is copied from the report, the verification log or the run
  log, never retyped from memory. If a number is not in a file, leave it out.
- Say "calculated" for every breaking size that no measurement backs.
  "Proven" only for a finding with a recorded measurement.
- Must not claim: that the system is secure, or that the code is clean (this
  audit did not look); that a size was measured when it was calculated; that
  a tool, agent or model was used unless the run log or a work file records
  it; that a finding "survived" review when the record says it was
  "challenged by" reviewers; any cost, date or effort in days that nobody
  estimated; completeness ("every problem"): the audit covers its hunt
  groups only.
- Proposed changes are proposals. The team decides.
-->

**Question:** {{config.audit.question}}

## 1. Can it reach {{target}} {{config.scale.unit_short}}?

_The answer in one sentence ("yes", "not as it is today", "yes, after these changes"), then two or three sentences on why. Say whether hardware or the code is the limit._

## 2. What breaks first, and at what size

_The few problems that fail at the smallest size, each in one plain line: what fails, from about which size of {{config.scale.unit}}, and what users or operators would see. Then one line per tier ({{tiers}}): how many findings fail by that size, copied from the report's tier table._

## 3. Already fixed

_Problems from earlier work or known issues that are fixed at the pinned commits, with the finding or claim id. Write "none found" if there are none._

## 4. Order of work

| When | Change | Why first | Effort |
|---|---|---|---|
| Now | _change_ | _the findings it closes, by id_ | _S, M or L as defined in the report_ |
| Next | | | |
| Later | | | |

_Effort uses the audit's S, M and L scale; do not turn it into days._

## 5. How this was produced

_Three or four sentences: the code was pinned at exact commits; agents mapped and hunted through the lenses {{lenses}}; every candidate's evidence was re-run by a script; each candidate was challenged by one skeptic per lens and checked by a verifier; a person approved every override, and overrides never added a finding. Copy agent counts, models and effort from `{{config.outputs.work_dir}}/run-log.json` only; where it records nothing, say "not recorded"._

## 6. Still unmeasured

_Which breaking sizes are calculated only, what access would measure them (for example a read-only database user on a replica, or pasted cache statistics), and what that would change. Point to `{{config.outputs.measurements}}`. Never production load._
