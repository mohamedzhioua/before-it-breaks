'use strict';
// Tests for kit.js, the data shapes, split-batches, workflow-args and
// synthesize-verdicts, on the invented fixture repo and fixture data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');
const DATA = path.join(__dirname, 'fixtures', 'data');
const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');
const { COMMANDS, GROUPS } = require('../kit');
const shapes = require('../tooling/lib/shapes');
const { loadConfig } = require('../tooling/lib/config');
const { synthesize, overrideProblems } = require('../tooling/synthesize-verdicts');

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// A pinned workspace from the demo config, pointed at one fixture repo.
function setup(t, name, edit) {
  const root = tmp(t, name);
  const repo = makeFixtureRepo(path.join(root, 'repos', 'notes-api'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'work', 'phase3'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'), 'utf8'));
  delete cfg.$schema;
  cfg.repos = cfg.repos.filter((r) => r.name === 'notes-api').map((r) => ({ ...r, path: '../repos/notes-api' }));
  cfg.groups = cfg.groups.filter((g) => g.repo === 'notes-api');
  cfg.modules = cfg.modules.filter((m) => m.repo === 'notes-api');
  if (edit) edit(cfg);
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  fs.copyFileSync(path.join(DATA, 'fixture-candidates.json'), path.join(ws, 'work', 'candidates.json'));
  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 0, pin.out + pin.err);
  return { ws, repo };
}

function args(list) {
  const r = kit(['args', ...list]);
  assert.equal(r.code, 0, r.out + r.err);
  return JSON.parse(r.out);
}

// ---------- kit.js ----------

test('kit help lists every command; unknown commands exit 2', (t) => {
  const r = kit(['help']);
  assert.equal(r.code, 0);
  for (const c of Object.keys(COMMANDS)) assert.match(r.out, new RegExp(`^  ${c}\\b`, 'm'), c);
  for (const [g, subs] of Object.entries(GROUPS)) {
    assert.match(r.out, new RegExp(`^  ${g} <${Object.keys(subs).join('\\|')}>`, 'm'), g);
  }
  assert.match(r.out, /^ {2}help\b/m);
  assert.match(r.out, /check mermaid requires --modules <dir>/);
  const bad = kit(['frobnicate']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown command "frobnicate"/);
  assert.equal(kit([]).code, 2);
  assert.equal(kit(['build']).code, 2);
  assert.equal(kit(['check', 'nothing']).code, 2);
});

test('a command whose tool is not shipped says so and exits 2', (t) => {
  const missing = Object.entries(GROUPS).flatMap(([g, subs]) => Object.entries(subs).map(([s, f]) => [[g, s], f]))
    .concat(Object.entries(COMMANDS).map(([c, [f]]) => [[c], f]))
    .find(([, f]) => !fs.existsSync(f));
  if (!missing) { t.skip('every tool is present'); return; }
  const r = kit(missing[0]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not available in this version/);
});

// ---------- shapes ----------

test('fixture data matches the shapes', (t) => {
  const { config } = loadConfig(path.join(ROOT, 'examples', 'demo-config'));
  assert.deepEqual(shapes.validateCandidates(JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-candidates.json'), 'utf8')), config), []);
  assert.deepEqual(shapes.validateRunOutput(JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-votes-B1.json'), 'utf8')), config), []);
  const errs = shapes.validateCandidate({ id: 'SVC-JOBS-1', repo: 'nope', group: 'WEB-LISTS', lens: 'x', title: 't', claim: 'c',
    locations: [{ repo: 'notes-api', path: '/abs/file.ts', line: 0 }], mechanism: 'm', evidence: [], source: 'old' }, config);
  for (const re of [/\.id: does not match/, /locations\[0\]\.path/, /line: must be at least 1/, /evidence: needs at least 1/,
    /source: does not match/, /repo: unknown repo "nope"/, /lens: unknown lens/, /id: "SVC-JOBS-1" must start with its group key/]) {
    assert.ok(errs.some((m) => re.test(m)), `${re} in ${errs.join(' | ')}`);
  }
  assert.equal(shapes.citeLocation({ repo: 'notes-api', path: 'src/a.ts', line: 4 }, { 'notes-api': 'b'.repeat(40) }), `notes-api@${'b'.repeat(10)}:src/a.ts:4`);
});

test('a candidate fixed at the pin is refuted with "fixed at pin", even without votes', () => {
  const { candidates, receipts } = unitInputs();
  candidates.find((c) => c.id === 'SVC-JOBS-02').status = 'fixed';
  assert.deepEqual(shapes.validateCandidates({ candidates }, demoConfig()), []);
  const doc = synthesize(demoConfig(), candidates, [], receipts);
  const v = doc.verdicts.find((x) => x.id === 'SVC-JOBS-02');
  assert.equal(v.verdict, 'REFUTED');
  assert.equal(v.why, 'fixed at pin');
  assert.equal(v.status, 'fixed');
  const file = { date: '2027-03-08', skeptic_lenses: ['reach', 'mech', 'math'], survive_votes: 2, missing_agents: [], unknown_ids: [], verdicts: doc.verdicts };
  assert.deepEqual(shapes.validateVerdicts(file), [], 'status "fixed" is a valid verdict status');
});

test('kit batches leaves out fixed and not_found candidates and hides severity_guess from skeptics', (t) => {
  const { ws } = setup(t, 'nohint');
  const file = path.join(ws, 'work', 'candidates.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.candidates[0].status = 'fixed';
  doc.candidates[1].status = 'not_found';
  fs.writeFileSync(file, JSON.stringify(doc));
  const b = kit(['batches', ws]);
  assert.equal(b.code, 0, b.out + b.err);
  assert.match(b.out, new RegExp(`not batched .*${doc.candidates[0].id}, ${doc.candidates[1].id}`));
  const dir = path.join(ws, 'work', 'phase3', 'batches');
  const batched = fs.readdirSync(dir).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).candidates);
  assert.equal(batched.length, doc.candidates.length - 2);
  assert.ok(!batched.some((c) => c.id === doc.candidates[0].id || c.id === doc.candidates[1].id));
  assert.ok(batched.every((c) => !('severity_guess' in c)), 'no severity hint in batch files');
  assert.ok(batched.every((c) => typeof c.mechanism === 'string'), 'the rest of the candidate is kept');
});

// ---------- batches and args ----------

function manyCandidates(n) {
  const base = JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-candidates.json'), 'utf8')).candidates;
  const groups = ['SVC-JOBS', 'SVC-IMPORT', 'DATA-INDEX', 'OPS-RUNTIME'];
  const lens = { 'SVC-JOBS': 'reliability', 'SVC-IMPORT': 'performance', 'DATA-INDEX': 'data', 'OPS-RUNTIME': 'infra' };
  return Array.from({ length: n }, (_, i) => {
    const g = groups[i % 3 === 0 ? 0 : i % 7 === 0 ? 3 : i % 2 ? 1 : 2];
    return { ...base[0], group: g, lens: lens[g], id: `${g}-${String(i + 1).padStart(2, '0')}` };
  });
}

test('kit batches and kit args verify keep every run within the agent cap', (t) => {
  const { ws } = setup(t, 'batches', (cfg) => {
    cfg.verify = { skeptic_lenses: ['reach', 'mech', 'math'], survive_votes: 2, batch_size: 4 };
    cfg.concurrency = { max_agents_per_workflow: 12, max_concurrent: 6, verify_pool: 3 };
  });
  const cands = manyCandidates(37);
  fs.writeFileSync(path.join(ws, 'work', 'candidates.json'), JSON.stringify({ candidates: cands }));
  const b = kit(['batches', ws]);
  assert.equal(b.code, 0, b.out + b.err);
  const runs = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'runs.json'), 'utf8'));
  assert.equal(runs.agents_per_batch, 4);
  assert.ok(runs.runs.length >= 2, 'more than one run is needed');

  const seen = [];
  for (const r of runs.runs) {
    const a = args(['verify', '--run', String(r.run), ws]);
    assert.equal(a.runs_total, runs.runs.length);
    const agents = a.batches.length * (a.verify.skeptic_lenses.length + 1);
    assert.ok(agents <= a.concurrency.max_agents_per_workflow, `run ${r.run}: ${agents} agents`);
    for (const batch of a.batches) {
      assert.ok(path.isAbsolute(batch.file) && batch.file.endsWith(path.join('phase3', 'batches', `${batch.batch}.json`)));
      const inFile = JSON.parse(fs.readFileSync(batch.file, 'utf8')).candidates.map((c) => c.id);
      assert.deepEqual(batch.ids, inFile);
      assert.equal(batch.size, inFile.length);
      assert.ok(inFile.length <= 4, `${batch.batch} has ${inFile.length}`);
      assert.equal(batch.candidates, undefined, 'candidate texts are not inlined');
      seen.push(...inFile);
    }
  }
  assert.deepEqual(seen.slice().sort(), cands.map((c) => c.id).sort(), 'every candidate in exactly one batch');
  const past = kit(['args', 'verify', '--run', String(runs.runs.length + 1), ws]);
  assert.equal(past.code, 2);
  assert.match(past.err, /this phase has \d+ runs?/);
});

const PATH_KEY = /(^|_)(path|dir|file|root|workspace|checklists)$/;

function relativePaths(v, at, out) {
  if (Array.isArray(v)) v.forEach((x, i) => relativePaths(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const where = `${at}.${k}`;
      const pathy = PATH_KEY.test(k) || ['outputs', 'lens_files', 'skeptic_briefs'].includes(k) || k === 'maps';
      if (pathy) {
        const values = typeof x === 'string' ? [x] : Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : [];
        for (const s of values) if (typeof s === 'string' && !path.isAbsolute(s)) out.push(`${where}: ${s}`);
      }
      relativePaths(x, where, out);
    }
  }
  return out;
}

test('kit args hunt prints valid JSON with absolute paths only, and respects the cap', (t) => {
  const { ws, repo } = setup(t, 'hunt');
  const a = args(['hunt', ws]);
  assert.equal(a.phase, 'hunt');
  assert.equal(a.date, '2027-03-08');
  assert.equal(a.dryRun, false);
  assert.deepEqual(relativePaths(a, 'args', []), []);
  assert.equal(a.repos[0].path, repo.path);
  assert.equal(a.repos[0].pin, repo.sha);
  assert.equal(a.repos[0].short, repo.sha.slice(0, 10));
  assert.ok(a.groups.length === 4 && a.groups.every((g) => g.maps.every((m) => path.isAbsolute(m))));
  assert.equal(a.models.hunter.model, undefined, 'inherit leaves the model out');
  assert.equal(a.models.hunter.effort, 'xhigh');
  assert.equal(a.models.verifier.model, 'sonnet');
  assert.equal(a.rule_writer, true);
  assert.equal(args(['hunt', '--date', '2027-04-01', ws]).date, '2027-04-01');

  const small = setup(t, 'hunt-small', (cfg) => { cfg.concurrency = { max_agents_per_workflow: 2, max_concurrent: 1, verify_pool: 1 }; });
  const first = args(['hunt', small.ws]);
  assert.equal(first.runs_total, 3);
  let groups = 0;
  for (let n = 1; n <= first.runs_total; n++) {
    const r = args(['hunt', '--run', String(n), small.ws]);
    assert.ok(r.groups.length + (r.rule_writer ? 1 : 0) <= 2, `run ${n}`);
    groups += r.groups.length;
  }
  assert.equal(groups, 4);

  const map = args(['map', ws]);
  assert.deepEqual(map.map_repos, ['notes-api']);
  assert.ok(path.isAbsolute(map.checklists));
  assert.equal(kit(['args', 'nope', ws]).code, 2);
});

test('kit args needs pins first', (t) => {
  const root = tmp(t, 'nopins');
  fs.copyFileSync(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'), path.join(root, 'audit.config.json'));
  const r = kit(['args', 'map', root]);
  assert.equal(r.code, 2);
  assert.match(r.err, /run `kit pin`/);
});

// ---------- synthesis ----------

function tally(ws) {
  const doc = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'verdicts.json'), 'utf8'));
  const t = {};
  for (const v of doc.verdicts) t[v.verdict] = (t[v.verdict] || 0) + 1;
  return { t, doc };
}

