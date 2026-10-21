'use strict';
/*
 * workflow-args.js - print the exact `args` object for one workflow run.
 *
 * Usage:
 *   node tooling/workflow-args.js <phase> [--run N] [--date YYYY-MM-DD]
 *                                 [--target-design <file>] [<workspace>]
 *   phase: map | hunt | verify | report-inputs | recommend
 *
 * Prints ONE JSON object on stdout; the skill or the lead hands it over as the
 * Workflow `args` unchanged. Workflows cannot read files, the clock or the
 * environment, so everything they need is in here, with absolute paths.
 *
 * Common part (every phase):
 *   phase, run, runs_total, audit, date (audit.date, or --date; workflows
 *   never read the clock), workspace, kit_root,
 *   repos: [{ name, path, role, pin, short, include, exclude, context_only,
 *            known_gaps }]  (path absolute, pin from work/pins.json),
 *   scale, known_limits, library_assumptions, out_of_scope, lenses,
 *   models (a role whose model is "inherit" has no model key: the workflow
 *   then sends no model option), agents { namespace, types }, concurrency,
 *   severity_rubric, effort_scale, rules (+ dir: workspace rules folder,
 *   kit_dir: bundled rules), publish, outputs (absolute), dryRun: false.
 * Phase part:
 *   map            map_repos (names of the repos that are not context_only),
 *                  checklists (method/phase1-map-checklists.md), map_dir.
 *   hunt           groups of run N (each with maps as absolute files under
 *                  work/phase1 and its lens_file), lens_files, claims_file,
 *                  map_dir, rule_writer (true on the last run when
 *                  rules.enabled; the rule writer counts as one agent).
 *   verify         batches of run N as [{ batch, file, groups, size, ids }]:
 *                  file is the absolute path of work/phase3/batches/B<n>.json
 *                  (from `kit batches`), which the agents read themselves, so
 *                  candidate texts are not copied into args; verify, pool
 *                  (concurrency.verify_pool), skeptic_briefs, receipts_dir.
 *                  Args stay small enough to paste into a Workflow call:
 *                  hunt carries only the config's group entries, report-inputs
 *                  only finding ids, recommend only the config's modules.
 *   report-inputs  report_batches [{ batch: "R<n>", ids }] of the findings
 *                  that survived (PROVEN-STATIC, PROVEN, UNPROVEN in
 *                  work/phase3/verdicts.json), areas, scale_bases,
 *                  verdicts_file, out_file, docs_writer (last run),
 *                  target_design (absolute path of --target-design, a file
 *                  describing a planned design to compare against; relative
 *                  to the workspace; null when not given).
 *   recommend      modules of run N (one architect each), cross_cutting
 *                  (true on the last run: one more architect writes the
 *                  cross-cutting decisions), report_inputs_file
 *                  (work/phase5/report-inputs.json), verdicts_file,
 *                  recs_dir, cross_cutting_file.
 * Runs: a phase that needs more agents than
 * concurrency.max_agents_per_workflow is split into runs; pick one with
 * --run N (default 1). runs_total says how many there are.
 *
 * Method files: bundled lenses and skeptic lenses point into the kit's
 * method/ folder; a custom lens points to <workspace>/method/lenses/<lens>.md
 * (custom skeptic lens: <workspace>/method/skeptics/<lens>.md).
 *
 * Every phase needs work/pins.json, so Phase 0 (`kit pin`) comes first.
 * Exit codes: 0 printed, 2 usage, config or missing input.
 *
 * Export: buildArgs(phase, { workspace, run, date, targetDesign }) -> object
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError, BUNDLED_LENSES } = require('./lib/config');
const { readPins } = require('./pin');

class CliError extends Error {}

const PHASES = ['map', 'hunt', 'verify', 'report-inputs', 'recommend'];
const BUNDLED_SKEPTICS = ['reach', 'mech', 'math'];
const SURVIVED = ['PROVEN-STATIC', 'PROVEN', 'UNPROVEN'];
const DATE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

// Splits list into k near-equal parts, larger parts first.
function parts(list, k) {
  const out = [];
  let start = 0;
  for (let p = 0; p < k; p++) {
    const len = Math.ceil((list.length - start) / (k - p));
    out.push(list.slice(start, start + len));
    start += len;
  }
  return out;
}

function pick(runs, n) {
  if (n > runs.length) throw new CliError(`--run ${n}: this phase has ${runs.length} run${runs.length === 1 ? '' : 's'}`);
  return runs[n - 1];
}

function readJson(file, missing) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError(missing);
    throw new CliError(`cannot read ${path.basename(file)} (${e.code || e.message})`);
  }
}

function common(config, paths, pins, date) {
  const repos = config.repos.map((r) => {
    const pin = pins.repos[r.name];
    if (!pin) throw new CliError(`repo ${r.name} is not in work/pins.json; run \`kit pin\` again`);
    return {
      name: r.name,
      path: paths.repos[r.name],
      role: r.role,
      pin: pin.sha,
      short: pin.short,
      include: r.include || [],
      exclude: r.exclude || [],
      context_only: r.context_only === true,
      known_gaps: r.known_gaps || [],
    };
  });
  const models = {};
  for (const [role, m] of Object.entries(config.models)) {
    models[role] = m.model === 'inherit' ? { effort: m.effort } : { model: m.model, effort: m.effort };
  }
  return {
    audit: { ...config.audit, date },
    date,
    workspace: paths.workspace,
    kit_root: paths.kit,
    repos,
    scale: config.scale,
    known_limits: config.known_limits,
    library_assumptions: config.library_assumptions,
    out_of_scope: config.out_of_scope,
    lenses: config.lenses,
    models,
    agents: { namespace: config.agents.namespace, types: config.agents.types },
    concurrency: config.concurrency,
    severity_rubric: config.severity_rubric,
    effort_scale: config.effort_scale,
    rules: { ...config.rules, dir: paths.rules, kit_dir: path.join(paths.kit, 'rules', 'semgrep') },
    publish: config.publish,
    outputs: paths.outputs,
    dryRun: false,
  };
}

function lensFile(paths, lens) {
  return BUNDLED_LENSES.includes(lens)
    ? path.join(paths.kit, 'method', 'lenses', `${lens}.md`)
    : path.join(paths.workspace, 'method', 'lenses', `${lens}.md`);
}

function skepticFile(paths, lens) {
  return BUNDLED_SKEPTICS.includes(lens)
    ? path.join(paths.kit, 'method', 'skeptics', `${lens}.md`)
    : path.join(paths.workspace, 'method', 'skeptics', `${lens}.md`);
}

function mapPart(config, paths, n) {
  const cap = config.concurrency.max_agents_per_workflow;
  const names = config.repos.filter((r) => r.context_only !== true).map((r) => r.name);
  const runs = parts(names, Math.max(1, Math.ceil(names.length / cap)));
  return {
    runs_total: runs.length,
    map_repos: pick(runs, n),
    checklists: path.join(paths.kit, 'method', 'phase1-map-checklists.md'),
    map_dir: path.join(paths.work, 'phase1'),
  };
}

function huntPart(config, paths, n) {
  const cap = config.concurrency.max_agents_per_workflow;
  const writer = config.rules.enabled ? 1 : 0;
  const total = Math.max(1, Math.ceil((config.groups.length + writer) / cap));
  const runs = parts(config.groups, total);
  const mapDir = path.join(paths.work, 'phase1');
  const groups = pick(runs, n).map((g) => ({
    ...g,
    claims: g.claims || [],
    maps: (g.maps || []).map((m) => path.join(mapDir, m)),
    lens_file: lensFile(paths, g.lens),
  }));
  return {
    runs_total: runs.length,
    groups,
    lens_files: Object.fromEntries(config.lenses.map((l) => [l, lensFile(paths, l)])),
    claims_file: path.join(paths.work, 'claims.json'),
    map_dir: mapDir,
    rule_writer: writer === 1 && n === runs.length,
  };
}

function verifyPart(config, paths, n) {
  const dir = path.join(paths.work, 'phase3');
  const plan = readJson(path.join(dir, 'runs.json'), 'work/phase3/runs.json is missing: run `kit batches` first');
  if (!plan || !Array.isArray(plan.runs) || !plan.runs.length) throw new CliError('work/phase3/runs.json has no runs; run `kit batches` again');
  const runPlan = pick(plan.runs, n);
  const perBatch = config.verify.skeptic_lenses.length + 1;
  if (runPlan.batches.length * perBatch > config.concurrency.max_agents_per_workflow) {
    throw new CliError('work/phase3/runs.json no longer fits the agent cap of the config; run `kit batches` again');
  }
  const batches = runPlan.batches.map((b) => {
    const data = readJson(path.join(dir, 'batches', `${b}.json`), `work/phase3/batches/${b}.json is missing: run \`kit batches\` again`);
    const ids = (data.candidates || []).map((c) => c.id);
    return { batch: b, file: path.join(dir, 'batches', `${b}.json`), groups: data.groups || [], size: ids.length, ids };
  });
  return {
    runs_total: plan.runs.length,
    batches,
    verify: config.verify,
    pool: config.concurrency.verify_pool,
    skeptic_briefs: Object.fromEntries(config.verify.skeptic_lenses.map((l) => [l, skepticFile(paths, l)])),
    receipts_dir: path.join(dir, 'receipts'),
  };
}

function reportPart(config, paths, n) {
  const file = path.join(paths.work, 'phase3', 'verdicts.json');
  const doc = readJson(file, 'work/phase3/verdicts.json is missing: run `kit synthesize` first');
  const ids = (doc.verdicts || []).filter((v) => SURVIVED.includes(v.verdict)).map((v) => v.id);
  if (!ids.length) throw new CliError('no finding survived verification; nothing to report');
  const size = config.verify.batch_size;
  const batches = parts(ids, Math.ceil(ids.length / size)).map((list, i) => ({ batch: `R${i + 1}`, ids: list }));
  const perRun = config.concurrency.max_agents_per_workflow - 1; // one slot for the docs writer
  if (perRun < 1) throw new CliError('concurrency.max_agents_per_workflow must be at least 2 for report-inputs');
  const runs = parts(batches, Math.ceil(batches.length / perRun));
  return {
    runs_total: runs.length,
    report_batches: pick(runs, n),
    areas: config.areas,
    scale_bases: config.scale.bases,
    verdicts_file: file,
    docs_dir: paths.docs,
    out_file: path.join(paths.work, 'phase5', 'report-inputs.json'),
    docs_writer: n === runs.length,
    target_design: paths.targetDesign || null,
  };
}

function recommendPart(config, paths, n) {
  const cap = config.concurrency.max_agents_per_workflow;
  const runs = parts(config.modules, Math.max(1, Math.ceil((config.modules.length + 1) / cap)));
  return {
    runs_total: runs.length,
    modules: pick(runs, n),
    cross_cutting: n === runs.length,
    report_inputs_file: path.join(paths.work, 'phase5', 'report-inputs.json'),
    verdicts_file: path.join(paths.work, 'phase3', 'verdicts.json'),
    recs_dir: path.join(paths.work, 'phase6', 'recs'),
    cross_cutting_file: path.join(paths.work, 'phase6', 'cross-cutting.json'),
  };
}

const PARTS = { map: mapPart, hunt: huntPart, verify: verifyPart, 'report-inputs': reportPart, recommend: recommendPart };

function buildArgs(phase, opts) {
  if (!PHASES.includes(phase)) throw new CliError(`unknown phase "${phase}" (one of ${PHASES.join(', ')})`);
  const { config, paths } = loadConfig(opts.workspace || '.');
  const pins = readPins(paths);
  const date = opts.date || config.audit.date;
  const n = opts.run || 1;
  if (opts.targetDesign) {
    const file = path.resolve(paths.workspace, opts.targetDesign);
    if (!fs.existsSync(file)) throw new CliError(`--target-design: file not found: ${opts.targetDesign}`);
    paths.targetDesign = file;
  }
  const part = PARTS[phase](config, paths, n);
  const { runs_total: runsTotal, ...rest } = part;
  return { phase, run: n, runs_total: runsTotal, ...common(config, paths, pins, date), ...rest };
}

function parseArgs(argv) {
  const opts = { phase: null, workspace: null, run: 1, date: null, targetDesign: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--target-design') {
      opts.targetDesign = argv[++i];
      if (opts.targetDesign === undefined) throw new CliError('--target-design needs a file');
    } else if (a === '--run' || a === '--date') {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} needs a value`);
      if (a === '--run') {
        if (!/^[1-9][0-9]*$/.test(v)) throw new CliError(`--run must be a whole number from 1 (got ${v})`);
        opts.run = Number(v);
      } else {
        if (!DATE.test(v)) throw new CliError(`--date must be YYYY-MM-DD (got ${v})`);
        opts.date = v;
      }
    } else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (opts.phase === null) opts.phase = a;
    else if (opts.workspace === null) opts.workspace = a;
    else throw new CliError(`unexpected argument ${a}`);
  }
  return opts;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help || opts.phase === null) {
      io[opts.help ? 'out' : 'err'](`usage: node tooling/workflow-args.js <${PHASES.join('|')}> [--run N] [--date YYYY-MM-DD] [--target-design <file>] [<workspace>]`);
      return opts.help ? 0 : 2;
    }
    io.out(JSON.stringify(buildArgs(opts.phase, opts), null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`args: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, buildArgs, PHASES };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
