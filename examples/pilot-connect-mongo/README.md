# Pilot excerpt: connect-mongo

Real output from the kit's first end-to-end run with real agents. The pages here are cut from what the kit generated. Only the page titles (marked "excerpt") and the one-line pointer under them were added; the finding text is not edited.

| | |
|---|---|
| Target | [connect-mongo](https://github.com/jdesboeufs/connect-mongo) at `182cfb09ad` (v6.0.0 plus 2 commits), the MongoDB session store for Express |
| Question | Can one store hold 1,000,000 active sessions, and what gives way first? |
| Settings | preset `scalability`, size `lite`, code only (no database access), Semgrep rules off |
| Run | Claude Code with the plugin loaded by `--plugin-dir`, phases run through the Workflow tool: map, hunt, evidence, verify, synthesize, report inputs. Recommend and measure were skipped. 10 agent dispatches in one session. |
| Result | 7 candidates; 5 findings PROVEN-STATIC (1 high, 1 medium, 3 low), 1 refuted, 1 merged as a duplicate |

## What is here

- [02-audit-report-excerpt.md](02-audit-report-excerpt.md): the High finding, SVC-REL-01, as the report shows it.
- [03-verification-log-excerpt.md](03-verification-log-excerpt.md): how the same finding was checked: the claim as hunted, the three skeptics' votes, the gates and the verifier.
- [work/phase3/receipts/SVC-REL-01.md](work/phase3/receipts/SVC-REL-01.md): the evidence receipt, the commands the kit re-ran at the pinned commit and their output.

This finding shows the method at work: the hunter rated it medium, the skeptics narrowed the trigger and raised it to high, and the verifier re-ran the evidence.

## How far to trust this

- PROVEN-STATIC means worked out from the code at the pinned commit and checked by the skeptics and a verifier. Nothing was measured.
- The driver and Node behaviour the finding relies on is marked unverified in the record, because the library sources were not on disk.
- This is one finding from one lite run on a small library. It is not a review of connect-mongo, and the maintainers have not been asked about it.

## Third-party text

The excerpt quotes short lines of connect-mongo source code in the evidence and receipt. connect-mongo is MIT-licensed, copyright (c) 2017 Jérôme Desboeufs; see [LICENSE-connect-mongo](LICENSE-connect-mongo) (copied from the project).
