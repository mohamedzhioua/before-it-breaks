'use strict';
// Tests for the .git folder check (tooling/lib/git-env.js) used by kit pin
// and kit doctor, the isolated git environment, and the runner's handling
// of links that lead nowhere. Fixture repos are built at test time in a
// temp folder; strings that would trip the leak gate are built at runtime.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');
const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');
const { gitDirCheck, configKeys, gitEnv, systemCarry, GIT_PRE } = require('../tooling/lib/git-env');
const { classify } = require('../tooling/run-evidence');
const { validatePins } = require('../tooling/lib/shapes');
const defaults = require('../config/defaults.json');

const AT = String.fromCharCode(64);
const PIN = 'a'.repeat(40);

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 180000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function git(dir, args, input) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', input: input || '' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// A workspace pointed at one fresh fixture repo.
function setup(t, name) {
  const root = tmp(t, name);
  const repo = makeFixtureRepo(path.join(root, 'repos', 'notes-api'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'work'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'demo-config', 'audit.config.json'), 'utf8'));
  delete cfg.$schema;
  cfg.repos = cfg.repos.filter((r) => r.name === 'notes-api').map((r) => ({ ...r, path: '../repos/notes-api' }));
  cfg.groups = cfg.groups.filter((g) => g.repo === 'notes-api');
  cfg.modules = cfg.modules.filter((m) => m.repo === 'notes-api');
  fs.writeFileSync(path.join(ws, 'audit.config.json'), JSON.stringify(cfg, null, 2));
  return { root, ws, repo };
}

// A shell script that leaves a marker file when anything runs it.
function markerScript(root) {
  const marker = path.join(root, 'marker-ran.txt');
  const script = path.join(root, 'marker.sh');
  const fwd = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(script, `#!/bin/sh\necho ran > "${fwd(marker)}"\nexit 1\n`);
  fs.chmodSync(script, 0o755);
  return { marker, program: fwd(script) };
}

// A new modification time with the same content: git must read the file
// again (through its filters) to know it is unchanged.
let touches = 0;
function touch(file) {
  const when = new Date(Date.now() + 3600 * 1000 * ++touches);
  fs.utimesSync(file, when, when);
}

function appendConfig(repoDir, text) {
  fs.appendFileSync(path.join(repoDir, '.git', 'config'), text);
}

// Replace HEAD by a commit with the same tree that carries a gpgsig header.
function signedLookingCommit(repoDir) {
  const head = git(repoDir, ['rev-parse', 'HEAD']);
  const tree = git(repoDir, ['rev-parse', 'HEAD^{tree}']);
  const who = `Fixture Author <fixture${AT}example.invalid> 1798794000 +0000`;
  const dash = '-'.repeat(5);
  const body = [
    `tree ${tree}`, `parent ${head}`, `author ${who}`, `committer ${who}`,
    `gpgsig ${dash}BEGIN PGP ${'SIGNATURE'}${dash}`, ' ', ' bm90IGEgcmVhbCBzaWduYXR1cmU=', ` ${dash}END PGP ${'SIGNATURE'}${dash}`,
    '', 'add a signed-looking commit', '',
  ].join('\n');
  const sha = git(repoDir, ['hash-object', '-t', 'commit', '-w', '--stdin'], body);
  git(repoDir, ['update-ref', 'refs/heads/main', sha]);
  return sha;
}

function gpgFixture(t) {
  const s = setup(t, 'gpg');
  const { marker, program } = markerScript(s.root);
  appendConfig(s.repo.path, `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${program}\n`);
  const sha = signedLookingCommit(s.repo.path);
  return { ...s, marker, sha };
}

// ---------- config parsing ----------

test('configKeys reads sections, subsections, legacy form and case like git', () => {
  const text = [
    String.fromCharCode(0xfeff) + '[Core]',
    '\tHooksPath = x',
    '[diff "Notes"] textconv = y',
    '[Filter.Notes]',
    '\tclean = "a # not a comment \\',
    '[alias] still the value"',
    '; [gpg] in a comment',
    '[user]',
    '\tname = "multi # \\',
    '[gpg] still quoted" ; comment \\',
    '\temptyBool',
    '\tx = a # a comment ends the value \\',
    '[include]',
  ].join('\n');
  assert.deepEqual(configKeys(text).map((k) => k.name), [
    'core.hookspath', 'diff.Notes.textconv', 'filter.notes.clean', 'user.name', 'user.emptybool', 'user.x',
  ]);
  assert.throws(() => configKeys('[core]\n\tx = "open\n'), /unclosed quote/);
  assert.throws(() => configKeys('[core\n'), /bad section header/);
});

