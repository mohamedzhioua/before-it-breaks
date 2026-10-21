'use strict';
// Tests for the plugin files and their tools: check-plugin, install-agents,
// save-result and record-run. Every workspace is a temp folder holding the
// invented demo config; results are invented here or taken from the fixture
// data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'fixtures', 'data');
const T = (f) => path.join(ROOT, 'tooling', f);
const { parseFrontMatter } = require('../tooling/check-plugin');
const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');

function run(tool, args) {
  const res = spawnSync(process.execPath, [T(tool), ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bib-plugin-${name}-`));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A workspace with the demo config and an empty work folder (no pins:
// save-result reads them for maps only, and that test pins for real).
function workspace(name) {
  const ws = tmp(name);
  const cfg = readJson(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'));
  delete cfg.$schema;
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(ws, 'work'), { recursive: true });
  return { ws, cfg };
}

function resultFile(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

// ---------- check-plugin ----------

test('check-plugin passes on the kit', () => {
  const r = run('check-plugin.js', []);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /check-plugin: ok/);
});

function copyKit() {
  const dir = tmp('kit');
  for (const p of ['agents', 'skills', '.claude-plugin']) fs.cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'kit.js'), path.join(dir, 'kit.js'));
  return dir;
}

test('check-plugin passes on an exact copy and fails on a broken one', () => {
  const good = copyKit();
  assert.equal(run('check-plugin.js', [good]).code, 0);

  const dir = copyKit();
  const edit = (rel, fn) => {
    const f = path.join(dir, rel);
    fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));
  };
  edit('agents/audit-hunter.md', (s) => s.replace('tools: Read, Grep, Glob, Bash', 'tools: Read, Grep, WebFetch'));
  edit('agents/audit-verifier.md', (s) => s.replace('model: sonnet', 'model: gpt-x').replace('## Safety rules', '## Other rules'));
  edit('agents/audit-mapper.md', (s) => s.replace('name: audit-mapper', 'name: mapper'));
  edit('skills/audit-status/SKILL.md', (s) => s.replace('name: audit-status', 'name: status'));
  edit('skills/run-phase/SKILL.md', (s) => s + '\nRun `node "${CLAUDE_PLUGIN_ROOT}/kit.js" frobnicate <ws>` and `node "${CLAUDE_PLUGIN_ROOT}/kit.js" build poster <ws>`.\n');
  edit('.claude-plugin/plugin.json', (s) => JSON.stringify({ ...JSON.parse(s), name: 'Not Kebab', version: 'one' }));
  fs.rmSync(path.join(dir, 'agents', 'audit-architect.md'));

  const r = run('check-plugin.js', [dir]);
  assert.equal(r.code, 1, r.out + r.err);
  for (const re of [
    /audit-hunter\.md: tool "WebFetch" is not allowed/,
    /audit-verifier\.md: model "gpt-x"/,
    /audit-verifier\.md: the body has no "## Safety rules" section/,
    /audit-mapper\.md: name "mapper" must match the file name/,
    /audit-status\/SKILL\.md: name "status" must match the folder name/,
    /"kit\.js frobnicate" is not a kit\.js command/,
    /"kit\.js build poster" needs one of/,
    /plugin\.json: name must be kebab-case/,
    /plugin\.json: version must look like/,
    /agents\/audit-architect\.md: missing/,
    /marketplace\.json: no plugins entry names "Not Kebab"/,
  ]) assert.match(r.out, re);
  assert.doesNotMatch(r.out + r.err, /\n\s+at /, 'no stack trace');
});

test('check-plugin exits 2 on a folder that is not a kit', () => {
  assert.equal(run('check-plugin.js', [tmp('empty')]).code, 2);
});

test('parseFrontMatter reads quoted and plain values and the body', () => {
  const fm = parseFrontMatter('---\r\nname: x\r\ndescription: "a: b"\r\n---\r\nbody\r\n');
  assert.deepEqual(fm.data, { name: 'x', description: 'a: b' });
  assert.equal(fm.body, 'body\n');
  assert.equal(parseFrontMatter('no front matter'), null);
});

// ---------- install-agents ----------

test('install-agents copies the 7 agent files and warns about the namespace', () => {
  const { ws } = workspace('install');
  const r = run('install-agents.js', [ws]);
  assert.equal(r.code, 0, r.out + r.err);
  const files = fs.readdirSync(path.join(ws, '.claude', 'agents')).sort();
  assert.equal(files.length, 7);
  assert.deepEqual(files, fs.readdirSync(path.join(ROOT, 'agents')).sort());
  for (const f of files) {
    assert.equal(fs.readFileSync(path.join(ws, '.claude', 'agents', f), 'utf8'), fs.readFileSync(path.join(ROOT, 'agents', f), 'utf8'));
  }
  assert.match(r.out, /"namespace": ""/);
  assert.match(r.out, /warning: audit\.config\.json still uses the namespace/);
  assert.equal(run('install-agents.js', [path.join(ws, 'missing')]).code, 2);

  // Same files again: fine. A changed file: refused without --force.
  assert.equal(run('install-agents.js', [ws]).code, 0);
  const edited = path.join(ws, '.claude', 'agents', 'audit-hunter.md');
  fs.appendFileSync(edited, '\nlocal edit\n');
  const refused = run('install-agents.js', [ws]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /re-run with --force/);
  assert.match(fs.readFileSync(edited, 'utf8'), /local edit/);
  assert.equal(run('install-agents.js', [ws, '--force']).code, 0);
  assert.equal(fs.readFileSync(edited, 'utf8'), fs.readFileSync(path.join(ROOT, 'agents', 'audit-hunter.md'), 'utf8'));
});

// ---------- save-result ----------

// A workspace pinned by pin.js on the invented fixture repo (notes-api only).
function pinnedWorkspace(name) {
  const root = tmp(name);
  const repo = makeFixtureRepo(path.join(root, 'repos', 'notes-api'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const cfg = readJson(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'));
  delete cfg.$schema;
  cfg.repos = cfg.repos.filter((r) => r.name === 'notes-api').map((r) => ({ ...r, path: repo.path }));
  cfg.groups = cfg.groups.filter((g) => g.repo === 'notes-api');
  cfg.modules = cfg.modules.filter((m) => m.repo === 'notes-api');
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  const pin = run('pin.js', [ws]);
  assert.equal(pin.code, 0, pin.out + pin.err);
  return { ws, sha: repo.sha };
}

test('save map writes one file per repo with a provenance line', () => {
  const { ws, sha } = pinnedWorkspace('map');
  const f = resultFile(ws, 'map-1.json', { maps: [{ repo: 'notes-api', text: '# notes-api\n\nImports run in a worker.\n' }] });
  const r = run('save-result.js', ['map', f, ws]);
  assert.equal(r.code, 0, r.out + r.err);
  const text = fs.readFileSync(path.join(ws, 'work', 'phase1', 'notes-api-map.md'), 'utf8');
  assert.match(text, new RegExp(`^> Map of \`notes-api\` at \`notes-api@${sha.slice(0, 10)}\`, audit date \\d{4}-\\d{2}-\\d{2}, saved from \`map-1\\.json\``));
  assert.match(text, /# notes-api\n\nImports run in a worker\.\n$/);

  const bad = resultFile(ws, 'map-bad.json', { maps: [{ repo: 'billing', text: 'x' }, { repo: 'notes-api', text: '  ' }] });
  const b = run('save-result.js', ['map', bad, ws]);
  assert.equal(b.code, 1);
  assert.match(b.err, /maps\[0\]\.repo: unknown repo "billing"/);
  assert.match(b.err, /maps\[1\]\.text: must be non-empty/);
  assert.equal(fs.readFileSync(path.join(ws, 'work', 'phase1', 'notes-api-map.md'), 'utf8'), text, 'unchanged');
});

