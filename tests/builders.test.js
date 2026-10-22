'use strict';
// Tests for the builders (log, report, measurements, recommendations,
// issues, explorer data), tiers.js, check-links and check-mermaid, on the
// invented fixture workspace of tests/fixtures/make-fixture-workspace.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');
const { makeFixtureWorkspace, DATA } = require('./fixtures/make-fixture-workspace');
const shapes = require('../tooling/lib/shapes');
const tiers = require('../tooling/tiers');
const { loadConfig } = require('../tooling/lib/config');
const { slugGithub, slugGitlab, headingText } = require('../tooling/check-links');

const AT_SIGN = String.fromCharCode(64);
const BUILDS = ['log', 'report', 'measurements', 'recommendations', 'issues', 'explorer'];
const PAGES = ['02-audit-report.md', '03-verification-log.md', '04-measurements.md', '05-recommendations.md',
  path.join('system-docs', '01-target-architecture.md'), path.join('work', 'phase6', 'issues.md')];
const OUTPUTS = PAGES.concat([
  path.join('work', 'phase3', 'final-verdicts.json'), path.join('work', 'phase3', 'claim-verdicts.json'),
  path.join('work', 'phase6', 'finding-modules.json'), path.join('work', 'explorer-data.json'),
]);

function node(args, opts) {
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, ...opts });
  return { code: res.status, out: res.stdout, err: res.stderr };
}
const kit = (args) => node([KIT, ...args]);
const data = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const read = (ws, f) => fs.readFileSync(path.join(ws, f), 'utf8');
const json = (ws, f) => JSON.parse(read(ws, f));

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function workspace(t, name) {
  return makeFixtureWorkspace(path.join(tmp(t, name), 'ws'));
}

function buildAll(ws) {
  for (const b of BUILDS) {
    const r = kit(['build', b, ws]);
    assert.equal(r.code, 0, `build ${b}: ${r.out}${r.err}`);
  }
}

function hashes(ws) {
  return Object.fromEntries(OUTPUTS.map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(ws, f))).digest('hex')]));
}

// ---------- shapes ----------

test('the fixture data passes every shape check', () => {
  const { config } = loadConfig(path.join(DATA, 'audit.config.json'));
  assert.deepEqual(shapes.validatePins(data('pins.json')), []);
  assert.deepEqual(shapes.validateCandidates(data('candidates.json'), config), []);
  assert.deepEqual(shapes.validateVerdicts(data('verdicts.json')), []);
  assert.deepEqual(shapes.validateReceiptIndex(data('receipts-index.json')), []);
  assert.deepEqual(shapes.validateReportInputs(data('report-inputs.json'), config), []);
  assert.deepEqual(shapes.validateCrossCutting(data('cross-cutting.json')), []);
  for (const f of fs.readdirSync(path.join(DATA, 'recs'))) assert.deepEqual(shapes.validateModulePlan(data(path.join('recs', f)), config), [], f);
  assert.deepEqual(shapes.validateMapResult({ repo: 'notes-api', text: '# Map' }, config), []);
  const verdicts = data('verdicts.json').verdicts;
  assert.equal(verdicts.length, 18);
  for (const v of ['PROVEN', 'PROVEN-STATIC', 'UNPROVEN', 'REFUTED', 'OUT-OF-SCOPE', 'HELD', 'MERGED', 'REMOVED', 'NEEDS-REVIEW']) {
    assert.ok(verdicts.some((x) => x.verdict === v), v);
  }
});

