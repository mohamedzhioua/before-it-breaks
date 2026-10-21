# Launcher prompts: {{config.audit.name}}

Short prompts that start or resume a session of this audit. The full rules are in `MASTER-PROMPT.md`; the live state is in `HANDOFF.md`. Rendered from the kit's `prompts/launcher.md`; after editing `audit.config.json`, run `{{kit_cmd}} init "{{workspace}}" --refresh-prompts`.

## 1. Open the session (terminal)

```
cd "{{workspace}}"
{{launch_line}}
```

Then, in the new session, run `/hooks`. If another plugin adds a Stop or SubagentStop hook that waits for something this audit never writes, turn that plugin off for this folder only (`claude plugin disable <plugin>@<marketplace> --scope local`) and check `/hooks` again. Do not work around a blocking hook from inside the session.

Live access (optional): set any read-only connection string as an environment variable **before** this launch, never in a file.

## 2a. First session (workspace created, audit not started): paste this

```text
You are the lead of the audit "{{config.audit.name}}" in this folder.

1. Run /hooks and confirm no other plugin's Stop or SubagentStop hook will block this audit. If one does, stop and tell me.
2. Read MASTER-PROMPT.md completely; section B is your instruction set. Then read HANDOFF.md.
3. Run `{{kit_cmd}} doctor .` If the repos are not pinned yet, do Phase 0 as the start-audit skill describes from its step 6: pin, run doctor again, and write the first HANDOFF entry.
4. Send me a short status: the pins, which access exists, and anything blocked. Then continue with Phase 1 (map) unless something needs me.

Non-negotiable: read-only on every repo and data store, write only inside this folder, cite repo@<short>:path:line for every finding, no secret values in files, and ask me before anything on the "ask me before" list in MASTER-PROMPT.md.
I authorize workflows of up to {{config.concurrency.max_agents_per_workflow}} agents each, with at most {{config.concurrency.max_concurrent}} running at once.
```

## 2b. Resume (a later session of the same audit): paste this

```text
You are the lead of the audit "{{config.audit.name}}", resuming it in this folder.

1. Run /hooks and confirm no blocking Stop or SubagentStop hook from another plugin. If you find one, halt and report it to me.
2. Read all of HANDOFF.md: it settles state, decisions and scope. Look through the rules in part B of MASTER-PROMPT.md. Do not redo finished steps.
3. Run the audit-status skill (or `{{kit_cmd}} doctor .`) and report: what is done, which gate is open, and whether every repo still sits on its pinned commit with no local changes. A moved repo blocks everything until I decide.
4. Re-check anything HANDOFF.md marks as unverified, then continue with the step it names as next.

Same non-negotiables as MASTER-PROMPT.md section B, rule 10 included. Workflows: up to {{config.concurrency.max_agents_per_workflow}} agents each, at most {{config.concurrency.max_concurrent}} at once.
```

## 2c. Next session with a different job (measure, presentation, follow-ups): paste this

Before stopping, the previous session writes the job for the next one under **Next step** in `HANDOFF.md` (or in a separate brief it names there), with its inputs, the deliverable and what needs the user.

```text
You are the new lead session of the audit "{{config.audit.name}}" in this folder.

Read HANDOFF.md and do the job its "Next step" line names, and nothing else. Run /hooks first and stop if another plugin's hook would block you.
Rules: read-only on every repo and data store, write only inside this folder, no secret values in files, and ask me before any advisor call, any install or download, anything that touches a shared environment, any action outside this folder, and publishing or sharing anything.
Start with a short plan of the job and wait for my go if it touches anything on that list.
```

## 3. Asking for a high-effort decision

When a choice is hard to reverse or the options are close (how to present results, a disputed verdict policy, a scope cut), use `{{kit_root}}/prompts/advisor.md`. Ask the user first and say why.