test('save hunt merges candidates by id and refuses an invalid result', () => {
  const { ws } = workspace('hunt');
  const fixture = readJson(path.join(DATA, 'fixture-candidates.json'));
  const first = fixture.candidates.slice(0, 3);
  let r = run('save-result.js', ['hunt', resultFile(ws, 'hunt-1.json', { candidates: first, notes: 'run 1' }), ws]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /3 added, 0 replaced, 3 in total/);

  const changed = { ...first[1], title: 'Changed title' };
  const fresh = { ...first[0], id: 'SVC-JOBS-77', title: 'A new candidate' };
  r = run('save-result.js', ['hunt', resultFile(ws, 'hunt-2.json', [changed, fresh]), '--run', '2', ws]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /1 added, 1 replaced, 4 in total/);
  const saved = readJson(path.join(ws, 'work', 'candidates.json')).candidates;
  assert.deepEqual(saved.map((c) => c.id), [first[0].id, first[1].id, first[2].id, 'SVC-JOBS-77']);
  assert.equal(saved[1].title, 'Changed title');

  const before = fs.readFileSync(path.join(ws, 'work', 'candidates.json'), 'utf8');
  const broken = { ...first[0], id: 'SVC-JOBS-78', locations: [] };
  const wrongGroup = { ...first[0], id: 'WEB-LISTS-01' };
  r = run('save-result.js', ['hunt', resultFile(ws, 'hunt-bad.json', { candidates: [broken, wrongGroup] }), ws]);
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing was saved/);
  assert.match(r.err, /locations/);
  assert.match(r.err, /must start with its group key/);
  assert.equal(fs.readFileSync(path.join(ws, 'work', 'candidates.json'), 'utf8'), before);
});

test('save verify writes votes-<run>.json and refuses a bad vote', () => {
  const { ws } = workspace('verify');
  const votes = readJson(path.join(DATA, 'fixture-votes-B1.json'));
  let r = run('save-result.js', ['verify', path.join(DATA, 'fixture-votes-B1.json'), '--run', '2', ws]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(readJson(path.join(ws, 'work', 'phase3', 'votes-2.json')), votes);

  const bad = JSON.parse(JSON.stringify(votes));
  const set = bad.results.find((x) => x.kind === 'vote');
  set.votes[0].vote = 'MAYBE';
  r = run('save-result.js', ['verify', resultFile(ws, 'v-bad.json', bad), ws]);
  assert.equal(r.code, 1);
  assert.match(r.err, /vote/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'phase3', 'votes-1.json')));
});

