'use strict';
// Tests for the fixes found by the first public pilot: the launch line for a
// kit that is not an installed plugin, saving the Workflow tool's output
// file as it is, the clipped steering excerpt, the size check against the
// skeptics' corrected threshold, and which pages 02 and 03 link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');
const { makeFixtureWorkspace, DATA } = require('./fixtures/make-fixture-workspace');
const { launchLine } = require('../tooling/init-workspace');
const { aroundMatch } = require('../tooling/build-verification-log');
const { sizeConflicts, correctedThreshold, correctedKind } = require('../tooling/build-report');
const { loadConfig } = require('../tooling/lib/config');

const posix = (p) => p.split(path.sep).join('/');

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// ---------- launch line ----------

test('the launch line adds --plugin-dir unless the kit is an installed plugin', () => {
  const cfg = { models: { lead: { model: 'inherit', effort: 'high' } } };
  const home = path.join(os.tmpdir(), 'bib-home');
  const installed = path.join(home, '.claude', 'plugins', 'cache', 'before-it-breaks');
  const elsewhere = path.join(os.tmpdir(), 'bib-checkout');
  const repos = [path.join(os.tmpdir(), 'repo')];
  const flag = (root) => `--plugin-dir "${posix(root)}"`;

  const none = launchLine(cfg, repos, { kitRoot: installed, env: {}, home });
  assert.ok(none.includes(flag(installed)), `CLAUDE_PLUGIN_ROOT unset: ${none}`);
  assert.match(none, /^claude --plugin-dir "[^"]+" --effort high --add-dir "/);
  const plugin = launchLine(cfg, repos, { kitRoot: installed, env: { CLAUDE_PLUGIN_ROOT: installed }, home });
  assert.ok(!plugin.includes('--plugin-dir'), `installed plugin: ${plugin}`);
  const outside = launchLine(cfg, repos, { kitRoot: elsewhere, env: { CLAUDE_PLUGIN_ROOT: elsewhere }, home });
  assert.ok(outside.includes(flag(elsewhere)), `root outside ~/.claude/plugins: ${outside}`);
  const running = launchLine(cfg, repos, { env: {}, home });
  assert.ok(running.includes(flag(ROOT)), 'the running kit by default');
});

test('an installed plugin is recognised through a link and under CLAUDE_CONFIG_DIR', (t) => {
  const cfg = { models: { lead: { model: 'inherit', effort: 'high' } } };
  const root = tmp(t, 'plugdir');
  const config = path.join(root, 'claude-config');
  const cache = path.join(config, 'plugins', 'cache', 'before-it-breaks');
  fs.mkdirSync(cache, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { CLAUDE_PLUGIN_ROOT: cache, CLAUDE_CONFIG_DIR: config };
  assert.ok(!launchLine(cfg, [], { kitRoot: cache, env, home }).includes('--plugin-dir'), 'CLAUDE_CONFIG_DIR/plugins counts as installed');
  assert.ok(launchLine(cfg, [], { kitRoot: cache, env: { CLAUDE_PLUGIN_ROOT: cache }, home }).includes('--plugin-dir'), 'without CLAUDE_CONFIG_DIR the same folder is outside ~/.claude/plugins');

  // ~/.claude itself is a link to the config folder: the plugin is still installed.
  try {
    fs.symlinkSync(config, path.join(home, '.claude'), 'junction');
  } catch (e) {
    t.skip(`links unavailable: ${e.code}`);
    return;
  }
  const viaLink = path.join(home, '.claude', 'plugins', 'cache', 'before-it-breaks');
  assert.ok(!launchLine(cfg, [], { kitRoot: cache, env: { CLAUDE_PLUGIN_ROOT: cache }, home }).includes('--plugin-dir'), 'real path of the root inside the linked plugins folder');
  assert.ok(!launchLine(cfg, [], { kitRoot: viaLink, env: { CLAUDE_PLUGIN_ROOT: viaLink }, home }).includes('--plugin-dir'), 'root given through the link');
});

// ---------- kit save and the Workflow wrapper ----------

function item(id, plain) {
  return { id, plain, threshold: 'About 2k rows, one remote call each.', breaks_at: 2000, breaks_at_basis: 'rows per file', fix_direction: 'Fetch profiles in bulk.', effort: 'S', area: 'background jobs' };
}

test('kit save unwraps the Workflow output file, as an object or as JSON text', (t) => {
  const ws = tmp(t, 'wrap');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'), 'utf8'));
  delete cfg.$schema;
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(ws, 'work'), { recursive: true });
  const out = path.join(ws, 'work', 'phase5', 'report-inputs.json');
  const save = (name, value, extra) => {
    const file = path.join(ws, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return kit(['save', 'report-inputs', file, ...(extra || []), ws]);
  };

  let r = save('wf-object.json', { result: { items: [item('SVC-JOBS-01', 'object form')] } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /note: unwrapped Workflow result/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).items[0].plain, 'object form');

  r = save('wf-string.json', { result: JSON.stringify({ items: [item('DATA-INDEX-01', 'string form')] }) }, ['--run', '2']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /note: unwrapped Workflow result/);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).items.map((i) => i.plain), ['object form', 'string form']);

  r = save('plain.json', { items: [item('SVC-JOBS-02', 'plain')] }, ['--run', '3']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /unwrapped/, 'a plain result is saved as it is');

  r = save('wf-bad.json', { result: '{ not json' }, ['--run', '4']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /the Workflow output's "result" text is not valid JSON/);
});