test('the new shape validators reject bad input with readable messages', () => {
  const { config } = loadConfig(path.join(DATA, 'audit.config.json'));
  const item = data('report-inputs.json').items[0];
  let errs = shapes.validateReportInputs({ items: [{ ...item, breaks_at_basis: 'per moon', area: 'space' }, item] }, config);
  assert.ok(errs.some((m) => /items\[0\]\.breaks_at_basis: must be one of/.test(m)), errs.join('\n'));
  assert.ok(errs.some((m) => /items\[0\]\.area: must be one of/.test(m)));
  assert.ok(errs.some((m) => /items\[1\]\.id: duplicate/.test(m)));
  errs = shapes.validateReportInputs({ items: [{ ...item, effort: 'XL', breaks_at: -1 }] });
  assert.ok(errs.some((m) => /effort: must be one of S, M, L/.test(m)) && errs.some((m) => /breaks_at: must be at least 0/.test(m)), errs.join('\n'));
  assert.deepEqual(shapes.validateReportInputs({ items: [item], failed: [] }), [], 'extra top-level keys are kept');
  const cc = data('cross-cutting.json');
  errs = shapes.validateCrossCutting({ ...cc, sections: [{ ...cc.sections[0], status: 'accepted' }, cc.sections[0]] });
  assert.ok(errs.some((m) => /status: must be "proposed"/.test(m)) && errs.some((m) => /sections\[1\]\.id: duplicate/.test(m)), errs.join('\n'));
  assert.ok(shapes.validateCrossCutting({ ...cc, roadmap: { now: [] } }).some((m) => /roadmap\.next: required/.test(m)));
  const plan = data(path.join('recs', 'svc.jobs.json'));
  assert.ok(shapes.validateModulePlan({ ...plan, repo: 'notes-ops' }, config).some((m) => /plan\.repo: unknown repo/.test(m)));
  assert.ok(shapes.validateModulePlan({ ...plan, recs: [{ ...plan.recs[0], order: 0 }] }).some((m) => /order: must be at least 1/.test(m)));
  assert.ok(shapes.validateMapResult({ repo: 'nope', text: '' }, config).length === 2);
});

// ---------- tiers ----------

