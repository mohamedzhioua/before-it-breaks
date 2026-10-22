'use strict';
// Tests for the audit-trail integrity checks: candidate shas in batch files,
// receipts and saved votes; conflicting or out-of-date votes files; stale
// final-verdicts.json; build report --strict with an undrafted input; and
// kit save refusing to overwrite another run's file.

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
const { makeFixtureWorkspace } = require('./fixtures/make-fixture-workspace');
const { writeFixtureVotes, fixtureVotes } = require('./fixtures/fixture-votes');
const { byVotesName } = require('../tooling/synthesize-verdicts');
const { canonicalJson, contentSha } = require('../tooling/lib/content-sha');
const { loadConfig } = require('../tooling/lib/config');

const LENSES = ['reach', 'mech', 'math'];

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

function ok(args) {
  const r = kit(args);
  assert.equal(r.code, 0, `kit ${args.join(' ')}\n${r.out}${r.err}`);
  return r;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// A pinned workspace on the fixture repo, with receipts and batches of four.
function setup(t, name) {
  const root = tmp(t, name);
  makeFixtureRepo(path.join(root, 'repos', 'notes-api'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'work', 'phase3'), { recursive: true });
  const cfg = readJson(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'));
  delete cfg.$schema;
  cfg.repos = cfg.repos.filter((r) => r.name === 'notes-api').map((r) => ({ ...r, path: '../repos/notes-api' }));
  cfg.groups = cfg.groups.filter((g) => g.repo === 'notes-api');
  cfg.modules = cfg.modules.filter((m) => m.repo === 'notes-api');
  cfg.verify = { skeptic_lenses: LENSES, survive_votes: 2, batch_size: 4 };
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  fs.copyFileSync(path.join(DATA, 'fixture-candidates.json'), path.join(ws, 'work', 'candidates.json'));
  ok(['pin', ws]);
  ok(['evidence', ws]);
  ok(['batches', ws]);
  return { ws, root, p3: path.join(ws, 'work', 'phase3') };
}

// A verify result for the given batches, as the verify workflow returns it:
// every lens votes REAL (or what vote() says), the verifier confirms, and
// bound_to carries the batch-plan id and candidate shas the args gave it.
function verifyResult(p3, batches, vote) {
  const index = readJson(path.join(p3, 'receipts', '_index.json'));
  const receipt = (id) => index.candidates.find((c) => c.id === id).receipt;
  const results = [];
  const shas = {};
  for (const b of batches) {
    const doc = readJson(path.join(p3, 'batches', `${b}.json`));
    Object.assign(shas, doc.shas);
    const ids = doc.candidates.map((c) => c.id);
    for (const lens of LENSES) {
      results.push({ kind: 'vote', batch: b, lens, votes: ids.map((id) => ({
        id, vote: (vote && vote(id, lens)) || 'REAL', gates: [{ gate: 1, result: 'PASS', reason: 'Read the code.' }], severity: 'high',
        corrected_threshold: '', duplicate_of: '', key_citations: [], reason: `${lens}: holds at the pin.`,
      })) });
    }
    results.push({ kind: 'verify', batch: b, checks: ids.map((id) => ({ id, receipt: receipt(id), verdict: 'CONFIRMED', rerun: '1 MATCH', citation_drift: '', notes: '' })) });
  }
  return { batches, missing: [], results, bound_to: { plan: readJson(path.join(p3, 'runs.json')).plan, shas } };
}

function save(ws, root, phase, name, value, extra) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return kit(['save', phase, file, ...(extra || []), ws]);
}

// Saves one verify result per run of runs.json, as votes-<run>.json.
function verifyAll(ws, root, p3, extra) {
  for (const r of readJson(path.join(p3, 'runs.json')).runs) {
    const s = save(ws, root, 'verify', `verify-${r.run}.json`, verifyResult(p3, r.batches), ['--run', String(r.run), ...(extra || [])]);
    assert.equal(s.code, 0, s.out + s.err);
  }
}

function verdicts(p3) {
  return Object.fromEntries(readJson(path.join(p3, 'verdicts.json')).verdicts.map((v) => [v.id, v]));
}

test('the content sha is the sha256 of sorted-key JSON of the whole object', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"c":null,"d":2}],"b":1}');
  assert.equal(contentSha({ b: 1, a: 2 }), contentSha({ a: 2, b: 1 }));
  assert.notEqual(contentSha({ a: 2 }), contentSha({ a: 3 }));
  assert.match(contentSha({}), /^[0-9a-f]{64}$/);
});