test('synthesize gives the expected verdicts, applies overrides and refuses "add"', (t) => {
  const { ws } = setup(t, 'synth');
  const ev = kit(['evidence', ws]);
  assert.equal(ev.code, 0, ev.out + ev.err);
  const p3 = path.join(ws, 'work', 'phase3');
  fs.copyFileSync(path.join(DATA, 'fixture-votes-B1.json'), path.join(p3, 'votes-B1.json'));

  const plain = kit(['synthesize', ws]);
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.match(plain.out, /^verdicts: NEEDS-REVIEW 2, OUT-OF-SCOPE 1, PROVEN-STATIC 4, REFUTED 1, UNPROVEN 1$/m);
  assert.deepEqual(tally(ws).t, { 'PROVEN-STATIC': 4, 'NEEDS-REVIEW': 2, UNPROVEN: 1, REFUTED: 1, 'OUT-OF-SCOPE': 1 });
  const bytes = fs.readFileSync(path.join(p3, 'verdicts.json'));
  assert.equal(kit(['synthesize', ws]).code, 0);
  assert.ok(bytes.equals(fs.readFileSync(path.join(p3, 'verdicts.json'))), 'deterministic');

  const { doc } = tally(ws);
  assert.deepEqual(shapes.validateVerdicts(doc), [], 'verdicts.json matches shapes VERDICTS');
  const byId = Object.fromEntries(doc.verdicts.map((v) => [v.id, v]));
  assert.equal(byId['SVC-JOBS-01'].severity, 'high');
  assert.equal(byId['SVC-JOBS-01'].corrected, true);
  assert.equal(byId['SVC-JOBS-01'].gates.g6_reproduces, 'PASS');
  assert.equal(byId['SVC-JOBS-01'].fp_check.process, 'PASS');
  assert.equal(byId['SVC-JOBS-01'].receipt, JSON.parse(fs.readFileSync(path.join(p3, 'receipts', '_index.json'), 'utf8')).candidates[0].receipt);
  assert.equal(byId['DATA-INDEX-03'].severity, 'high');
  assert.equal(byId['SVC-IMPORT-02'].severity, 'none');
  assert.equal(byId['SVC-IMPORT-02'].gates.g1_reachable, 'FAIL');
  assert.match(byId['OPS-RUNTIME-01'].why, /incomplete: 2\/3 votes/);
  assert.match(byId['DATA-INDEX-02'].why, /split/);
  assert.match(plain.out, /duplicates flagged: SVC-IMPORT-03->SVC-IMPORT-01/);

  fs.copyFileSync(path.join(DATA, 'fixture-overrides.json'), path.join(p3, 'master-overrides.json'));
  const over = kit(['synthesize', ws]);
  assert.equal(over.code, 0, over.out + over.err);
  const after = tally(ws);
  assert.deepEqual(after.t, {
    'PROVEN-STATIC': 2, UNPROVEN: 1, REFUTED: 1, 'OUT-OF-SCOPE': 1, 'NEEDS-REVIEW': 1, REMOVED: 1, HELD: 1, MERGED: 1,
  });
  const v2 = Object.fromEntries(after.doc.verdicts.map((v) => [v.id, v]));
  assert.equal(v2['SVC-JOBS-02'].override.approved_by, 'Notes platform tech lead', 'approved_by is copied');
  assert.deepEqual(shapes.validateVerdicts(after.doc), []);
  assert.equal(v2['SVC-IMPORT-03'].merged_into, 'SVC-IMPORT-01');
  assert.deepEqual(v2['SVC-IMPORT-01'].merged_from, ['SVC-IMPORT-03']);
  assert.equal(v2['SVC-JOBS-02'].synthesized_verdict, 'PROVEN-STATIC');
  assert.equal(v2['DATA-INDEX-03'].verdict, 'PROVEN-STATIC');
  assert.equal(v2['DATA-INDEX-03'].title, 'Workspace note list loads every note at once');

  fs.copyFileSync(path.join(DATA, 'fixture-overrides-add.json'), path.join(p3, 'master-overrides.json'));
  const add = kit(['synthesize', ws]);
  assert.equal(add.code, 2, add.out + add.err);
  assert.match(add.err, /"add" is not allowed; overrides may remove, merge, re-scope or hold a finding, never add one/);
  assert.doesNotMatch(add.err, /\n\s+at /);

  fs.writeFileSync(path.join(p3, 'master-overrides.json'), JSON.stringify({ overrides: [{ id: 'SVC-JOBS-01', action: 'hold', reason: ' ', approved_by: 'Notes platform tech lead' }] }));
  assert.match(kit(['synthesize', ws]).err, /reason: required/);

  const report = args(['report-inputs', ws]);
  assert.ok(report.report_batches.length >= 1);
  assert.ok(report.report_batches.every((b) => b.ids.every((id) => ['PROVEN-STATIC', 'PROVEN', 'UNPROVEN'].includes(v2[id].verdict))));
});

