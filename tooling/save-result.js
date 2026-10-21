'use strict';
/*
 * save-result.js - check one workflow result and write it to the workspace
 * file of its phase. Results are saved the moment a run returns, so nothing
 * lives only in a chat session.
 *
 * Usage:
 *   node tooling/save-result.js <phase> <result-json-file> [--run N] [<workspace>]
 *   phase: map | hunt | verify | report-inputs | recommend
 *
 * What each phase accepts and where it goes (paths under the config's
 * work folder):
 *   map            { maps: [{ repo, text }] } (or one { repo, text }, or a
 *                  bare array of them). Each text is written to
 *                  phase1/<repo>-map.md below a provenance line (repo, short
 *                  pin, audit date, source file). The repo must be in the
 *                  config.
 *   hunt           { candidates: [CANDIDATE...] } or a bare array, checked
 *                  with shapes.validateCandidates and the config. Merged into
 *                  candidates.json by id: a known id is replaced in place,
 *                  a new id is appended.
 *   verify         RUN_OUTPUT, checked with shapes.validateRunOutput and the
 *                  config. Written to phase3/votes-<N>.json (N from --run,
 *                  default 1).
 *   report-inputs  a JSON object. shapes.js has no shape for it yet, so only
 *                  the outer form is checked (said on stdout). Run 1 writes
 *                  phase5/report-inputs.json; a later run merges into it:
 *                  arrays are joined (items with the same "id" replaced),
 *                  other keys take the new value.
 *   recommend      { recs, cross_cutting }. recs is an object of
 *                  name -> plan, or an array of plans that each have a
 *                  "module" name; each plan goes to phase6/recs/<name>.json.
 *                  cross_cutting goes to phase6/cross-cutting.json; when it
 *                  has "sections" that must be an array, and when it has
 *                  "roadmap" that must hold now, next and later arrays.
 *                  shapes.js has no shape for these yet (said on stdout).
 *
 * Nothing is written when the result is invalid. Files are written to a
 * temporary name first and then renamed.
 *
 * Exit codes: 0 saved, 1 the result is invalid, 2 usage, config, pins or
 * unreadable input.
 *
 * Exports: main(argv, io), saveResult(phase, result, opts) -> { written,
 *   notes }   (throws ResultError with .errors when invalid)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');
const { validateCandidates, validateRunOutput } = require('./lib/shapes');
const { readPins } = require('./pin');

class CliError extends Error {}
class ResultError extends Error {
  constructor(errors) {
    super(`${errors.length} error${errors.length === 1 ? '' : 's'} in the result`);
    this.errors = errors;
  }
}

const PHASES = ['map', 'hunt', 'verify', 'report-inputs', 'recommend'];
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NO_SHAPE = (phase) => `note: tooling/lib/shapes.js has no shape for ${phase} results yet; only the outer form was checked`;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new CliError(`cannot read ${what} ${file} (${e.code || e.message})`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new CliError(`${what} ${file} is not valid JSON (${e.message})`);
  }
}

// ---------- phases ----------

function planMap(result, ctx) {
  const list = Array.isArray(result) ? result : isObj(result) && Array.isArray(result.maps) ? result.maps : isObj(result) && 'repo' in result ? [result] : null;
  if (!list) throw new ResultError(['result: expected { maps: [{ repo, text }] }, one { repo, text }, or an array of them']);
  const repos = new Set(ctx.config.repos.map((r) => r.name));
  const errs = [];
  const seen = new Set();
  list.forEach((m, i) => {
    const at = `maps[${i}]`;
    if (!isObj(m)) { errs.push(`${at}: must be an object`); return; }
    if (typeof m.repo !== 'string' || !repos.has(m.repo)) errs.push(`${at}.repo: unknown repo "${m.repo}"`);
    else if (seen.has(m.repo)) errs.push(`${at}.repo: "${m.repo}" appears twice`);
    else seen.add(m.repo);
    if (typeof m.text !== 'string' || !m.text.trim()) errs.push(`${at}.text: must be non-empty Markdown text`);
  });
  if (!list.length) errs.push('maps: is empty');
  if (errs.length) throw new ResultError(errs);
  const pins = readPins(ctx.paths);
  return list.map((m) => {
    const pin = pins.repos[m.repo];
    const short = pin && typeof pin.short === 'string' ? pin.short : 'UNPINNED';
    const header = `> Map of \`${m.repo}\` at \`${m.repo}@${short}\`, audit date ${ctx.config.audit.date}, saved from \`${ctx.source}\`.\n` +
      '> Written by an AI mapper. Anything marked UNVERIFIED is a lead, not a finding.\n\n';
    return { file: path.join(ctx.paths.work, 'phase1', `${m.repo}-map.md`), text: header + m.text.replace(/\s*$/, '\n') };
  });
}

function planHunt(result, ctx) {
  const incoming = Array.isArray(result) ? result : isObj(result) ? result.candidates : undefined;
  const errs = validateCandidates(Array.isArray(incoming) ? { candidates: incoming } : incoming, ctx.config);
  if (errs.length) throw new ResultError(errs);
  const file = path.join(ctx.paths.work, 'candidates.json');
  let doc = { candidates: [] };
  if (fs.existsSync(file)) {
    doc = readJson(file, 'existing');
    if (Array.isArray(doc)) doc = { candidates: doc };
    if (!isObj(doc) || !Array.isArray(doc.candidates)) throw new CliError(`${file} has no "candidates" array; fix or move it first`);
  }
  const merged = doc.candidates.slice();
  const index = new Map(merged.map((c, i) => [isObj(c) ? c.id : undefined, i]));
  let added = 0;
  let replaced = 0;
  for (const c of incoming) {
    if (index.has(c.id)) { merged[index.get(c.id)] = c; replaced++; } else { index.set(c.id, merged.length); merged.push(c); added++; }
  }
  const after = validateCandidates({ candidates: merged }, ctx.config);
  if (after.length) throw new ResultError(after.map((m) => `after merging into candidates.json: ${m}`));
  ctx.notes.push(`candidates: ${added} added, ${replaced} replaced, ${merged.length} in total`);
  return [{ file, text: json({ ...doc, candidates: merged }) }];
}

function planVerify(result, ctx) {
  const errs = validateRunOutput(result, ctx.config);
  if (errs.length) throw new ResultError(errs);
  return [{ file: path.join(ctx.paths.work, 'phase3', `votes-${ctx.run}.json`), text: json(result) }];
}

function mergeObjects(old, next) {
  const out = { ...old };
  for (const [k, v] of Object.entries(next)) {
    if (Array.isArray(v) && Array.isArray(old[k])) {
      const list = old[k].slice();
      const index = new Map(list.map((x, i) => [isObj(x) && typeof x.id === 'string' ? x.id : Symbol('none'), i]));
      for (const x of v) {
        if (isObj(x) && typeof x.id === 'string' && index.has(x.id)) list[index.get(x.id)] = x;
        else list.push(x);
      }
      out[k] = list;
    } else out[k] = v;
  }
  return out;
}

function planReport(result, ctx) {
  if (!isObj(result)) throw new ResultError(['result: must be a JSON object']);
  ctx.notes.push(NO_SHAPE('report-inputs'));
  const file = path.join(ctx.paths.work, 'phase5', 'report-inputs.json');
  let value = result;
  if (ctx.run !== '1' && fs.existsSync(file)) {
    const old = readJson(file, 'existing');
    if (!isObj(old)) throw new CliError(`${file} is not a JSON object; fix or move it first`);
    value = mergeObjects(old, result);
    ctx.notes.push(`run ${ctx.run} merged into the existing report-inputs.json`);
  }
  return [{ file, text: json(value) }];
}

function planRecommend(result, ctx) {
  if (!isObj(result)) throw new ResultError(['result: must be an object { recs, cross_cutting }']);
  const errs = [];
  const plans = [];
  const { recs, cross_cutting: cc } = result;
  if (Array.isArray(recs)) {
    recs.forEach((r, i) => {
      if (!isObj(r)) errs.push(`recs[${i}]: must be an object`);
      else if (typeof r.module !== 'string' || !FILE_NAME.test(r.module)) errs.push(`recs[${i}].module: must be a file-safe name (letters, digits, . _ -)`);
      else plans.push([r.module, r]);
    });
  } else if (isObj(recs)) {
    for (const [name, r] of Object.entries(recs)) {
      if (!FILE_NAME.test(name)) errs.push(`recs.${name}: the name must be file-safe (letters, digits, . _ -)`);
      else if (!isObj(r) && !Array.isArray(r)) errs.push(`recs.${name}: must be an object or an array`);
      else plans.push([name, r]);
    }
  } else errs.push('recs: must be an object of name -> plan, or an array of plans with a "module" name');
  const names = plans.map(([n]) => n.toLowerCase());
  names.forEach((n, i) => { if (names.indexOf(n) !== i) errs.push(`recs: "${plans[i][0]}" appears twice`); });
  if (!isObj(cc)) errs.push('cross_cutting: must be an object');
  else {
    if ('sections' in cc && !Array.isArray(cc.sections)) errs.push('cross_cutting.sections: must be an array');
    if ('roadmap' in cc) {
      if (!isObj(cc.roadmap)) errs.push('cross_cutting.roadmap: must be an object with now, next and later');
      else for (const k of ['now', 'next', 'later']) if (!Array.isArray(cc.roadmap[k])) errs.push(`cross_cutting.roadmap.${k}: must be an array`);
    }
  }
  if (errs.length) throw new ResultError(errs);
  ctx.notes.push(NO_SHAPE('recommend'));
  const dir = path.join(ctx.paths.work, 'phase6');
  return plans.map(([name, r]) => ({ file: path.join(dir, 'recs', `${name}.json`), text: json(r) }))
    .concat({ file: path.join(dir, 'cross-cutting.json'), text: json(cc) });
}

const PLAN = { map: planMap, hunt: planHunt, verify: planVerify, 'report-inputs': planReport, recommend: planRecommend };

function saveResult(phase, result, opts) {
  if (!PHASES.includes(phase)) throw new CliError(`unknown phase "${phase}" (one of ${PHASES.join(', ')})`);
  const { config, paths } = loadConfig(opts.workspace || '.');
  const ctx = { config, paths, run: String(opts.run || '1'), source: opts.source || 'result', notes: [] };
  const writes = PLAN[phase](result, ctx);
  for (const w of writes) writeAtomic(w.file, w.text);
  return { written: writes.map((w) => w.file), notes: ctx.notes };
}

function parseArgs(argv) {
  const opts = { phase: null, file: null, workspace: null, run: '1', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--run') {
      const v = argv[++i];
      if (v === undefined || !RUN.test(v)) throw new CliError('--run needs a run name such as 1, 2 or B1');
      opts.run = v;
    } else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (opts.phase === null) opts.phase = a;
    else if (opts.file === null) opts.file = a;
    else if (opts.workspace === null) opts.workspace = a;
    else throw new CliError(`unexpected argument ${a}`);
  }
  return opts;
}

const USAGE = `usage: node tooling/save-result.js <${PHASES.join('|')}> <result-json-file> [--run N] [<workspace>]`;

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }
    if (opts.phase === null || opts.file === null) { io.err(USAGE); return 2; }
    if (!PHASES.includes(opts.phase)) throw new CliError(`unknown phase "${opts.phase}" (one of ${PHASES.join(', ')})`);
    const result = readJson(opts.file, 'result file');
    const { written, notes } = saveResult(opts.phase, result, { ...opts, source: path.basename(opts.file) });
    notes.forEach((n) => io.out(n));
    written.forEach((f) => io.out(`saved ${f}`));
    return 0;
  } catch (e) {
    if (e instanceof ResultError) {
      io.err(`save: ${e.message}; nothing was saved`);
      e.errors.forEach((m) => io.err(`  - ${m}`));
      return 1;
    }
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`save: ${e.message}`);
      if (e instanceof ConfigError && e.errors && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, saveResult, ResultError, PHASES };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
