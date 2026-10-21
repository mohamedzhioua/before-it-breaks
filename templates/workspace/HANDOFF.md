# HANDOFF: {{config.audit.name}}

This file is the memory between sessions. A new session reads it first and trusts it over anything said in chat; when it and the work files disagree, the files win. Rewrite the **State** and **Next step** lines before every stop, and add a dated entry under **Log**.

**State:** workspace created on {{date}}. Nothing pinned, nothing run.
**Next step:** check `audit.config.json` (repo roles, hunt groups, scale), then `{{kit_cmd}} doctor "{{workspace}}"` and Phase 0: `{{kit_cmd}} pin "{{workspace}}"`.

## 1. Settings at a glance

- Question: {{config.audit.question}}
- Preset `{{config.preset}}`, size `{{size_name}}` ({{size_guidance}}); lenses: {{lenses}}; static rules {{rules_state}}.
- Scale: {{config.scale.unit}}, target {{target}}, graded at {{tiers}}.
- Out of scope: {{out_of_scope}}.

{{repos_table}}

## 2. Pins

_After Phase 0, copy the short commit of each repo from `{{config.outputs.work_dir}}/phase0-baseline.md`. Findings cite code as `repo@<short>:path:line` at these commits._

## 3. Gate confirmations

Each gate that needs a person (see the gate table of the `audit-status` skill) is met only when a line here says who confirmed it and when.

| Date | Gate | Confirmed by | Note |
|---|---|---|---|

## 4. Decisions and scope (settled; do not reopen without the user)

- _One line per decision: what, who decided, when._

## 5. Failed or skipped legs

_One line per leg stopped by the stop rule (three failed attempts), with the reason and where its output was kept._

## 6. Open questions for the user

- _None yet._

## 7. Log

- **{{date}}**: workspace created by `kit init` (preset `{{config.preset}}`, size `{{size_name}}`, repos {{repo_names}}).