test('batch files, receipts and saved votes carry the candidate sha; unchanged re-runs stay byte-identical', (t) => {
  const { ws, root, p3 } = setup(t, 'bind');
  const cands = readJson(path.join(ws, 'work', 'candidates.json')).candidates;
  const shaOf = Object.fromEntries(cands.map((c) => [c.id, contentSha(c)]));
  const runs = readJson(path.join(p3, 'runs.json'));
  assert.match(runs.plan, /^[0-9a-f]{12}$/);
  const b1 = readJson(path.join(p3, 'batches', 'B1.json'));
  assert.equal(b1.plan, runs.plan);
  for (const c of b1.candidates) assert.equal(b1.shas[c.id], shaOf[c.id], 'sha of the whole candidate, severity_guess included');
  for (const e of readJson(path.join(p3, 'receipts', '_index.json')).candidates) assert.equal(e.sha, shaOf[e.id]);

  verifyAll(ws, root, p3);
  const saved = readJson(path.join(p3, 'votes-1.json'));
  assert.equal(saved.bound_to.plan, runs.plan);
  assert.equal(saved.bound_to.shas[b1.candidates[0].id], shaOf[b1.candidates[0].id]);
  const s1 = ok(['synthesize', ws]);
  assert.doesNotMatch(s1.out, /changed after|ignored in|not saved with/);
  assert.ok(Object.values(verdicts(p3)).every((v) => !/changed after/.test(v.why)));

  const snap = (f) => fs.readFileSync(path.join(p3, f));
  const before = ['verdicts.json', 'runs.json', 'batches/B1.json', 'receipts/_index.json', 'votes-1.json'].map((f) => [f, snap(f)]);
  ok(['batches', ws]);
  ok(['evidence', ws]);
  verifyAll(ws, root, p3);
  ok(['synthesize', ws]);
  for (const [f, bytes] of before) assert.ok(bytes.equals(snap(f)), `${f} is byte-identical after an unchanged re-run`);
});

test('kit args verify hands the batch-plan id and each batch\'s candidate shas to the workflow', (t) => {
  const { ws, p3 } = setup(t, 'args');
  const a = JSON.parse(ok(['args', 'verify', '--run', '1', ws]).out);
  assert.equal(a.plan, readJson(path.join(p3, 'runs.json')).plan);
  for (const b of a.batches) assert.deepEqual(b.shas, readJson(path.join(p3, 'batches', `${b.batch}.json`)).shas);
});

test('a candidate changed by a re-hunt after verify is NEEDS-REVIEW: changed after batching, then after receipt', (t) => {
  const { ws, root, p3 } = setup(t, 'rehunt');
  verifyAll(ws, root, p3);
  ok(['synthesize', ws]);
  const id = readJson(path.join(p3, 'batches', 'B1.json')).candidates[0].id;
  assert.notEqual(verdicts(p3)[id].verdict, 'NEEDS-REVIEW');
  const planBefore = readJson(path.join(p3, 'runs.json')).plan;

  const cand = readJson(path.join(ws, 'work', 'candidates.json')).candidates.find((c) => c.id === id);
  const h = save(ws, root, 'hunt', 'rehunt.json', { candidates: [{ ...cand, mechanism: `${cand.mechanism} Re-read in a second hunt.` }] }, ['--run', '2']);
  assert.equal(h.code, 0, h.out + h.err);
  let s = ok(['synthesize', ws]);
  assert.equal(verdicts(p3)[id].verdict, 'NEEDS-REVIEW');
  assert.match(verdicts(p3)[id].why, /^changed after batching/);
  assert.match(s.out, new RegExp(`NEEDS-REVIEW: .*${id} \\(changed after batching`));
  assert.match(s.out, new RegExp(`ignored in votes-1\\.json .*: ${id}$`, 'm'));
  const others = Object.values(verdicts(p3)).filter((v) => v.id !== id);
  assert.ok(others.every((v) => !/changed after/.test(v.why)), 'only the changed candidate');

  // Cut the batches again and verify again: the same run numbers now need --force.
  ok(['batches', ws]);
  assert.notEqual(readJson(path.join(p3, 'runs.json')).plan, planBefore);
  const refused = save(ws, root, 'verify', 'again.json', verifyResult(p3, readJson(path.join(p3, 'runs.json')).runs[0].batches), ['--run', '1']);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /votes-1\.json holds votes cast on batch plan [0-9a-f]{12}, and this result is from batch plan [0-9a-f]{12}: it looks like another run\. Give the right --run, or add --force/);
  verifyAll(ws, root, p3, ['--force']);
  s = ok(['synthesize', ws]);
  assert.doesNotMatch(s.out, /ignored in/);
  assert.equal(verdicts(p3)[id].verdict, 'NEEDS-REVIEW');
  assert.match(verdicts(p3)[id].why, /^changed after receipt/);

  ok(['evidence', ws]);
  ok(['synthesize', ws]);
  assert.doesNotMatch(verdicts(p3)[id].why, /changed after/);
});