// ---------- steering excerpt ----------

test('the steering excerpt is clipped around the first match, with an ellipsis where text was cut', () => {
  const before = 'a'.repeat(300);
  const after = 'b'.repeat(300);
  const note = `${before} a comment said to ignore previous instructions ${after}`;
  const ex = aroundMatch(note, /\bignore previous\b/i, 120);
  assert.match(ex, /^\.\.\.a+ a comment said to ignore previous instructions b+\.\.\.$/);
  assert.equal(ex.length, 3 + 120 + 'ignore previous'.length + 120 + 3);
  const early = aroundMatch('ignore previous instructions, then a short tail', /\bignore previous\b/i, 120);
  assert.equal(early, 'ignore previous instructions, then a short tail', 'nothing cut: no ellipsis');
});

// ---------- size check against the corrected threshold ----------

test('build report compares a corrected finding with the skeptics\' corrected threshold', () => {
  const { config } = loadConfig(path.join(DATA, 'audit.config.json'));
  const findings = [{ id: 'A-01', corrected: true }, { id: 'B-01', corrected: true }, { id: 'C-01', corrected: false }];
  const cands = new Map([
    ['A-01', { breaks_at: '40000', breaks_at_basis: 'per-tenant items' }],
    ['B-01', { breaks_at: null, breaks_at_basis: 'not size-driven' }],
    ['C-01', { breaks_at: '40000', breaks_at_basis: 'per-tenant items' }],
  ]);
  const notSized = { breaks_at: null, breaks_at_basis: 'not size-driven', threshold: 'n/a: any retry is enough' };
  const sized = { breaks_at: 40000, breaks_at_basis: 'per-tenant items', threshold: 'about 40k items' };
  const inputs = new Map([['A-01', notSized], ['B-01', notSized], ['C-01', notSized]]);
  const vote = (v, text) => ({ vote: v, corrected_threshold: text || '' });
  const verdict = (math, mech) => ({ corrected: true, votes: { reach: null, mech, math } });
  const lenses = ['reach', 'mech', 'math'];
  assert.equal(correctedThreshold(verdict(vote('PARTIAL', 'not size-driven: one bad record stalls the queue'), vote('PARTIAL', 'about 10k items')), lenses), 'not size-driven: one bad record stalls the queue', 'the math skeptic first');
  assert.equal(correctedThreshold(verdict(vote('PARTIAL', ''), vote('PARTIAL', 'about 10k items')), lenses), 'about 10k items', 'else the first in lens order');
  assert.equal(correctedThreshold(verdict(vote('REFUTED', 'about 5k items'), vote('REAL', 'about 6k items')), lenses), '', 'text on a vote other than PARTIAL is ignored');
  assert.equal(correctedThreshold({ ...verdict(vote('PARTIAL', 'about 10k items')), corrected: false }, lenses), '');
  assert.equal(correctedKind('fails after 3 retries'), null, 'a bare count is not a size');
  for (const t of ['about 40k', '2M docs', '500 users per workspace', '5 MB per request', '300/s']) assert.equal(correctedKind(t), 'size', t);
  assert.equal(correctedKind('fails at any size'), 'any');
  assert.equal(correctedKind('not size-driven: one retry'), 'n/s');

  // A-01 follows the skeptics (not size-driven): no check. C-01 was not corrected: the hunter's size counts.
  const corrections = new Map([['A-01', 'not size-driven: one bad record stalls the queue'], ['B-01', 'about 25k items per workspace']]);
  const out = sizeConflicts(findings, inputs, cands, config, corrections);
  assert.equal(out.length, 2, out.join('\n'));
  assert.match(out[0], /^B-01: the report input says not size-driven .* but the skeptics' corrected threshold says a breaking size \("about 25k items per workspace"\)/);
  assert.match(out[1], /^C-01: .* but the verified candidate says a breaking size \(breaks_at "40000"/);
  // Without the corrections, A-01 disagrees with the hunter's breaking size.
  assert.match(sizeConflicts(findings.slice(0, 1), inputs, cands, config).join('\n'), /^A-01: .*the verified candidate says a breaking size/);
  // An unreadable corrected text falls back to the hunter's size: the check still runs.
  const unreadable = new Map([['A-01', 'fails after 3 retries']]);
  assert.match(sizeConflicts(findings.slice(0, 1), inputs, cands, config, unreadable).join('\n'), /^A-01: .*the verified candidate says a breaking size \(breaks_at "40000"/);
  // A report input that follows the corrected size raises nothing either.
  assert.deepEqual(sizeConflicts(findings.slice(1, 2), new Map([['B-01', sized]]), cands, config, corrections), []);
});

// ---------- links to 04 and 05 ----------

// A fixture workspace with no recommend result: work/phase6 is moved out and
// its plans are returned as a recommend result, as the workflow would give it.
function withoutRecommend(t, name) {
  const ws = makeFixtureWorkspace(path.join(tmp(t, name), 'ws'));
  const dir = path.join(ws, 'work', 'phase6');
  const recs = fs.readdirSync(path.join(dir, 'recs')).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'recs', f), 'utf8')));
  const crossCutting = JSON.parse(fs.readFileSync(path.join(dir, 'cross-cutting.json'), 'utf8'));
  const diagrams = path.join(ws, 'diagrams-aside');
  fs.renameSync(path.join(dir, 'diagrams'), diagrams);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ws, result: { recs, cross_cutting: crossCutting }, diagrams };
}

