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
 *     every <work>/phase3/votes-*.json, numbered names first in number
 *     order (votes-2 before votes-10), then the others in name order. A
 *     file may hold the output itself or wrap it as { "result": ... }.
 *     The output's bound_to (copied by the verify workflow from its args)
 *     gives the sha each candidate had when the skeptics saw it. A vote or
 *     check counts only when that sha is the candidate's current sha; the
 *     others are set aside and their files named on the console. A file
 *     without bound_to (hand-written, or saved before candidate shas
 *     existed) has all its votes set aside. Two counted votes from one
 *     lens on the same candidate must agree on "vote", "severity", each
 *     gate's "result", "corrected_threshold" and "duplicate_of" (two
 *     verifier checks on "verdict"); a difference stops the run with exit
 *     1. Free-text fields never conflict: the later file wins on them,
 *     with a note.
 *   <work>/phase3/master-overrides.json         (optional)
 * Output: <work>/phase3/verdicts.json, then tallies on the console. Each
 * verdict records "sha", the contentSha of the candidate it judged, and the
 * file records "overrides_sha256", "pins_sha256" and "receipts_sha256", the
 * sha256 of master-overrides.json, pins.json and receipts/_index.json (null
 * when a file is absent); `kit build log` and every builder refuse to run when
 * any of these no longer matches (tiers.checkSynthesis).
 *
 * Rules (deterministic; anything they cannot settle is NEEDS-REVIEW for the
 * lead). n = number of skeptic lenses (verify.skeptic_lenses), majority =
 * more than half of n, survive = REAL + PARTIAL votes, need =
 * verify.survive_votes:
 *   candidate status "fixed" (true before, fixed at the pin) -> REFUTED
 *   candidate status "not_found" (cited code gone)  -> REFUTED
 *       (these two are not batched for voting, so they need no votes)
 *   a lens (or the verifier) has only set-aside votes
 *       -> NEEDS-REVIEW: "changed after batching" when one was bound to an
 *          earlier sha, else "votes not saved with kit save verify"
 *   a verifier check but no receipt index entry    -> NEEDS-REVIEW (no receipt)
 *   its receipt index entry has another sha        -> NEEDS-REVIEW (changed after receipt)
 *   the verifier checked another receipt id        -> NEEDS-REVIEW (different receipt)
 *       (the sha is lib/content-sha.js of the whole candidate object)
 *   fewer than n votes, or no verifier check      -> NEEDS-REVIEW (incomplete)
 *   OUT_OF_SCOPE votes >= majority                 -> OUT-OF-SCOPE
 *   REFUTED votes >= majority                      -> REFUTED
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
 * Every override needs a non-empty reason, a non-empty "approved_by" (the
 * person who approved it, copied into verdicts.json) and an existing
 * candidate id;
 * one override per candidate, and no other keys than the action uses (so
 * no "verdict"). A merge target may not itself be removed or merged. Any
 * other action (including "add") or broken rule stops the run with exit 2
 * and nothing is written. Severity order is the key order of
 * severity_rubric (most severe first), then "none".
 *
 * Exit codes: 0 written, 1 two votes files disagree on the same vote, 2
 * usage, config or input error.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');
const { validateCandidates, validateRunOutput, validateReceiptIndex, validateVerdicts } = require('./lib/shapes');
const { canonicalJson, contentSha, fileSha } = require('./lib/content-sha');

class CliError extends Error {}
// Two votes files give different answers for the same vote: exit 1.
class ConflictError extends Error {}

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

