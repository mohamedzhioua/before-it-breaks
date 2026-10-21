# Limits

For anyone deciding how much weight to give an audit made with this kit. These are the honest limits of the method and of this version.

- **Proven on code, not measured.** The method has been used on code only. Its findings are PROVEN-STATIC or UNPROVEN: breaking sizes are calculated from the code, the configuration and documented limits, and the skeptics correct many of them, but a calculation can still be wrong. The measure step that would confirm them is [designed, not yet proven](measuring.md).
- **One reference system.** The method has been used end to end on one private audit of a multi-repository Node.js/TypeScript system using MongoDB, Redis and Kubernetes. Nothing about that system ships with the kit. Other stacks are untested; the public worked example in [`examples/`](../examples/README.md) is planned, not yet run.
- **Not deterministic.** Two runs on the same code will not find exactly the same candidates or reach exactly the same verdicts. Trust rests on what can be re-checked (pinned citations, receipts anyone can re-run, recorded overrides), not on what one model believes.
- **One model family.** All three skeptics differ in lens and each works in its own context, but they share a model family, so they may share blind spots. By default the verifier uses another, smaller model, and it checks evidence mechanically, not merit.
- **Scope sets coverage.** Hunters read the groups you define. Code outside every group, repos marked `context_only`, and topics in `out_of_scope` are not hunted. There is no completeness guarantee.
- **Costs are not predictable precisely.** Time and AI usage grow with the number of repos, groups and candidates, and multi-agent phases use far more than ordinary chat. Record what each phase actually used in the run log; the kit gives no fixed figures.
- **Models change.** The kit was built and used with Claude models available in late 2026. Other and later models are untested; the config uses aliases so it keeps working, but results may differ.
- **Experimental parts.** The recommend phase (module plans, decision records, roadmap) is experimental: it has not been scripted in a full audit yet, and it does not yet guarantee a plan for every finding in a planned module; `recommend` lists any finding id it got no plan for in `failed`.
- **Out of reach: security, load testing, observability.** The kit does not look for vulnerabilities, measure production behaviour or replace monitoring.
- **The evidence allowlist is not a sandbox**, and the agents read untrusted code. See [security](security.md).
