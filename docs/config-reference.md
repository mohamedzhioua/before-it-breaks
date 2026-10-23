# Config reference

For the person writing or checking an `audit.config.json`. Every field of [`config/audit.config.schema.json`](../config/audit.config.schema.json) is listed below, in schema order.

## How the config is built

- One `audit.config.json` per workspace. `kit init` writes a first version; you edit it by hand. Generated state (pins, run log, results) lives in `work/`, never in the config.
- The kit merges, in this order: [`config/defaults.json`](../config/defaults.json), then the preset named in `preset` ([`config/presets/`](../config/presets/)), then your file. Later wins. Objects merge key by key; arrays replace, except `evidence.secret_patterns` and `read_only.deny_bash`, where your entries are **added** to the defaults (the defaults cannot be removed).
- **Required** means required after that merge, so a field the defaults or preset fill (for example every `models` role) need not appear in your file. Inside an object or list item, it means required in that object.
- **Default** is the value from `config/defaults.json`; "set by preset" means only the presets fill it; "(presets override)" means a preset may change it.
- **Example** comes from the invented [demo config](../examples/demo-config/audit.config.json) where it sets the field; long values are cut short.
- Command-line flags are not config fields. `kit pin --allow-dirty` and `--trust-git-dir` (a repo's `.git` folder is trusted input; see [security](security.md#threats)) are recorded in `work/pins.json`; `kit init --force` adds missing files to a non-empty folder without overwriting; `kit save --force` only replaces another run's file, or report-inputs run 1 (a same-run hunt re-save is noted). See [Run an audit](run-an-audit.md) and [security](security.md).
- Check a config with `kit validate <ws>` (add `--example` for an example plan, where a repo may be given by `url` and `ref` and its `pin` may be `"TODO"`). Errors are listed in plain words.

A minimal config, with everything else from the defaults and the preset:

```json
{
  "$schema": "<kit>/config/audit.config.schema.json",
  "preset": "scalability",
  "size": "lite",
  "audit": { "name": "Notes platform growth audit", "question": "Can a single workspace hold half a million notes, and what gives way first?", "type": "scalability", "date": "2027-03-08" },
  "repos": [ { "name": "notes-api", "path": "../repos/notes-api", "role": "backend" } ],
  "scale": { "target": 500000, "unit": "notes per workspace" },
  "groups": [ { "key": "SVC-IMPORT", "repo": "notes-api", "lens": "performance", "scope": "src/modules/imports/" } ]
}
```

## Fields

### `$schema`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `$schema` | string |  |  | `"../../config/audit.config.schema.json"` | Relative path or URL of this schema, so editors can autocomplete and flag typos. |

### `preset`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `preset` | `scalability`, `reliability`, `performance` |  |  | `"scalability"` | Starting point chosen from the decision guide. Its values sit between the kit defaults and your own fields: anything you write here still wins. |

### `size`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `size` | `lite`, `standard`, `full` |  |  | `"lite"` | Rough audit size from the decision guide (see config/sizes.json). It is guidance for planning repos, hunt groups and verify runs; it does not change any other field. |

### `audit`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `audit` | object | yes |  |  | What this audit is about, in plain words. These sentences are copied into agent prompts and report headers. |
| `audit.name` | string | yes |  | `"Notes platform growth audit"` | Short title used in report headings, e.g. "Notes platform growth audit". |
| `audit.question` | string | yes |  | `"Can a single workspace hold half a million notes, and what gives  ...` | The one question the audit must answer, e.g. "Can a single workspace hold half a million notes, and what gives way first?". |
| `audit.type` | `scalability`, `reliability`, `performance` | yes | set by preset | `"scalability"` | Kind of audit; normally the same as the preset. |
| `audit.date` | string | yes |  | `"2027-03-08"` | Audit date as YYYY-MM-DD. Workflows cannot read the clock, so the date travels in through their arguments. |
| `audit.placeholders` | array of enum |  |  |  | Written by `kit init`: the fields it filled with a neutral default because no answer was given. `validate` and `doctor` warn while one of them still holds init's default; remove an entry once you have set the real value. |

### `kit`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `kit` | object |  |  |  | Where the kit itself lives. Written by `kit init` inside a workspace; leave it out elsewhere and the kit uses its own folder. |
| `kit.root` | string |  |  |  | Absolute path of the kit checkout or plugin folder, as a record only: the tools always use the kit that is running, `doctor` warns when the two differ, and `init <ws> --refresh-prompts` re-renders the prompts and updates `kit.root`. |

### `repos`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `repos` | array of object | yes |  | `[{"name":"notes-api","path":"../repos/notes-api","role":"backend", ...` | Every repository the audit reads. Code is only ever read; nothing in these folders is changed. |
| `repos[].name` | string | yes |  | `"notes-api"` | Short kebab-case name used everywhere else, e.g. "notes-api". |
| `repos[].path` | string |  |  | `"../repos/notes-api"` | Folder of the checkout, absolute or relative to the workspace. |
| `repos[].url` | string |  |  |  | Clone address (example plans). |
| `repos[].ref` | string |  |  |  | Tag or branch to clone (example plans). |
| `repos[].pin` | string |  |  |  | Commit the example plan was written against, or "TODO" until it is chosen. |
| `repos[].role` | `backend`, `frontend`, `infra`, `other` | yes |  | `"backend"` | What the repo is, which picks the mapper checklist. |
| `repos[].include` | array of string |  |  | `["src/"]` | Folders or files to read, relative to the repo. Empty means the whole repo. |
| `repos[].exclude` | array of string |  |  | `["src/**/*.spec.ts"]` | Folders or files to skip, relative to the repo. |
| `repos[].context_only` | boolean |  |  | `false` | Read for context (e.g. deployment manifests) but never hunted in; no group may point at it. |
| `repos[].known_gaps` | array of string |  |  | `["The search indexer runs as a separate service that is not in sco ...` | Things you know the audit cannot see in this repo, stated in the report's limits. |

### `scale`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `scale` | object | yes |  |  | The size that matters and the size you are aiming for. Thresholds are reported against these tiers. |
| `scale.unit` | string | yes |  | `"notes in one workspace"` | The growing quantity, said in full, e.g. "notes in one workspace". |
| `scale.unit_short` | string |  |  | `"notes"` | One-word form used in tables, e.g. "notes". Defaults to the first word of `unit`. |
| `scale.target` | integer | yes |  | `500000` | The size you want one tenant (or the unit's owner) to reach. |
| `scale.platform_target` | integer |  |  | `20000000` | Optional size for the whole platform (all tenants together). Must be at least `target`. |
| `scale.tiers` | array of integer |  |  | `[5000,50000,500000]` | Strictly ascending sizes at which findings are graded. Every tier must be at most `target`. Left out: 10000 and 100000 (those below the target) followed by the target itself. |
| `scale.bases` | array of string |  | `[6 entries]` (see the file) |  | Allowed answers to "what does this finding grow with?". The defaults cover per-tenant data, platform data, fan-out, file rows, and items that do not depend on size. |

### `known_limits`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `known_limits` | array of string |  | `[]` | `["Edge proxy rejects request bodies over 2 MiB","Edge proxy closes ...` | Hard limits of the platform that agents may rely on without proving them again, e.g. "Edge proxy rejects request bodies over 2 MiB". |

### `library_assumptions`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `library_assumptions` | array of string |  | `[]` | `["Job queue: a failed job keeps its id until it is removed, so re- ...` | Library behaviours the hunters and skeptics should check, each one line, e.g. "queue library: a failed job id cannot be reused until removed". |

### `out_of_scope`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `out_of_scope` | array of string |  | `["security"]` | `["security","the legacy CSV export tool"]` | Topics agents must not report on; anything they notice there goes to notes, not findings. Example: "security", "legacy import tool". |

### `lenses`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `lenses` | array of string | yes | set by preset | `[5 entries]` (see the file) | Hunt lenses in use. Each one is a method file the hunters read first (method/lenses/<lens>.md). The kit ships performance, reliability, data, infra and frontend; any other name must also appear in custom_lenses. |

### `custom_lenses`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `custom_lenses` | array of string |  |  |  | Lenses you wrote yourself, e.g. "search-index". Listing one here lets `lenses` use it; you must also provide its lens file at `<ws>/method/lenses/<name>.md` (a custom skeptic lens in `verify.skeptic_lenses` goes at `<ws>/method/skeptics/<key>.md`). `validate` and `doctor` report any of these files that is missing. |

### `groups`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `groups` | array of object | yes |  | `[5 entries]` (see the file) | Hunt groups: one hunter agent per group, each with one repo and one lens. |
| `groups[].key` | string | yes |  | `"SVC-JOBS"` | Upper-case id such as "SVC-JOBS"; it prefixes every candidate the group finds. |
| `groups[].repo` | string | yes |  | `"notes-api"` | Name of a repo from `repos` that is not context-only. |
| `groups[].lens` | string | yes |  | `"reliability"` | One of `lenses`. |
| `groups[].scope` | string | yes |  | `"src/jobs/ and the queue set-up in src/queue/"` | Which code this hunter reads, e.g. "src/jobs/ and the queue setup". |
| `groups[].focus` | string |  |  | `"Retries, duplicate notifications, jobs that never finish."` | What to look for first, in a sentence. |
| `groups[].claims` | array of string |  |  | `[]` | Ids of earlier-audit claims (work/claims.json) this group must re-check. |
| `groups[].maps` | array of string |  |  | `["notes-api-map.md"]` | Phase-1 map files the hunter reads before starting. |

### `areas`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `areas` | array of string |  | `[5 entries]` (see the file) (presets override) |  | Report sections that findings are filed under, e.g. "background jobs", "database and indexes". |

### `modules`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `modules` | array of object |  | `[]` | `[{"repo":"notes-api","pattern":"^src/modules/([^/]+)","id":"svc.$1 ...` | How file paths map to named modules in the architecture view. The first rule whose pattern matches a path wins. `init` writes one starting rule per repo: backend and other repos `^src/([^/]+)/` → `<repo>.$1`; frontend `^src/(?:pages|features|components)/([^/]+)/`; infra and context-only repos none. |
| `modules[].repo` | string | yes |  | `"notes-api"` | Repo the rule applies to. |
| `modules[].pattern` | string | yes |  | `"^src/modules/([^/]+)"` | JavaScript regular expression matched against repo-relative paths; capture groups can be used as $1, $2 in `id` and `label`. |
| `modules[].id` | string | yes |  | `"svc.$1"` | Module id, e.g. "svc.$1". |
| `modules[].label` | string | yes |  | `"$1"` | Name shown in diagrams. |
| `modules[].layer` | string |  |  | `"Domain"` | Architecture layer, e.g. "Domain" or "Edge". |
| `modules[].doc` | string |  |  | `"system-docs/notes-api/architecture.md#modules"` | Workspace-relative link to the module's description. |

### `severity_rubric`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `severity_rubric` | object |  | see the file |  | Severity levels and what each means, in report order (most severe first). |
| `severity_rubric.<key>` | string |  |  |  |  |

### `effort_scale`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `effort_scale` | object |  | see the file |  | Effort sizes for recommended fixes and what each means, smallest first. |
| `effort_scale.<key>` | string |  |  |  |  |

### `verify`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `verify` | object |  |  |  | How candidate findings are challenged before they count. |
| `verify.skeptic_lenses` | array of string | yes | `["reach","mech","math"]` (presets override) |  | One skeptic per lens tries to refute each candidate. At least three, so a cut in budget never cuts the checks. |
| `verify.survive_votes` | integer | yes | `2` (presets override) |  | How many skeptics must fail to refute a candidate for it to survive. At most the number of skeptic lenses. |
| `verify.batch_size` | integer | yes | `30` (presets override) |  | Candidates per verify batch. |

### `models`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `models` | object |  |  |  | Model and effort per role. Leave a role out to keep its default; `inherit` means the workflow sends no model option and the session's model is used. |
| `models.lead` | object | yes |  |  | Model and effort for one role. |
| `models.lead.model` | string | yes | `"opus"` |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.lead.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"high"` |  | Reasoning effort. |
| `models.mapper` | object | yes |  |  | Model and effort for one role. |
| `models.mapper.model` | string | yes | `"inherit"` |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.mapper.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"medium"` |  | Reasoning effort. |
| `models.hunter` | object | yes |  |  | Model and effort for one role. |
| `models.hunter.model` | string | yes | `"inherit"` (presets override) |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.hunter.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"high"` (presets override) | `"xhigh"` | Reasoning effort. |
| `models.rule_writer` | object | yes |  |  | Model and effort for one role. |
| `models.rule_writer.model` | string | yes | `"inherit"` |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.rule_writer.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"medium"` |  | Reasoning effort. |
| `models.skeptic` | object | yes |  |  | Model and effort for one role. |
| `models.skeptic.model` | string | yes | `"inherit"` (presets override) |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.skeptic.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"high"` (presets override) |  | Reasoning effort. |
| `models.verifier` | object | yes |  |  | Model and effort for one role. |
| `models.verifier.model` | string | yes | `"sonnet"` (presets override) |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.verifier.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"low"` (presets override) |  | Reasoning effort. |
| `models.architect` | object | yes |  |  | Model and effort for one role. |
| `models.architect.model` | string | yes | `"inherit"` |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.architect.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"medium"` |  | Reasoning effort. |
| `models.docs_writer` | object | yes |  |  | Model and effort for one role. |
| `models.docs_writer.model` | string | yes | `"sonnet"` |  | `opus`, `sonnet`, `fable`, `inherit`, or a full model id starting with "claude-". |
| `models.docs_writer.effort` | `low`, `medium`, `high`, `xhigh`, `max` | yes | `"medium"` |  | Reasoning effort. |

### `agents`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `agents` | object |  |  |  | How agent types are named. With the plugin installed the namespace is the plugin name plus a colon; after `kit install-agents` set it to an empty string. |
| `agents.namespace` | string | yes | `"before-it-breaks:"` |  | Prefix put in front of every agent type. |
| `agents.types` | object | yes |  |  | Agent file name per role (without the namespace). |
| `agents.types.mapper` | string | yes | `"audit-mapper"` |  |  |
| `agents.types.hunter` | string | yes | `"audit-hunter"` |  |  |
| `agents.types.rule_writer` | string | yes | `"audit-rule-writer"` |  |  |
| `agents.types.skeptic` | string | yes | `"audit-skeptic"` |  |  |
| `agents.types.verifier` | string | yes | `"audit-verifier"` |  |  |
| `agents.types.architect` | string | yes | `"audit-architect"` |  |  |
| `agents.types.docs_writer` | string | yes | `"audit-docs-writer"` |  |  |

### `concurrency`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `concurrency` | object |  |  |  | Limits on how many agents run. Larger phases are split into several workflow runs. |
| `concurrency.max_agents_per_workflow` | integer | yes | `12` |  | Most agents one workflow run may start. |
| `concurrency.max_concurrent` | integer | yes | `6` |  | Most agents running at the same moment. At most `max_agents_per_workflow`. |
| `concurrency.verify_pool` | integer | yes | `3` |  | Verify batches worked on in parallel. |

### `evidence`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `evidence` | object |  |  |  | Rules for re-running the read-only commands that back each finding. |
| `evidence.shell` | string | yes | `"auto"` |  | `auto` finds a POSIX shell (Git Bash on Windows); otherwise give `bash` or an absolute path to one. |
| `evidence.timeout_ms` | integer | yes | `60000` |  | Time limit per command, in milliseconds. |
| `evidence.max_lines` | integer | yes | `200` |  | Output lines kept per command. |
| `evidence.allowed_heads` | array of string | yes | `[13 entries]` (see the file) |  | Programs a command may start with. Anything else is skipped as unsafe. |
| `evidence.git_read_subcommands` | array of string | yes | `[9 entries]` (see the file) |  | git subcommands treated as read-only. |
| `evidence.live_prefixes` | array of string | yes | `["mongosh","psql","redis-cli","LIVE"]` |  | Command starts that need a live system (a database shell, say). Those commands are recorded but not run by the kit. |
| `evidence.secret_patterns` | array of string | yes | `["(password|passwd|secret|token|api[_-]?key)\\s*[:=]\\s*\\S+","aut ...` |  | JavaScript regular expressions (case-insensitive) whose matches are masked in place in command text; when one matches a command's output, that command's whole output is withheld from the receipt. Your entries are added to the kit's default masks; the defaults cannot be removed. |

### `rules`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `rules` | object |  |  |  | Static-analysis rules run over the repos. |
| `rules.enabled` | boolean | yes | `true` |  | Turn the rules stage off for stacks the bundled rules do not cover. |
| `rules.engine` | const "semgrep" | yes | `"semgrep"` |  | Rule engine. Only Semgrep is supported. |
| `rules.languages` | array of string | yes | `["typescript"]` |  | Languages to scan, e.g. "typescript". |
| `rules.sets` | array of string | yes | `["typescript"]` |  | Bundled rule folders under rules/semgrep/ to use. |

### `outputs`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `outputs` | object |  |  |  | File and folder names of the deliverables, relative to the workspace; target_architecture is a file name inside docs_dir. |
| `outputs.summary` | string | yes | `"01-executive-summary.md"` |  |  |
| `outputs.report` | string | yes | `"02-audit-report.md"` |  |  |
| `outputs.log` | string | yes | `"03-verification-log.md"` |  |  |
| `outputs.measurements` | string | yes | `"04-measurements.md"` |  |  |
| `outputs.recommendations` | string | yes | `"05-recommendations.md"` |  |  |
| `outputs.docs_dir` | string | yes | `"system-docs"` |  |  |
| `outputs.work_dir` | string | yes | `"work"` |  |  |
| `outputs.target_architecture` | string |  | `"01-target-architecture.md"` |  |  |

### `publish`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `publish` | object |  |  |  | Where results are published, which decides link formats and the issue export. |
| `publish.tracker` | `gitlab`, `github`, `none` | yes | `"none"` | `"github"` | Issue tracker: `gitlab` writes a CSV import, `github` a markdown checklist, `none` nothing. |
| `publish.base_url` | string | yes | `""` | `""` | Web address of the repository that will hold the docs, used to build links. Empty keeps links relative. |
| `publish.docs_host` | `gitlab`, `github` | yes | `"github"` | `"github"` | Which host's markdown and diagram rendering the docs should suit. |

### `measure`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `measure` | object |  |  |  | The measure phase (designed, not yet proven): what access unlocks which checks, and how commands are sorted by kind. |
| `measure.access` | array of object |  | `[5 entries]` (see the file) |  | Access levels you may grant, the safe way to grant each, and what each one makes provable. |
| `measure.access[].kind` | string | yes |  |  |  |
| `measure.access[].safe_form` | string | yes |  |  |  |
| `measure.access[].unlocks` | string | yes |  |  |  |
| `measure.kinds` | object |  | see the file |  | Measurement kind -> JavaScript regular expression matched against a command. |
| `measure.kinds.<key>` | string |  |  |  |  |

### `read_only`

| Field | Type | Required | Default | Example (demo config) | Meaning |
|---|---|---|---|---|---|
| `read_only` | object |  |  |  | Commands the audit session must never run. `kit init` turns them into deny rules in the workspace's .claude/settings.json. |
| `read_only.deny_bash` | array of string | yes | see `config/defaults.json` |  | Command prefixes to deny, in six groups: git writes (push, commit, checkout, switch, reset, restore, stash, clean, `git rm`, `git mv`, merge, rebase, pull, apply, am, cherry-pick, revert); package installs (`npm install`/`i`/`ci`, `pnpm add`/`install`/`i`, `yarn add`/`install` and bare `yarn` (it installs), `bun add`/`install`); download and remote tools (curl, wget, nc, ssh, scp, `curl.exe`, `wget.exe`); interpreters and shells (python, python3, py, perl, ruby, `node -e`/`--eval`/`-p`/`--print`/`-i` and the `--eval=`/`--print=` forms, bash, sh, zsh, powershell, pwsh, cmd); package runners (npx, `npm run`/`exec`/`x`, `pnpm dlx`/`exec`, `yarn dlx`, bunx, `bun x`/`run`); git commands that reach out or change config (fetch, clone, remote, config, submodule). Bare `node` cannot be denied: the kit runs on it. Each git entry also gets a `git * <sub>` rule, so an unquoted search word that is a subcommand (`git grep config`) matches; quote it or use `rg`. These rules are a layer, not a boundary. Your entries are added to the kit's default list; the defaults cannot be removed. |

