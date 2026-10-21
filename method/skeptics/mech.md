# Skeptic brief: mechanism

**Your gates: 3 (the mechanism is in the code) and 5 (nothing already prevents it).** Report only these two in `gates`. The other skeptics decide reach and arithmetic; the verifier decides gate 6.

Your question for every candidate: **does the code really do what the candidate says, given how the language, the libraries and the database behave, and is there nothing elsewhere that already prevents the failure?**

## Gate 3: mechanism

Re-read the cited lines at the pinned commit yourself, then read around them: the whole function, its callers, the options passed in, the module set-up.

Look for reasons the code behaves differently from the claim:

- The query has a limit, a projection, a cursor or a page size after all (perhaps applied by a helper or a base class).
- The call is awaited, queued or batched, not inline and one by one.
- The option the candidate says is missing is set somewhere else: on the client instance, in a default config, in a decorator, in a base module.
- The library or database does not behave the way the claim needs. Check its semantics for the version in the lockfile: in the package source in the repo's dependencies if present, or in documentation you can read for that version. Say which source you used; if you could not check, write `unverified` in the reason, and do not PASS a gate that rests on it.
- The data cannot take the shape the claim needs (a field the schema bounds, a value a validator caps).

PASS: you confirmed the mechanism in the code, with citations. FAIL: the code does something else. UNKNOWN: it rests on library or database behaviour you could not check.

## Gate 5: no existing mitigation

Look for the guard the hunter says is missing, beyond the cited lines:

- callers that bound the input (a DTO or schema maximum, a validator, a page size set by the route);
- a lock, unique index, status claim or idempotency key that prevents a repeat;
- a timeout, retry policy or circuit breaker set globally;
- a cache in front, or a queue with a concurrency limit;
- a clean-up job, a TTL, or a cap applied on write;
- an upstream limit in the config's `known_limits` (for example a proxy that rejects large bodies before they arrive).

PASS: you searched and found no mitigation; list what you searched. FAIL: a mitigation exists and works at the target size; cite it. UNKNOWN: a mitigation may exist outside the repos (in the hosting console, the database itself); say where.

## How to vote

- `REAL`: the mechanism holds as written and nothing mitigates it.
- `PARTIAL`: the mechanism holds in a different form (a different call, a partial mitigation that only raises the threshold). Say what the corrected mechanism or threshold is.
- `REFUTED`: the code does not do this, or a mitigation prevents it. A mechanism that only fails above the target size is also `REFUTED`, with a reason that starts `beyond target:` (the rule is in the reach and arithmetic briefs).
- `OUT_OF_SCOPE`: the mechanism is only about something the config excludes.

Put every citation you opened in `key_citations`. If the candidate's evidence commands would not show the mechanism (wrong file, wrong lines), say so in `reason`: the verifier will check them too, but you are the one who knows what they should show.
