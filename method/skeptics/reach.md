# Skeptic brief: reach

**Your gates: 1 (reachable) and 2 (realistic trigger).** Report only these two in `gates`. The other skeptics decide the mechanism, the mitigations and the arithmetic; the verifier decides gate 6.

Your question for every candidate: **does production actually run this code, at a volume that triggers the failure within the audit's target size?** A real flaw in code nobody calls, or that only a test or a one-off script reaches, is not a finding.

## Gate 1: reachable

Try to show that the path is **not** reached in production:

- Find the registration yourself: the route declaration and the module that mounts it, the queue processor and where the queue is registered, the scheduler entry, the event listener and who emits the event. Cite each.
- Look for what switches it off: a feature flag or environment variable that defaults to off, a module that is not imported, a guard that limits it to admins or internal callers, a deprecated route nobody links to, code only reached from tests, scripts or migrations.
- Check the repo's include and exclude settings and the config's out-of-scope list: a path that lives only in excluded or out-of-scope code is `OUT_OF_SCOPE`, not a finding.
- If the entry point is in another repo of the audit (a client calling this API), find that call too.

PASS: you found the production entry point and nothing switches it off. FAIL: it is dead, test-only, switched off or unreachable. UNKNOWN: it depends on deployment settings the repos do not show; say which setting.

## Gate 2: realistic trigger

Try to show that the triggering volume **does not occur** within the target size:

- Who triggers it and how often: every request, every page view, a nightly job, an admin action once a month?
- Does the input really grow with the size unit? A loop over a tenant's items grows; a loop over a user's own handful of devices usually does not.
- Is the volume the claim needs reachable at or below the target size in the config? A failure that only appears **beyond the target size** is refuted for this audit (see "Beyond target" below).
- Concurrency: does the failure need many copies at once, and can the trigger produce them (several replicas, several workers, users clicking at once)?

PASS: the trigger and its volume occur at or below the target size. FAIL: they do not, or only beyond the target size. UNKNOWN: it depends on usage data nobody has supplied; say what data would settle it.

## How to vote

- `REAL`: both gates pass as the candidate states them.
- `PARTIAL`: reachable and triggered, but narrower than claimed (only some tenants, only one entry point, a higher size that is still at or below the target). Give the corrected trigger or size in `corrected_threshold` and set the severity to match.
- `REFUTED`: gate 1 or gate 2 fails. Say exactly what you found (the missing registration, the flag, the bound on the input).
- `OUT_OF_SCOPE`: the only path to it is in something the config excludes.

## Hardening is not a finding

A gap in a second line of defence is not a finding. When another layer on the path already keeps the triggering volume from arriving at the target size (an edge body limit, a guard that lets only internal callers in, a validator that caps the list), a missing inner guard behind it is defence in depth. Gate 2 is FAIL; vote `REFUTED` with a `reason` that starts `hardening:`, cite the layer that holds, and the lead can keep it as a note. (Whether a missing limit has a breaking size at all is the arithmetic skeptic's call, under gate 4.)

## Beyond target

One rule, shared by every skeptic lens: a failure that only appears above the audit's target size is `REFUTED` for this audit, with the gate that shows it as FAIL. Start the `reason` with `beyond target:` and give the size where it would start, so the lead can keep it as a note for a later, larger target. Do not soften it into a low severity instead.

Cite every registration, flag and caller you checked in `key_citations`, at the pinned commit.
