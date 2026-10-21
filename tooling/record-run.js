'use strict';
/*
 * record-run.js - append one entry to the workspace run log, so every audit
 * keeps a record of which agents ran each phase, on which model and effort.
 *
 * Usage:
 *   node tooling/record-run.js <phase> --agents N --agent-type T --model M
 *     --effort E [--run N] [--wall-clock SECONDS] [--tokens N]
 *     [--note TEXT] [<workspace>]
 *
 *   phase        a step name such as pin, map, hunt, evidence, batches,
 *                verify, synthesize, report-inputs, build, recommend,
 *                measure (lower case, words joined by "-").
 *   --agents     how many agents ran (0 for a script step).
 *   --agent-type the agent type dispatched (for example
 *                before-it-breaks:audit-skeptic), or "script".
 *   --model      the model the agents ACTUALLY ran on, as the harness
 *                reported it, or "unknown". "inherit" is refused: it says
 *                what was asked for, not what ran.
 *   --effort     low | medium | high | xhigh | max | unknown.
 *   --wall-clock seconds, when known. --tokens: total tokens, when the
 *                harness reports them.
 *
 * The log is <work>/run-log.json: { "entries": [ { phase, run, agents,
 * agent_type, model, effort, wall_clock_s, tokens, note, recorded_at } ] }.
 * A missing file is created; a file holding a bare array is accepted and
 * rewritten in the object form. Fields not given are null.
 *
 * Exit codes: 0 recorded, 2 usage, config or an unreadable log.
 *
 * Exports: main(argv, io), recordRun(entry, { workspace, now }) -> file
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');

class CliError extends Error {}

const PHASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'unknown'];
const WHOLE = /^(0|[1-9][0-9]*)$/;
const NUMBER = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function logFile(paths) {
  return path.join(paths.work, 'run-log.json');
}

function readLog(file) {
  if (!fs.existsSync(file)) return { entries: [] };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new CliError(`${file} is not valid JSON (${e.message}); fix or move it first`);
  }
  if (Array.isArray(doc)) return { entries: doc };
  if (doc && typeof doc === 'object' && Array.isArray(doc.entries)) return doc;
  throw new CliError(`${file} has no "entries" array; fix or move it first`);
}

function recordRun(entry, opts) {
  const { paths } = loadConfig(opts.workspace || '.');
  const file = logFile(paths);
  const doc = readLog(file);
  const now = opts.now || new Date();
  doc.entries.push({ ...entry, recorded_at: now.toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

const OPTIONS = {
  '--agents': 'agents',
  '--agent-type': 'agent_type',
  '--model': 'model',
  '--effort': 'effort',
  '--run': 'run',
  '--wall-clock': 'wall_clock_s',
  '--tokens': 'tokens',
  '--note': 'note',
};

function parseArgs(argv) {
  const opts = { phase: null, workspace: null, help: false, values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (Object.prototype.hasOwnProperty.call(OPTIONS, a)) {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} needs a value`);
      opts.values[OPTIONS[a]] = v;
    } else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (opts.phase === null) opts.phase = a;
    else if (opts.workspace === null) opts.workspace = a;
    else throw new CliError(`unexpected argument ${a}`);
  }
  return opts;
}

function toEntry(opts) {
  const v = opts.values;
  const errs = [];
  if (!PHASE.test(opts.phase)) errs.push(`phase: "${opts.phase}" must be lower case words joined by "-" (for example report-inputs)`);
  for (const [flag, key] of [['--agents', 'agents'], ['--agent-type', 'agent_type'], ['--model', 'model'], ['--effort', 'effort']]) {
    if (v[key] === undefined || !String(v[key]).trim()) errs.push(`${flag} is required`);
  }
  if (v.agents !== undefined && !WHOLE.test(v.agents)) errs.push(`--agents must be a whole number (got ${v.agents})`);
  if (v.model !== undefined && v.model.trim().toLowerCase() === 'inherit') {
    errs.push('--model: record the model the agents actually ran on (or "unknown"), not "inherit"');
  }
  if (v.effort !== undefined && !EFFORTS.includes(v.effort)) errs.push(`--effort must be one of ${EFFORTS.join(', ')} (got ${v.effort})`);
  if (v.wall_clock_s !== undefined && !NUMBER.test(v.wall_clock_s)) errs.push(`--wall-clock must be a number of seconds (got ${v.wall_clock_s})`);
  if (v.tokens !== undefined && !WHOLE.test(v.tokens)) errs.push(`--tokens must be a whole number (got ${v.tokens})`);
  if (errs.length) throw new CliError(errs.join('; '));
  return {
    phase: opts.phase,
    run: v.run === undefined ? null : v.run,
    agents: Number(v.agents),
    agent_type: v.agent_type.trim(),
    model: v.model.trim(),
    effort: v.effort,
    wall_clock_s: v.wall_clock_s === undefined ? null : Number(v.wall_clock_s),
    tokens: v.tokens === undefined ? null : Number(v.tokens),
    note: v.note === undefined ? null : v.note,
  };
}

const USAGE = 'usage: node tooling/record-run.js <phase> --agents N --agent-type T --model M --effort E [--run N] [--wall-clock S] [--tokens N] [--note TEXT] [<workspace>]';

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }
    if (opts.phase === null) { io.err(USAGE); return 2; }
    const entry = toEntry(opts);
    const file = recordRun(entry, { workspace: opts.workspace });
    io.out(`recorded ${entry.phase}${entry.run ? ` run ${entry.run}` : ''} in ${file}`);
    return 0;
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`log: ${e.message}`);
      if (e instanceof ConfigError && e.errors && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, recordRun, EFFORTS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
