---
name: start-audit
description: Start a new Before It Breaks audit. Interviews the user in plain language (what they want to know, the size that matters, stack, code size, access, budget, team, earlier audit, tracker), creates the audit workspace, checks the set-up, pins every repo (Phase 0) and writes the first HANDOFF entry.
when_to_use: The user wants to audit whether their software will hold up as it grows (scalability, reliability under load, static performance) and has no audit workspace yet.
argument-hint: "[workspace folder] [repo folder ...]"
---

# Start an audit

You set up one audit of whether a system will hold up as it grows. You do not look for problems yet. At the end the user has a workspace folder, a checked configuration, every repo pinned at an exact commit, and a launch line for the session that will run the audit.

Speak plainly: the user may be a manager or founder, not an engineer. Explain any term the first time you use it.

## 1. Interview (one message, all questions at once)

Ask these in **one batch**, numbered, each with its options, so the user can answer in one reply. Give a sensible default for each and say they can answer "default".

1. **Which question should the audit answer?**
   - "Will it hold when we grow a lot?" → preset `scalability`
   - "Why does it fail, run twice or lose work?" → preset `reliability`
   - "Why is it slow today?" → preset `performance` (measuring later is strongly advised)
2. **Which quantity grows, and how large must it get?** For example "notes in one workspace, target one million", or "rows in one import file". Ask for the unit, the target, and (optional) a platform-wide target.
3. **What is it built with?** Language, framework, database, cache or queue.
4. **How big is the code, and how many repositories?** A rough line count or "small / medium / large" is enough. Ask for the folder of each repository.
5. **Beyond the code, what can the audit look at?** Nothing else (code only, the default), a read-only database user on a replica, pasted cache or queue stats, a staging environment with an agreed load window. **Never production load.**
6. **What is the budget?** In time and in AI usage. Say plainly: if the budget is tight we cut **scope** (fewer repos or module groups), never **checks** (every candidate still gets three skeptics and one verifier).
7. **Who takes part?** Someone to run the audit, at ease in a terminal and in Claude Code; someone who knows the system, answers questions and approves every override; and the people who will read the results.
8. **Is there an earlier audit whose claims should be re-checked?** If yes, where is it?
9. **Where do you track work?** GitLab, GitHub, another tracker, or none.
10. **Where should the workspace folder go?** It must be outside this kit and outside the repos being audited (default: a folder named after the audit in the user's home `audits` folder).

## 2. Refuse what this kit does not do

If the answer to question 1 (or anything else the user asks for) is a **security** audit, a **code quality or maintainability** review, a compliance or licence audit, say clearly that this kit does not do that and that its results must not be presented as one. Suggest a dedicated tool or a specialist audit for it. Continue only with the parts that are in scope, and add the excluded topic to `out_of_scope` in the config.

## 3. Turn the answers into settings

- Preset: from question 1.
- Size: read `${CLAUDE_PLUGIN_ROOT}/config/sizes.json` and pick the size whose description fits the answer to question 4. If the code is larger than the largest size, recommend one workspace per service and ask which service to start with.
- Stack: if it is not Node.js/TypeScript, say that the method still works but the bundled static rules will not, so rules are switched off unless the user wants a rule-writing pass.
- Access: with code only, no verdict can go above PROVEN-STATIC (limits worked out from the code, never measured). Say so.
- Summarise the settings in a short table and ask the user to confirm **once** before creating anything.

## 4. Create the workspace

Run, with the user's answers: one `--repo` per repository folder, the audit question from question 1 (in the user's words), the unit and target from question 2, and a short audit name. Pass **every** flag: a value left out is filled with a neutral default that ends up in the prompts, and `validate` and `doctor` warn until it is replaced.

```
node "${CLAUDE_PLUGIN_ROOT}/kit.js" init <workspace> --preset <preset> --size <size> --repo <folder> [--repo <folder> ...] --name "<audit name>" --question "<audit question>" --unit "<unit, e.g. notes in one workspace>" --target <whole number>
```

Add `--no-rules` when the stack is not covered by the bundled rules (section 3). `init` refuses a folder that already holds an audit; it never changes an existing audit.

Then open `<workspace>/audit.config.json` and fill in what `init` could not know: optional `scale.platform_target` and `scale.tiers`, `out_of_scope`, `publish.tracker`, and each repo's `role` (init sets every repo to `backend`). Check it:

```
node "${CLAUDE_PLUGIN_ROOT}/kit.js" validate <workspace>
```

`scale.unit_short` (the short unit used in headings) defaults to the first word of the unit; set it if that reads badly. Fix every error it lists, and act on every WARNING (a value still holding init's default). After any edit of the config, render the prompts again so they carry the new values:

```
node "${CLAUDE_PLUGIN_ROOT}/kit.js" init <workspace> --refresh-prompts
```

This rewrites only `MASTER-PROMPT.md` and `LAUNCHER-PROMPT.md`.

**If `init` reports "not available in this version":** create the workspace folder yourself, copy `${CLAUDE_PLUGIN_ROOT}/examples/demo-config/audit.config.json` into it as `audit.config.json`, replace the invented demo values with the user's answers (repos, scale, question, date, groups) and run `validate` as above. Tell the user that the other files `init` would create (the folder layout, `.gitignore`, `.claude/settings.json` deny rules, `HANDOFF.md`) are missing and must be added by hand, or by `init` once their kit version has it.

If the earlier-audit answer was yes, list each earlier claim in `<workspace>/work/claims.json` (id, wording, source) so every one gets a verdict later.

## 5. Check the set-up

```
node "${CLAUDE_PLUGIN_ROOT}/kit.js" doctor <workspace>
```

Every required line should say `ok`. Before Phase 0 the pin check fails because nothing is pinned yet; that is expected. Fix anything else it reports (missing tool, repo folder not found, invalid config). Do not install anything without asking the user.

## 6. Phase 0: pin

```
node "${CLAUDE_PLUGIN_ROOT}/kit.js" pin <workspace>
```

It records the exact commit of every repo. It refuses a repo with uncommitted changes: ask the user to commit or stash in that repo themselves, or, only if they agree, re-run with `--allow-dirty` (which is recorded). Never change the repos yourself. Then run `doctor` again: now every required line must be `ok`.

## 7. First HANDOFF entry

Write (or append to) `<workspace>/HANDOFF.md` a dated entry with: the audit question and settings, the repos with their short pins, which access is available, what is out of scope, open questions, and **next step: Phase 1 (map), with `/before-it-breaks:run-phase map`**. The HANDOFF file is the memory between sessions; chat history is not.

## 8. Tell the user how to continue

`doctor` prints a launch line of the form `claude --add-dir "<repo>" --add-dir "<repo>" ...`. Give the user **that exact line**, copied from the output, and tell them to:

1. open a terminal in the workspace folder and run the line, so the audit session can read every repo;
2. run `/hooks` in the new session and check that no other plugin adds a Stop hook that demands a security-style record; if one does, disable that plugin for this workspace only;
3. start Phase 1 with `/before-it-breaks:run-phase map`, or check progress any time with `/before-it-breaks:audit-status`.

End with a short status: workspace path, preset, size, repos pinned, access, and the next command.