test('a change and kit batches between the verify run and its save: saved with a note, the candidate is NEEDS-REVIEW', (t) => {
  const { ws, root, p3 } = setup(t, 'late');
  const runs = readJson(path.join(p3, 'runs.json')).runs;
  const results = runs.map((r) => verifyResult(p3, r.batches));
  const id = readJson(path.join(p3, 'batches', 'B1.json')).candidates[0].id;
  const file = path.join(ws, 'work', 'candidates.json');
  const doc = readJson(file);
  doc.candidates.find((c) => c.id === id).title = 'A title edited after the verify run';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  ok(['batches', ws]);
  results.forEach((res, i) => {
    const s = save(ws, root, 'verify', `late-${i}.json`, res, ['--run', String(runs[i].run)]);
    assert.equal(s.code, 0, s.out + s.err);
    assert.match(s.out, /note: the batches were cut again after this verify run/);
  });
  ok(['synthesize', ws]);
  assert.equal(verdicts(p3)[id].verdict, 'NEEDS-REVIEW');
  assert.match(verdicts(p3)[id].why, /^changed after batching/);
  assert.ok(Object.values(verdicts(p3)).filter((v) => v.id !== id).every((v) => !/changed after|not saved/.test(v.why)));
});

test('votes without bound_to (hand-written or from an older kit) are never trusted', (t) => {
  const { ws, root, p3 } = setup(t, 'unbound');
  const runs = readJson(path.join(p3, 'runs.json')).runs;
  for (const r of runs) {
    const { bound_to: _drop, ...plain } = verifyResult(p3, r.batches);
    const s = save(ws, root, 'verify', `plain-${r.run}.json`, plain, ['--run', String(r.run)]);
    assert.equal(s.code, 0, s.out + s.err);
    assert.match(s.out, /note: the result has no bound_to/);
  }
  // A file placed by hand, in the { result } wrapper, is no different.
  const { bound_to: _x, ...extra } = verifyResult(p3, runs[0].batches);
  fs.writeFileSync(path.join(p3, 'votes-hand.json'), JSON.stringify({ result: extra }));
  const s = ok(['synthesize', ws]);
  const voted = Object.values(verdicts(p3)).filter((v) => !v.status);
  assert.ok(voted.length > 0);
  for (const v of voted) {
    assert.equal(v.verdict, 'NEEDS-REVIEW', v.id);
    assert.equal(v.why, 'votes not saved with `kit save verify` (no bound_to); verify again');
  }
  assert.match(s.out, /ignored in votes-1\.json/);
  assert.match(s.out, /ignored in votes-hand\.json/);
});

