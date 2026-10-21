# <short title of the change, as a decision>

<!-- MADR-lite decision record (after the MADR format: context, options,
     decision, consequences). An audit only proposes: the status stays
     "proposed" until the team accepts, changes or rejects it, and the team
     edits this record when it does. Replace every <...>. -->

- **Status:** proposed
- **Date proposed:** <YYYY-MM-DD>
- **Decided by:** <the team or person who will decide; blank until then>
- **Findings it closes:** <finding ids from the audit report>

## Context

<What the code does today and why that fails at the sizes the audit checked. Cite findings, not opinions. Two to five sentences.>

## Options considered

1. **<option>**: <what it means>. Good: <...>. Bad: <...>.
2. **<option>**: <...>.
3. **Do nothing**: <what keeps breaking, and from about which size>.

## Decision (proposed)

<The option the audit recommends, in one or two sentences, and the main reason.>

## Consequences

- **Better:** <what stops failing; which findings close>
- **Worse or harder:** <new moving parts, migrations, operating cost>
- **Depends on:** <other records or changes that must come first>
- **Effort:** <S, M or L, as defined in the audit report>

## Example

<!-- Invented, to show the level of detail. Delete when you write a real record. -->

**Send notifications through a queue, one job per batch of recipients** · Status: proposed · Findings: SVC-JOBS-01, SVC-JOBS-04.
Context: a note shared with a whole workspace sends one notification per member inside the request, so a large workspace times out and a retry sends some twice. Options: keep sending in the request with a higher timeout; one queue job per recipient; one queue job per batch with an idempotency key. Decision (proposed): one job per batch of recipients, each job keyed so a retry cannot send twice. Consequences: requests return at once and retries are safe; a queue worker and a dead-letter view are new to operate; effort M.
