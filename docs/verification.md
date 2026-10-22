# Verification: how a candidate becomes a finding

For anyone who wants to know why a finding can be trusted, or who reads a verification log. Every log built by the kit links here. The rules below are what `tooling/synthesize-verdicts.js` and the verify workflow actually do.

## In one paragraph

A hunter's candidate carries citations and read-only evidence commands. A script re-runs those commands at the pinned commits and keeps a receipt. Three skeptics, each with its own lens and its own context, try to refute the candidate by reading the code themselves. A verifier, on a different model by default, checks mechanically that the receipt supports the cited code facts. Fixed rules, not a model, turn the votes and the check into a verdict. The audit lead may then take findings away or narrow them, with a written reason and a named approver, but never add one.

## The six gates

Each candidate is judged on six questions. Each skeptic answers only the gates of its own lens; the verifier answers gate 6.

| Gate | Question | Answered by |
|---|---|---|
| 1 Reachable | Does production run this code? (A registered route, job, schedule or listener, not switched off, not test-only.) | `reach` |
| 2 Realistic trigger | Does the triggering volume occur at or below the target size? | `reach` |
| 3 Mechanism | Does the code really do what the candidate says, given how the language, libraries and database behave? | `mech` |
| 4 Bounds | Is the breaking size right, re-derived from scratch from the code, the config and documented limits? | `math` |
| 5 No mitigation | Is there nothing elsewhere (a validator, a lock, a global timeout, an upstream limit) that already prevents it? | `mech` |
| 6 Reproduces | Does the re-run evidence show the cited code facts? | verifier |

A gate is **FAIL** if any vote reporting it says FAIL, **PASS** if at least one says PASS and none FAIL, and **UNKNOWN** otherwise. UNKNOWN is an honest answer: a gate that rests on library behaviour nobody could check, or on a number only a measurement can give, stays UNKNOWN rather than being guessed.

## The three skeptic lenses

The briefs are in [`method/skeptics/`](../method/skeptics/). The lens names are configurable (`verify.skeptic_lenses`, at least three); the bundled ones are:

- **reach** ([brief](../method/skeptics/reach.md)): tries to show the code is dead, test-only, switched off, or never triggered at a volume within the target.
- **mech** ([brief](../method/skeptics/mech.md)): re-reads the cited lines and their surroundings to show the code behaves differently, or that a mitigation already exists.
- **math** ([brief](../method/skeptics/math.md)): re-derives every sum and limit and checks the units, sizes per item and where each limit applies.

Each skeptic votes **REAL** (holds as stated), **PARTIAL** (real, but with a corrected mechanism, trigger or size still at or below the target), **REFUTED** or **OUT_OF_SCOPE**, and recommends a severity from the rubric. Skeptics never see the hunter's own severity guess: `kit batches` removes it.

**Beyond-target rule.** A failure that only appears above the audit's target size is REFUTED for this audit, with the gate that shows it as FAIL, and a reason that starts `beyond target:` with the size where it would start. The lead can keep it as a note for a later, larger target. It is never softened into a low-severity finding.

## The verifier

The verifier does not judge whether a problem matters. For each candidate it:

1. compares each command's captured output in the receipt with the command's `expect` text and the cited code facts;
2. re-runs exactly one command, through the kit's own runner (`kit evidence <ws> --only <id> --cmd <n>`), and records MATCH or MISMATCH;
3. checks citation drift: does each cited `path:line` at the pin still show the code described?

It returns **CONFIRMED** (the output supports the facts), **REFUTED** (it contradicts them) or **UNVERIFIABLE** (the commands need live access, were skipped or withheld, or show nothing decisive). By default it runs on `sonnet` while the skeptics inherit the session model, so it is less likely to share their blind spots; see [models and effort](models-and-effort.md).

## Batches and the batch plan