test('leftover votes from an earlier plan neither count nor conflict with a fresh verify', (t) => {
  const { ws, root, p3 } = setup(t, 'leftover');
  verifyAll(ws, root, p3);
  ok(['synthesize', ws]);
  const before = readJson(path.join(p3, 'runs.json')).runs;
  // Change X, and drop another candidate so the batches shift.
  const file = path.join(ws, 'work', 'candidates.json');
  const doc = readJson(file);
  const last = before[before.length - 1].batches.slice(-1)[0];
  const xId = readJson(path.join(p3, 'batches', `${last}.json`)).candidates.slice(-1)[0].id;
  doc.candidates.find((c) => c.id === xId).claim += ' Checked again.';
  doc.candidates.find((c) => c.id !== xId && !c.status).status = 'fixed';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  ok(['batches', ws]);
  ok(['evidence', ws]);
  const runs = readJson(path.join(p3, 'runs.json')).runs;
  const holds = (b) => readJson(path.join(p3, 'batches', `${b}.json`)).candidates.some((c) => c.id === xId);
  const xRun = runs.find((r) => r.batches.some(holds));
  // The fresh votes differ from the old ones for X; saved under a new run name, the old files stay.
  const fresh = verifyResult(p3, xRun.batches, (id) => (id === xId ? 'PARTIAL' : 'REAL'));
  const s = save(ws, root, 'verify', 'fresh.json', fresh, ['--run', '9']);
  assert.equal(s.code, 0, s.out + s.err);
  const syn = kit(['synthesize', ws]);
  assert.equal(syn.code, 0, `no ConflictError: ${syn.out}${syn.err}`);
  const v = verdicts(p3)[xId];
  assert.equal(v.verdict, 'PROVEN-STATIC', v.why);
  assert.equal(v.votes.reach.vote, 'PARTIAL', 'the fresh votes counted');
  assert.match(syn.out, new RegExp(`ignored in votes-\\d+\\.json .*${xId}`));
});