test('gitDirCheck lists every problem of a .git folder', (t) => {
  const root = tmp(t, 'check');
  const repo = makeFixtureRepo(path.join(root, 'r')).path;
  assert.deepEqual(gitDirCheck(repo).problems, []);
  assert.deepEqual(gitDirCheck(path.join(repo, 'src')).problems, [], 'found by walking up');

  appendConfig(repo, [
    '[CORE]', '\tworktree = /x', '\tsshCommand = x', '\tfsmonitor = x',
    '[diff "n"]', '\tcommand = x', '[gpg "ssh"]', '\tprogram = x',
    '[include]', '\tpath = other', '[includeIf "gitdir:/x/"]', '\tpath = other', '[alias]', '\tst = !x', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n');
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '# filter=no\n*.md diff=notes\n');
  const p = gitDirCheck(repo).problems.join('\n');
  for (const re of [/alternates/, /core\.worktree/, /core\.sshcommand/, /core\.fsmonitor/, /diff\.n\.command/, /gpg\.ssh\.program/,
    /include\.path/, /includeif\.gitdir:\/x\/\.path/, /alias\.st/, /attributes line 2 names diff=/]) assert.match(p, re);
  assert.doesNotMatch(p, /attributes line 1/);

  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
  assert.match(gitDirCheck(wt).problems.join('\n'), /\.git is a file/);
});

test('gitDirCheck refuses fetch, transport and credential settings', (t) => {
  const repo = makeFixtureRepo(path.join(tmp(t, 'fetch'), 'r')).path;
  appendConfig(repo, [
    '[remote "origin"]', '\turl = https://example.invalid/notes.git', '\tpromisor = true', '\tuploadpack = x',
    '\treceivepack = x', '\tvcs = x', '[extensions]', '\tpartialClone = origin', '[protocol "file"]', '\tallow = always',
    '[credential]', '\thelper = x', '[core]', '\taskPass = x', '\tgitProxy = x', '',
  ].join('\n'));
  const p = gitDirCheck(repo).problems.join('\n');
  for (const re of [/remote\.origin\.promisor/, /remote\.origin\.uploadpack/, /remote\.origin\.receivepack/, /remote\.origin\.vcs/,
    /extensions\.partialclone/, /protocol\.file\.allow/, /credential\.helper/, /core\.askpass/, /core\.gitproxy/]) assert.match(p, re);
  assert.doesNotMatch(p, /remote\.origin\.url/);
});

test('gitDirCheck refuses diff.external and trace2 settings', (t) => {
  const repo = makeFixtureRepo(path.join(tmp(t, 'trace'), 'r')).path;
  appendConfig(repo, ['[diff]', '\texternal = x', '[trace2]', '\teventTarget = x', ''].join('\n'));
  const p = gitDirCheck(repo).problems.join('\n');
  assert.match(p, /diff\.external/);
  assert.match(p, /trace2\.eventtarget/);
});

test('core.autocrlf and core.eol are carried from global config too; global wins over system', (t) => {
  const home = tmp(t, 'home');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tautocrlf = input\n\teol = lf\n\teditor = x\n');
  const code = "const { systemCarry, gitEnv } = require(process.argv[1]); const e = systemCarry(gitEnv());"
    + " process.stdout.write(e.GIT_CONFIG_SYSTEM ? require('fs').readFileSync(e.GIT_CONFIG_SYSTEM, 'utf8') : '');";
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];
  const res = spawnSync(process.execPath, ['-e', code, path.join(__dirname, '..', 'tooling', 'lib', 'git-env.js')], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  const keys = Object.fromEntries(configKeys(res.stdout).map((k) => [k.name, true]));
  assert.ok(keys['core.autocrlf'] && keys['core.eol'], res.stdout);
  assert.match(res.stdout, /autocrlf = input/, 'the global value wins');
  assert.doesNotMatch(res.stdout, /editor/, 'only the two carried keys');
});

test('gitDirCheck reads a CRLF config like git', (t) => {
  assert.deepEqual(configKeys('[core]\r\n\tbare = false\r\n[GPG]\r\n\tprogram = x\r\n').map((k) => k.name), ['core.bare', 'gpg.program']);
  const repo = makeFixtureRepo(path.join(tmp(t, 'crlf'), 'r')).path;
  appendConfig(repo, '[alias]\r\n\tst = !x\r\n');
  assert.match(gitDirCheck(repo).problems.join('\n'), /line \d+ sets alias\.st/);
});

test('gitDirCheck refuses a config or attributes file that is not a small regular file', (t) => {
  const repo = makeFixtureRepo(path.join(tmp(t, 'nonreg'), 'r')).path;
  const cfg = path.join(repo, '.git', 'config');
  fs.rmSync(cfg);
  fs.mkdirSync(cfg);
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '#'.repeat(1024 * 1024 + 1));
  const p = gitDirCheck(repo).problems.join('\n');
  assert.match(p, /\.git\/config is not a regular file/);
  assert.match(p, /\.git\/info\/attributes is larger than 1 MiB/);
});

