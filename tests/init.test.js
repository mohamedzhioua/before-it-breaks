'use strict';
// Tests for kit init (tooling/init-workspace.js) on the invented fixture repo:
// the layout it writes, the refusals, the rendered prompts and the deny rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');
const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');
const { render, denyRules, fileDenyRules } = require('../tooling/init-workspace');

const OPEN = '{' + '{';

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

function setup(t, name, extra) {
  const root = tmp(t, name);
  const repo = makeFixtureRepo(path.join(root, 'repos', 'notes-service')).path;
  const ws = path.join(root, 'audits', 'notes');
  const res = kit(['init', ws, '--preset', 'scalability', '--size', 'lite', '--repo', repo, ...(extra || [])]);
  return { root, repo, ws, res };
}

test('init creates the workspace layout with no placeholder left', (t) => {
  const { ws, res } = setup(t, 'init-layout');
  assert.equal(res.code, 0, res.out + res.err);
  for (const f of ['audit.config.json', 'README.md', 'HANDOFF.md', '01-executive-summary.md', 'MASTER-PROMPT.md',
    'LAUNCHER-PROMPT.md', '.gitignore', '.claude/settings.json', 'work/run-log.json', 'work/claims.json',
    'work/phase3/master-overrides.json', 'rules/run-tests.sh']) {
    assert.ok(fs.existsSync(path.join(ws, f)), `missing ${f}`);
  }
  for (const d of ['system-docs', 'rules/results', 'rules/typescript/tests', 'work/args', 'work/phase1', 'work/phase2',
    'work/phase3/batches', 'work/phase3/receipts', 'work/phase4', 'work/phase5', 'work/phase6/recs', 'work/phase6/diagrams']) {
    assert.ok(fs.statSync(path.join(ws, d)).isDirectory(), `missing folder ${d}`);
  }
  const yaml = fs.readdirSync(path.join(ws, 'rules', 'typescript')).filter((f) => f.endsWith('.yaml'));
  assert.equal(yaml.length, fs.readdirSync(path.join(ROOT, 'rules', 'semgrep', 'typescript')).filter((f) => f.endsWith('.yaml')).length);
  const left = files(ws).filter((f) => fs.readFileSync(f, 'utf8').includes(OPEN));
  assert.deepEqual(left, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, 'work', 'run-log.json'), 'utf8')), { entries: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'master-overrides.json'), 'utf8')), { overrides: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, 'work', 'claims.json'), 'utf8')), []);
  assert.match(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8'), /^\*$/m);
  assert.match(res.out, /check each|role/i);
});

test('the written config validates and names the repo after its folder', (t) => {
  const { ws, res } = setup(t, 'init-config');
  assert.equal(res.code, 0, res.out + res.err);
  const v = kit(['validate', ws]);
  assert.equal(v.code, 0, v.out + v.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'audit.config.json'), 'utf8'));
  assert.equal(cfg.preset, 'scalability');
  assert.equal(cfg.size, 'lite');
  assert.equal(cfg.repos.length, 1);
  assert.equal(cfg.repos[0].name, 'notes-service');
  assert.equal(cfg.repos[0].role, 'backend');
  assert.equal(cfg.repos[0].path, '../../repos/notes-service');
  assert.ok(path.isAbsolute(cfg.kit.root));
  assert.ok(fs.existsSync(path.resolve(ws, cfg.$schema)), 'the $schema path must point at the kit schema');
  assert.ok(cfg.groups.length >= 3 && cfg.groups.every((g) => /^SVC-/.test(g.key)));
});

test('doctor fails only on pins before Phase 0, and passes after pin', (t) => {
  const { ws, res } = setup(t, 'init-doctor');
  assert.equal(res.code, 0, res.out + res.err);
  const before = kit(['doctor', ws, '--no-optional']);
  assert.equal(before.code, 1, before.out + before.err);
  const failed = before.out.split('\n').filter((l) => l.startsWith('FAIL'));
  assert.equal(failed.length, 1, before.out);
  assert.match(failed[0], /^FAIL pins:/);
  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 0, pin.out + pin.err);
  const after = kit(['doctor', ws, '--no-optional']);
  assert.equal(after.code, 0, after.out + after.err);
});