test('a receipts index from before candidate shas gives a readable error', (t) => {
  const { ws, p3 } = setup(t, 'oldindex');
  writeFixtureVotes(ws);
  const f = path.join(p3, 'receipts', '_index.json');
  const idx = readJson(f);
  for (const e of idx.candidates) delete e.sha;
  fs.writeFileSync(f, JSON.stringify(idx));
  const r = kit(['synthesize', ws]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /receipts from before this version \(no candidate sha\): run `kit evidence` again/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

test('votes files are read in number order: votes-2 before votes-10, other names after', () => {
  const names = ['votes-10.json', 'votes-B1.json', 'votes-2.json', 'votes-a.json', 'votes-1.json', 'votes-02.json'];
  assert.deepEqual(names.slice().sort(byVotesName), ['votes-1.json', 'votes-02.json', 'votes-2.json', 'votes-10.json', 'votes-B1.json', 'votes-a.json']);
});

test('the same vote in two files must agree on substance; free text never conflicts', (t) => {
  const { ws, p3 } = setup(t, 'conflict');
  const votes = fixtureVotes(ws);
  fs.writeFileSync(path.join(p3, 'votes-2.json'), JSON.stringify(votes));
  ok(['synthesize', ws]);
  const one = fs.readFileSync(path.join(p3, 'verdicts.json'));
  fs.writeFileSync(path.join(p3, 'votes-10.json'), JSON.stringify(votes));
  ok(['synthesize', ws]);
  assert.ok(one.equals(fs.readFileSync(path.join(p3, 'verdicts.json'))), 'an identical copy changes nothing');

  // Only the reason, notes and rerun text differ: no conflict, the later file (votes-10) wins on text.
  const id = votes.results.find((r) => r.kind === 'vote' && r.lens === 'mech').votes[0].id;
  const wordy = JSON.parse(JSON.stringify(votes));
  wordy.results.find((r) => r.kind === 'vote' && r.lens === 'mech').votes[0].reason = 'Same vote, said in other words.';
  wordy.results.find((r) => r.kind === 'verify').checks[0].notes = 'Other notes.';
  fs.writeFileSync(path.join(p3, 'votes-10.json'), JSON.stringify(wordy));
  const noted = ok(['synthesize', ws]);
  assert.match(noted.out, new RegExp(`note: ${id}, lens mech: the text in votes-10\\.json replaces the text in votes-2\\.json \\(same substance\\)`));
  assert.match(noted.out, new RegExp(`note: ${id}, verifier: the text in votes-10\\.json replaces`));
  const v = verdicts(p3)[id];
  assert.equal(v.votes.mech.reason, 'Same vote, said in other words.');
  assert.equal(v.verifier.notes, 'Other notes.');

  // A different vote or verifier verdict conflicts.
  const other = JSON.parse(JSON.stringify(votes));
  other.results.find((r) => r.kind === 'vote' && r.lens === 'mech').votes[0].vote = 'REFUTED';
  other.results.find((r) => r.kind === 'verify').checks[0].verdict = 'REFUTED';
  fs.writeFileSync(path.join(p3, 'votes-10.json'), JSON.stringify(other));
  const before = fs.readFileSync(path.join(p3, 'verdicts.json'));
  let r = kit(['synthesize', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /the votes files disagree on 2 votes/);
  const mech = votes.results.find((x) => x.lens === 'mech').votes[0];
  assert.match(r.err, new RegExp(`${id}, lens mech: vote ${mech.vote} in votes-2\\.json, REFUTED in votes-10\\.json\n`));
  assert.match(r.err, /verifier: verdict CONFIRMED in votes-2\.json, REFUTED in votes-10\.json/);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
  assert.ok(before.equals(fs.readFileSync(path.join(p3, 'verdicts.json'))), 'nothing written');

  // A different severity alone conflicts too.
  const sev = JSON.parse(JSON.stringify(votes));
  const sv = sev.results.find((x) => x.kind === 'vote' && x.lens === 'mech').votes[0];
  sv.severity = sv.severity === 'low' ? 'medium' : 'low';
  fs.writeFileSync(path.join(p3, 'votes-10.json'), JSON.stringify(sev));
  r = kit(['synthesize', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, new RegExp(`disagree on 1 vote .*\\n {2}- ${id}, lens mech: severity ${mech.severity} in votes-2\\.json, ${sv.severity} in votes-10\\.json`));

  // So do a corrected threshold and a gate result.
  const corr = JSON.parse(JSON.stringify(votes));
  corr.results.find((x) => x.kind === 'vote' && x.lens === 'mech').votes[0].corrected_threshold = 'About 40k rows, not 100k.';
  fs.writeFileSync(path.join(p3, 'votes-10.json'), JSON.stringify(corr));
  r = kit(['synthesize', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, new RegExp(`${id}, lens mech: corrected_threshold \\(empty\\) in votes-2\\.json, About 40k rows, not 100k\\. in votes-10\\.json`));
  const gate = JSON.parse(JSON.stringify(votes));
  const gv = gate.results.find((x) => x.kind === 'vote' && x.lens === 'mech').votes[0];
  gv.gates[0].result = gv.gates[0].result === 'FAIL' ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(p3, 'votes-10.json'), JSON.stringify(gate));
  r = kit(['synthesize', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, new RegExp(`${id}, lens mech: gates \\S+ in votes-2\\.json, \\S+ in votes-10\\.json`));
});

test('an edit to a candidate or to the overrides after kit synthesize makes build log and the builders refuse', (t) => {
  const { ws, p3 } = setup(t, 'aftersynth');
  writeFixtureVotes(ws);
  ok(['synthesize', ws]);
  const vdoc = readJson(path.join(p3, 'verdicts.json'));
  assert.equal(vdoc.overrides_sha256, null);
  const cfile = path.join(ws, 'work', 'candidates.json');
  const cands = readJson(cfile);
  for (const v of vdoc.verdicts) assert.equal(v.sha, contentSha(cands.candidates.find((c) => c.id === v.id)));
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws]);
  const STALE = /candidates or overrides changed after `kit synthesize`; run it again/;
  const refuses = (what) => {
    for (const args of [['build', 'log', ws], ['build', 'report', ws]]) {
      const r = kit(args);
      assert.equal(r.code, 1, `${what}: ${args.join(' ')}\n${r.out}${r.err}`);
      assert.match(r.err, STALE, what);
    }
  };
  const saved = fs.readFileSync(cfile);

  // A candidate edited after synthesize.
  const edited = readJson(cfile);
  edited.candidates[0].title = 'Edited after synthesis';
  fs.writeFileSync(cfile, JSON.stringify(edited, null, 2));
  refuses('edited candidate');
  fs.writeFileSync(cfile, saved);
  ok(['build', 'report', ws]);

  // A candidate added after synthesize.
  const added = readJson(cfile);
  added.candidates.push({ ...added.candidates[0], id: `${added.candidates[0].group}-99`, title: 'Added after synthesis' });
  fs.writeFileSync(cfile, JSON.stringify(added, null, 2));
  refuses('added candidate');
  fs.writeFileSync(cfile, saved);

  // An overrides file written after synthesize.
  const ofile = path.join(p3, 'master-overrides.json');
  fs.copyFileSync(path.join(DATA, 'fixture-overrides.json'), ofile);
  refuses('new overrides');
  ok(['synthesize', ws]);
  assert.match(readJson(path.join(p3, 'verdicts.json')).overrides_sha256, /^[0-9a-f]{64}$/);
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws]);
  const o = readJson(ofile);
  o.overrides[0].reason += ' Edited later.';
  fs.writeFileSync(ofile, JSON.stringify(o, null, 2));
  refuses('edited overrides');
  fs.rmSync(ofile);
  refuses('removed overrides');
});

test('a re-pin or a changed receipts index after kit synthesize is stale; a reformatted candidates.json is not', (t) => {
  const { ws, root, p3 } = setup(t, 'repin');
  writeFixtureVotes(ws);
  ok(['synthesize', ws]);
  const vdoc = readJson(path.join(p3, 'verdicts.json'));
  assert.match(vdoc.pins_sha256, /^[0-9a-f]{64}$/);
  assert.match(vdoc.receipts_sha256, /^[0-9a-f]{64}$/);
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws]);
  const STALE = /pins or evidence receipts changed after `kit synthesize`; run `kit evidence` and `kit synthesize` again/;
  const refuses = (what) => {
    for (const args of [['build', 'log', ws], ['build', 'report', ws]]) {
      const r = kit(args);
      assert.equal(r.code, 1, `${what}: ${args.join(' ')}\n${r.out}${r.err}`);
      assert.match(r.err, STALE, what);
    }
  };

  // Reformatted candidates.json: other whitespace and key order, same canonical JSON.
  const cfile = path.join(ws, 'work', 'candidates.json');
  const doc = readJson(cfile);
  const reordered = { candidates: doc.candidates.map((c) => Object.fromEntries(Object.entries(c).reverse())) };
  fs.writeFileSync(cfile, JSON.stringify(reordered, null, 4) + '\n\n');
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws]);

  // A new commit in the repo and kit pin again.
  const repo = path.join(root, 'repos', 'notes-api');
  fs.writeFileSync(path.join(repo, 'NOTES.md'), 'A change after synthesis.\n');
  const git = (args) => {
    const r = require('child_process').spawnSync('git', ['-C', repo, '-c', 'user.name=Notes Dev', '-c', `user.email=dev${String.fromCharCode(64)}notes.invalid`, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['add', 'NOTES.md']);
  git(['commit', '-q', '-m', 'notes']);
  const pinsBefore = fs.readFileSync(path.join(ws, 'work', 'pins.json'));
  ok(['pin', ws]);
  assert.ok(!pinsBefore.equals(fs.readFileSync(path.join(ws, 'work', 'pins.json'))), 'the pin moved');
  refuses('re-pin');

  // kit evidence again on the new pin: still stale until synthesize runs again.
  const indexBefore = fs.readFileSync(path.join(p3, 'receipts', '_index.json'));
  ok(['evidence', ws]);
  assert.ok(!indexBefore.equals(fs.readFileSync(path.join(p3, 'receipts', '_index.json'))), 'the receipts changed');
  refuses('re-evidence');
  ok(['synthesize', ws]);
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws]);

  // A receipts index rewritten after synthesize (same pins).
  const ifile = path.join(p3, 'receipts', '_index.json');
  fs.writeFileSync(ifile, JSON.stringify(readJson(ifile)));
  refuses('receipts index');
});

