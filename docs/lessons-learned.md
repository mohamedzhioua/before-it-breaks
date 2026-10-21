# Lessons learned

For anyone running an audit or changing the kit. These are the things that went wrong or surprised us while the method was used for real; several kit features exist because of them.

1. **What an agent hands back is the only output.** Subagent transcripts are not kept. Save every result to a named file the moment it returns (the workflows return results and `kit save` writes them), or it is gone when the session ends.
2. **Do not read big results into the conversation.** Count and extract with a script; open a single entry only when you need it. Large JSON in context crowds out the work.
3. **Check other plugins' hooks.** A Stop hook from another plugin (for example one written for security reviews) can expect a record this audit never writes and block every turn. Run `/hooks` at the start of each audit session and disable that plugin for the workspace only (`claude plugin disable <plugin>@<marketplace> --scope local`).
4. **Challenging findings is its own job.** A workflow made for reviewing pull requests judges one change; a list of candidates needs a skeptic step built for it.
5. **Claim only what a record proves.** It is easy to say a tool was used because it was installed, that every evidence command ran when some were refused, that findings "survived" when they were "challenged", or to name the models of a phase nobody recorded. The run log, the receipt index and the plain verdict words exist so every such claim can be checked.
6. **Keep instructions consistent across files.** When two prompts or docs disagree, agents follow whichever they read last. The kit keeps one source per rule (the gate table in `audit-status`, the shapes in `tooling/lib/shapes.js`).
7. **Windows needs care.** Semgrep's parallel test mode can trip over its own settings file, so `run-tests.sh` runs one rule per process. In Git Bash, quote pathspecs with single quotes and set `MSYS_NO_PATHCONV=1` for git paths. Odd folder or file names that some tools or operating systems cannot check out can still be read with `git show <pin>:<path>`.
8. **A workflow run can only be resumed in the session that started it.** So every piece of state lives in a file, and a new session picks up from there.
9. **Keep the session's effort fixed.** Changing it mid-session clears the prompt cache. Set each agent's effort at dispatch instead.
10. **Do not tell strong agents to "double-check".** It wastes effort and does not add independence; checking belongs to separate agents with their own instructions.
11. **Overrides narrow, they never add.** Lead overrides remove, merge, re-scope or hold back findings, each with a written reason. In practice none needed to add one, so the kit forbids it.
12. **Run the secrets scan and keep its output.** A claim that "the secrets scan was clean" is worth nothing without the record; `kit check secrets` always writes one.
13. **Audiences differ.** Managers need plain headlines; engineers need ids, commits and model names. Put the second kind in notes and appendices, not on the slide face.