test('save report-inputs writes run 1 and merges later runs by id', () => {
  const { ws } = workspace('report');
  const out = path.join(ws, 'work', 'phase5', 'report-inputs.json');
  let r = run('save-result.js', ['report-inputs', resultFile(ws, 'r1.json', { items: [{ id: 'SVC-JOBS-01', one_liner: 'a' }], docs: { changed: 1 } }), ws]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /no shape for report-inputs/);
  r = run('save-result.js', ['report-inputs', resultFile(ws, 'r2.json', { items: [{ id: 'SVC-JOBS-01', one_liner: 'b' }, { id: 'DATA-INDEX-01', one_liner: 'c' }] }), '--run', '2', ws]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(readJson(out), {
    items: [{ id: 'SVC-JOBS-01', one_liner: 'b' }, { id: 'DATA-INDEX-01', one_liner: 'c' }],
    docs: { changed: 1 },
  });
  assert.equal(run('save-result.js', ['report-inputs', resultFile(ws, 'r3.json', [1, 2]), ws]).code, 1);
  assert.equal(run('save-result.js', ['report-inputs', resultFile(ws, 'r4.json', '{ not json'), ws]).code, 2);
});

test('save recommend writes module plans and cross-cutting, refuses bad names', () => {
  const { ws } = workspace('recommend');
  const cc = { sections: [{ title: 'Move imports to a queue', status: 'proposed' }], roadmap: { now: ['a'], next: [], later: [] } };
  let r = run('save-result.js', ['recommend', resultFile(ws, 'rec.json', { recs: [{ module: 'api.imports', changes: [] }], cross_cutting: cc }), ws]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(readJson(path.join(ws, 'work', 'phase6', 'recs', 'api.imports.json')), { module: 'api.imports', changes: [] });
  assert.deepEqual(readJson(path.join(ws, 'work', 'phase6', 'cross-cutting.json')), cc);

  r = run('save-result.js', ['recommend', resultFile(ws, 'rec-bad.json', { recs: { '../escape': {} }, cross_cutting: { roadmap: { now: [] } } }), ws]);
  assert.equal(r.code, 1);
  assert.match(r.err, /must be file-safe/);
  assert.match(r.err, /roadmap\.next: must be an array/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'phase6', 'escape.json')));
});

test('save-result usage and config errors exit 2', () => {
  const { ws } = workspace('usage');
  assert.equal(run('save-result.js', []).code, 2);
  assert.equal(run('save-result.js', ['poster', path.join(DATA, 'fixture-votes-B1.json'), ws]).code, 2);
  assert.equal(run('save-result.js', ['verify', path.join(ws, 'missing.json'), ws]).code, 2);
  const r = run('save-result.js', ['verify', path.join(DATA, 'fixture-votes-B1.json'), tmp('no-config')]);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
});

// ---------- record-run ----------

test('record-run appends entries to work/run-log.json', () => {
  const { ws } = workspace('log');
  let r = run('record-run.js', ['hunt', '--agents', '5', '--agent-type', 'before-it-breaks:audit-hunter', '--model', 'claude-opus-5-5', '--effort', 'high', '--run', '1', '--wall-clock', '42.5', '--tokens', '1234', '--note', 'one hunter retried', ws]);
  assert.equal(r.code, 0, r.out + r.err);
  r = run('record-run.js', ['synthesize', '--agents', '0', '--agent-type', 'script', '--model', 'unknown', '--effort', 'unknown', ws]);
  assert.equal(r.code, 0, r.out + r.err);
  const log = readJson(path.join(ws, 'work', 'run-log.json'));
  assert.equal(log.entries.length, 2);
  const [a, b] = log.entries;
  assert.deepEqual({ ...a, recorded_at: undefined }, {
    phase: 'hunt', run: '1', agents: 5, agent_type: 'before-it-breaks:audit-hunter', model: 'claude-opus-5-5', effort: 'high',
    wall_clock_s: 42.5, tokens: 1234, note: 'one hunter retried', recorded_at: undefined,
  });
  assert.match(a.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(b.wall_clock_s, null);
  assert.equal(b.tokens, null);
});

test('record-run refuses "inherit", bad numbers and missing fields', () => {
  const { ws } = workspace('log-bad');
  const base = ['map', '--agents', '2', '--agent-type', 'before-it-breaks:audit-mapper', '--effort', 'medium'];
  let r = run('record-run.js', [...base, '--model', 'inherit', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /actually ran on/);
  r = run('record-run.js', ['map', '--agents', 'two', '--agent-type', 'x', '--model', 'sonnet', '--effort', 'extreme', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--agents must be a whole number/);
  assert.match(r.err, /--effort must be one of/);
  r = run('record-run.js', ['map', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--model is required/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'run-log.json')));
});
