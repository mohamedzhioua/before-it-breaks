'use strict';
// Tests for tooling/lib/config.js and tooling/validate-config.js. Each broken
// config is a modified copy of the demo config, written to a temp workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tooling', 'validate-config.js');
const DEMO_DIR = path.join(ROOT, 'examples', 'demo-config');
const DEMO = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'audit.config.json'), 'utf8'));
const lib = require(path.join(ROOT, 'tooling', 'lib', 'config.js'));

function demo() {
  return JSON.parse(JSON.stringify(DEMO));
}

function workspace(cfg, name = 'ws') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-config-${name}-`));
  const text = typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2);
  fs.writeFileSync(path.join(dir, 'audit.config.json'), text);
  return dir;
}

function run(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

// Writes the config, runs the CLI and checks for exit 1 plus one message.
function expectInvalid(cfg, re, extra = []) {
  const r = run([workspace(cfg), ...extra]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /audit\.config\.json: \d+ errors?/);
  assert.match(r.out, re);
  assert.doesNotMatch(r.out + r.err, /\n\s+at /, 'no stack trace');
  return r;
}

// ---------- the demo ----------

test('demo config validates', () => {
  const r = run([DEMO_DIR]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.trim(), 'OK');
});

test('a config file path works as well as a workspace folder', () => {
  const r = run([path.join(DEMO_DIR, 'audit.config.json')]);
  assert.equal(r.code, 0, r.out + r.err);
});

test('loadConfig returns absolute repo paths (in paths only) and applied defaults', () => {
  assert.equal(DEMO.models.verifier, undefined, 'demo must leave the verifier model out');
  const { config, paths } = lib.loadConfig(DEMO_DIR);
  assert.equal(config.models.verifier.model, 'sonnet');
  assert.equal(config.models.verifier.effort, 'low');
  assert.equal(config.models.hunter.effort, 'xhigh', 'demo override kept');
  assert.equal(config.models.hunter.model, 'inherit', 'sibling default kept');
  assert.equal(config.agents.namespace, 'before-it-breaks:');
  assert.equal(config.verify.survive_votes, 2);
  config.repos.forEach((r, i) => {
    assert.equal(r.path, DEMO.repos[i].path, 'config keeps the path as written');
    assert.ok(path.isAbsolute(paths.repos[r.name]), paths.repos[r.name]);
    assert.equal(paths.repos[r.name], path.resolve(DEMO_DIR, '..', 'repos', r.name));
  });
  assert.ok(!JSON.stringify(config).includes(path.resolve(DEMO_DIR)), 'no absolute workspace path in config');
  assert.equal(paths.workspace, path.resolve(DEMO_DIR));
  assert.equal(paths.outputs.report, path.join(path.resolve(DEMO_DIR), '02-audit-report.md'));
  assert.equal(paths.work, path.join(path.resolve(DEMO_DIR), 'work'));
  assert.equal(paths.kit, path.resolve(ROOT));
  assert.equal(config.scale.bases.length > 0, true);
});

test('loadConfig fills tiers and unit_short when left out', () => {
  const cfg = demo();
  cfg.scale = { unit: 'users in one workspace', target: 50000 };
  const { config } = lib.loadConfig(workspace(cfg));
  assert.deepEqual(config.scale.tiers, [10000, 50000]);
  assert.equal(config.scale.unit_short, 'users');
});

test('loadConfig throws ConfigError with a string list', () => {
  const cfg = demo();
  delete cfg.repos[0].name;
  cfg.extras = true;
  assert.throws(() => lib.loadConfig(workspace(cfg)), (e) => {
    assert.ok(e instanceof lib.ConfigError);
    assert.equal(e.stage, 'validate');
    assert.ok(Array.isArray(e.errors) && e.errors.every((m) => typeof m === 'string'));
    assert.ok(e.errors.includes('repos[0].name: required'), e.errors.join('\n'));
    assert.ok(e.errors.includes('extras: unknown field'), e.errors.join('\n'));
    return true;
  });
});

// ---------- acceptance: broken copies ----------

test('missing repo name fails', () => {
  const cfg = demo();
  delete cfg.repos[1].name;
  const r = expectInvalid(cfg, /repos\[1\]\.name: required/);
  assert.match(r.out, /: 1 error\n/, 'no follow-on unknown-repo errors');
});

test('tiers out of order fail', () => {
  const cfg = demo();
  cfg.scale.tiers = [50000, 5000, 500000];
  expectInvalid(cfg, /scale\.tiers\[1\]: 5000 must be above the previous tier 50000/);
});

test('a tier above the target fails', () => {
  const cfg = demo();
  cfg.scale.tiers = [5000, 900000];
  expectInvalid(cfg, /scale\.tiers\[1\]: 900000 is above scale\.target 500000/);
});

test('unknown lens in a group fails', () => {
  const cfg = demo();
  cfg.groups[0].lens = 'security';
  expectInvalid(cfg, /groups\[0\]\.lens: "security" is not in lenses/);
});

test('duplicate repo name fails', () => {
  const cfg = demo();
  cfg.repos[1].name = 'notes-api';
  expectInvalid(cfg, /repos\[1\]\.name: duplicate "notes-api"/);
});

test('bad model effort fails', () => {
  const cfg = demo();
  cfg.models.skeptic = { model: 'opus', effort: 'extreme' };
  expectInvalid(cfg, /models\.skeptic\.effort: must be one of low, medium, high, xhigh, max \(got "extreme"\)/);
});

test('bad model name fails, full ids are accepted', () => {
  const cfg = demo();
  cfg.models.lead = { model: 'gpt', effort: 'high' };
  expectInvalid(cfg, /models\.lead\.model: does not match/);
  const ok = demo();
  ok.models.lead = { model: 'claude-opus-5-5', effort: 'high' };
  assert.equal(run([workspace(ok)]).code, 0);
});

test('unknown top-level field fails', () => {
  const cfg = demo();
  cfg.extras = { anything: 1 };
  expectInvalid(cfg, /^\s+1\. extras: unknown field$/m);
});

// ---------- other semantic rules ----------

test('group on a context-only repo fails', () => {
  const cfg = demo();
  cfg.groups[3].repo = 'notes-ops';
  expectInvalid(cfg, /groups\[3\]\.repo: "notes-ops" is context_only/);
});

test('group on an unknown repo fails', () => {
  const cfg = demo();
  cfg.groups[0].repo = 'notes-mobile';
  expectInvalid(cfg, /groups\[0\]\.repo: unknown repo "notes-mobile"/);
});

test('lower-case and duplicate group keys fail', () => {
  const cfg = demo();
  cfg.groups[0].key = 'svc-jobs';
  cfg.groups[2].key = 'SVC-IMPORT';
  const r = expectInvalid(cfg, /groups\[0\]\.key: must be upper-case/);
  assert.match(r.out, /groups\[2\]\.key: duplicate "SVC-IMPORT"/);
});

test('non-kebab repo name fails', () => {
  const cfg = demo();
  cfg.repos[0].name = 'Notes_API';
  expectInvalid(cfg, /repos\[0\]\.name: must be kebab-case/);
});

test('survive_votes above the skeptic count fails', () => {
  const cfg = demo();
  cfg.verify = { skeptic_lenses: ['reach', 'mech', 'math'], survive_votes: 4, batch_size: 10 };
  expectInvalid(cfg, /verify\.survive_votes: 4 is more than the 3 skeptic lenses/);
});

test('fewer than three skeptic lenses fails', () => {
  const cfg = demo();
  cfg.verify = { skeptic_lenses: ['reach', 'mech'], survive_votes: 1, batch_size: 10 };
  expectInvalid(cfg, /verify\.skeptic_lenses: needs at least 3 items \(got 2\)/);
});

test('max_concurrent above max_agents_per_workflow fails', () => {
  const cfg = demo();
  cfg.concurrency = { max_agents_per_workflow: 4, max_concurrent: 8, verify_pool: 2 };
  expectInvalid(cfg, /concurrency\.max_concurrent: 8 is more than max_agents_per_workflow 4/);
});

test('module pattern that does not compile fails', () => {
  const cfg = demo();
  cfg.modules[0].pattern = '^src/(unclosed';
  expectInvalid(cfg, /modules\[0\]\.pattern: not a valid regular expression/);
});

test('wrong types and empty strings are reported readably', () => {
  const cfg = demo();
  cfg.scale.target = '500000';
  cfg.audit.name = '  ';
  cfg.audit.date = '08/03/2027';
  const r = expectInvalid(cfg, /scale\.target: expected integer, got string/);
  assert.match(r.out, /audit\.name: must not be empty/);
  assert.match(r.out, /audit\.date: does not match/);
});

test('output path leaving the workspace fails', () => {
  const cfg = demo();
  cfg.outputs = { report: '../elsewhere/report.md' };
  expectInvalid(cfg, /outputs\.report: must stay inside the workspace/);
});

// ---------- example mode ----------

function exampleCopy() {
  const cfg = demo();
  cfg.repos[0] = {
    name: 'notes-api',
    url: 'https://example.invalid/notes/notes-api.git',
    ref: 'v2.4.0',
    pin: 'TODO',
    role: 'backend',
    include: ['src/'],
  };
  return cfg;
}

test('url/ref/TODO-pin repo is accepted only with --example', () => {
  const ws = workspace(exampleCopy(), 'example');
  const plain = run([ws]);
  assert.equal(plain.code, 1, plain.out + plain.err);
  assert.match(plain.out, /repos\[0\]\.path: required \(a url\/ref repo without a path is allowed only in example mode/);
  assert.match(plain.out, /repos\[0\]\.pin: "TODO" is allowed only in example mode/);
  const ex = run([ws, '--example']);
  assert.equal(ex.code, 0, ex.out + ex.err);
  assert.equal(ex.out.trim(), 'OK');
  const { paths } = lib.loadConfig(ws, { example: true });
  assert.equal(paths.repos['notes-api'], null);
});

test('example repo needs both url and ref', () => {
  const cfg = exampleCopy();
  delete cfg.repos[0].ref;
  expectInvalid(cfg, /repos\[0\]: needs a path, or a url and a ref/, ['--example']);
});

// ---------- CLI usage errors ----------

test('missing config file exits 2 with one line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-config-empty-'));
  const r = run([dir]);
  assert.equal(r.code, 2);
  assert.match(r.err, /^validate-config: .*audit\.config\.json: file not found\n$/);
});

test('invalid JSON exits 2', () => {
  const r = run([workspace('{ "audit": ')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid JSON/);
});

test('unknown option and extra positional exit 2', () => {
  assert.equal(run(['--fast']).code, 2);
  assert.equal(run([DEMO_DIR, DEMO_DIR]).code, 2);
});

test('main can be called in-process', () => {
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s) };
  assert.equal(require(CLI).main([DEMO_DIR], io), 0);
  assert.deepEqual(lines, ['OK']);
});

// ---------- library pieces ----------

test('deepMerge merges objects and replaces arrays', () => {
  const base = { a: { b: 1, c: [1, 2] }, d: 'x' };
  const out = lib.deepMerge(base, { a: { c: [3] }, e: true });
  assert.deepEqual(out, { a: { b: 1, c: [3] }, d: 'x', e: true });
  assert.deepEqual(base, { a: { b: 1, c: [1, 2] }, d: 'x' }, 'inputs untouched');
});

test('every preset combines with a minimal config into a valid one', () => {
  for (const preset of ['scalability', 'reliability', 'performance']) {
    const cfg = {
      preset,
      audit: { name: 'Notes check', question: 'What breaks first?', date: '2027-01-04' },
      repos: [{ name: 'notes-api', path: 'repo', role: 'backend' }],
      scale: { unit: 'notes in one workspace', target: 200000 },
      groups: [],
    };
    const merged = lib.withDefaults(cfg);
    assert.equal(merged.audit.type, preset);
    merged.groups = [{ key: 'SVC-ONE', repo: 'notes-api', lens: merged.lenses[0], scope: 'src/' }];
    assert.deepEqual(lib.validateConfig(merged), [], preset);
  }
});

test('the sizes file has the three sizes with ranges', () => {
  const sizes = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'sizes.json'), 'utf8'));
  assert.deepEqual(Object.keys(sizes), ['lite', 'standard', 'full']);
  for (const s of Object.values(sizes)) {
    for (const k of ['repos', 'hunt_groups', 'verify_runs']) assert.ok(s[k].min <= s[k].max, k);
  }
});

test('schema defaults agree with config/defaults.json', () => {
  const schema = JSON.parse(fs.readFileSync(lib.SCHEMA_FILE, 'utf8'));
  const defaults = JSON.parse(fs.readFileSync(lib.DEFAULTS_FILE, 'utf8'));
  let checked = 0;
  (function walk(node, trail) {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'default')) {
      const value = trail.reduce((o, k) => (o ? o[k] : undefined), defaults);
      assert.deepEqual(value, node.default, trail.join('.'));
      checked++;
    }
    for (const [k, child] of Object.entries(node.properties || {})) walk(child, trail.concat(k));
  })(schema, []);
  assert.ok(checked >= 3);
});

test('validateConfig on a non-object reports the type', () => {
  assert.deepEqual(lib.validateConfig([]), ['(config): expected object, got array']);
});

// ---------- round 2: safety lists, lenses, paths, prototype keys, schema ----------

test('custom secret patterns are added to the default masks, never replace them', () => {
  const cfg = demo();
  cfg.evidence = { secret_patterns: ['notes_key=\S+'] };
  const { config } = lib.loadConfig(workspace(cfg));
  const list = config.evidence.secret_patterns;
  assert.ok(list.includes('notes_key=\S+'));
  for (const word of ['password', 'token', 'authorization']) {
    assert.ok(list.some((p) => p.includes(word)), `default mask for ${word} kept`);
  }
  assert.equal(config.evidence.timeout_ms, 60000, 'other evidence defaults kept');
});

test('an empty secret pattern list still keeps the defaults', () => {
  const cfg = demo();
  cfg.evidence = { secret_patterns: [] };
  const defaults = JSON.parse(fs.readFileSync(lib.DEFAULTS_FILE, 'utf8'));
  const { config } = lib.loadConfig(workspace(cfg));
  assert.deepEqual(config.evidence.secret_patterns, defaults.evidence.secret_patterns);
});

test('a custom deny list keeps git push and git commit', () => {
  const cfg = demo();
  cfg.read_only = { deny_bash: ['docker compose up', 'git push'] };
  const { config } = lib.loadConfig(workspace(cfg));
  const list = config.read_only.deny_bash;
  for (const cmd of ['git push', 'git commit', 'docker compose up']) assert.ok(list.includes(cmd), cmd);
  assert.equal(list.filter((c) => c === 'git push').length, 1, 'no duplicate entries');
});

test('a misspelled lens fails; a custom lens is accepted only via custom_lenses', () => {
  const cfg = demo();
  cfg.lenses = ['perfomance', 'reliability', 'data', 'infra', 'frontend'];
  cfg.groups = cfg.groups.filter((g) => g.lens !== 'performance');
  expectInvalid(cfg, /lenses\[0\]: "perfomance" is not a bundled lens \(performance, reliability, data, infra, frontend\)/);
  const custom = demo();
  custom.lenses.push('search-index');
  expectInvalid(custom, /lenses\[5\]: "search-index" is not a bundled lens/);
  custom.custom_lenses = ['search-index'];
  custom.groups.push({ key: 'SVC-SEARCH', repo: 'notes-api', lens: 'search-index', scope: 'src/search/' });
  const r = run([workspace(custom)]);
  assert.equal(r.code, 0, r.out + r.err);
});

test('Git Bash style paths are rejected on Windows only', () => {
  const merged = lib.withDefaults(demo());
  merged.repos[0].path = '/c/work/notes-api';
  merged.kit = { root: '/d/tools/before-it-breaks' };
  const win = lib.validateConfig(merged, { platform: 'win32' });
  assert.ok(win.includes('repos[0].path: "/c/work/notes-api" is a Git Bash style path; on Windows write it as C:/work/notes-api'), win.join('\n'));
  assert.ok(win.some((m) => m.startsWith('kit.root: "/d/tools/before-it-breaks" is a Git Bash style path') && m.endsWith('D:/tools/before-it-breaks')), win.join('\n'));
  const outs = lib.withDefaults(demo());
  outs.outputs.report = '/c/out/report.md';
  assert.ok(lib.validateConfig(outs, { platform: 'win32' }).some((m) => m.startsWith('outputs.report: "/c/out/report.md" is a Git Bash style path')));
  assert.deepEqual(lib.validateConfig(merged, { platform: 'linux' }), []);
});

test('__proto__, constructor and prototype keys are unknown fields and pollute nothing', () => {
  const text = JSON.stringify(demo()).replace(/^\{/, '{"__proto__":{"polluted":true},')
    .replace('"models":{', '"models":{"constructor":{"model":"opus","effort":"high"},');
  const r = run([workspace(text)]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^\s+\d+\. __proto__: unknown field$/m);
  assert.match(r.out, /^\s+\d+\. models\.constructor: unknown field$/m);
  const raw = JSON.parse('{"__proto__":{"polluted":true},"a":{"prototype":{"x":1}}}');
  const merged = lib.deepMerge({ a: { b: 1 } }, raw);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.deepEqual(Object.keys(merged), ['a']);
  assert.deepEqual(merged.a, { b: 1 });
  assert.deepEqual(lib.validateConfig(JSON.parse('{"__proto__":1}')).filter((m) => m.includes('__proto__')), ['__proto__: unknown field']);
});

test('defaults: measure kinds per spec, no find or tee in allowed heads', () => {
  const d = JSON.parse(fs.readFileSync(lib.DEFAULTS_FILE, 'utf8'));
  assert.deepEqual(Object.keys(d.measure.kinds).sort(), ['bench', 'k8s', 'lib', 'mongo', 'queue', 'redis']);
  for (const a of d.measure.access) assert.ok(Object.prototype.hasOwnProperty.call(d.measure.kinds, a.kind), a.kind);
  assert.ok(!d.evidence.allowed_heads.includes('find'));
  assert.ok(!d.evidence.allowed_heads.includes('tee'));
});

test('the whole schema uses only supported keywords and resolvable $refs', () => {
  const schema = JSON.parse(fs.readFileSync(lib.SCHEMA_FILE, 'utf8'));
  const supported = new Set(lib.SUPPORTED_KEYWORDS);
  let nodes = 0;
  (function walk(node, at) {
    assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${at} is a schema object`);
    nodes++;
    for (const k of Object.keys(node)) assert.ok(supported.has(k), `${at}: unsupported keyword ${k}`);
    if (node.$ref !== undefined) {
      const m = /^#\/\$defs\/(.+)$/.exec(node.$ref);
      assert.ok(m && schema.$defs[m[1]], `${at}: $ref ${node.$ref} resolves`);
      const siblings = Object.keys(node).filter((k) => k !== '$ref' && !['description', 'title', '$comment'].includes(k));
      assert.deepEqual(siblings, [], `${at}: no keywords beside $ref`);
    }
    for (const [k, child] of Object.entries(node.properties || {})) walk(child, `${at}.properties.${k}`);
    for (const [k, child] of Object.entries(node.$defs || {})) walk(child, `${at}.$defs.${k}`);
    if (node.items !== undefined) walk(node.items, `${at}.items`);
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      walk(node.additionalProperties, `${at}.additionalProperties`);
    }
  })(schema, '#');
  assert.ok(nodes > 50, `walked ${nodes} nodes`);
});

test('a schema outside the subset gives a readable ConfigError, not a crash', () => {
  const bad = [
    [{ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } }, /unsupported keyword "maxLength" at a/],
    [{ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }, /unknown \$ref "#\/\$defs\/missing"/],
    [{ type: 'object', $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s', pattern: 'x' } } }, /\$ref with sibling keywords \(pattern\) at a/],
  ];
  for (const [schema, re] of bad) {
    assert.throws(() => lib.validateConfig({ a: 'value' }, { schema }), (e) => {
      assert.ok(e instanceof lib.ConfigError);
      assert.equal(e.stage, 'schema');
      assert.match(e.errors[0], /^config\/audit\.config\.schema\.json: /);
      assert.match(e.errors[0], re);
      return true;
    });
  }
});