// ---------- synthesis rules, unit level ----------

function demoConfig() {
  return loadConfig(path.join(ROOT, 'examples', 'demo-config')).config;
}

function unitInputs() {
  const candidates = JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-candidates.json'), 'utf8')).candidates;
  const outputs = [JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-votes-B1.json'), 'utf8'))];
  const receipts = { date: '2027-03-08', pins: {}, totals: { ran: 0, failed: 0, skipped_live: 0, skipped_unsafe: 0 }, candidates: [] };
  return { candidates, outputs, receipts };
}

test('a candidate whose cited code is not found is refuted', () => {
  const { candidates, outputs, receipts } = unitInputs();
  const plain = synthesize(demoConfig(), candidates, outputs, receipts).verdicts.find((v) => v.id === 'SVC-JOBS-02');
  assert.equal(plain.verdict, 'PROVEN-STATIC');
  candidates.find((c) => c.id === 'SVC-JOBS-02').status = 'not_found';
  assert.deepEqual(shapes.validateCandidates({ candidates }, demoConfig()), []);
  const v = synthesize(demoConfig(), candidates, outputs, receipts).verdicts.find((x) => x.id === 'SVC-JOBS-02');
  assert.equal(v.verdict, 'REFUTED');
  assert.match(v.why, /does not exist at the pinned commit/);
  assert.equal(v.status, 'not_found');
});

test('overrides may only narrow: severity down, survivors only, no merge into a removed one, no extra keys', () => {
  const { candidates, outputs, receipts } = unitInputs();
  const config = demoConfig();
  const verdicts = synthesize(config, candidates, outputs, receipts).verdicts;
  const check = (list) => overrideProblems(verdicts, list, config).join('\n');
  const why = 'Checked by the lead.';
  const by = 'Notes platform tech lead';
  assert.equal(check([{ id: 'SVC-JOBS-01', action: 're-scope', severity: 'medium', reason: why, approved_by: by }]), '', 'lowering is fine');
  assert.equal(check([{ id: 'SVC-JOBS-01', action: 're-scope', severity: 'high', reason: why, approved_by: by }]), '', 'keeping is fine');
  assert.match(check([{ id: 'SVC-JOBS-01', action: 're-scope', severity: 'critical', reason: why, approved_by: by }]), /above the synthesized "high"/);
  assert.match(check([{ id: 'SVC-IMPORT-02', action: 're-scope', title: 'New title', reason: why, approved_by: by }]), /only to a finding that survived \(this one is REFUTED\)/);
  assert.match(check([{ id: 'SVC-JOBS-01', action: 're-scope', severity: 'urgent', reason: why, approved_by: by }]), /severity: must be one of/);
  assert.match(check([
    { id: 'OPS-RUNTIME-01', action: 'remove', reason: why, approved_by: by },
    { id: 'SVC-JOBS-02', action: 'merge', into: 'OPS-RUNTIME-01', reason: why, approved_by: by },
  ]), /"OPS-RUNTIME-01" is itself removed or merged/);
  assert.match(check([
    { id: 'SVC-IMPORT-03', action: 'merge', into: 'SVC-IMPORT-01', reason: why, approved_by: by },
    { id: 'SVC-JOBS-02', action: 'merge', into: 'SVC-IMPORT-03', reason: why, approved_by: by },
  ]), /"SVC-IMPORT-03" is itself removed or merged/);
  assert.match(check([{ id: 'SVC-IMPORT-02', action: 'hold', verdict: 'PROVEN-STATIC', reason: why, approved_by: by }]), /verdict: not allowed with action hold/);
  assert.match(check([{ id: 'SVC-JOBS-01', action: 'hold', reason: why, approved_by: by }, { id: 'SVC-JOBS-01', action: 'remove', reason: why, approved_by: by }]), /more than one override/);
  assert.equal(check([{ id: 'SVC-JOBS-01', action: 'hold', reason: why, approved_by: 'Lead' }]), '', 'approved_by is accepted on every action');
  assert.match(check([{ id: 'SVC-JOBS-01', action: 'hold', reason: why }]), /approved_by: required/, 'approved_by is required');
  assert.match(check([{ id: 'SVC-JOBS-01', action: 'hold', reason: why, approved_by: ' ' }]), /approved_by: required/, 'a blank approver is refused');
  assert.match(check([{ id: 'SVC-JOBS-01', action: 'hold', reason: why, approved_by: 7 }]), /approved_by: required/, 'a non-string approver is refused');
});

// ---------- config: rubric and effort scale replace the defaults ----------

test('a custom severity rubric or effort scale replaces the default one, in the order given', (t) => {
  const dir = tmp(t, 'rubric');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'), 'utf8'));
  delete cfg.$schema;
  cfg.repos.forEach((r) => { r.path = path.join(ROOT, 'examples', 'repos', r.name); });
  cfg.severity_rubric = { blocker: 'Stops the target outright.', major: 'Hurts badly at the target.', minor: 'Worth fixing.' };
  cfg.effort_scale = { quick: 'Hours.', big: 'Weeks.' };
  fs.writeFileSync(path.join(dir, 'audit.config.json'), JSON.stringify(cfg));
  const { config } = loadConfig(dir);
  assert.deepEqual(Object.keys(config.severity_rubric), ['blocker', 'major', 'minor']);
  assert.deepEqual(Object.keys(config.effort_scale), ['quick', 'big']);
  assert.deepEqual(Object.keys(demoConfig().severity_rubric), ['critical', 'high', 'medium', 'low'], 'defaults stay when none is given');

  const { candidates, outputs, receipts } = unitInputs();
  const map = { critical: 'blocker', high: 'major', medium: 'minor', low: 'minor', none: 'none' };
  for (const o of outputs[0].results) {
    if (o.kind === 'vote') o.votes.forEach((v) => { v.severity = map[v.severity]; });
  }
  const byId = Object.fromEntries(synthesize(config, candidates, outputs, receipts).verdicts.map((v) => [v.id, v]));
  assert.equal(byId['SVC-JOBS-01'].severity, 'major', 'median of major, major, minor');
  assert.equal(byId['DATA-INDEX-03'].severity, 'major', 'median of blocker, major, major');
  assert.equal(byId['SVC-JOBS-02'].severity, 'minor');
});

// ---------- args for report-inputs and recommend ----------

test('kit args recommend resolves modules from the surviving findings and splits them over runs within the cap; report-inputs passes target_design', (t) => {
  const { ws } = setup(t, 'recommend', (cfg) => {
    cfg.concurrency = { max_agents_per_workflow: 2, max_concurrent: 1, verify_pool: 1 };
    // Two rules, three resolved modules: svc.jobs, svc.imports, svc.notes.
    cfg.modules = [
      { repo: 'notes-api', pattern: '^src/(jobs)/', id: 'svc.$1', label: '$1', layer: 'Domain' },
      { repo: 'notes-api', pattern: '^src/modules/([^/]+)/', id: 'svc.$1', label: '$1', layer: 'Domain' },
    ];
  });
  assert.equal(kit(['args', 'recommend', ws]).code, 2, 'recommend needs verdicts.json');
  assert.equal(kit(['evidence', ws]).code, 0);
  fs.copyFileSync(path.join(DATA, 'fixture-votes-B1.json'), path.join(ws, 'work', 'phase3', 'votes-B1.json'));
  assert.equal(kit(['synthesize', ws]).code, 0);
  const verdicts = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'verdicts.json'), 'utf8')).verdicts;
  const survived = verdicts.filter((v) => ['PROVEN', 'PROVEN-STATIC', 'UNPROVEN'].includes(v.verdict)).map((v) => v.id);

  const first = args(['recommend', ws]);
  assert.ok(path.isAbsolute(first.report_inputs_file) && first.report_inputs_file.endsWith(path.join('phase5', 'report-inputs.json')));
  const all = [];
  for (let n = 1; n <= first.runs_total; n++) {
    const r = args(['recommend', '--run', String(n), ws]);
    assert.ok(r.modules.length + (r.cross_cutting ? 1 : 0) <= 2, `run ${n}`);
    assert.equal(r.cross_cutting, n === first.runs_total);
    assert.deepEqual(r.unmapped_finding_ids, first.unmapped_finding_ids);
    all.push(...r.modules);
  }
  assert.ok(all.length >= 2, `modules: ${JSON.stringify(all)}`);
  assert.equal(first.runs_total, Math.ceil((all.length + 1) / 2));
  for (const m of all) {
    assert.deepEqual(Object.keys(m).sort(), ['finding_ids', 'id', 'label', 'layer', 'repo']);
    assert.match(m.id, /^svc\.(jobs|imports|notes)$/);
    assert.ok(m.finding_ids.length >= 1);
  }
  assert.equal(new Set(all.map((m) => m.id)).size, all.length, 'one entry per resolved module');
  assert.deepEqual(all.flatMap((m) => m.finding_ids).concat(first.unmapped_finding_ids).sort(), survived.slice().sort(), 'every surviving finding exactly once');
  assert.equal(args(['report-inputs', ws]).target_design, null);
  fs.writeFileSync(path.join(ws, 'target-design.md'), '# Planned design\n');
  const withDesign = args(['report-inputs', '--target-design', 'target-design.md', ws]);
  assert.equal(withDesign.target_design, path.join(ws, 'target-design.md'));
  const missing = kit(['args', 'report-inputs', '--target-design', 'nope.md', ws]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /file not found/);
});
