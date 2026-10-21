'use strict';
/*
 * split-batches.js - cut the candidates into verify batches and plan the
 * verify workflow runs.
 *
 * Usage:
 *   node tooling/split-batches.js [<workspace>]
 *
 * Reads <work>/candidates.json. Writes:
 *   <work>/phase3/batches/B<n>.json  { batch, groups, candidates } with at
 *       most verify.batch_size candidates each. Candidates with status
 *       "fixed" or "not_found" are left out (synthesis refutes them without
 *       votes), and severity_guess is removed from each candidate so the
 *       skeptics judge severity without the hunter's hint. Groups are taken in config
 *       order and kept together: a group joins the current batch while it
 *       fits, otherwise it starts a new one; a group larger than the batch
 *       size is cut into near-equal parts. Old B<n>.json files are removed.
 *   <work>/phase3/runs.json  { agents_per_batch, max_agents_per_workflow,
 *       runs: [{ run, batches, agents }] }. Each batch needs one skeptic per
 *       skeptic lens plus one verifier; each run holds as many batches as
 *       fit in concurrency.max_agents_per_workflow.
 *
 * Exit codes: 0 written, 2 usage, config or input error (including an agent
 * cap too small for even one batch).
 *
 * Exports: plan(config, candidates) -> { batches, runs, agentsPerBatch },
 *   forSkeptics(candidate) -> the candidate without severity_guess, NOT_VOTED
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');
const { validateCandidates } = require('./lib/shapes');

class CliError extends Error {}

// Statuses that need no votes: synthesize-verdicts refutes them directly.
const NOT_VOTED = ['fixed', 'not_found'];

// What a skeptic sees of a candidate: everything but the hunter's severity hint.
function forSkeptics(c) {
  const { severity_guess: _hint, ...rest } = c;
  return rest;
}

function chunks(list, size) {
  const parts = Math.ceil(list.length / size);
  const out = [];
  let start = 0;
  for (let p = 0; p < parts; p++) {
    const len = Math.ceil((list.length - start) / (parts - p));
    out.push(list.slice(start, start + len));
    start += len;
  }
  return out;
}

function plan(config, candidates) {
  const size = config.verify.batch_size;
  const agentsPerBatch = config.verify.skeptic_lenses.length + 1;
  const cap = config.concurrency.max_agents_per_workflow;
  const perRun = Math.floor(cap / agentsPerBatch);
  if (perRun < 1) {
    throw new CliError(`concurrency.max_agents_per_workflow is ${cap}, but one verify batch needs ${agentsPerBatch} agents `
      + `(${config.verify.skeptic_lenses.length} skeptics + 1 verifier)`);
  }
  const order = config.groups.map((g) => g.key);
  const byGroup = new Map(order.map((k) => [k, []]));
  for (const c of candidates) if (!NOT_VOTED.includes(c.status)) byGroup.get(c.group).push(c);

  const batches = [];
  let cur = null;
  const open = () => { cur = { groups: [], candidates: [] }; batches.push(cur); };
  for (const key of order) {
    const list = byGroup.get(key);
    if (!list.length) continue;
    if (list.length > size) {
      for (const part of chunks(list, size)) {
        open();
        cur.groups.push(key);
        cur.candidates.push(...part);
      }
      cur = null;
      continue;
    }
    if (!cur || cur.candidates.length + list.length > size) open();
    cur.groups.push(key);
    cur.candidates.push(...list);
  }
  batches.forEach((b, i) => { b.batch = `B${i + 1}`; });

  const runs = [];
  for (let i = 0; i < batches.length; i += perRun) {
    const names = batches.slice(i, i + perRun).map((b) => b.batch);
    runs.push({ run: runs.length + 1, batches: names, agents: names.length * agentsPerBatch });
  }
  return { batches, runs, agentsPerBatch };
}

function run(opts, io) {
  const { config, paths } = loadConfig(opts.workspace);
  const file = path.join(paths.work, 'candidates.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError(e.code === 'ENOENT' ? 'work/candidates.json is missing (Phase 2 writes it)' : `cannot read work/candidates.json (${e.code || e.message})`);
  }
  const errs = validateCandidates(data, config);
  if (errs.length) {
    throw new CliError(`work/candidates.json has ${errs.length} problem${errs.length === 1 ? '' : 's'}:\n${errs.slice(0, 20).map((m) => `  - ${m}`).join('\n')}`);
  }
  const candidates = Array.isArray(data) ? data : data.candidates;
  if (!candidates.length) throw new CliError('work/candidates.json has no candidates');
  const p = plan(config, candidates);

  const dir = path.join(paths.work, 'phase3', 'batches');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^B[0-9]+\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  for (const b of p.batches) {
    fs.writeFileSync(path.join(dir, `${b.batch}.json`),
      JSON.stringify({ batch: b.batch, groups: b.groups, candidates: b.candidates.map(forSkeptics) }, null, 2) + '\n');
  }
  const runsDoc = {
    agents_per_batch: p.agentsPerBatch,
    max_agents_per_workflow: config.concurrency.max_agents_per_workflow,
    runs: p.runs,
  };
  fs.writeFileSync(path.join(paths.work, 'phase3', 'runs.json'), JSON.stringify(runsDoc, null, 2) + '\n');
  for (const b of p.batches) io.out(`${b.batch}: ${b.candidates.length} candidates (${b.groups.join(', ')})`);
  for (const r of p.runs) io.out(`run ${r.run}: ${r.batches.join(', ')} = ${r.agents} agents`);
  const skipped = candidates.filter((c) => NOT_VOTED.includes(c.status));
  if (skipped.length) io.out(`not batched (status fixed or not_found; synthesis refutes them): ${skipped.map((c) => c.id).join(', ')}`);
  io.out(`${candidates.length - skipped.length} candidates in ${p.batches.length} batches and ${p.runs.length} run${p.runs.length === 1 ? '' : 's'}`);
  return 0;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const pos = [];
    for (const a of argv) {
      if (a === '--help' || a === '-h') {
        io.out('usage: node tooling/split-batches.js [<workspace>]');
        return 0;
      }
      if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      pos.push(a);
    }
    if (pos.length > 1) throw new CliError('only one workspace may be given');
    return run({ workspace: pos[0] || '.' }, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`split-batches: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, plan, forSkeptics, NOT_VOTED };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