test('gitDirCheck refuses a bare layout and tells a plain folder apart', (t) => {
  const root = tmp(t, 'bare');
  const bare = path.join(root, 'notes.git');
  fs.mkdirSync(bare);
  git(bare, ['init', '-q', '--bare']);
  const chk = gitDirCheck(bare);
  assert.equal(chk.notRepo, null);
  assert.match(chk.problems.join('\n'), /is itself a git folder/);
  const repo = makeFixtureRepo(path.join(root, 'r')).path;
  assert.match(gitDirCheck(path.join(repo, '.git', 'refs')).problems.join('\n'), /is itself a git folder/);
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.match(gitDirCheck(plain).notRepo, /no \.git in it or above it/);
  const empty = path.join(root, 'empty');
  fs.mkdirSync(path.join(empty, '.git'), { recursive: true });
  assert.match(gitDirCheck(empty).notRepo, /no HEAD, objects or refs/);
});

test('the isolated env drops inherited git variables, stops fetching and ignores global config', () => {
  const env = gitEnv({ PATH: 'p', GIT_DIR: 'x', GIT_ASKPASS: 'x', GIT_SSH_COMMAND: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_PARAMETERS: "'a.b=c'" });
  assert.equal(env.PATH, 'p');
  for (const k of ['GIT_DIR', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_PARAMETERS']) assert.equal(env[k], undefined, k);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_NO_LAZY_FETCH, '1');
  assert.ok(env.GIT_ALLOW_PROTOCOL && !/^(file|https?|ssh|git)$/.test(env.GIT_ALLOW_PROTOCOL));
  for (const s of ['log.showSignature=false', 'gpg.program=', 'gpg.ssh.program=', 'gpg.x509.program=', 'safe.bareRepository=explicit']) {
    assert.ok(GIT_PRE.includes(s), s);
  }
  const res = spawnSync('git', ['config', '--global', '--list'], { encoding: 'utf8', env: gitEnv() });
  assert.equal(res.stdout.trim(), '', 'no global settings are visible');
  const carried = systemCarry(gitEnv());
  if (carried.GIT_CONFIG_SYSTEM) {
    assert.equal(carried.GIT_CONFIG_NOSYSTEM, undefined);
    const keys = configKeys(fs.readFileSync(carried.GIT_CONFIG_SYSTEM, 'utf8')).map((k) => k.name);
    assert.ok(keys.length && keys.every((k) => /^core\.(autocrlf|eol)$/.test(k)), keys.join(','));
  } else {
    assert.equal(carried.GIT_CONFIG_NOSYSTEM, '1');
  }
});

test('carried system settings keep system precedence: the repo own core.autocrlf wins', (t) => {
  const root = tmp(t, 'carry');
  const repo = makeFixtureRepo(path.join(root, 'repo')).path;
  const env = systemCarry(gitEnv());
  const get = () => spawnSync('git', ['-C', repo, 'config', '--get', 'core.autocrlf'], { encoding: 'utf8', env }).stdout.trim();
  const sys = spawnSync('git', ['config', '--system', '--get', 'core.autocrlf'], { encoding: 'utf8', cwd: os.tmpdir() }).stdout.trim();
  spawnSync('git', ['-C', repo, 'config', '--unset-all', 'core.autocrlf']); // the fixture sets its own
  if (/^(true|false|input)$/.test(sys)) assert.equal(get(), sys, 'system value carried when the repo sets none');
  const own = sys === 'input' ? 'false' : 'input';
  git(repo, ['config', 'core.autocrlf', own]);
  assert.equal(get(), own, 'repo value wins over the carried one');
  assert.ok(!GIT_PRE.some((s) => /autocrlf|eol/.test(s)), 'not passed as -c');
});

test('format-only extensions are accepted; others are refused', (t) => {
  const root = tmp(t, 'ext');
  const repo = makeFixtureRepo(path.join(root, 'repo')).path;
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[extensions]\n\tworktreeConfig = true\n\tobjectFormat = sha1\n\trefStorage = files\n');
  assert.deepEqual(gitDirCheck(repo).problems, []);
  fs.appendFileSync(path.join(repo, '.git', 'config'), '\tpartialClone = origin\n');
  assert.match(gitDirCheck(repo).problems.join('\n'), /extensions\.partialclone/);
});

// ---------- kit pin and kit doctor ----------

test('gpg fixture: pin and doctor refuse before git runs; --trust-git-dir pins and gpg still never runs', (t) => {
  const { ws, repo, marker, sha } = gpgFixture(t);

  // The fixture is live: plain git with the repo's own config runs the program.
  spawnSync('git', ['-C', repo.path, 'log', '-1', '--format=%cI', 'HEAD'], { encoding: 'utf8' });
  assert.ok(fs.existsSync(marker), 'plain git started gpg.program, so the fixture can prove something');
  fs.rmSync(marker, { force: true });

  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 2, pin.out + pin.err);
  assert.match(pin.err, /refusing to run git/);
  assert.match(pin.err, /log|gpg\.program/);
  assert.match(pin.err, /--trust-git-dir/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'pins.json')));
  assert.ok(!fs.existsSync(marker), 'the marker never ran');

  const doctor = kit(['doctor', ws, '--no-optional']);
  assert.equal(doctor.code, 2, doctor.out + doctor.err);
  assert.match(doctor.out, /FAIL repo notes-api: \.git folder refused \(git not run\)/);
  assert.ok(!fs.existsSync(marker), 'the marker never ran');

  const trusted = kit(['pin', ws, '--trust-git-dir']);
  assert.equal(trusted.code, 0, trusted.out + trusted.err);
  assert.match(trusted.err, /refusal skipped \(--trust-git-dir/);
  const pins = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'pins.json'), 'utf8'));
  assert.deepEqual(validatePins(pins), []);
  assert.equal(pins.repos['notes-api'].sha, sha);
  assert.equal(pins.repos['notes-api'].trust_git_dir, true);
  assert.match(fs.readFileSync(path.join(ws, 'work', 'phase0-baseline.md'), 'utf8'), /Git folder trusted \(`--trust-git-dir`\): notes-api/);
  assert.ok(!fs.existsSync(marker), 'the isolated env kept gpg from running');

  const after = kit(['doctor', ws, '--no-optional']);
  assert.match(after.out, /ok {3}repo notes-api: git repository found \(\.git folder trusted/);
  assert.ok(!fs.existsSync(marker), 'the marker never ran');
});