test('a verifier check on another receipt, or with no receipt at all, is NEEDS-REVIEW', (t) => {
  const { ws, root, p3 } = setup(t, 'receipt');
  verifyAll(ws, root, p3);
  ok(['synthesize', ws]);
  const file = path.join(p3, 'votes-1.json');
  const doc = readJson(file);
  const checks = doc.results.find((r) => r.kind === 'verify').checks;
  const [a, b] = [checks[0].id, checks[1].id];
  assert.notEqual(verdicts(p3)[a].verdict, 'NEEDS-REVIEW');
  checks[0].receipt = 'ffffffffffff';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const ifile = path.join(p3, 'receipts', '_index.json');
  const idx = readJson(ifile);
  idx.candidates = idx.candidates.filter((e) => e.id !== b);
  fs.writeFileSync(ifile, JSON.stringify(idx, null, 2));
  ok(['synthesize', ws]);
  const v = verdicts(p3);
  assert.equal(v[a].verdict, 'NEEDS-REVIEW');
  assert.match(v[a].why, /^verifier checked a different receipt \(ffffffffffff, the receipt now is [0-9a-f]{12}\)/);
  assert.equal(v[b].verdict, 'NEEDS-REVIEW');
  assert.equal(v[b].why, 'no receipt for this candidate; run kit evidence');
});