function build(ws, steps) {
  for (const b of steps) {
    const r = kit(['build', b, ws]);
    assert.equal(r.code, 0, `${b}: ${r.out}${r.err}`);
  }
}

const read = (ws, f) => fs.readFileSync(path.join(ws, f), 'utf8');

test('in the documented order, 02 links 05 on its first build only when recommend saved a result; 04 always', (t) => {
  // (a) Recommend skipped: log, measurements, (report inputs saved), report.
  const a = withoutRecommend(t, 'skip');
  assert.ok(!fs.existsSync(path.join(a.ws, 'work', 'phase6')));
  build(a.ws, ['log', 'measurements', 'report']);
  const reportA = read(a.ws, '02-audit-report.md');
  assert.match(reportA, /There are no recommendations in this audit\./);
  assert.doesNotMatch(reportA, /05-recommendations\.md/);
  for (const page of [reportA, read(a.ws, '03-verification-log.md')]) assert.match(page, /\[the measurements page\]\(04-measurements\.md\)/);
  let links = kit(['check', 'links', a.ws]);
  assert.equal(links.code, 0, links.out + links.err);
  assert.match(links.out, /broken: 0/);

  // (b) Recommend saved before build report: log, measurements, save recommend,
  // build recommendations, then report. Its first build links 05.
  const b = withoutRecommend(t, 'recs');
  build(b.ws, ['log', 'measurements']);
  const file = path.join(b.ws, 'recommend-1.json');
  fs.writeFileSync(file, JSON.stringify(b.result, null, 2));
  const saved = kit(['save', 'recommend', file, b.ws]);
  assert.equal(saved.code, 0, saved.out + saved.err);
  fs.renameSync(b.diagrams, path.join(b.ws, 'work', 'phase6', 'diagrams'));
  build(b.ws, ['recommendations']);
  assert.ok(!fs.existsSync(path.join(b.ws, '02-audit-report.md')), 'the report is not built yet');
  build(b.ws, ['report']);
  const reportB = read(b.ws, '02-audit-report.md');
  assert.match(reportB, /\[the recommendations\]\(05-recommendations\.md\)/);
  assert.doesNotMatch(reportB, /There are no recommendations in this audit/);
  for (const page of [reportB, read(b.ws, '03-verification-log.md')]) assert.match(page, /\[the measurements page\]\(04-measurements\.md\)/);
  links = kit(['check', 'links', b.ws]);
  assert.equal(links.code, 0, links.out + links.err);
  assert.match(links.out, /broken: 0/);

  // The second and third builds in this order are byte-identical.
  const ORDER = ['log', 'measurements', 'recommendations', 'report'];
  const pages = ['02-audit-report.md', '03-verification-log.md', '04-measurements.md', '05-recommendations.md'];
  build(b.ws, ORDER);
  const second = pages.map((f) => fs.readFileSync(path.join(b.ws, f)));
  build(b.ws, ORDER);
  pages.forEach((f, i) => assert.ok(fs.readFileSync(path.join(b.ws, f)).equals(second[i]), `${f} differs between the second and third build`));

  // A skipped build measurements shows up as a broken link.
  fs.rmSync(path.join(a.ws, '04-measurements.md'));
  assert.equal(kit(['check', 'links', a.ws]).code, 1);
});