test('filter fixture: pin refuses a filter in .git/config named by info/attributes', (t) => {
  const { ws, repo, root } = setup(t, 'filter');
  const { marker, program } = markerScript(root);
  appendConfig(repo.path, `[filter "notes"]\n\tclean = ${program}\n\tsmudge = ${program}\n`);
  fs.mkdirSync(path.join(repo.path, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo.path, '.git', 'info', 'attributes'), '* filter=notes\n');

  // The fixture is live: after a touch, plain git status runs the clean filter.
  touch(path.join(repo.path, 'package.json'));
  spawnSync('git', ['-C', repo.path, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.ok(fs.existsSync(marker), 'plain git status started the clean filter, so the fixture can prove something');
  fs.rmSync(marker, { force: true });
  touch(path.join(repo.path, 'package.json'));

  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 2, pin.out + pin.err);
  assert.match(pin.err, /filter\.notes\.clean/);
  assert.match(pin.err, /info\/attributes line 1 names filter=/);
  assert.ok(!fs.existsSync(marker), 'the marker never ran');
});

test('submodules are not looked into: a filter in a submodule never runs', (t) => {
  const { ws, repo, root } = setup(t, 'submodule');
  const { marker, program } = markerScript(root);
  const sub = path.join(repo.path, 'vendor', 'notes-lib');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'index.js'), 'module.exports = {};\n');
  const who = ['-c', 'user.name=Fixture Author', '-c', `user.email=fixture${AT}example.invalid`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
  git(sub, ['init', '-q', '-b', 'main']);
  git(sub, [...who, 'add', '-A']);
  git(sub, [...who, 'commit', '-q', '-m', 'library']);
  git(repo.path, [...who, '-c', 'advice.addEmbeddedRepo=false', 'add', 'vendor/notes-lib']);
  git(repo.path, [...who, 'commit', '-q', '-m', 'add the library as a submodule']);
  appendConfig(sub, `[filter "notes"]\n\tclean = ${program}\n`);
  fs.mkdirSync(path.join(sub, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(sub, '.git', 'info', 'attributes'), '* filter=notes\n');

  // The fixture is live: plain git status in the outer repo looks into the
  // submodule and runs its clean filter.
  touch(path.join(sub, 'index.js'));
  spawnSync('git', ['-C', repo.path, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.ok(fs.existsSync(marker), 'plain git status ran the submodule filter, so the fixture can prove something');
  fs.rmSync(marker, { force: true });
  touch(path.join(sub, 'index.js'));

  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 0, pin.out + pin.err);
  assert.ok(!fs.existsSync(marker), 'pin did not look into the submodule');
  const unchanged = kit(['check', 'unchanged', ws]);
  assert.equal(unchanged.code, 0, unchanged.out + unchanged.err);
  assert.ok(!fs.existsSync(marker), 'check unchanged did not look into the submodule');
});

test('a folder that is not a repo keeps the old message, with no --trust-git-dir advice', (t) => {
  const { ws, repo } = setup(t, 'norepo');
  fs.rmSync(path.join(repo.path, '.git'), { recursive: true, force: true });
  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 2, pin.out + pin.err);
  assert.match(pin.err, /repo notes-api: not a git repository: /);
  assert.doesNotMatch(pin.err, /trust-git-dir/);
  const doctor = kit(['doctor', ws, '--no-optional']);
  assert.equal(doctor.code, 1, doctor.out + doctor.err);
  assert.match(doctor.out, /FAIL repo notes-api: not a git repository: /);
  assert.doesNotMatch(doctor.out, /trust-git-dir/);
});

test('check unchanged and the evidence runner check the .git folder again', (t) => {
  const { ws, repo, root } = setup(t, 'recheck');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'data', 'fixture-candidates.json'), path.join(ws, 'work', 'candidates.json'));
  assert.equal(kit(['pin', ws]).code, 0);
  const { marker, program } = markerScript(root);
  appendConfig(repo.path, `[filter "notes"]\n\tclean = ${program}\n`);
  fs.mkdirSync(path.join(repo.path, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo.path, '.git', 'info', 'attributes'), '* filter=notes\n');
  touch(path.join(repo.path, 'package.json'));

  const unchanged = kit(['check', 'unchanged', ws]);
  assert.equal(unchanged.code, 1, unchanged.out + unchanged.err);
  assert.match(unchanged.out, /FAIL notes-api: \.git folder refused \(git not run\): .*filter\.notes\.clean/);
  const evidence = kit(['evidence', ws]);
  assert.equal(evidence.code, 2, evidence.out + evidence.err);
  assert.match(evidence.err, /refusing to run git on these repos/);
  assert.ok(!fs.existsSync(marker), 'the marker never ran');
});

