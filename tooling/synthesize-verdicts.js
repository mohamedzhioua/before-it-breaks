'use strict';
/*
 * synthesize-verdicts.js - Phase 3 synthesis: skeptic votes + verifier
 * checks + evidence receipts -> one verdict per candidate.
 *
 * Usage:
 *   node tooling/synthesize-verdicts.js [<workspace>] [<votes-file>...]
 *
 * Inputs (shapes in tooling/lib/shapes.js):
 *   <work>/candidates.json
 *   <work>/phase3/receipts/_index.json          (from run-evidence.js)
 *   votes files: the saved outputs of the verify workflow runs; default
 *     every <work>/phase3/votes-*.json, read in name order. A file may hold
 *     the output itself or wrap it as { "result": ... }. When the same
 *     candidate gets two votes from one lens, the later file wins.
 *   <work>/phase3/master-overrides.json         (optional)
 * Output: <work>/phase3/verdicts.json, then tallies on the console.
 *
 * Rules (deterministic; anything they cannot settle is NEEDS-REVIEW for the
 * lead). n = number of skeptic lenses (verify.skeptic_lenses), majority =
 * more than half of n, survive = REAL + PARTIAL votes, need =
 * verify.survive_votes:
 *   fewer than n votes, or no verifier check      -> NEEDS-REVIEW (incomplete)
 *   OUT_OF_SCOPE votes >= majority                 -> OUT-OF-SCOPE
 *   REFUTED votes >= majority                      -> REFUTED
 *   candidate status "not_found" (cited code gone)  -> REFUTED
 *   survive >= need and verifier CONFIRMED         -> PROVEN-STATIC
 *   survive >= need and verifier UNVERIFIABLE      -> UNPROVEN
 *   anything else                                  -> NEEDS-REVIEW (split)
 * Severity: the median of the skeptics' recommended levels, ignoring "none"
 * when at least two gave a real level; "none" unless the candidate survived.
 *
 * Gates: each skeptic reports the gates of its own lens (1 reachable,
 * 2 realistic trigger, 3 mechanism, 4 bounds, 5 no mitigation); gate 6
 * (evidence reproduces) comes from the verifier. A gate is FAIL if any vote
 * reporting it says FAIL, PASS if one says PASS and none FAIL, otherwise
 * UNKNOWN. The same results are also given in the vocabulary of the
 * fp-check method (see docs/verification.md).
 *
 * Master overrides: { "overrides": [ { "id", "action", "reason", ... } ] }.
 * The lead may only take findings away or narrow them, never add one:
 *   remove     verdict REMOVED (kept in the file for the record)
 *   merge      verdict MERGED; needs "into": another candidate id
 *   re-scope   keeps the verdict; may set "title" and/or "severity". Only
 *              for a finding that survived (PROVEN-STATIC, PROVEN,
 *              UNPROVEN), and the severity may only stay or go down.
 *   hold       verdict HELD (held back from the report)
 * Every override needs a non-empty reason and an existing candidate id; it
 * may carry "approved_by" (who approved it), copied into verdicts.json;
 * one override per candidate, and no other keys than the action uses (so
 * no "verdict"). A merge target may not itself be removed or merged. Any
 * other action (including "add") or broken rule stops the run with exit 2
 * and nothing is written. Severity order is the key order of
 * severity_rubric (most severe first), then "none".
 *
 * Exit codes: 0 written, 2 usage, config or input error.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');
const { validateCandidates, validateRunOutput, validateReceiptIndex, validateVerdicts } = require('./lib/shapes');

class CliError extends Error {}

const ACTIONS = ['remove', 'merge', 're-scope', 'hold'];

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError(`${label} is missing`);
    throw new CliError(`cannot read ${label} (${e.code || e.message})`);
  }
}

function problems(label, errs) {
  if (!errs.length) return;
  const shown = errs.slice(0, 20).map((m) => `  - ${m}`);
  if (errs.length > 20) shown.push(`  ... and ${errs.length - 20} more`);
  throw new CliError(`${label} has ${errs.length} problem${errs.length === 1 ? '' : 's'}:\n${shown.join('\n')}`);
}

function votesFiles(paths, given) {
  if (given.length) return given.map((f) => path.resolve(f));
  const dir = path.join(paths.work, 'phase3');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^votes-.*\.json$/.test(f)).sort() : [];
  if (!names.length) throw new CliError('no votes files: save each verify run as work/phase3/votes-<name>.json');
  return names.map((f) => path.join(dir, f));
}

function readOverrides(paths) {
  const file = path.join(paths.work, 'phase3', 'master-overrides.json');
  if (!fs.existsSync(file)) return [];
  const data = readJson(file, 'work/phase3/master-overrides.json');
  const list = Array.isArray(data) ? data : data && data.overrides;
  if (!Array.isArray(list)) throw new CliError('work/phase3/master-overrides.json: expected { "overrides": [...] }');
  return list;
}

const SURVIVING = ['PROVEN-STATIC', 'PROVEN', 'UNPROVEN'];
const KEYS = { remove: [], hold: [], merge: ['into'], 're-scope': ['title', 'severity'] };

// Checks every override against the synthesized verdicts; returns string[].
function overrideProblems(verdicts, overrides, config) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const levels = ['none'].concat(Object.keys(config.severity_rubric).reverse()); // index = rank
  const gone = new Set(overrides.filter((o) => o && (o.action === 'remove' || o.action === 'merge')).map((o) => o.id));
  const errs = [];
  const seen = new Set();
  overrides.forEach((o, i) => {
    const at = `overrides[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push(`${at}: must be an object`); return; }
    if (!ACTIONS.includes(o.action)) {
      errs.push(`${at}.action: "${o.action}" is not allowed; overrides may remove, merge, re-scope or hold a finding, never add one`);
      return;
    }
    for (const k of Object.keys(o)) {
      if (!['id', 'action', 'reason', 'approved_by', ...KEYS[o.action]].includes(k)) errs.push(`${at}.${k}: not allowed with action ${o.action}`);
    }
    if (typeof o.reason !== 'string' || !o.reason.trim()) errs.push(`${at}.reason: required (say why)`);
    if (o.approved_by !== undefined && (typeof o.approved_by !== 'string' || !o.approved_by.trim())) errs.push(`${at}.approved_by: must be a non-empty string (who approved it)`);
    const v = byId.get(o.id);
    if (!v) { errs.push(`${at}.id: "${o.id}" is not a candidate`); return; }
    if (seen.has(o.id)) errs.push(`${at}.id: "${o.id}" has more than one override`);
    seen.add(o.id);
    if (o.action === 'merge') {
      if (!byId.has(o.into) || o.into === o.id) errs.push(`${at}.into: must be another candidate id`);
      else if (gone.has(o.into)) errs.push(`${at}.into: "${o.into}" is itself removed or merged`);
    }
    if (o.action === 're-scope') {
      if (o.title === undefined && o.severity === undefined) errs.push(`${at}: re-scope needs a title or a severity`);
      if (!SURVIVING.includes(v.verdict)) errs.push(`${at}: re-scope applies only to a finding that survived (this one is ${v.verdict})`);
      if (o.title !== undefined && (typeof o.title !== 'string' || !o.title.trim())) errs.push(`${at}.title: must be a non-empty string`);
      if (o.severity !== undefined) {
        const r = levels.indexOf(o.severity);
        if (r < 0) errs.push(`${at}.severity: must be one of ${levels.slice().reverse().join(', ')}`);
        else if (r > levels.indexOf(v.severity)) errs.push(`${at}.severity: "${o.severity}" is above the synthesized "${v.severity}"; re-scope may only keep or lower it`);
      }
    }
  });
  return errs;
}

function median(list) {
  const s = list.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

function gateOf(results) {
  if (results.includes('FAIL')) return 'FAIL';
  return results.includes('PASS') ? 'PASS' : 'UNKNOWN';
}

function both(a, b) {
  if (a === 'FAIL' || b === 'FAIL') return 'FAIL';
  return a === 'PASS' && b === 'PASS' ? 'PASS' : 'UNKNOWN';
}

function synthesize(config, candidates, outputs, receipts) {
  const lenses = config.verify.skeptic_lenses;
  const need = config.verify.survive_votes;
  const majority = Math.floor(lenses.length / 2) + 1;
  const levels = ['none'].concat(Object.keys(config.severity_rubric).reverse()); // index = rank
  const votes = {};
  const checks = {};
  const missing = [];
  const unknown = new Set();
  const ids = new Set(candidates.map((c) => c.id));
  for (const out of outputs) {
    missing.push(...(out.missing || []));
    for (const r of out.results) {
      const list = r.kind === 'vote' ? r.votes : r.checks;
      for (const v of list) {
        if (!ids.has(v.id)) { unknown.add(v.id); continue; }
        if (r.kind === 'vote') (votes[v.id] = votes[v.id] || {})[r.lens] = v;
        else checks[v.id] = v;
      }
    }
  }
  const receiptById = new Map(receipts.candidates.map((x) => [x.id, x]));

  const verdicts = candidates.map((c) => {
    const v = votes[c.id] || {};
    const cast = lenses.map((l) => v[l]).filter(Boolean);
    const count = (k) => cast.filter((x) => x.vote === k).length;
    const survive = count('REAL') + count('PARTIAL');
    const chk = checks[c.id];
    const ver = chk ? chk.verdict : 'MISSING';
    const gate = (n) => gateOf(cast.flatMap((x) => x.gates.filter((g) => g.gate === n).map((g) => g.result)));
    const gates = {
      g1_reachable: gate(1),
      g2_trigger: gate(2),
      g3_mechanism: gate(3),
      g4_bounds: gate(4),
      g5_no_mitigation: gate(5),
      g6_reproduces: ver === 'CONFIRMED' ? 'PASS' : ver === 'REFUTED' ? 'FAIL' : 'UNKNOWN',
    };
    const ranks = cast.map((x) => levels.indexOf(x.severity)).filter((r) => r >= 0);
    const real = ranks.filter((r) => r > 0);
    const severity = survive >= need ? levels[median(real.length >= 2 ? real : ranks)] : 'none';
    const fp_check = {
      process: cast.length === lenses.length && chk ? 'PASS' : 'FAIL',
      reachability: both(gates.g1_reachable, gates.g2_trigger),
      real_impact: survive >= need && severity !== 'none' ? 'PASS' : 'FAIL',
      poc_validation: gates.g3_mechanism === 'FAIL' || gates.g6_reproduces === 'FAIL' ? 'FAIL'
        : gates.g3_mechanism === 'PASS' && gates.g6_reproduces === 'PASS' ? 'PASS' : 'UNKNOWN',
      math_bounds: gates.g4_bounds,
      environment: gates.g5_no_mitigation,
    };

    let verdict;
    let why;
    if (cast.length < lenses.length || !chk) {
      verdict = 'NEEDS-REVIEW';
      why = `incomplete: ${cast.length}/${lenses.length} votes, verifier ${chk ? 'present' : 'missing'}`;
    } else if (count('OUT_OF_SCOPE') >= majority) {
      verdict = 'OUT-OF-SCOPE';
      why = 'most skeptics voted it out of scope';
    } else if (count('REFUTED') >= majority) {
      verdict = 'REFUTED';
      why = 'most skeptics refuted it';
    } else if (c.status === 'not_found') {
      verdict = 'REFUTED';
      why = 'the cited code does not exist at the pinned commit';
    } else if (survive >= need && ver === 'CONFIRMED') {
      verdict = 'PROVEN-STATIC';
      why = count('PARTIAL') >= majority ? 'survived the skeptics with corrections; evidence reproduced' : 'survived the skeptics; evidence reproduced';
    } else if (survive >= need && ver === 'UNVERIFIABLE') {
      verdict = 'UNPROVEN';
      why = 'the skeptics accept the mechanism, but only a live system can settle the evidence';
    } else {
      verdict = 'NEEDS-REVIEW';
      why = `split: votes ${cast.map((x) => x.vote).join('/')}, verifier ${ver}`;
    }

    return {
      id: c.id,
      title: c.title,
      repo: c.repo,
      group: c.group,
      lens: c.lens,
      source: c.source,
      ...(c.status ? { status: c.status } : {}),
      verdict,
      why,
      severity,
      corrected: survive >= need && count('PARTIAL') >= 1,
      votes: Object.fromEntries(lenses.map((l) => [l, v[l] ? {
        vote: v[l].vote,
        severity: v[l].severity,
        duplicate_of: v[l].duplicate_of || '',
        corrected_threshold: v[l].corrected_threshold || '',
        reason: v[l].reason,
        gates: v[l].gates,
        key_citations: v[l].key_citations || [],
      } : null])),
      verifier: chk ? { verdict: chk.verdict, receipt: chk.receipt, rerun: chk.rerun, citation_drift: chk.citation_drift || '', notes: chk.notes } : null,
      receipt: receiptById.has(c.id) ? receiptById.get(c.id).receipt : null,
      gates,
      fp_check,
    };
  });
  return { verdicts, missing, unknown: [...unknown].sort() };
}

// Applies overrides already checked by overrideProblems.
function applyOverrides(verdicts, overrides) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  for (const o of overrides) {
    const v = byId.get(o.id);
    v.override = { action: o.action, reason: o.reason.trim() };
    if (o.approved_by !== undefined) v.override.approved_by = o.approved_by.trim();
    if (o.action === 'remove' || o.action === 'merge' || o.action === 'hold') {
      v.synthesized_verdict = v.verdict;
      v.verdict = { remove: 'REMOVED', merge: 'MERGED', hold: 'HELD' }[o.action];
    }
    if (o.action === 'merge') {
      v.merged_into = o.into;
      const target = byId.get(o.into);
      target.merged_from = (target.merged_from || []).concat(o.id).sort();
    }
    if (o.action === 're-scope') {
      if (o.title !== undefined) { v.original_title = v.title; v.title = String(o.title); }
      if (o.severity !== undefined) { v.original_severity = v.severity; v.severity = String(o.severity); }
    }
  }
}

function run(opts, io) {
  const { config, paths } = loadConfig(opts.workspace);
  const cfile = readJson(path.join(paths.work, 'candidates.json'), 'work/candidates.json');
  problems('work/candidates.json', validateCandidates(cfile, config));
  const candidates = Array.isArray(cfile) ? cfile : cfile.candidates;
  const receipts = readJson(path.join(paths.work, 'phase3', 'receipts', '_index.json'),
    'work/phase3/receipts/_index.json (run `kit evidence` first)');
  problems('work/phase3/receipts/_index.json', validateReceiptIndex(receipts));

  const outputs = votesFiles(paths, opts.files).map((f) => {
    const raw = readJson(f, path.basename(f));
    const out = raw && raw.result && !raw.results ? raw.result : raw;
    problems(path.basename(f), validateRunOutput(out, config));
    return out;
  });
  const overrides = readOverrides(paths);
  const res = synthesize(config, candidates, outputs, receipts);
  problems('work/phase3/master-overrides.json', overrideProblems(res.verdicts, overrides, config));
  applyOverrides(res.verdicts, overrides);
  const doc = {
    date: config.audit.date,
    skeptic_lenses: config.verify.skeptic_lenses,
    survive_votes: config.verify.survive_votes,
    missing_agents: res.missing,
    unknown_ids: res.unknown,
    verdicts: res.verdicts,
  };
  const shapeErrs = validateVerdicts(doc);
  if (shapeErrs.length) throw new Error(`internal error: verdicts do not match shapes VERDICTS: ${shapeErrs.slice(0, 3).join('; ')}`);
  const outFile = path.join(paths.work, 'phase3', 'verdicts.json');
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');

  const tally = {};
  for (const v of res.verdicts) tally[v.verdict] = (tally[v.verdict] || 0) + 1;
  io.out(`verdicts: ${Object.keys(tally).sort().map((k) => `${k} ${tally[k]}`).join(', ')}`);
  io.out(`missing agents: ${res.missing.join(', ') || 'none'}`);
  if (res.unknown.length) io.out(`votes for unknown ids (ignored): ${res.unknown.join(', ')}`);
  io.out(`NEEDS-REVIEW: ${res.verdicts.filter((v) => v.verdict === 'NEEDS-REVIEW').map((v) => `${v.id} (${v.why})`).join('; ') || 'none'}`);
  const dups = res.verdicts.filter((v) => Object.values(v.votes).some((x) => x && x.duplicate_of))
    .map((v) => `${v.id}->${Object.values(v.votes).map((x) => x && x.duplicate_of).filter(Boolean)[0]}`);
  io.out(`duplicates flagged: ${dups.join(', ') || 'none'}`);
  io.out(`overrides applied: ${overrides.length}`);
  return 0;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const pos = [];
    for (const a of argv) {
      if (a === '--help' || a === '-h') {
        io.out('usage: node tooling/synthesize-verdicts.js [<workspace>] [<votes-file>...]');
        return 0;
      }
      if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      pos.push(a);
    }
    return run({ workspace: pos[0] || '.', files: pos.slice(1) }, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`synthesize: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, synthesize, overrideProblems, applyOverrides, ACTIONS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