test('kit args verify refuses batch files from before candidate shas', (t) => {
  const { ws, p3 } = setup(t, 'oldbatches');
  const bfile = path.join(p3, 'batches', 'B1.json');
  const b1 = readJson(bfile);
  const { shas: _s, ...noShas } = b1;
  fs.writeFileSync(bfile, JSON.stringify(noShas, null, 2));
  let r = kit(['args', 'verify', '--run', '1', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /batch files are from an older version: run `kit batches` again/);
  ok(['batches', ws]);
  const rfile = path.join(p3, 'runs.json');
  const runs = readJson(rfile);
  delete runs.plan;
  fs.writeFileSync(rfile, JSON.stringify(runs, null, 2));
  r = kit(['args', 'verify', '--run', '1', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /batch files are from an older version: run `kit batches` again/);
});

test('an override after kit build log makes every builder refuse until build log runs again', (t) => {
  const { ws, p3 } = setup(t, 'stale');
  writeFixtureVotes(ws);
  ok(['synthesize', ws]);
  ok(['build', 'log', ws]);
  const final = readJson(path.join(p3, 'final-verdicts.json'));
  assert.equal(final.verdicts_sha256, contentShaOfFile(path.join(p3, 'verdicts.json')));
  ok(['build', 'report', ws]);

  fs.copyFileSync(path.join(DATA, 'fixture-overrides.json'), path.join(p3, 'master-overrides.json'));
  ok(['synthesize', ws]);
  for (const b of ['report', 'measurements', 'recommendations', 'issues', 'explorer']) {
    const r = kit(['build', b, ws]);
    assert.equal(r.code, 1, `build ${b}: ${r.out}${r.err}`);
    assert.match(r.err, /verdicts\.json changed after `kit build log`; re-run it/, b);
  }
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws]);

  const f = path.join(p3, 'final-verdicts.json');
  const doc = readJson(f);
  delete doc.verdicts_sha256;
  fs.writeFileSync(f, JSON.stringify(doc));
  const old = kit(['build', 'report', ws]);
  assert.equal(old.code, 1);
  assert.match(old.err, /does not record which verdicts\.json it was built from/);

  ok(['build', 'log', ws]);
  fs.rmSync(path.join(p3, 'verdicts.json'));
  const gone = kit(['build', 'report', ws]);
  assert.equal(gone.code, 1, gone.out + gone.err);
  assert.match(gone.err, /verdicts\.json is missing, but final-verdicts\.json was built from it/);
});