test('tiers, maturity and number formatting follow the config', () => {
  const { config } = loadConfig(path.join(DATA, 'audit.config.json'));
  assert.deepEqual(tiers.buildTiers(config).map((t) => `${t.id}=${t.label}`), [
    'T0=breaks already, at any size', 'T1=up to 5k', 'T2=5k to 50k', 'T3=50k to 500k',
    'T4=above 500k (toward 20M platform-wide)', 'grows=slows with size, no single breaking point', 'n/s=not size-driven',
  ]);
  const at = (n, basis) => tiers.tierOf({ breaks_at: n, breaks_at_basis: basis || 'per-tenant items' }, config);
  assert.deepEqual([at(0), at(1), at(5000), at(5001), at(50000), at(500000), at(500001), at(null), at(null, 'not size-driven'), at(7, 'not size-driven')],
    ['T0', 'T1', 'T1', 'T2', 'T2', 'T3', 'T4', 'grows', 'n/s', 'n/s']);
  const L = ['critical', 'high', 'medium', 'low'];
  assert.equal(tiers.maturity({ critical: 1 }, L), 'Weak');
  assert.equal(tiers.maturity({ high: 3 }, L), 'Weak');
  assert.equal(tiers.maturity({ high: 2, low: 4 }, L), 'Moderate');
  assert.equal(tiers.maturity({ medium: 1 }, L), 'Satisfactory');
  assert.equal(tiers.maturity({ low: 9 }, L), 'Strong');
  assert.equal(tiers.maturity({}, L), '-');
  assert.deepEqual([0, 999, 1000, 2500, 70000, 3200000, 40000000, null].map(tiers.fmtN), ['any size', '999', '1k', '2.5k', '70k', '3.2M', '40M', '-']);
  const r = node([path.join(ROOT, 'tooling', 'tiers.js'), path.join(DATA, 'audit.config.json')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T4 +above 500k \(toward 20M/m);
});

// ---------- the builders on the fixture workspace ----------

test('every builder runs, rebuilds byte-identically, and leaves no broken link', (t) => {
  const ws = workspace(t, 'build');
  buildAll(ws);
  for (const f of OUTPUTS) assert.ok(fs.existsSync(path.join(ws, f)), f);
  const first = hashes(ws);
  buildAll(ws);
  assert.deepEqual(hashes(ws), first, 'second build differs');

  const links = kit(['check', 'links', ws]);
  assert.equal(links.code, 0, links.out + links.err);
  assert.match(links.out, /files: 6 .* broken: 0/);
  const issues = kit(['check', 'links', ws, path.join('work', 'phase6', 'issues.md')]);
  assert.equal(issues.code, 0, issues.out + issues.err);
  assert.match(issues.out, /broken: 0/);
  const gitlab = kit(['check', 'links', ws, '--host', 'gitlab']);
  assert.equal(gitlab.code, 0, gitlab.out);

  // Leak gate over the generated workspace: built-in checks (no private denylist in tests).
  const clean = node([path.join(ROOT, 'tooling', 'check-clean.js'), ws]);
  assert.equal(clean.code, 0, clean.out + clean.err);
});

test('every generated page opens with the trust line and the verdict legend', (t) => {
  const ws = workspace(t, 'pages');
  buildAll(ws);
  for (const p of PAGES) {
    const top = read(ws, p).split('\n').slice(0, 20).join('\n');
    assert.match(top, /^# /, p);
    assert.match(top, /\*\*How far to trust this:\*\* 1 of 12 findings was measured on a running system \(PROVEN\)\. Every other threshold is calculated from the code at the pinned commits, not measured\./, p);
    assert.match(top, /1 more candidate is still open \(NEEDS-REVIEW: OPS-RUNTIME-03\)/, p);
    assert.match(top, /Verdict words used on this page/, p);
    assert.ok(top.includes('**NOT-CHECKED**:'), p);
    for (const v of shapes.VERDICT_VALUES) assert.ok(top.includes(`**${v}**:`), `${p}: ${v}`);
  }
  const csv = path.join(ws, 'work', 'phase6', 'issues.csv');
  const r = kit(['build', 'issues', ws, '--tracker', 'gitlab']);
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(csv, 'utf8'), /calculated from the code at the pinned commits, not measured/);
});

test('counts in the outputs equal the fixture: severities, tiers, areas, maturity, verdicts, claims', (t) => {
  const ws = workspace(t, 'counts');
  buildAll(ws);
  const ex = json(ws, path.join('work', 'explorer-data.json'));
  assert.deepEqual(ex.totals, { findings: 12, critical: 2, high: 5, medium: 3, low: 2, measured: 1, proven_static: 10, unproven: ['DATA-INDEX-03'], open: ['OPS-RUNTIME-03'] });
  assert.deepEqual(ex.tiers.map((x) => `${x.tier}:${x.total}`), ['T0:1', 'T1:2', 'T2:3', 'T3:2', 'T4:1', 'grows:1', 'n/s:2']);
  assert.deepEqual(ex.tiers.find((x) => x.tier === 'T2'), { tier: 'T2', label: '5k to 50k', critical: 0, high: 1, medium: 0, low: 2, total: 3 });
  assert.deepEqual(Object.fromEntries(ex.areas.map((a) => [a.area, `${a.critical}/${a.high}/${a.medium}/${a.low} ${a.maturity}`])), {
    'background jobs': '2/1/0/0 Weak',
    'database and indexes': '0/1/2/0 Moderate',
    'edge and HTTP': '0/3/0/0 Weak',
    'front-end': '0/0/0/1 Strong',
    infrastructure: '0/0/1/1 Satisfactory',
  });
  assert.deepEqual(Object.fromEntries(ex.heatmap.map((h) => [h.module === null ? 'unmapped' : h.module, h.total])),
    { 'svc.imports': 2, 'svc.notes': 2, 'svc.health': 1, 'svc.users': 1, 'svc.jobs': 3, 'web.workspaces': 1, unmapped: 2 });
  assert.deepEqual(ex.roadmap.map((r) => r.id), ['now-1', 'next-1', 'next-2', 'later-1']);
  assert.deepEqual(ex.claims, { total: 4, 'PROVEN-STATIC': 2, 'NOT-CHECKED': 1, REFUTED: 1 });

  const report = read(ws, '02-audit-report.md');
  for (const row of ['| Critical | 2 |', '| High | 5 |', '| Medium | 3 |', '| Low | 2 |', '| **Total** | **12** |',
    '| T0 | breaks already, at any size | 1 | 0 | 0 | 0 | 1 |', '| T2 | 5k to 50k | 0 | 1 | 0 | 2 | 3 |', '| n/s | not size-driven | 0 | 1 | 1 | 0 | 2 |',
    '| edge and HTTP | 0 | 3 | 0 | 0 | 3 | Weak |', '| front-end | 0 | 0 | 0 | 1 | 1 | Strong |', '| infrastructure | 0 | 0 | 1 | 1 | 2 | Satisfactory |']) {
    assert.ok(report.includes(row), row);
  }
  const order = [...report.matchAll(/^### ([A-Z]+-[A-Z]+-\d+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['SVC-JOBS-01', 'SVC-IMPORT-01', 'WEB-LISTS-01', 'SVC-IMPORT-02', 'DATA-INDEX-01', 'OPS-RUNTIME-01', 'SVC-JOBS-02',
    'DATA-INDEX-02', 'DATA-INDEX-03', 'OPS-RUNTIME-02', 'SVC-JOBS-03', 'WEB-LISTS-02']);
  assert.match(report, /\| SVC-IMPORT-03 \| MERGED \(into SVC-IMPORT-02\) \|/);
  assert.match(report, /`notes-api@[0-9a-f]{10}:src\/jobs\/notify\.queue\.ts:8`/);

  const final = json(ws, path.join('work', 'phase3', 'final-verdicts.json'));
  assert.equal(final.findings.filter((f) => f.in_report).length, 12);
  const claims = json(ws, path.join('work', 'phase3', 'claim-verdicts.json')).claims;
  assert.deepEqual(claims.map((c) => `${c.id}:${c.verdict}`), ['P-1:PROVEN-STATIC', 'P-2:REFUTED', 'P-3:NOT-CHECKED', 'P-4:PROVEN-STATIC']);
  assert.match(read(ws, '03-verification-log.md'), /\| Verdicts \| PROVEN 1 · PROVEN-STATIC 10 · UNPROVEN 1 · REFUTED 1 · OUT-OF-SCOPE 1 · NEEDS-REVIEW 1 · REMOVED 1 · MERGED 1 · HELD 1 \|/);
  assert.match(read(ws, '03-verification-log.md'), /fixture-model-a/);

  const m = read(ws, '04-measurements.md');
  assert.match(m, /Designed, not yet proven/);
  assert.match(m, /\*\*Status:\*\* 6 read-only live checks prepared for 6 candidates \(1 more is left out/);
  assert.deepEqual([...m.matchAll(/^## Checks: (\w+)$/gm)].map((x) => x[1]), ['mongo', 'redis', 'k8s', 'bench', 'other']);

  const fm = json(ws, path.join('work', 'phase6', 'finding-modules.json'));
  assert.deepEqual(fm.unmapped, ['OPS-RUNTIME-01', 'WEB-LISTS-02']);
  assert.deepEqual(fm.findings.find((f) => f.id === 'SVC-IMPORT-02').modules, ['svc.imports', 'svc.notes']);
  assert.equal(fm.problems.length, 3);
  const rec = read(ws, '05-recommendations.md');
  const notes = rec.indexOf('## Notes for the audit team');
  assert.ok(notes > rec.indexOf('## Modules'), 'notes at the bottom');
  assert.ok(rec.indexOf('has findings but no plan') > notes, 'coverage problems only in the notes');
  assert.match(rec, /Effort M \(Touches every worker\)\./);
  assert.match(rec, /Effort S \(two collections and one migration\)\./);
  assert.match(rec, /```mermaid\nflowchart LR\n/);
  assert.doesNotMatch(rec + read(ws, path.join('system-docs', '01-target-architecture.md')), /quadrantChart|xychart/);
  assert.match(rec, /n_cc_queue_policy --> n_cc_bounded_reads/);
  const md = read(ws, path.join('work', 'phase6', 'issues.md'));
  assert.equal((md.match(/^- \[ \] /gm) || []).length, 4);
  assert.match(report, /\n\*\*In short:\*\* 12 findings, 2 of them critical\. The first to break is \[SVC-JOBS-01\]\(#svc-jobs-01\), at any size\.\n/);
  assert.match(report, /each finding is sized in its own unit, its `breaks_at_basis`/i);
  const openAt = report.indexOf('## Open: waiting for a decision');
  assert.ok(openAt > 0 && report.indexOf('| OPS-RUNTIME-03 |', openAt) > openAt);
  assert.ok(!report.slice(report.indexOf('## Not in this report')).includes('OPS-RUNTIME-03'), 'open is not "did not survive"');
  assert.match(read(ws, '03-verification-log.md'), /\| P-3 \|.*\*\*NOT-CHECKED\*\*/);
  const warn = kit(['build', 'report', ws]);
  assert.match(warn.out, /warning: 1 candidate is still NEEDS-REVIEW \(open\): OPS-RUNTIME-03/);
});

test('build issues: gitlab CSV with a base URL; tracker "none" writes nothing', (t) => {
  const ws = workspace(t, 'issues');
  buildAll(ws);
  const r = kit(['build', 'issues', ws, '--tracker', 'gitlab', '--base-url', 'https://example.invalid/notes/audit/']);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(path.join(ws, 'work', 'phase6', 'issues.csv'), 'utf8');
  assert.ok(text.startsWith('"title","description"\r\n'));
  assert.equal(text.split('\r\n').filter((l) => l.startsWith('"[')).length, 4);
  assert.match(text, /\[SVC-JOBS-01\]\(https:\/\/example\.invalid\/notes\/audit\/02-audit-report\.md#svc-jobs-01\)/);
  assert.match(text, /"\[next\] Stream note imports in batches"/);
  const cfg = json(ws, 'audit.config.json');
  cfg.publish.tracker = 'none';
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg));
  fs.rmSync(path.join(ws, 'work', 'phase6', 'issues.md'));
  const none = kit(['build', 'issues', ws]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /nothing written/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'phase6', 'issues.md')));
  assert.equal(kit(['build', 'issues', ws, '--tracker', 'jira']).code, 2);
});

test('build explorer refuses to write when the counts do not hold', (t) => {
  const ws = workspace(t, 'explorer');
  buildAll(ws);
  const out = path.join(ws, 'work', 'explorer-data.json');
  fs.rmSync(out);
  const fmFile = path.join(ws, 'work', 'phase6', 'finding-modules.json');
  const fm = JSON.parse(fs.readFileSync(fmFile, 'utf8'));
  fm.findings = fm.findings.slice(1);
  fs.writeFileSync(fmFile, JSON.stringify(fm));
  const r = kit(['build', 'explorer', ws]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /final-verdicts\.json reports 12/);
  assert.match(r.err, /roadmap now-1: "SVC-JOBS-01" is not a reported finding/);
  assert.ok(!fs.existsSync(out));
});

test('builders stop with exit 2 and a readable message on missing or bad input', (t) => {
  const ws = workspace(t, 'errors');
  let r = kit(['build', 'report', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /final-verdicts\.json \(run `kit build log` first\) is missing/);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
  const inputs = path.join(ws, 'work', 'phase5', 'report-inputs.json');
  const doc = JSON.parse(fs.readFileSync(inputs, 'utf8'));
  doc.items[0].area = 'the moon';
  fs.writeFileSync(inputs, JSON.stringify(doc));
  assert.equal(kit(['build', 'log', ws]).code, 0);
  r = kit(['build', 'report', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /report-inputs\.json is not valid:\n {2}- report_inputs\.items\[0\]\.area: must be one of/);
  fs.writeFileSync(path.join(ws, 'work', 'phase3', 'verdicts.json'), '{ not json');
  r = kit(['build', 'log', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /verdicts\.json .* is not valid JSON/);
  assert.equal(kit(['build', 'log', ws, '--frobnicate']).code, 2);
  assert.equal(kit(['build', 'log', path.join(ws, 'nowhere')]).code, 2);
});

// ---------- masking ----------

test('secrets planted in agent text never reach a generated page or data file', (t) => {
  const ws = workspace(t, 'mask');
  // Built at runtime so this test file itself stays clean.
  const secret = 'S3cret' + 'Pw42';
  const url = 'mongo' + 'db://notes_admin:' + secret + String.fromCharCode(64) + 'db.example.invalid/notes';
  const token = 'gh' + 'p_' + 'Q7'.repeat(18);
  const edit = (rel, fn) => { const f = path.join(ws, rel); const v = JSON.parse(fs.readFileSync(f, 'utf8')); fn(v); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
  edit(path.join('work', 'candidates.json'), (d) => {
    const c = d.candidates.find((x) => x.id === 'DATA-INDEX-01');
    c.evidence[1].cmd = `mongosh "${url}" --quiet --eval "db.notes.getIndexes()"`;
    c.evidence[1].expect = `No index on workspaceId; use ${token} to read the dashboard.`;
  });
  edit(path.join('work', 'phase3', 'verdicts.json'), (d) => {
    const v = d.verdicts.find((x) => x.id === 'SVC-JOBS-01');
    v.votes.reach.reason = `Reached through ${url} with ${token}.`;
    v.verifier.notes = `Checked with ${token}.`;
  });
  edit(path.join('work', 'phase5', 'report-inputs.json'), (d) => { d.items[0].plain = `Digest fails; the agent quoted ${token} and ${url}.`; });
  edit(path.join('work', 'phase6', 'cross-cutting.json'), (d) => {
    d.roadmap.now[0].change = `Rotate ${token} and clean up failed jobs.`;
    d.sections[0].title = 'One <b>job</b> policy for `queues`';
  });
  buildAll(ws);
  assert.equal(kit(['build', 'issues', ws, '--tracker', 'gitlab']).code, 0);
  const files = OUTPUTS.concat([path.join('work', 'phase6', 'issues.csv')]);
  for (const f of files) {
    const text = read(ws, f);
    assert.ok(!text.includes(secret), `${f}: password leaked`);
    assert.ok(!text.includes(token), `${f}: token leaked`);
  }
  for (const f of ['03-verification-log.md', '04-measurements.md', path.join('work', 'phase6', 'issues.md'), path.join('work', 'explorer-data.json')]) {
    assert.match(read(ws, f), /\[masked: /, f);
  }
  assert.doesNotThrow(() => json(ws, path.join('work', 'explorer-data.json')));
  // The planted inputs still hold the secrets; the outputs must not.
  const clean = node([path.join(ROOT, 'tooling', 'check-clean.js'), ...files.map((f) => path.join(ws, f))]);
  assert.equal(clean.code, 0, clean.out + clean.err);
  // Mermaid labels: angle brackets and backticks are entity-coded.
  assert.match(read(ws, '05-recommendations.md'), /\["One #lt;b#gt;job#lt;\/b#gt; policy for #96;queues#96;"\]/);
});

test('prose() and cell() escape raw HTML and images; one() and code() keep the raw text', () => {
  assert.equal(tiers.prose('a  <img src=x>\n![p](https://notes.invalid/p.png)'), 'a &lt;img src=x> !\\[p](https://notes.invalid/p.png)');
  assert.equal(tiers.cell('<b>x</b> | ![y](z)'), '&lt;b>x&lt;/b> \\| !\\[y](z)');
  assert.equal(tiers.cell(''), '-');
  assert.equal(tiers.one('a <b>'), 'a <b>');
  assert.equal(tiers.code('grep -n "<T>" src'), '`grep -n "<T>" src`');
  assert.equal(tiers.code('![x](y)'), '`![x](y)`');
});

// Removes CommonMark code spans: a run of n backticks up to the next run of
// exactly n backticks. What is left is what renders as Markdown.
function outsideCodeSpans(md) {
  let out = '';
  let i = 0;
  while (i < md.length) {
    if (md[i] !== '`') { out += md[i++]; continue; }
    let n = 0;
    while (md[i + n] === '`') n++;
    const re = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, 'g');
    re.lastIndex = i + n;
    const close = re.exec(md);
    if (!close) { out += md.slice(i, i + n); i += n; continue; }
    i = close.index + n;
  }
  return out;
}

test('code() fences any backtick run, so text in it never escapes the span', () => {
  const BT = '`';
  const evil = `x ${BT.repeat(2)} <img src=//t/p> ${BT.repeat(2)}`;
  const span = tiers.code(evil);
  assert.equal(span, `${BT.repeat(3)} ${evil} ${BT.repeat(3)}`);
  assert.ok(!outsideCodeSpans(`see ${span} here`).includes('<img'), span);
  assert.equal(tiers.code(`a${BT}b`), `${BT.repeat(2)}a${BT}b${BT.repeat(2)}`);
  assert.equal(tiers.code(`${BT}a`), `${BT.repeat(2)} ${BT}a ${BT.repeat(2)}`);
  // The old fixed double fence broke on a double run inside.
  assert.ok(outsideCodeSpans(`${BT.repeat(2)} ${evil} ${BT.repeat(2)}`).includes('<img'), 'the helper sees the old escape');
});

test('agent text with HTML or an image never reaches a page raw; code spans stay raw', (t) => {
  const ws = workspace(t, 'escape');
  const tag = '<img src=x onerror=alert(1)>';
  const img = '![pixel](https://tracker.invalid/p.png)';
  const edit = (rel, fn) => { const f = path.join(ws, rel); const v = JSON.parse(fs.readFileSync(f, 'utf8')); fn(v); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
  edit(path.join('work', 'candidates.json'), (d) => {
    const c = d.candidates.find((x) => x.id === 'SVC-JOBS-01');
    c.claim = `Jobs pile up ${tag} ${img}`;
    c.mechanism = `Mechanism ${img}`;
    c.mitigations_searched = [`Looked for a cap ${tag}`];
  });
  edit(path.join('work', 'phase3', 'verdicts.json'), (d) => {
    const v = d.verdicts.find((x) => x.id === 'SVC-JOBS-01');
    v.votes.reach.reason = `Reached ${tag}.`;
    v.votes.reach.key_citations = ['x ' + '``' + ' <img src=//t/p> ' + '``'];
    v.verifier.notes = `Notes ${img}`;
  });
  edit(path.join('work', 'phase5', 'report-inputs.json'), (d) => { d.items[0].plain = `Digest ${tag} ${img}`; d.items[0].fix_direction = `Fix ${img}`; });
  edit(path.join('work', 'phase6', 'cross-cutting.json'), (d) => { d.roadmap.now[0].change = `Change ${tag} ${img}.`; d.sections[0].decision = `Decide ${tag}`; });
  buildAll(ws);
  for (const f of PAGES) {
    const text = read(ws, f);
    assert.ok(!outsideCodeSpans(text).includes('<img'), `${f}: raw HTML`);
    assert.ok(!outsideCodeSpans(text).includes(img), `${f}: raw image`);
  }
  assert.match(read(ws, '02-audit-report.md'), /Jobs pile up &lt;img src=x onerror=alert\(1\)> !\\\[pixel\]/);
  const log = read(ws, '03-verification-log.md');
  assert.ok(log.includes('``` x `` <img src=//t/p> `` ```'), 'key citation stays raw inside a longer fence');
  assert.match(log, /Looked for a cap &lt;img/);
  // An evidence command keeps its raw text inside backticks.
  edit(path.join('work', 'candidates.json'), (d) => { d.candidates.find((x) => x.id === 'DATA-INDEX-01').evidence[1].cmd = 'git grep -n "<T>" src'; });
  assert.equal(kit(['build', 'measurements', ws]).code, 0);
  assert.match(read(ws, '04-measurements.md'), /`git grep -n "<T>" src`/);
});

test('CSV cells that a spreadsheet would read as a formula get a leading quote', () => {
  const { csv } = require('../tooling/build-issues');
  for (const c of ['=', '+', '-', AT_SIGN, '\t', '\r']) {
    assert.equal(csv(`${c}SUM(A1)`), `"'${c}SUM(A1)"`, JSON.stringify(c));
  }
  assert.equal(csv('Stream "note" imports'), '"Stream ""note"" imports"');
  assert.equal(csv('a=b'), '"a=b"');
  assert.equal(csv('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
});

// ---------- check-links ----------

test('check-links finds missing files and anchors; slug rules per host', (t) => {
  const dir = tmp(t, 'links');
  fs.writeFileSync(path.join(dir, 'a.md'), [
    '# Title', '', '## Notes — and more', '', '## Notes — and more', '', '<a id="custom"></a>', '',
    '[ok](b.md#second-part) [self](#title) [dup](#notes--and-more-1) [custom](#custom) [web](https://example.invalid/x)',
    '`[ignored](nowhere.md)`', '', '```', '[ignored too](nowhere.md)', '```', '',
    '[gone](missing.md) [bad anchor](b.md#nope)', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'b.md'), '# B\n\n## Second part\n');
  let r = kit(['check', 'links', dir, '--host', 'github']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /broken: 2/);
  assert.match(r.out, /a\.md:16 {2}missing file {2}missing\.md/);
  assert.match(r.out, /a\.md:16 {2}missing anchor {2}b\.md#nope/);
  assert.equal(slugGithub(headingText('Notes — and more')), 'notes--and-more');
  assert.equal(slugGitlab(headingText('Notes — and more')), 'notes-and-more');
  assert.equal(slugGithub(headingText('Using `kit build` [here](x.md)')), 'using-kit-build-here');
  assert.equal(slugGithub(headingText('The _quick_ fix for snake_case __now__')), 'the-quick-fix-for-snake_case-now');
  r = kit(['check', 'links', dir, '--host', 'gitlab']);
  assert.match(r.out, /broken: 3/, 'the GitHub-only duplicate anchor fails under GitLab rules');
  const empty = tmp(t, 'links-empty');
  assert.equal(kit(['check', 'links', empty]).code, 2);
  assert.equal(kit(['check', 'links', dir, '--host', 'nope']).code, 2);
});

// ---------- check-mermaid ----------

function stubModules(dir) {
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('package.json', '{"name":"stub-modules","private":true}');
  put('node_modules/mermaid/package.json', '{"name":"mermaid","version":"0.0.0-stub"}');
  put('node_modules/mermaid/dist/mermaid.core.mjs', "export default { initialize() {}, async parse(text) { if (/BROKEN/.test(text)) throw new Error('stub: cannot parse'); return { diagramType: 'flowchart-v2' }; } };\n");
  put('node_modules/jsdom/package.json', '{"name":"jsdom","version":"0.0.0-stub","main":"index.js"}');
  put('node_modules/jsdom/index.js', 'class JSDOM { constructor() { this.window = {}; } }\nmodule.exports = { JSDOM };\n');
}

test('--strict turns check: warnings into exit 1 and still writes the pages', (t) => {
  const ws = workspace(t, 'strict');
  assert.equal(kit(['build', 'log', ws]).code, 0);
  const loose = kit(['build', 'recommendations', ws]);
  assert.equal(loose.code, 0, loose.out + loose.err);
  const checks = loose.out.split('\n').filter((l) => l.startsWith('check: '));
  assert.equal(checks.length, 3, loose.out);
  fs.rmSync(path.join(ws, '05-recommendations.md'));
  const strict = kit(['build', 'recommendations', ws, '--strict']);
  assert.equal(strict.code, 1, strict.out + strict.err);
  assert.match(strict.out, /--strict: 3 check warnings, exit 1/);
  assert.ok(fs.existsSync(path.join(ws, '05-recommendations.md')), 'the page is still written');
  assert.equal(kit(['build', 'report', ws, '--strict']).code, 0, 'the fixture report inputs agree with their candidates');
  assert.match(kit(['build', 'report', ws, '--help']).out, /--strict/);
});

test('build report names report inputs whose size reading disagrees with the candidate', () => {
  const { sizeConflicts } = require('../tooling/build-report');
  const { config } = loadConfig(path.join(DATA, 'audit.config.json'));
  const f = (id) => ({ id });
  const cand = (breaksAt, basis) => ({ breaks_at: breaksAt, breaks_at_basis: basis });
  const inp = (breaksAt, basis, threshold) => ({ breaks_at: breaksAt, breaks_at_basis: basis, threshold: threshold || '' });
  const cands = new Map([['A-01', cand('40000', 'per-tenant items')], ['B-01', cand(null, 'not size-driven')], ['C-01', cand('any size', 'per-tenant items')],
    ['D-01', cand(null, 'not size-driven')], ['E-01', cand('40000', 'per-tenant items')], ['F-01', cand(null, 'per-tenant items')]]);
  const inputs = new Map([['A-01', inp(null, 'not size-driven')], ['B-01', inp(0, 'per-tenant items')], ['C-01', inp(null, 'not size-driven')],
    ['D-01', inp(null, 'not size-driven', 'Fails at any size.')], ['E-01', inp(40000, 'per-tenant items')], ['F-01', inp(null, 'not size-driven')]]);
  const out = sizeConflicts(['A-01', 'B-01', 'C-01', 'D-01', 'E-01', 'F-01'].map(f), inputs, cands, config);
  assert.equal(out.length, 4, out.join('\n'));
  assert.match(out[0], /^A-01: the report input says not size-driven \(not size-driven, tier n\/s\) but the verified candidate says a breaking size \(breaks_at "40000"/);
  assert.match(out[1], /^B-01: the report input says breaks at any size \(any size, tier T0\) but the verified candidate says not size-driven \(breaks_at null/);
  assert.match(out[2], /^C-01: .*not size-driven .* but the verified candidate says breaks at any size/);
  assert.match(out[3], /^D-01: the report input threshold says "any size" \(tier T0\) but its basis is not size-driven \(tier n\/s\)/);
});

test('check-mermaid needs --modules, says so, and parses every block', (t) => {
  const MJS = path.join(ROOT, 'tooling', 'check-mermaid.mjs');
  const ws = workspace(t, 'mermaid');
  buildAll(ws);
  let r = node([MJS, ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /mermaid is not available/);
  assert.match(r.err, /--modules <dir> is required/);
  assert.match(node([MJS, '--help']).out, /--modules <dir> is required/);
  const empty = tmp(t, 'mods-empty');
  r = node([MJS, ws, '--modules', empty]);
  assert.equal(r.code, 2);
  assert.match(r.err, /were not found in/);
  const mods = tmp(t, 'mods');
  stubModules(mods);
  r = kit(['check', 'mermaid', ws, '--modules', mods]);
  assert.equal(r.code, 2, 'the default version is not the stub');
  assert.match(r.err, /installed mermaid is 0\.0\.0-stub, not \d+\.\d+\.\d+/);
  r = kit(['check', 'mermaid', ws, '--modules', mods, '--mermaid-version', '0.0.0-stub']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /mermaid 0\.0\.0-stub: \d+ files, 3 blocks, 0 failed/);
  assert.equal(node([MJS, ws, '--modules', mods, '--mermaid-version', '11.0.0']).code, 2);
  fs.appendFileSync(path.join(ws, '05-recommendations.md'), '\n```mermaid\nBROKEN\n```\n');
  r = node([MJS, ws, '--modules', mods, '--mermaid-version', 'any']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL {2}05-recommendations\.md:\d+ {2}BROKEN/);
});
