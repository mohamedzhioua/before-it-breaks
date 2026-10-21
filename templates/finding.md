# Candidate and finding fields

A **candidate** is what a hunter reports in Phase 2: a suspected problem with citations and evidence commands. It becomes a **finding** only after Phase 3: its evidence re-run by script, one skeptic per lens trying to refute it, a verifier checking the receipt, and the synthesis rules giving it a verdict. Phase 5 then adds the plain-language report fields.

The authoritative shapes are in `tooling/lib/shapes.js` (`CANDIDATE`, `VERDICT`, `REPORT_INPUT`); `kit save` checks every result against them. This page explains the fields and shows one fully invented example from the "notes platform" used throughout the kit.

## Candidate (Phase 2, `work/candidates.json`)

| Field | Required | What goes in it |
|---|---|---|
| `id` | yes | Group key plus a two-digit number, e.g. `SVC-IMPORT-01` |
| `repo`, `group`, `lens` | yes | The repo name, hunt group key and lens from the config |
| `title` | yes | One line |
| `claim` | yes | What breaks, for whom, at what size, in plain words |
| `locations` | yes | One or more `{ repo, path, line }` at the pinned commit |
| `mechanism` | yes | The exact code mechanism: the query, loop or option, quoted |
| `arithmetic` | no | Where it breaks, with the sums shown; or `n/a: <why>` |
| `breaks_at`, `breaks_at_basis` | no | The breaking size in the config's unit (null when not size-driven) and what it counts (one of `scale.bases`) |
| `severity_guess` | no | A hint only; skeptics set the severity |
| `evidence` | yes | Read-only commands `{ cmd, expect }`, written with `{repo:<name>}` and `{pin:<name>}` instead of local paths and commits |
| `mitigations_searched` | no | Each guard looked for (a limit, a batch, a timeout) and what was found, with a citation |
| `library_facts` | no | `{ library, version, fact, source }`; source is `lockfile`, `package-source`, `docs` or `unverified` |
| `source` | yes | `new`, or `prior-claim:<ID>` for a claim from `work/claims.json` |
| `status` | no | `fixed` (held earlier, fixed at the pin) or `not_found` (the cited code is gone); both are refuted without a vote |
| `rule_pattern_hint` | no | The code shape a static rule should match, if the pattern repeats |
| `notes` | no | Anything else, including out-of-scope observations |

## Finding (Phase 3 and 5)

| Field | Set by | What it means |
|---|---|---|
| `verdict` | synthesis | PROVEN, PROVEN-STATIC, UNPROVEN, REFUTED, NEEDS-REVIEW, OUT-OF-SCOPE, or REMOVED / MERGED / HELD after an override |
| `severity` | synthesis | The median of the skeptics' levels from the config's `severity_rubric`; `none` unless the candidate survived |
| `gates` | skeptics and verifier | `g1_reachable`, `g2_trigger`, `g3_mechanism`, `g4_bounds`, `g5_no_mitigation`, `g6_reproduces`: PASS, FAIL or UNKNOWN |
| `votes`, `verifier`, `receipt` | Phase 3 | The skeptic votes, the verifier's check and the evidence receipt file |
| `override` | the lead, approved by a person | `{ action, reason, approved_by }`; only remove, merge, re-scope or hold |
| `plain` | Phase 5 | One line a non-engineer can follow |
| `threshold` | Phase 5 | The breaking size with the sums as the skeptics checked them |
| `fix_direction` | Phase 5 | The direction of the fix in one or two sentences, no code |
| `effort` | Phase 5 | S, M or L from the config's `effort_scale` |
| `area` | Phase 5 | One of the config's `areas` |

## Invented example

Nothing here describes a real system.

```json
{
  "id": "SVC-IMPORT-01",
  "repo": "notes-api",
  "group": "SVC-IMPORT",
  "lens": "performance",
  "title": "Note import fetches each owner's profile one at a time",
  "claim": "Importing a file of notes waits for one remote profile call per row, so a large import runs past the request timeout and is retried from the start.",
  "locations": [
    { "repo": "notes-api", "path": "src/modules/imports/import.service.ts", "line": 9 }
  ],
  "mechanism": "Inside `for (const row of rows)` the service awaits `this.users.fetchProfile(row.userId)` and then `NoteModel.create(...)`: two awaited round trips per row, strictly one after another.",
  "arithmetic": "At about 40 ms per profile call plus 5 ms per insert, 2,000 rows take about 90 s, past a 60 s edge timeout.",
  "breaks_at": "2,000 rows in one import file",
  "breaks_at_basis": "rows per file",
  "severity_guess": "high",
  "evidence": [
    {
      "cmd": "git -C {repo:notes-api} show {pin:notes-api}:src/modules/imports/import.service.ts",
      "expect": "an awaited fetchProfile call inside the for-of loop over rows"
    }
  ],
  "mitigations_searched": [
    "Batch profile endpoint: none in src/clients/users.client.ts",
    "Concurrency limit or chunking around the loop: none found"
  ],
  "library_facts": [],
  "source": "new",
  "rule_pattern_hint": "await of a remote client method inside a for-of loop",
  "notes": ""
}
```

After Phase 3 and 5, the same finding as the report would show it:

> **SVC-IMPORT-01 · High · PROVEN-STATIC** · Note import fetches each owner's profile one at a time
> **In plain words:** large note imports fail and start over.
> **Breaks at:** about 2,000 rows per file (calculated: two awaited calls per row at the latencies above; not measured).
> **Evidence:** `notes-api@<short>:src/modules/imports/import.service.ts:9`, receipt re-run and matched; skeptics: reach REAL, mechanism REAL, arithmetic PARTIAL (corrected the per-row cost).
> **Fix direction:** look up all owners in one batch call before the loop, and insert notes in chunks. **Effort:** S. **Area:** background jobs.
