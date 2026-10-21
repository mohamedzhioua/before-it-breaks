# Severity, effort and breaking sizes

For anyone reading a report: what the severity words, effort letters and size tiers mean. All of them come from the config, so an audit can change them; the defaults are below.

## Severity

From `severity_rubric` in [`config/defaults.json`](../config/defaults.json), most severe first:

| Level | Meaning |
|---|---|
| critical | Breaks for every user, or loses or corrupts data, at or below the target size |
| high | Breaks or becomes unusable for some users at or below the target size |
| medium | Degrades noticeably (slower, costlier, retries, partial results) at or below the target size without failing outright |
| low | Wasteful or fragile, with no failure expected inside the target size |

A failure that only appears beyond the target is not a low-severity finding: it is refuted for this audit and kept as a note ([beyond-target rule](verification.md#the-three-skeptic-lenses)). The severity of a finding is the median of the skeptics' recommendations, not the hunter's guess. The key order of the rubric is the report's order; rename or add levels in the config if your audit needs to.

## Effort

From `effort_scale`, smallest first:

| Size | Meaning |
|---|---|
| S | Under a day for one engineer; no migration |
| M | A few days; may need a small migration or a config change in several places |
| L | A week or more, a data migration, or a design change across services |

## Breaking sizes and tiers

Each finding states `breaks_at` (the size at which it fails) and `breaks_at_basis` (what that size counts, chosen from the list in `scale.bases`; see the [glossary](glossary.md)). Findings are then placed on a ladder built from `scale.tiers`. With tiers *a* < *b* < *c*:

| Tier | Means |
|---|---|
| T0 | Breaks already, at any size |
| T1 | Breaks at or below *a* |
| T2 | Above *a*, up to *b* |
| T3 | Above *b*, up to *c* |
| T4 | Above *c* (towards `scale.platform_target` when set) |
| grows | Gets slower or costlier as size grows, with no single breaking point |
| n/s | Not size-driven |

Without `scale.tiers`, the kit uses 10 000 and 100 000 (where they are below the target) and then the target. Labels carry no unit because one ladder holds findings sized in different units; each size counts what its basis names. Every size is **calculated** unless the verdict is PROVEN.

## Maturity of an area

Each report area (`areas`) gets a maturity word from its severity counts, by rule:

| Maturity | When |
|---|---|
| Weak | Any finding at the top level, or three or more at the second |
| Moderate | Any finding at the second level |
| Satisfactory | Any finding at the third level |
| Strong | Lower levels only |
| - | No findings |

The rule is mechanical so two readers get the same word; it says nothing about parts of the system outside the audit's scope.