function contentShaOfFile(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('build report --strict fails when a reported finding has no report input', (t) => {
  const ws = makeFixtureWorkspace(path.join(tmp(t, 'undrafted'), 'ws'));
  ok(['build', 'log', ws]);
  ok(['build', 'report', ws, '--strict']);
  const file = path.join(ws, 'work', 'phase5', 'report-inputs.json');
  const doc = readJson(file);
  const dropped = doc.items.shift().id;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const loose = ok(['build', 'report', ws]);
  assert.match(loose.out, new RegExp(`check: no report input drafted yet for ${dropped}`));
  const strict = kit(['build', 'report', ws, '--strict']);
  assert.equal(strict.code, 1, strict.out + strict.err);
  assert.match(strict.out, /--strict: 1 check warning, exit 1/);
});

test('kit save refuses to overwrite another run\'s file unless --force', (t) => {
  const { ws, root, p3 } = setup(t, 'runs');
  const runs = readJson(path.join(p3, 'runs.json')).runs;
  const batches = runs.flatMap((r) => r.batches);
  assert.ok(batches.length >= 2, 'the fixture needs two batches');

  // verify: votes-1 holds B1; a B2 result saved as run 1 is refused.
  ok(['save', 'verify', writeTo(root, 'v1.json', verifyResult(p3, ['B1'])), '--run', '1', ws]);
  const held = fs.readFileSync(path.join(p3, 'votes-1.json'));
  let r = save(ws, root, 'verify', 'v2.json', verifyResult(p3, ['B2']));
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /votes-1\.json holds the votes of batches B1, and this result is for batches B2: it looks like another run\. Give the right --run, or add --force/);
  assert.ok(held.equals(fs.readFileSync(path.join(p3, 'votes-1.json'))), 'unchanged');
  assert.equal(save(ws, root, 'verify', 'v1-again.json', verifyResult(p3, ['B1']), ['--run', '1']).code, 0, 'the same run may be saved again');
  r = save(ws, root, 'verify', 'v2.json', verifyResult(p3, ['B2']), ['--force']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /--force: .*replaced/);
  assert.deepEqual(readJson(path.join(p3, 'votes-1.json')).batches, ['B2']);

  // hunt: the run comes from summary.run when --run is left out.
  const cand = readJson(path.join(ws, 'work', 'candidates.json')).candidates[0];
  const hunt = (run) => ({ candidates: [cand], summary: { run, hunters: [], claims_not_resolved: [], notes: [] } });
  r = save(ws, root, 'hunt', 'h1.json', hunt(1));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /run 1, from the result \(summary\.run\)/);
  r = save(ws, root, 'hunt', 'h2.json', hunt(2));
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(fs.existsSync(path.join(ws, 'work', 'phase2', 'hunt-2.json')));
  assert.equal(readJson(path.join(ws, 'work', 'phase2', 'hunt-1.json')).summary.run, 1, 'run 1 kept');
  r = save(ws, root, 'hunt', 'h2.json', hunt(2), ['--run', '1']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /hunt-1\.json already holds another hunt summary \(hunt run 1\)/);
  assert.equal(save(ws, root, 'hunt', 'h2.json', hunt(2), ['--run', '1', '--force']).code, 0);
  // Neither side names a run: different content still needs --force.
  const bare = (note) => ({ candidates: [cand], summary: { hunters: [], claims_not_resolved: [], notes: [{ group: 'SVC-JOBS', notes: note }] } });
  assert.equal(save(ws, root, 'hunt', 'h5.json', bare('first'), ['--run', '5']).code, 0);
  assert.equal(save(ws, root, 'hunt', 'h5.json', bare('first'), ['--run', '5']).code, 0, 'the same content again is fine');
  r = save(ws, root, 'hunt', 'h5b.json', bare('second'), ['--run', '5']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /hunt-5\.json already holds another hunt summary\. Give the right --run, or add --force/);
  assert.equal(save(ws, root, 'hunt', 'h5b.json', bare('second'), ['--run', '5', '--force']).code, 0);

  // report-inputs: run 1 replaces the whole file, so it needs --force once the file exists.
  const item = (plain) => ({ items: [{ id: cand.id, plain, threshold: 'n/a: not size-driven', breaks_at: null, breaks_at_basis: 'not size-driven', fix_direction: 'Bound it.', effort: 'S', area: loadConfig(ws).config.areas[0] }] });
  assert.equal(save(ws, root, 'report-inputs', 'r1.json', item('first')).code, 0);
  assert.equal(save(ws, root, 'report-inputs', 'r1.json', item('first')).code, 0, 'the same content again is fine');
  r = save(ws, root, 'report-inputs', 'r2.json', item('second'));
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /report-inputs\.json exists, and run 1 would replace all of it/);
  assert.equal(readJson(path.join(ws, 'work', 'phase5', 'report-inputs.json')).items[0].plain, 'first');
  assert.equal(save(ws, root, 'report-inputs', 'r2.json', item('second'), ['--run', '2']).code, 0, 'a later run merges');
  assert.equal(save(ws, root, 'report-inputs', 'r3.json', item('third'), ['--force']).code, 0);
  assert.equal(readJson(path.join(ws, 'work', 'phase5', 'report-inputs.json')).items[0].plain, 'third');
});

function writeTo(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}
