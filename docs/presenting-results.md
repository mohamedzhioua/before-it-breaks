# Presenting the results

For whoever writes up and shares a finished audit. It covers the order people should read things in, which visuals the builders produce, the rules that keep diagrams rendering on GitHub and GitLab, and how to hand the work to a team.

## Layers: each reader stops where they have enough

1. **Workspace `README.md`**: the question, the short answer, status and a reading guide by role.
2. **`01-executive-summary.md`**: written by a person from the template: the answer to the question, the first failure and the size it appears at, what was recently fixed, the order of work, how the audit was produced, and what is still unmeasured.
3. **`02-audit-report.md`**: every surviving finding, with tables by severity, by tier, by area and an index.
4. **`03-verification-log.md`**: how each candidate was checked, for anyone who doubts one.
5. **`05-recommendations.md`** and **`system-docs/`**: for the engineers who will make the changes.

Everything except the summary is rebuilt from the data files, so it cannot drift from the verdicts. Copy every number in the summary, slides and messages from these pages; never retype it.

## Visuals

| Visual | Where | Shows |
|---|---|---|
| Tier ladder | report | How many findings break at each size tier, by severity |
| Area table with maturity | report | Where the problems are, with a mechanical maturity word |
| Module × severity heatmap | recommendations | Which modules carry the findings, and the earliest size at which each one breaks (a plain table, so it renders everywhere) |
| Now / next / later roadmap | recommendations | The order of work, from the cross-cutting plan |
| Change dependency graph | recommendations | Which changes must come before which (a Mermaid flowchart) |
| Current vs target architecture | target-architecture page | Diagrams drawn by hand or by an agent in `work/phase6/diagrams/`, with a table of what changes and why |

Left out on purpose: quadrant charts of effort against tier (discrete values stack on a few spots and become unreadable) and risk matrices with a guessed likelihood axis. A small count table says the same as a bar chart and renders on every host.

## Mermaid rules (GitHub and GitLab)

Each host renders with its own bundled Mermaid version, and an editor preview may differ. The host's own preview is the authority: run the render test in `templates/render-test.md` once per host before the team reads the docs there. Until it passes, keep to this subset:

- **Diagram types:** `flowchart` (TD or LR) and `sequenceDiagram` only. No C4 or architecture diagram types, no `xychart`, `quadrantChart` or other beta types.
- **No frontmatter and no `%%{init}` directives.**
- **Node ids** are plain letters and digits; never a reserved word such as `end` or `graph` in lower case.
- **Quote every label**, including edge labels and subgraph titles. Write brackets, braces, parentheses, `#` and quotes inside a label as entity codes (`#quot;`, `#40;`). Keep labels short.
- **Keep diagrams small:** a couple of dozen nodes and a handful of subgraphs at most; split rather than grow.
- **Dotted edges** (`-.->`) for optional or unconfirmed paths.
- **Change marking:** three `classDef` classes, `changed`, `new` and `removed` (dashed), with light fills and dark text so both light and dark themes stay readable; explain them in a line of Markdown above the block, not in a node.
- **Outside diagrams:** relative links only; anchors must match the host's heading slugs (`kit check links <ws> --host github|gitlab` checks them); emoji in tables are fine; alert boxes and `<details>` sparingly; no inline styles or host-only include syntax.

`kit check mermaid <ws> --modules <dir>` parses every block with a Mermaid version you install in a folder outside the kit and the repos; it catches syntax errors, not layout problems. Its default Mermaid version is an assumption: set `--mermaid-version` to the version your host renders.

## Sharing with the team

- **One source of truth.** The workspace pages are the record. Slides, the explorer and issues all point back to finding ids in the report.
- **Kickoff slides:** outline in `templates/kickoff-deck-outline.md`. Plain headlines for the room; ids, commits and model names in the speaker notes and the appendix. Severity always as a word, never as colour alone. Every breaking size says "calculated" unless it was measured.
- **Findings explorer:** `kit build explorer <ws>` writes `work/explorer-data.json` (findings, totals, tiers, areas, heatmap, roadmap) after checking that all the counts agree. Feed it to a dashboard, a spreadsheet or a small local page; hosting it anywhere is publishing, so ask first.
- **Issues:** `kit build issues <ws>` writes one issue per roadmap change, listing the findings it closes: `issues.csv` for a GitLab import, or `issues.md`, a checklist for any tracker. From then on, **status lives in the tracker**, not in the audit pages.
- **Messages:** `templates/team-message.md` (a short announcement that links rather than explains) and `templates/meeting-brief.md` (a one-page brief for the hand-over meeting).
- **Decisions:** proposed changes use `templates/decision-record.md` (after MADR); the status stays "proposed" until the team decides.

Mind private data: the workspace `.gitignore` ignores everything, and `kit check secrets` must be clean, with its record kept, before anything leaves the workspace.
