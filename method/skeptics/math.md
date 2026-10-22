# Skeptic brief: arithmetic

**Your gate: 4 (bounds).** Report only gate 4 in `gates`. You also own every number the candidate relies on, including the library and platform limits behind them. The other skeptics decide reach and mechanism; the verifier decides gate 6.

Your question for every candidate: **is the size at which it breaks right?** Re-derive the sums yourself from the code, the config and documented limits. Do not check the hunter's arithmetic line by line; work it out independently, then compare.

## How to re-derive

1. Write down each input and where it comes from:
   - from the code (a page size, a concurrency setting, a timeout, a retry count), with a citation;
   - from the config: the scale (unit, target, tiers), the `known_limits`, the `library_assumptions`;
   - from documented limits of the database, runtime or library, with the source and version;
   - an assumption (a time per call, bytes per item, a request rate). Mark it as an assumption and keep it conservative.
2. Compute where the sum crosses the limit, in the audit's size unit. Show every step in `reason` or `corrected_threshold`.
3. Compare with the candidate's `breaks_at`. An order of magnitude apart matters; a few percent does not.

Common sums: items × bytes per item against a size limit; items × round trips × time per round trip against a timeout; run time against a schedule interval; queue length against drain rate; quadratic reads (N² ÷ 2P for skip pagination over N rows with page size P); pool size × processes × replicas against a connection limit.

## Try to break the numbers

- Is a unit wrong (MB against MiB, bytes against characters, milliseconds against seconds)?
- Is the size per item realistic? Count field names and values for document stores; do not assume a few bytes for a record with many fields, or kilobytes for one with two.
- Does the limit apply where the candidate says (a request body limit to an internal call that never crosses the edge; a document limit to a query result, which is not one document)?
- Does the library behave as the assumption says, for the version in the lockfile? Check the package source or documentation you can read, and name it. A `library_assumptions` entry is not proof; if the number rests on it and you could not check it, say so and the gate is UNKNOWN.
- Is the threshold reached within the target size or the tiers at all?

**Hardening, not a finding.** A missing limit (no page size, no timeout, no cap) is a finding only when it breaks something at a size that can be worked out. REFUTE it as hardening, with gate 4 as FAIL and a `reason` that starts `hardening:`, when after your own attempt no breaking size at all can be derived from the code, the config or documented limits. A size you can derive but that sits above the target is `beyond target:` (below), not hardening. A size that only a measurement could give is gate 4 UNKNOWN (the UNPROVEN path), never `hardening:`. If the hunter left the arithmetic out but you can re-derive it, vote PARTIAL with the corrected threshold instead. A mechanism chain that ends in "any size" (one retry is enough, one request can send the input) counts as computed.

PASS: your sum agrees with the candidate within the same order of magnitude, and the break is at or below the target size. FAIL: the sum is off by a factor of ten or more, or the break is never reached within the target size. UNKNOWN: a number the sum needs can only be measured; say which number and how to measure it.

## How to vote

- `REAL`: the sums hold.
- `PARTIAL`: the problem is real but breaks at a different size, still at or below the target size. Put your corrected sum and size in `corrected_threshold`, and set the severity from the rubric at that size. This is the usual outcome for a real finding with a wrong number.
- `REFUTED`: the break is never reached within the target size, or the arithmetic rests on a limit that does not apply.
- `OUT_OF_SCOPE`: only about something the config excludes.

## Beyond target

One rule, shared by every skeptic lens: a failure that only appears above the audit's target size is `REFUTED` for this audit, with gate 4 as FAIL. Start the `reason` with `beyond target:` and give your re-derived size, so the lead can keep it as a note for a later, larger target. Do not record it as `PARTIAL` with a low severity instead.

Never invent a number to make a sum work. "Not measured" with the command that would measure it is a valid answer.
