# Meeting brief: handing the audit to <lead's role> (<YYYY-MM-DD>)

<!-- A one-page brief for the person who runs the audit, before handing it to
     the team lead. Replace every <...>; copy numbers from the README and the
     run log, never from memory. Delete a line rather than leave a
     placeholder. -->

## 1. The audit in thirty seconds

- **Answer:** <one sentence>.
- **Counts:** <total> findings: <per severity>. <How many fail at or below the smallest tier>.
- **Trust:** <what was pinned, re-run and challenged; what was measured, if anything>.
- **Effort:** <what the run log records: phases run, agents per phase, models and effort; "not recorded" where it is silent>.

## 2. Deliverables

| Item | Location |
|---|---|
| The audit, with a reading guide by role | `README.md`, then the summary, report, verification log and recommendations |
| How each repo works today | `system-docs/` |
| Current and target design | the target architecture page |
| Kickoff slides | `<link or file>` |
| Findings explorer (optional) | `<link or file>` |
| Tracker import | `issues.csv` or `issues.md` |
| Message for the team | `<file>` (from `templates/team-message.md`) |
| Static rules for CI | `rules/` |

## 3. What to do with the workspace, step by step

1. **Agree where it will live.** The workspace ignores every file by default; decide with the lead which files go into a private repository, if any.
2. **Run `check secrets` and keep its record** before anything leaves the machine.
3. **Run the render test** (`templates/render-test.md`) in the docs host's preview.
4. **Set `publish.base_url`** once the location is known, and rebuild the tracker import and the explorer so their links work.
5. **Share** the slides and the explorer with the team, then send the team message.
6. **Kickoff meeting** with the slides; leave with owners for the "now" changes.
7. **After the meeting:** import the tracker file, label and assign it; propose the static rules for CI.
8. **Later, when access exists:** the measure phase (designed, not yet proven).

## 4. What the lead must decide

1. Owners for the "now" changes.
2. Yes, no or a date for each proposed design change.
3. Read-only access for measuring, or someone to paste the output of the agreed commands.
4. The static rules in CI.
5. Where the audit lives, and who may read it.

## 5. Likely questions

- **"How sure is this?"** <What the code evidence shows, and what is still calculated.>
- **"How long will the fixes take?"** Effort is S, M or L as the report defines them; the team turns them into days.
- **"Why is nothing measured?"** <The access that was missing; the checks that are ready.>
- **"Where do we see progress?"** In the tracker only; the reports are reference material.

## 6. Rules that keep it true

- Generated files are rebuilt from `work/`, never edited by hand.
- A verdict changes only through an override with a reason and an approver, then a rebuild.
- Finding ids go into every ticket and merge request.
