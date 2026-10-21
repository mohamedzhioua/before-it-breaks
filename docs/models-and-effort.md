# Models and effort

For the person running an audit and anyone tuning its cost. Which model and reasoning effort each role uses is set in `models` in `audit.config.json`; this page explains the defaults and the rule behind them.

## The rule: escalate on stakes, not cost

Spend effort where a mistake would reach the report. Hunters and skeptics decide what counts as a finding, so they get high effort. Mechanical work (comparing a receipt with a citation, tidying docs) gets a smaller model or lower effort. When the budget is tight, cut the scope (fewer groups or repos), not the effort of the checks.

## Defaults

From [`config/defaults.json`](../config/defaults.json); a preset may change some of them.

| Role | Agent | Model | Effort | Why |
|---|---|---|---|---|
| lead | the session itself | `opus` | `high` | Plans, decides gates and overrides; `init` puts these in the launch line it prints |
| mapper | `audit-mapper` | `inherit` | `medium` | Broad reading, little judgement |
| hunter | `audit-hunter` | `inherit` | `high` | Decides what is worth a candidate |
| rule_writer | `audit-rule-writer` | `inherit` | `medium` | Turns confirmed patterns into tested rules |
| skeptic | `audit-skeptic` | `inherit` | `high` (`xhigh` in the reliability preset) | Decides what survives |
| verifier | `audit-verifier` | `sonnet` | `low` | Mechanical check, on purpose a different model from the skeptics |
| architect | `audit-architect` | `inherit` | `medium` | Report inputs and plans from verified findings |
| docs_writer | `audit-docs-writer` | `sonnet` | `medium` | Editing and citation clean-up |

`inherit` means the workflow passes no model, so the agent runs on the session's model. A model is written as an alias (`opus`, `sonnet`, `fable`), `inherit`, or a full id starting with `claude-`; effort is one of `low`, `medium`, `high`, `xhigh`, `max`. Override a single role, for example `"models": { "hunter": { "effort": "xhigh" } }`; the rest keep their defaults.

## Keep the session's effort fixed

Each agent's effort is set when it is started, so per-role settings cost nothing extra. Changing the *session's* own effort mid-session clears the prompt cache and costs more; ask the user first.

## Record what actually ran

The config says what was asked for; the run log says what happened. After every phase, record the model and effort the harness reports, not the configured ones:

```
kit log <phase> --agents <count> --agent-type <type> --model <model> --effort <effort> [--tokens <n>] [--wall-clock <s>] <ws>
```

If they differ from the config, say so in `--note`. The verification log prints who ran each step from this file; with no entries it says the models are unrecorded and lists the configured ones as configured, not as observed. An advisor call (a stronger model asked about one hard decision, with the user's approval) is recorded the same way; see `prompts/advisor.md`.

## Model names age

Model names and their abilities change. The kit uses aliases so a config keeps working when a new model ships, and it never claims a result for a model it did not run on. Anything you learn about a specific model belongs in your run log and notes, not in the method.