`kit batches` cuts the candidates into batches for the skeptics and writes a **batch plan**: a short id (the first 12 hex characters of a hash of every batch's name, groups and candidate hashes) that names exactly which candidates, in which batches, the skeptics were given. The same candidates always give the same plan.

Each candidate also has a content hash, taken over the whole candidate object, including `severity_guess`. The verify workflow copies the plan and these hashes into its result (`bound_to`), and `kit save verify` keeps them in `votes-<N>.json`. This is how a vote is tied to the version of the candidate the skeptics actually read.

## Synthesis rules

`kit synthesize` applies these in order. *n* is the number of skeptic lenses, the majority is more than half of *n*, "survive" counts REAL plus PARTIAL votes, and *need* is `verify.survive_votes` (default 2).

| Condition | Verdict |
|---|---|
| The hunter marked it `fixed` (true before, fixed at the pin) | REFUTED ("fixed at pin"), no votes needed |
| The hunter marked it `not_found` (the cited code is gone) | REFUTED, no votes needed |
| A lens, or the verifier, has only votes cast on a different version of the candidate (compared by content hash, not by date) | NEEDS-REVIEW ("changed after batching") |
| A lens, or the verifier, has only votes that are not bound to any version (hand-written, or not saved with `kit save verify`) | NEEDS-REVIEW ("votes not saved with `kit save verify`") |
| A verifier check but no receipt for the candidate | NEEDS-REVIEW ("no receipt") |
| The receipt was made for a different version of the candidate (compared by content hash) | NEEDS-REVIEW ("changed after receipt") |
| The verifier checked a receipt other than the current one | NEEDS-REVIEW ("different receipt") |
| Fewer than *n* votes, or no verifier check | NEEDS-REVIEW (incomplete) |
| OUT_OF_SCOPE votes reach a majority | OUT-OF-SCOPE |
| REFUTED votes reach a majority | REFUTED |
| survive ≥ *need* and verifier CONFIRMED | PROVEN-STATIC |
| survive ≥ *need* and verifier UNVERIFIABLE | UNPROVEN |
| anything else | NEEDS-REVIEW (split) |

**Severity** is the median of the skeptics' recommended levels, ignoring "none" when at least two gave a real level; a candidate that did not survive gets "none". Severity levels and their order come from `severity_rubric` ([severity and sizes](severity-and-sizes.md)).

The output depends only on the input files, so running it twice gives the same `verdicts.json`.

**Votes count only when they are bound to the candidate's current content.** A vote or check whose recorded hash is not the candidate's hash today is set aside, and `kit synthesize` names the file and the ids. Because the hash covers the whole candidate, even an edit to `severity_guess` alone gives NEEDS-REVIEW; this is strict by design.

**When two files disagree.** If two votes files hold a counted vote from the same lens on the same candidate (or two verifier checks), they conflict only on substance: the vote, the severity, each gate's result, the corrected threshold, `duplicate_of`, and the verifier's verdict. A difference there stops `kit synthesize` with exit 1 and names both files; keep the file of the run you trust and remove or re-save the other. A difference in free text only (reasons, notes, rerun text, key citations) never conflicts: the later file (votes files are read in run-number order, so `votes-2` before `votes-10`) wins, and a note says so.

### When a verdict goes stale

`kit synthesize` records the hashes of the candidates, `master-overrides.json`, `pins.json` and the receipts index in `verdicts.json`. `kit build log` and every other builder refuse to run (exit 1) when any of them has changed since, and say what to re-run. After any change to the candidates, the overrides, the pins or the receipts, run `kit synthesize` and then `kit build log` again; a changed candidate or pin also needs `kit evidence` again, and a changed candidate needs batches and verify again before its votes count. Run `kit evidence` once, before verify, and re-run it only on purpose.

## Verdicts

| Verdict | Meaning | In the report? |
|---|---|---|
| PROVEN | Measured on a running system | yes |
| PROVEN-STATIC | Code re-read at the pin, evidence re-run and confirmed, skeptics failed to refute it. Not measured | yes |
| UNPROVEN | The skeptics accept the mechanism, but the evidence could not be re-run here (for example, it needs a live system) | yes |
| REFUTED | The skeptics or the evidence showed it does not hold (including "fixed at pin" and beyond target) | no |
| OUT-OF-SCOPE | Real or not, outside this audit's question | no |
| NEEDS-REVIEW | The rules could not settle it; a person must decide | no, listed as open |
| HELD | Held back by the audit owner, with a recorded reason | no |
| MERGED | The same problem as another finding; counted there | no |
| REMOVED | Withdrawn by the audit owner, with a recorded reason | no |
| NOT-CHECKED | For a claim from an earlier audit only: no candidate tested it, so the audit says nothing about it. Shown as "NOT-CHECKED (hunter: unresolved)" when a hunter looked but could not settle it; the entry then names the command that would | — |

When there is something to list, a "Notes for the audit team" section closes the page: in the verification log, hunter notes about suspected attempts to steer an agent and entries naming unknown claim ids; in the report, size conflicts between the report inputs and the verified candidates.

The synthesis step never produces PROVEN; in this version no kit step does. It is reserved for findings backed by a measurement (see [measuring](measuring.md)). A claim from earlier work takes the best verdict of the candidates that checked it; a claim nobody checked is NOT-CHECKED, never UNPROVEN.

## Overrides

After synthesis, the lead writes `work/phase3/master-overrides.json` as `{ "overrides": [ ... ] }`, one entry per candidate at most:

| Action | Effect | Extra fields |
|---|---|---|
| `remove` | Verdict REMOVED, kept in the file for the record | — |
| `merge` | Verdict MERGED | `into`: another candidate id, not itself removed or merged |
| `re-scope` | Keeps the verdict; only for a finding that survived | `title` and/or `severity`; severity may only stay or go down |
| `hold` | Verdict HELD, held back from the report | — |

Every override needs an existing candidate id and a non-empty `reason`; `approved_by` names who approved it and is copied into the verdicts and the log; synthesis refuses an override without it. There is **no add action**: anything else, or any broken rule, stops synthesis with exit code 2 and nothing is written. A problem the lead noticed personally goes back through hunt and verify like any other. Run `kit synthesize` again after every change to the file, and then `kit build log` (the builders exit 1 until you do).

## How the gates map onto fp-check

The gates adapt the false-positive check method of Trail of Bits' fp-check, written for security bugs, to claims about scale and reliability. The verdicts file and the log give each candidate's result in both vocabularies:

| fp-check step | Computed from |
|---|---|
| 1 Process | all *n* votes and a verifier check are present |
| 2 Reachability | gates 1 and 2 both PASS (FAIL if either fails) |
| 3 Real impact (read as scale and reliability) | the candidate survived with a severity above "none" |
| 4 PoC validation | gates 3 and 6 both PASS (FAIL if either fails) |
| 5 Math bounds | gate 4 |
| 6 Environment | gate 5 |

The main shift: a security proof of concept becomes "the mechanism is in the code and the evidence reproduces", and "math bounds" becomes the breaking-size arithmetic, judged against the audit's target size.