test('a clean repo pins exactly as before', (t) => {
  const { ws, repo } = setup(t, 'clean');
  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 0, pin.out + pin.err);
  assert.equal(pin.err, '');
  const pins = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'pins.json'), 'utf8'));
  assert.deepEqual(Object.keys(pins), ['date', 'allow_dirty', 'repos']);
  assert.deepEqual(Object.keys(pins.repos['notes-api']), ['sha', 'short', 'branch', 'commit_date', 'porcelain', 'changes_sha256']);
  assert.equal(pins.repos['notes-api'].sha, repo.sha);
  assert.equal(pins.repos['notes-api'].porcelain, 0);
  const baseline = fs.readFileSync(path.join(ws, 'work', 'phase0-baseline.md'), 'utf8');
  assert.match(baseline, /All repos were clean when pinned\.\n\nFull commits are in `pins\.json`\.\n$/);
  assert.doesNotMatch(baseline, /trust/);
});

// ---------- runner path check ----------

test('a link inside a repo that leads nowhere is refused by the runner', (t) => {
  const dir = path.join(tmp(t, 'dangling'), 'notes api');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const nowhere = path.join(tmp(t, 'gone'), 'missing');
  try {
    fs.symlinkSync(nowhere, path.join(dir, 'link'), 'junction');
  } catch (e) {
    t.skip(`symlinks not available here (${e.code})`);
    return;
  }
  const fwd = dir.replace(/\\/g, '/');
  const ctx = {
    expand: (kind, name) => (name !== 'notes-api' ? null : kind === 'pin' ? PIN : fwd),
    roots: require('../tooling/run-evidence').makeRoots({ 'notes-api': dir }),
  };
  const r = classify('cat {repo:notes-api}/link/secret.txt', defaults.evidence, ctx);
  assert.equal(r.status, 'skipped-unsafe');
  assert.match(r.reason, /cannot be resolved/);
  assert.equal(classify('cat {repo:notes-api}/src/missing.txt', defaults.evidence, ctx).status, 'run', 'a plain missing file is still fine');
});