// votes-<number>.json in number order first, then the other names in plain
// code-point order.
function byVotesName(a, b) {
  const num = (f) => { const m = /^votes-([0-9]+)\.json$/.exec(f); return m ? Number(m[1]) : null; };
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null && x !== y) return x - y;
  if (x !== null && y === null) return -1;
  if (x === null && y !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function votesFiles(paths, given) {
  if (given.length) return given.map((f) => path.resolve(f));
  const dir = path.join(paths.work, 'phase3');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^votes-.*\.json$/.test(f)).sort(byVotesName) : [];
  if (!names.length) throw new CliError('no votes files: save each verify run as work/phase3/votes-<name>.json');
  return names.map((f) => path.join(dir, f));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
    if (typeof o.approved_by !== 'string' || !o.approved_by.trim()) errs.push(`${at}.approved_by: required (the name of the person who approved this override)`);
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

// The fields of a vote (lens set) or a verifier check (lens null) that count
// for a conflict between votes files.
function substance(v, lens) {
  if (!lens) return { verdict: v.verdict };
  return {
    vote: v.vote,
    severity: v.severity,
    gates: v.gates.map((g) => ({ gate: g.gate, result: g.result })).sort((a, b) => a.gate - b.gate),
    corrected_threshold: v.corrected_threshold || '',
    duplicate_of: v.duplicate_of || '',
  };
}

// One field of substance, for a message.
function shown(value) {
  if (Array.isArray(value)) return value.map((g) => `${g.gate}:${g.result}`).join(',') || 'none';
  return value === '' ? '(empty)' : String(value);
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

// names (optional, one per output): the file each output came from, for
// messages. A vote or check counts only when the output's bound_to binds it
// to the candidate's current sha; the others are set aside (see run()).
function synthesize(config, candidates, outputs, receipts, names) {
  const lenses = config.verify.skeptic_lenses;
  const need = config.verify.survive_votes;
  const majority = Math.floor(lenses.length / 2) + 1;
  const levels = ['none'].concat(Object.keys(config.severity_rubric).reverse()); // index = rank
  const votes = {};
  const checks = {};
  const missing = [];
  const unknown = new Set();
  const ids = new Set(candidates.map((c) => c.id));
  const current = new Map(candidates.map((c) => [c.id, contentSha(c)]));
  const first = new Map(); // "id lens" -> { value, file } of a vote on the current candidate
  const setAside = new Map(); // "id lens" -> ['unbound' | 'changed', ...]
  const ignored = new Map(); // file -> Set of ids whose votes there were set aside
  const conflicts = [];
  const textNotes = [];
  outputs.forEach((out, i) => {
    const file = (names && names[i]) || `output ${i + 1}`;
    const shas = isPlainObject(out.bound_to) && isPlainObject(out.bound_to.shas) ? out.bound_to.shas : null;
    missing.push(...(out.missing || []));
    for (const r of out.results) {
      const list = r.kind === 'vote' ? r.votes : r.checks;
      const lens = r.kind === 'vote' ? r.lens : null;
      for (const v of list) {
        if (!ids.has(v.id)) { unknown.add(v.id); continue; }
        const key = `${v.id} ${lens || '(verifier)'}`;
        if (!shas || shas[v.id] !== current.get(v.id)) {
          if (!setAside.has(key)) setAside.set(key, []);
          setAside.get(key).push(shas ? 'changed' : 'unbound');
          if (!ignored.has(file)) ignored.set(file, new Set());
          ignored.get(file).add(v.id);
          continue;
        }
        // Two counted answers for the same id and lens conflict only on
        // substance (see substance()): for a vote, "vote", "severity", each
        // gate's "result", "corrected_threshold" and "duplicate_of"; for a
        // verifier check, "verdict". Free text (reason, notes, rerun,
        // key_citations, the gates' reasons) never conflicts: the later file
        // (votes files are read in number order) wins on it, with a note.
        const prev = first.get(key);
        if (prev) {
          const was = substance(prev.value, lens);
          const now = substance(v, lens);
          const fields = Object.keys(was).filter((k) => canonicalJson(was[k]) !== canonicalJson(now[k]));
          if (fields.length) {
            const what = fields.map((k) => `${k} ${shown(was[k])} in ${prev.file}, ${shown(now[k])} in ${file}`).join('; ');
            conflicts.push(`${v.id}, ${lens ? `lens ${lens}` : 'verifier'}: ${what}`);
            continue;
          }
          if (canonicalJson(prev.value) !== canonicalJson(v)) {
            textNotes.push(`${v.id}, ${lens ? `lens ${lens}` : 'verifier'}: the text in ${file} replaces the text in ${prev.file} (same substance)`);
          }
        }
        first.set(key, { value: v, file });
        if (lens) (votes[v.id] = votes[v.id] || {})[lens] = v;
        else checks[v.id] = v;
      }
    }
  });
  if (conflicts.length) {
    throw new ConflictError(`the votes files disagree on ${conflicts.length} vote${conflicts.length === 1 ? '' : 's'} cast on the same version of a candidate; keep the file of the run you trust and remove or re-save the other:\n${conflicts.map((m) => `  - ${m}`).join('\n')}`);
  }
  // Why a candidate is set aside: some lens (or the verifier) has only votes
  // that were not cast on its current version.
  const setAsideWhy = (id) => {
    const kinds = lenses.map((l) => `${id} ${l}`).concat(`${id} (verifier)`)
      .filter((k) => !first.has(k) && setAside.has(k)).flatMap((k) => setAside.get(k));
    if (!kinds.length) return null;
    return kinds.includes('changed')
      ? 'changed after batching: the candidate is not the one the skeptics and the verifier saw; run kit batches and verify it again'
      : 'votes not saved with `kit save verify` (no bound_to); verify again';
  };
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

    const sha = contentSha(c);
    const rec = receiptById.get(c.id);
    let verdict;
    let why;
    if (c.status === 'fixed') {
      verdict = 'REFUTED';
      why = 'fixed at pin';
    } else if (c.status === 'not_found') {
      verdict = 'REFUTED';
      why = 'the cited code does not exist at the pinned commit';
    } else if (setAsideWhy(c.id)) {
      verdict = 'NEEDS-REVIEW';
      why = setAsideWhy(c.id);
    } else if (chk && !rec) {
      verdict = 'NEEDS-REVIEW';
      why = 'no receipt for this candidate; run kit evidence';
    } else if (rec && rec.sha !== sha) {
      verdict = 'NEEDS-REVIEW';
      why = 'changed after receipt: the evidence receipt is from an earlier version of the candidate; run kit evidence again';
    } else if (chk && rec && chk.receipt !== rec.receipt) {
      verdict = 'NEEDS-REVIEW';
      why = `verifier checked a different receipt (${chk.receipt || 'none'}, the receipt now is ${rec.receipt}); verify it again`;
    } else if (cast.length < lenses.length || !chk) {
      verdict = 'NEEDS-REVIEW';
      why = `incomplete: ${cast.length}/${lenses.length} votes, verifier ${chk ? 'present' : 'missing'}`;
    } else if (count('OUT_OF_SCOPE') >= majority) {
      verdict = 'OUT-OF-SCOPE';
      why = 'most skeptics voted it out of scope';
    } else if (count('REFUTED') >= majority) {
      verdict = 'REFUTED';
      why = 'most skeptics refuted it';
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
      sha,
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
  return { verdicts, missing, unknown: [...unknown].sort(), ignored: [...ignored].map(([file, set]) => ({ file, ids: [...set].sort() })), textNotes };
}

// Applies overrides already checked by overrideProblems.
function applyOverrides(verdicts, overrides) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  for (const o of overrides) {
    const v = byId.get(o.id);
    v.override = { action: o.action, reason: o.reason.trim(), approved_by: o.approved_by.trim() };
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
  const receiptsSha = fileSha(path.join(paths.work, 'phase3', 'receipts', '_index.json'));
  const pinsSha = fileSha(path.join(paths.work, 'pins.json'));
  const receipts = readJson(path.join(paths.work, 'phase3', 'receipts', '_index.json'),
    'work/phase3/receipts/_index.json (run `kit evidence` first)');
  problems('work/phase3/receipts/_index.json', validateReceiptIndex(receipts));

  const names = [];
  const outputs = votesFiles(paths, opts.files).map((f) => {
    const name = path.basename(f);
    const raw = readJson(f, name);
    const out = raw && raw.result && !raw.results ? raw.result : raw;
    problems(name, validateRunOutput(out, config));
    names.push(name);
    return out;
  });
  const overrides = readOverrides(paths);
  const overridesSha = fileSha(path.join(paths.work, 'phase3', 'master-overrides.json'));
  const res = synthesize(config, candidates, outputs, receipts, names);
  problems('work/phase3/master-overrides.json', overrideProblems(res.verdicts, overrides, config));
  applyOverrides(res.verdicts, overrides);
  const doc = {
    date: config.audit.date,
    skeptic_lenses: config.verify.skeptic_lenses,
    survive_votes: config.verify.survive_votes,
    missing_agents: res.missing,
    unknown_ids: res.unknown,
    overrides_sha256: overridesSha,
    pins_sha256: pinsSha,
    receipts_sha256: receiptsSha,
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
  for (const n of res.textNotes) io.out(`note: ${n}`);
  for (const x of res.ignored) io.out(`ignored in ${x.file} (not cast on the current version of the candidate, or not saved with kit save verify): ${x.ids.join(', ')}`);
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
    if (e instanceof ConflictError) {
      io.err(`synthesize: ${e.message}`);
      io.err('nothing was written');
      return 1;
    }
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`synthesize: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, synthesize, overrideProblems, applyOverrides, byVotesName, ConflictError, ACTIONS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