// Deny-rule matching as the kit assumes it (Claude Code permission rules):
// "*" matches any text, the rest literally, over the whole command.
function denies(rules, cmd) {
  return rules.some((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return false;
    const re = new RegExp(`^${m[1].split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(cmd);
  });
}

test('.claude/settings.json denies writes by git, installs and edits in the repos', (t) => {
  const { ws, repo, res } = setup(t, 'init-settings');
  assert.equal(res.code, 0, res.out + res.err);
  const deny = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  for (const rule of ['Bash(git push)', 'Bash(git push *)', 'Bash(git * push)', 'Bash(git * push *)', 'Bash(git * commit *)',
    'Bash(git * checkout *)', 'Bash(git * reset *)', 'Bash(npm install *)']) {
    assert.ok(deny.includes(rule), `missing ${rule}`);
  }
  assert.ok(!deny.some((r) => r.includes(':*')), 'rules use the "prefix *" form');
  const anchor = fileDenyRules([repo])[0];
  assert.match(anchor, /^Edit\(\/\/.+\/\*\*\)$/);
  assert.ok(deny.includes(anchor) && deny.includes(anchor.replace('Edit(', 'Write(')));
  assert.deepEqual(denyRules(['git reset ']), ['Bash(git reset)', 'Bash(git reset *)', 'Bash(git * reset)', 'Bash(git * reset *)']);
  const r = '/w/notes-service';
  for (const cmd of [`git -C ${r} push`, `git -C ${r} push origin main`, `git -C ${r} commit -m x`, `git -C ${r} checkout main`,
    `git -C ${r} reset --hard`, 'git push', 'git stash', 'npm install left-pad']) {
    assert.ok(denies(deny, cmd), `should deny: ${cmd}`);
  }
  for (const cmd of [`git -C ${r} show abc123:src/jobs/notify.queue.ts`, `git -C ${r} log --oneline -5`,
    `git -C ${r} grep -n 'commit' -- src`, `git -C ${r} show abc123:src/checkout/reset.ts`, `git -C ${r} ls-files src`,
    `git -C ${r} log -S 'push' -- src`, `git -C ${r} blame -L 1,9 abc123 -- src/main.ts`]) {
    assert.ok(!denies(deny, cmd), `should allow: ${cmd}`);
  }
});

test('init refuses a folder inside the kit (exit 2) and writes nothing', (t) => {
  const root = tmp(t, 'init-inkit');
  const repo = makeFixtureRepo(path.join(root, 'notes-service')).path;
  const name = `init-refused-${process.pid}`;
  const target = path.join(ROOT, 'workspaces', name);
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const res = kit(['init', target, '--preset', 'scalability', '--size', 'lite', '--repo', repo]);
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, /inside the kit/);
  assert.equal(fs.existsSync(target), false);
});

test('--force on a non-empty folder only adds missing files', (t) => {
  const root = tmp(t, 'init-nonempty');
  const repo = makeFixtureRepo(path.join(root, 'notes-service')).path;
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'keep.txt'), 'mine\n');
  fs.writeFileSync(path.join(ws, 'HANDOFF.md'), 'my own handoff\n');
  const args = ['init', ws, '--preset', 'reliability', '--size', 'standard', '--repo', repo];
  const no = kit(args);
  assert.equal(no.code, 2, no.out + no.err);
  assert.match(no.err, /not empty.*no existing file is overwritten/);
  assert.equal(fs.existsSync(path.join(ws, 'audit.config.json')), false);
  const yes = kit([...args, '--force']);
  assert.equal(yes.code, 0, yes.out + yes.err);
  assert.equal(fs.readFileSync(path.join(ws, 'keep.txt'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(ws, 'HANDOFF.md'), 'utf8'), 'my own handoff\n');
  assert.ok(fs.existsSync(path.join(ws, 'audit.config.json')));
  assert.match(yes.out, /kept 1 existing file/);
});

test('init refuses an existing audit, even with --force, and keeps its state', (t) => {
  const { ws, repo, res } = setup(t, 'init-existing');
  assert.equal(res.code, 0, res.out + res.err);
  const state = {
    'audit.config.json': null,
    'HANDOFF.md': '# HANDOFF\n\nPhase 2 done; approvals recorded.\n',
    'work/run-log.json': '{ "entries": [ { "phase": "map" } ] }\n',
    'work/claims.json': '[ { "id": "P-1", "wording": "Imports are slow", "source": "a review" } ]\n',
    'work/phase3/master-overrides.json': '{ "overrides": [ { "id": "SVC-REL-01", "action": "hold", "reason": "x" } ] }\n',
    '.claude/settings.json': '{ "permissions": { "deny": ["Bash(rm *)"] } }\n',
  };
  for (const [f, text] of Object.entries(state)) {
    if (text === null) state[f] = fs.readFileSync(path.join(ws, f), 'utf8');
    else fs.writeFileSync(path.join(ws, f), text);
  }
  for (const extra of [[], ['--force']]) {
    const again = kit(['init', ws, '--preset', 'scalability', '--size', 'full', '--repo', repo, ...extra]);
    assert.equal(again.code, 2, again.out + again.err);
    assert.match(again.err, /already holds an audit.*--refresh-prompts/);
  }
  for (const [f, text] of Object.entries(state)) assert.equal(fs.readFileSync(path.join(ws, f), 'utf8'), text, f);
});

test('--refresh-prompts renders only the two prompts from the current config', (t) => {
  const { ws, res } = setup(t, 'init-refresh');
  assert.equal(res.code, 0, res.out + res.err);
  const file = path.join(ws, 'audit.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.audit.question = 'Can one workspace hold two million notes?';
  cfg.audit.placeholders = cfg.audit.placeholders.filter((k) => k !== 'audit.question');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const handoff = fs.readFileSync(path.join(ws, 'HANDOFF.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ws, 'README.md'), 'utf8');
  const r = kit(['init', ws, '--refresh-prompts']);
  assert.equal(r.code, 0, r.out + r.err);
  for (const f of ['MASTER-PROMPT.md', 'LAUNCHER-PROMPT.md']) {
    assert.ok(!fs.readFileSync(path.join(ws, f), 'utf8').includes(OPEN), f);
  }
  assert.match(fs.readFileSync(path.join(ws, 'MASTER-PROMPT.md'), 'utf8'), /two million notes/);
  assert.equal(fs.readFileSync(path.join(ws, 'HANDOFF.md'), 'utf8'), handoff);
  assert.equal(fs.readFileSync(path.join(ws, 'README.md'), 'utf8'), readme);
  assert.match(r.out, /WARNING scale\.unit/);
  assert.doesNotMatch(r.out, /WARNING audit\.question/);
  const bad = kit(['init', ws, '--refresh-prompts', '--preset', 'scalability']);
  assert.equal(bad.code, 2);
  const none = kit(['init', path.join(ws, 'work'), '--refresh-prompts']);
  assert.equal(none.code, 2);
  assert.match(none.err, /no audit\.config\.json/);
});

test('validate and doctor warn while init defaults remain, and stop once they are set', (t) => {
  const { ws, res } = setup(t, 'init-warn');
  assert.equal(res.code, 0, res.out + res.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'audit.config.json'), 'utf8'));
  assert.deepEqual(cfg.audit.placeholders, ['audit.question', 'scale.unit', 'scale.target']);
  const v = kit(['validate', ws]);
  assert.equal(v.code, 0, v.out + v.err);
  assert.equal(v.out.split('\n').filter((l) => l.startsWith('WARNING')).length, 3, v.out);
  assert.match(v.out, /--refresh-prompts/);
  const d = kit(['doctor', ws, '--no-optional']);
  assert.match(d.out, /WARNING audit\.question/);
  cfg.audit.question = 'Can one workspace hold a million notes?';
  cfg.scale.unit = 'notes in one workspace';
  cfg.scale.target = 2000000;
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  const v2 = kit(['validate', ws]);
  assert.equal(v2.out.trim(), 'OK');
});

test('init refuses a workspace inside a repo, a repo inside the workspace, a missing repo and bad options', (t) => {
  const root = tmp(t, 'init-bad');
  const repo = makeFixtureRepo(path.join(root, 'notes-service')).path;
  const inner = makeFixtureRepo(path.join(root, 'f', 'notes-web')).path;
  const cases = [
    [[path.join(repo, 'audit'), '--preset', 'scalability', '--size', 'lite', '--repo', repo], /inside the repo/],
    [[path.join(root, 'f'), '--preset', 'scalability', '--size', 'lite', '--repo', inner, '--force'], /inside the workspace/],
    [[path.join(root, 'a'), '--preset', 'scalability', '--size', 'lite', '--repo', path.join(root, 'nope')], /not found/],
    [[path.join(root, 'b'), '--preset', 'security', '--size', 'lite', '--repo', repo], /--preset must be one of/],
    [[path.join(root, 'c'), '--preset', 'scalability', '--size', 'huge', '--repo', repo], /--size must be one of/],
    [[path.join(root, 'd'), '--preset', 'scalability', '--size', 'lite'], /--repo/],
    [[path.join(root, 'e'), '--preset', 'scalability', '--size', 'lite', '--repo', repo, '--target', '10k'], /--target/],
  ];
  for (const [args, re] of cases) {
    const res = kit(['init', ...args]);
    assert.equal(res.code, 2, `${args.join(' ')}\n${res.out}${res.err}`);
    assert.match(res.err, re);
  }
  assert.equal(fs.existsSync(path.join(repo, 'audit')), false);
  assert.equal(fs.existsSync(path.join(root, 'f', 'audit.config.json')), false);
});

test('flags fill the config and the rendered prompts', (t) => {
  const { ws, res } = setup(t, 'init-flags', ['--name', 'Notes growth check', '--question', 'Can one workspace hold a million notes?',
    '--unit', 'notes in one workspace', '--target', '1000000', '--no-rules']);
  assert.equal(res.code, 0, res.out + res.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'audit.config.json'), 'utf8'));
  assert.equal(cfg.audit.name, 'Notes growth check');
  assert.equal(cfg.scale.target, 1000000);
  assert.equal(cfg.rules.enabled, false);
  assert.equal(fs.existsSync(path.join(ws, 'rules', 'typescript')), false);
  const master = fs.readFileSync(path.join(ws, 'MASTER-PROMPT.md'), 'utf8');
  assert.match(master, /^# Master prompt: Notes growth check/);
  assert.match(master, /Can one workspace hold a million notes\?/);
  assert.match(master, /1,000,000/);
  assert.match(master, /before-it-breaks:audit-skeptic/);
  assert.match(master, /--add-dir "/);
  const summary = fs.readFileSync(path.join(ws, '01-executive-summary.md'), 'utf8');
  assert.match(summary, /Can it reach 1,000,000 notes\?/);
});

test('render fills known keys and reports unknown ones', () => {
  const missing = [];
  const out = render(`a ${OPEN}x.y}} b ${OPEN} list }} c ${OPEN}nope}}`, { x: { y: 'Y' }, list: ['p', 'q'] }, 't.md', missing);
  assert.equal(out, `a Y b p, q c ${OPEN}nope}}`);
  assert.deepEqual(missing, [`t.md: ${OPEN}nope}}`]);
});
