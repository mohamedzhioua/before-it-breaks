'use strict';
// Tests for the Phase 0 and evidence tools: pin, doctor, check-unchanged,
// run-evidence (classifier, runner, receipts) and scan-secrets, on the
// invented fixture repo. Refused commands are only classified, never run.
// Strings that would trip the leak gate are built at runtime.

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
const { classify, lex, sedScriptProblem, makeRoots } = require('../tooling/run-evidence');
const { validatePins } = require('../tooling/lib/shapes');
const defaults = require('../config/defaults.json');

const EV = defaults.evidence;
const PIN = 'a'.repeat(40);
const AT = String.fromCharCode(64);

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bib-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// A repo-root folder (with a space in its name) for classifier tests.
function classifyCtx(t) {
  const dir = path.join(tmp(t, 'classify'), 'notes api');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const fwd = dir.replace(/\\/g, '/');
  return {
    dir,
    ctx: {
      expand: (kind, name) => (name !== 'notes-api' ? null : kind === 'pin' ? PIN : fwd),
      roots: makeRoots({ 'notes-api': dir }),
    },
  };
}

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 180000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function git(dir, args) {
  const name = 'Fixture Author';
  const mail = `fixture${AT}example.invalid`;
  const res = spawnSync('git', ['-C', dir, '-c', `user.name=${name}`, '-c', `user.email=${mail}`, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// A workspace made from the demo config, pointed at one fixture repo (by a
// relative path, as a real workspace would be).
function setup(t, name, candidates) {
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
  if (candidates) fs.writeFileSync(path.join(ws, 'work', 'candidates.json'), JSON.stringify({ candidates }, null, 2));
  else fs.copyFileSync(path.join(DATA, 'fixture-candidates.json'), path.join(ws, 'work', 'candidates.json'));
  return { root, ws, repo };
}

function readDir(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

// ---------- classifier: accepted ----------

test('plain read-only pipelines are accepted and become argument lists', (t) => {
  const { dir, ctx } = classifyCtx(t);
  const fwd = dir.replace(/\\/g, '/');
  const r = classify('git -C {repo:notes-api} grep -n "find(" {pin:notes-api} -- src | head -5', EV, ctx);
  assert.equal(r.status, 'run', r.reason);
  assert.deepEqual(r.steps, [
    { head: 'git', args: ['-C', fwd, 'grep', '-n', 'find(', PIN, '--', 'src'], stderr: 'keep' },
    { head: 'head', args: ['-5'], stderr: 'keep' },
  ]);
  const quiet = classify('git -C "{repo:notes-api}" show {pin:notes-api}:package.json 2>/dev/null | wc -l', EV, ctx);
  assert.equal(quiet.status, 'run', quiet.reason);
  assert.equal(quiet.steps[0].stderr, 'null');
  for (const c of [
    "sed -n '120,140p;/skip(/p' {repo:notes-api}/src/import.service.ts",
    "sed -E 's/a+/b/g' {repo:notes-api}/src/x.ts",
    "grep -n -e 'remove.*Fail' --include='src/*.ts' -r {repo:notes-api}/src",
    "git -C {repo:notes-api} log -1 --pretty=raw {pin:notes-api}",
    'git -C {repo:notes-api} log -1 --format=format:%h {pin:notes-api}',
    'sort -t , -k 2 {repo:notes-api}/package.json | uniq -c',
    "git -C {repo:notes-api} log -3 --format='%h %an %s' {pin:notes-api}",
    'git -C {repo:notes-api} diff --stat {pin:notes-api}..{pin:notes-api}',
    'git -C {repo:notes-api} blame -L 1,3 {pin:notes-api} -- package.json',
    "grep -rn --include='*.ts' -e removeOnFail {repo:notes-api}/src",
    'git -C {repo:notes-api} ls-tree -r --name-only {pin:notes-api} | wc -l',
    // .env in a search pattern or a sed script is text to find, not a file to read
    "rg 'process\\.env' {repo:notes-api}/src",
    "rg -n 'process\\.env\\.NOTES_URL' {repo:notes-api}/src",
    "git -C {repo:notes-api} grep -e '\\.env' {pin:notes-api}",
    "git -C {repo:notes-api} grep -n '\\.env' {pin:notes-api} -- src",
    "git -C {repo:notes-api} log -S '.env' --oneline {pin:notes-api}",
    "grep -rn -e '\\.env' {repo:notes-api}/src",
    "sed -n '/\\.env/p' {repo:notes-api}/src/x.ts",
    // broad file patterns run; the runner's excludes keep .env out
    "rg -n -g 'src/**/*.ts' x {repo:notes-api}/src",
    "grep -rn --include='*/x.ts' -e x {repo:notes-api}/src",
    "grep -rn --include='*.e2e.ts' -e x {repo:notes-api}/src",
    "rg -n -g '.envrc' x {repo:notes-api}/src",
    'grep .env {repo:notes-api}/src/a.ts',
    // literal rev:path with brackets, safe include and exclude patterns
    "git -C {repo:notes-api} show '{pin:notes-api}:app/[id]/page.tsx'",
    "rg -n -g '*.ts' -g '!.env*' removeOnFail {repo:notes-api}/src",
    "grep -rn --include='*.ts' --exclude='.env*' -e x {repo:notes-api}/src",
    'cat {repo:notes-api}/src/environment.ts',
    'head -n 2 {repo:notes-api}/package.json 2>&1',
  ]) {
    const x = classify(c, EV, ctx);
    assert.equal(x.status, 'run', `${c}: ${x.reason}`);
  }
});

test('blame/diff revisions must be commit ids, and -L paths stay inside the repo', (t) => {
  const { ctx } = classifyCtx(t);
  for (const c of [
    'git -C {repo:notes-api} blame src/a.ts',
    'git -C {repo:notes-api} diff src/a.ts src/b.ts',
    'git -C {repo:notes-api} log -L 1,2:' + ['', 'etc', 'hosts'].join('/') + ' {pin:notes-api}',
  ]) {
    assert.equal(classify(c, EV, ctx).status, 'skipped-unsafe', c);
  }
});

test('live commands are skipped as live', () => {
  for (const c of ['mongosh --eval "db.notes.stats()"', 'LIVE: check the queue dashboard', 'redis-cli INFO memory']) {
    assert.equal(classify(c, EV, {}).status, 'skipped-live', c);
  }
});

// ---------- classifier: refused ----------

test('every refused class is refused with its reason (classified only)', (t) => {
  const { ctx } = classifyCtx(t);
  const R = '{repo:notes-api}';
  const P = '{pin:notes-api}';
  const G = `git -C ${R}`;
  const cases = [
    // shell features
    [`git show $(id)`, /substitution/],
    [`git show "$(id)"`, /substitution/],
    ['git show `id`', /backticks/],
    ['git show "`id`"', /backticks/],
    [`cat <(id)`, /redirection and process substitution/],
    [`cat ${R}/a >(id)`, /redirection and process substitution/],
    [`${G} show ${P}:a > copy.txt`, /redirection/],
    [`${G} show ${P}:a >> copy.txt`, /redirection/],
    [`cat < ${R}/a`, /redirection/],
    ['git log; id', /chains/],
    ['git log && id', /chains/],
    ['git log || id', /chains/],
    ['git log & id', /chains/],
    ['git log\nid', /chains/],
    ['cat $HOME/x', /expansion/],
    ['cat "${HOME}"', /expansion/],
    ['GIT_PAGER=id git log', /VAR=value/],
    ['(git log)', /subshells/],
    [`${G} log --{output,x}=log.txt`, /brace/],
    [`cat ${R}/src/*.ts`, /glob/],
    ["grep 'unterminated", /unterminated/],
    ['git show {pin:other}', /unknown placeholder/],
    ['git log | ', /empty pipeline/],
    ['git log # comment', /comments/],
    // programs
    ['/bin/rm -rf x', /program name only/],
    ['rm -rf x', /allowed_heads/],
    ['bash -c id', /"bash" is not in evidence.allowed_heads/],
    [`${G} show ${P}:a | tee copy.txt`, /"tee" is not in evidence.allowed_heads/],
    [`find ${R}/src -delete`, /"find" is not in evidence.allowed_heads/],
    ['xargs rm', /xargs/],
    ['semgrep --config r .', /"semgrep" is not in evidence.allowed_heads/],
    // paths
    ['cat ~/x', /~/],
    [`cat ${'/etc'}/hosts`, /outside the repos/],
    [`cat ${'/dev'}/stdin`, /outside the repos/],
    [`cat ${R}/../secret.txt`, /"\.\."/],
    ['cat src/a.ts', /must start with \{repo/],
    [`${G} grep -n x ${P} -- ../up`, /"\.\."/],
    [`${G} show ${P}:${'/etc'}/hosts`, /outside the repos/],
    [`cat ${R}/.env`, /\.env/],
    // git rev:path forms
    [`${G} show ${P}:.env`, /reads an \.env file/],
    [`${G} show HEAD:.env.local`, /reads an \.env file/],
    [`${G} show ${P}:config/.env.local`, /reads an \.env file/],
    // any case, any number of suffixes
    [`cat ${R}/.ENV`, /reads an \.env file/],
    [`cat ${R}/config/.env.production.local`, /reads an \.env file/],
    [`${G} show ${P}:.env.local.bak`, /reads an \.env file/],
    // wildcards in git pathspecs, and include patterns that could match .env
    [`${G} grep -n -e x ${P} -- '.en?'`, /wildcards .* git pathspecs/],
    [`${G} grep -n -e x ${P} -- '*.env*'`, /wildcards .* git pathspecs/],
    [`${G} grep -n -e x ${P} -- '.en[v]'`, /wildcards .* git pathspecs/],
    [`${G} log -p ${P} -- 'config/*'`, /wildcards .* git pathspecs/],
    [`${G} grep -n -e x ${P} -- ':(glob)**/.e*'`, /wildcards|pathspec magic/],
    [`grep -rn --include='.env*' -e x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`grep -rn --include='*' -e x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`grep -rn --include='config/.e?v' -e x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`rg -n -g '*' x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`rg -n --glob='.{env,cfg}' x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`rg -n -g '.EN[V]*' x ${R}/src`, /could match an \.env file|reads an \.env file/],
    // values glued to an option, .env folders, and globs that could start with ".e"
    [`grep -rn --include=.env.staging -e x ${R}/src`, /reads an \.env file/],
    [`grep -rn --include='.env.st?ging' -e x ${R}/src`, /reads an \.env file/],
    [`rg -n -g '.env*' x ${R}/src`, /reads an \.env file/],
    [`rg -n -g '.env.local' x ${R}/src`, /reads an \.env file/],
    [`grep -e x ${R}/.env`, /reads an \.env file/],
    [`rg -n -g.env.staging x ${R}/src`, /reads an \.env file/],
    [`rg -n --glob=.env.staging x ${R}/src`, /reads an \.env file/],
    [`rg -n -g '.?nv' x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`grep -rn --include='.[eE]*' -e x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`grep -rn --include='?*' -e x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`cat ${R}/.env/x`, /reads an \.env file/],
    [`cat ${R}/config/.ENV.d/settings.json`, /reads an \.env file/],
    [`${G} show ${P}:config/.env/x`, /reads an \.env file/],
    [`rg -n -g '.env' x ${R}/src`, /could match an \.env file|reads an \.env file/],
    [`grep -rn --include=.env.staging -e x ${R}/src`, /reads an \.env file|could match/],
    // file patterns after a path
    [`grep -rn -e x ${R}/src --include='*.ts'`, /--include comes after the pattern or a path: put file patterns before the paths/],
    [`grep -rn x ${R}/src --exclude='*.md'`, /put file patterns before the paths/],
    [`rg -n x ${R}/src -g '*.ts'`, /-g comes after the pattern or a path: put file patterns before the paths/],
    // git structure
    [`git -C ${'/elsewhere'} log`, /-C must be followed by \{repo/],
    [`git -C ${R}/src log`, /-C must be followed by \{repo/],
    ['git log -1', /git needs -C/],
    [`git -c core.pager=id -C ${R} log`, /option "-c"/],
    [`${G} push origin main`, /git_read_subcommands/],
    [`${G} log --output=log.txt`, /--output is not on the allowlist for git log/],
    [`${G} log --outp=log.txt`, /--outp is not on the allowlist/],
    [`${G} log --out"put"=log.txt`, /--output is not on the allowlist/],
    [`${G} log -p --ext-diff ${P}`, /--ext-diff is not on the allowlist/],
    [`${G} grep -O x ${P}`, /-O is not on the allowlist/],
    [`${G} log --format='%G?' ${P}`, /%G/],
    [`${G} diff ${P}`, /two revisions/],
    [`${G} blame -- package.json`, /a revision/],
    [`${G} grep --no-index x`, /--no-index is not on the allowlist/],
    // per-program options
    ['grep --frobnicate x', /--frobnicate is not on the allowlist for grep/],
    [`grep --line-n x ${R}/a`, /--line-n is not on the allowlist for grep/],
    [`grep -R x ${R}`, /-R is not on the allowlist for grep/],
    // awk and jq are never run
    [`awk '{ print $1 }' ${R}/a`, /"awk" is never run/],
    [`awk -v f=sys\\164em 'BEGIN { @f("id") }'`, /"awk" is never run/],
    [`gawk '{ print }' ${R}/a`, /"gawk" is never run/],
    [`jq 'import "x" as y; .' ${R}/a.json`, /"jq" is never run/],
    // MSYS argument handling: @file, control characters, globs
    [`grep -e x @${R}/list.txt`, /may not start with @/],
    [`${G} log '@{1}'`, /may not start with @/],
    ["grep -e 'a" + String.fromCharCode(0) + "b' " + R + '/a', /control characters/],
    ["grep -e 'a" + String.fromCharCode(9) + "b' " + R + '/a', /control characters/],
    ["grep -e x '" + R + "/src/*.ts'", /glob characters .* file operands/],
    ["cat '" + R + "/src/a?.ts'", /glob characters .* file operands/],
    ["sort -t '*' " + R + '/a', /glob characters .* value of -t/],
    [`${G} log --pretty=myalias ${P}`, /neither a built-in format/],
    [`${G} log --format=medium2 ${P}`, /neither a built-in format/],
    [`sed -i 's/a/b/' ${R}/a`, /-i is not on the allowlist for sed/],
    [`sed -ni 's/a/b/p' ${R}/a`, /-i is not on the allowlist for sed/],
    [`sed --in-place=.bak 's/a/b/' ${R}/a`, /--in-place is not on the allowlist/],
    [`sed -n 'w out.txt' ${R}/a`, /command "w"/],
    [`sed 's/a/b/w out.txt' ${R}/a`, /s\/\/\/w/],
    [`sed 's/a/id/e' ${R}/a`, /s\/\/\/e/],
    [`sed -e '1e id' ${R}/a`, /command "e"/],
    [`sort -o out.txt ${R}/a`, /-o is not on the allowlist for sort/],
    [`sort --out=x ${R}/a`, /--out is not on the allowlist for sort/],
    [`sort --compress-program=x ${R}/a`, /--compress-program is not on the allowlist/],
    [`uniq ${R}/a ${R}/b`, /at most 1 file/],
    ['rg --pre=./x foo', /--pre is not on the allowlist/],
    [`tail -f ${R}/a`, /-f is not on the allowlist for tail/],
  ];
  for (const [cmd, re] of cases) {
    const r = classify(cmd, EV, ctx);
    assert.equal(r.status, 'skipped-unsafe', `${cmd} -> ${r.status}`);
    assert.match(r.reason, re, cmd);
  }
});

test('a symlink inside a repo that points outside it is refused', (t) => {
  const { dir, ctx } = classifyCtx(t);
  const outside = tmp(t, 'outside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x\n');
  try {
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  } catch (e) {
    t.skip(`symlinks not available here (${e.code})`);
    return;
  }
  const r = classify('cat {repo:notes-api}/link/secret.txt', EV, ctx);
  assert.equal(r.status, 'skipped-unsafe');
  assert.match(r.reason, /through a symlink/);
});

test('heads without an option table stay refused even if the config allows them', () => {
  const ev = { ...EV, allowed_heads: EV.allowed_heads.concat(['find', 'tee', 'xargs', 'bash', 'semgrep', 'awk', 'jq']) };
  for (const c of ['find . -name x', 'tee out', 'xargs cat', 'bash -c id', 'semgrep --config r .']) {
    const r = classify(c, ev, {});
    assert.equal(r.status, 'skipped-unsafe', c);
    assert.match(r.reason, /no option list/, c);
  }
  for (const c of ['awk 1', 'jq .']) assert.match(classify(c, ev, {}).reason, /is never run/, c);
});

// Runs the evidence runner with spawnSync wrapped, so the test sees the argv and the
// environment each program got. -> { res, calls: [{ bin, args, home }] }
function runnerTraced(t, args) {
  const dir = tmp(t, 'trace');
  const log = path.join(dir, 'spawn.log');
  const hook = path.join(dir, 'trace.js');
  fs.writeFileSync(hook, [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    'const real = cp.spawnSync;',
    'cp.spawnSync = function (bin, argv, opts) {',
    '  fs.appendFileSync(process.env.BIB_TRACE, JSON.stringify({ bin: String(bin), args: argv || [], home: opts && opts.env ? opts.env.HOME || null : null }) + "\\n");',
    '  return real.apply(this, arguments);',
    '};',
  ].join('\n'));
  const res = spawnSync(process.execPath, ['-r', hook, path.join(ROOT, 'tooling', 'run-evidence.js'), ...args], { encoding: 'utf8', timeout: 180000, env: { ...process.env, BIB_TRACE: log } });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { res, calls };
}
const base0 = () => JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-candidates.json'), 'utf8')).candidates[0];
const isSed = (c) => /(^|[\\/])sed(\.exe)?$/i.test(c.bin);

test('sed gets --sandbox, probed once in the child environment, and only when a step uses sed', (t) => {
  const { SED_FIXED, sedSandbox } = require('../tooling/run-evidence');
  assert.deepEqual(SED_FIXED, ['--sandbox']);
  assert.equal(sedSandbox(null), false, 'no sed binary: no sandbox');
  const direct = spawnSync('sed', ['--sandbox', '--version'], { encoding: 'utf8' });
  if (direct.status !== 0) { t.skip('the sed on PATH has no --sandbox'); return; }
  const cand = (id, cmd) => ({ ...base0(), id, evidence: [{ cmd, expect: 'see the output' }] });
  // No sed step: no probe.
  const plain = setup(t, 'sedless', [cand('SVC-JOBS-20', 'git -C {repo:notes-api} show {pin:notes-api}:package.json')]);
  assert.equal(kit(['pin', plain.ws]).code, 0);
  const none = runnerTraced(t, [plain.ws]);
  assert.equal(none.res.status, 0, none.res.stdout + none.res.stderr);
  assert.equal(none.calls.filter(isSed).length, 0, 'no sed step, no sed probe');
  // Two sed steps: one probe, in the child's own HOME, then --sandbox first on every sed step.
  const { ws } = setup(t, 'sedbox', [
    cand('SVC-JOBS-21', "sed -n '1p' {repo:notes-api}/package.json"),
    cand('SVC-JOBS-22', "git -C {repo:notes-api} show {pin:notes-api}:package.json | sed -n '2p'"),
  ]);
  assert.equal(kit(['pin', ws]).code, 0);
  const dry = kit(['evidence', ws, '--dry-run']);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.doesNotMatch(dry.out, /does not support --sandbox/);
  const run = runnerTraced(t, [ws]);
  assert.equal(run.res.status, 0, run.res.stdout + run.res.stderr);
  const seds = run.calls.filter(isSed);
  const probes = seds.filter((c) => c.args.includes('--version'));
  assert.equal(probes.length, 1, JSON.stringify(seds));
  assert.ok(probes[0].home && probes[0].home !== process.env.HOME, 'the probe runs in the child environment');
  const steps = seds.filter((c) => !c.args.includes('--version'));
  assert.equal(steps.length, 2);
  for (const c of steps) assert.equal(c.args[0], '--sandbox', JSON.stringify(c.args));
  assert.doesNotMatch(run.res.stderr, /does not support --sandbox/);
  const receipt = fs.readFileSync(path.join(ws, 'work', 'phase3', 'receipts', 'SVC-JOBS-21.md'), 'utf8');
  assert.match(receipt, /classification: ran\nexit code: 0\noutput \(1 line\):\n```\n\{\n```/);
});

test('.env files and folders never reach a receipt through a folder search; user includes still apply', (t) => {
  const { GREP_ENV_EXCLUDE, RG_ENV_EXCLUDE, GIT_ENV_EXCLUDE } = require('../tooling/run-evidence');
  const cand = (id, cmd) => ({ ...base0(), id, evidence: [{ cmd, expect: 'see the output' }] });
  const { ws, repo } = setup(t, 'envskip', [
    cand('SVC-JOBS-23', 'git -C {repo:notes-api} grep -n -e ENVMARKER {pin:notes-api}'),
    cand('SVC-JOBS-24', 'git -C {repo:notes-api} grep -n -e ENVMARKER {pin:notes-api} -- config'),
    cand('SVC-JOBS-25', 'grep -rn -e ENVMARKER {repo:notes-api}/config'),
    cand('SVC-JOBS-26', "grep -rn --include='*.ts' -e ENVMARKER {repo:notes-api}/config"),
    cand('SVC-JOBS-27', 'rg -n --hidden ENVMARKER {repo:notes-api}/config'),
    cand('SVC-JOBS-28', "rg -n --hidden -g '*.ts' ENVMARKER {repo:notes-api}/config"),
  ]);
  fs.mkdirSync(path.join(repo.path, 'config', '.env'), { recursive: true });
  const files = { '.env': 'root', 'config/.env/x': 'in an .env folder', 'config/.ENV.local': 'upper', 'config/.env.staging': 'staging',
    'config/app.txt': 'app.txt', 'config/app.ts': 'app.ts', 'config/data.json': 'data.json' };
  for (const [rel, v] of Object.entries(files)) fs.writeFileSync(path.join(repo.path, rel), `ENVMARKER ${v}\n`);
  git(repo.path, ['add', '-A']);
  git(repo.path, ['commit', '-q', '-m', 'add config']);
  assert.equal(kit(['pin', ws]).code, 0);
  const run = runnerTraced(t, [ws]);
  assert.equal(run.res.status, 0, run.res.stdout + run.res.stderr);
  const dir = path.join(ws, 'work', 'phase3', 'receipts');
  const receipt = (id) => fs.readFileSync(path.join(dir, `${id}.md`), 'utf8');
  const hidden = /ENVMARKER (root|in an \.env folder|upper|staging)/;
  for (const id of ['SVC-JOBS-23', 'SVC-JOBS-24', 'SVC-JOBS-25']) {
    assert.match(receipt(id), /ENVMARKER app\.txt/, `${id} still searches`);
    assert.match(receipt(id), /ENVMARKER data\.json/, `${id} still searches`);
    assert.doesNotMatch(receipt(id), hidden, `${id} showed an .env file`);
  }
  // Regression guard: the user's include still limits the search.
  assert.match(receipt('SVC-JOBS-26'), /ENVMARKER app\.ts/);
  assert.doesNotMatch(receipt('SVC-JOBS-26'), /app\.txt|data\.json/);
  assert.doesNotMatch(receipt('SVC-JOBS-26'), hidden);
  // rg: checked only when it is installed; otherwise the receipt says it was not found.
  const rg = receipt('SVC-JOBS-27');
  if (/classification: ran/.test(rg)) {
    assert.match(rg, /ENVMARKER app\.txt/);
    assert.doesNotMatch(rg, hidden);
    assert.match(receipt('SVC-JOBS-28'), /ENVMARKER app\.ts/);
    assert.doesNotMatch(receipt('SVC-JOBS-28'), /app\.txt|data\.json/);
    const rgCall = run.calls.find((c) => /(^|[\\/])rg(\.exe)?$/i.test(c.bin) && c.args.includes('*.ts'));
    assert.ok(rgCall && rgCall.args.indexOf('*.ts') < rgCall.args.indexOf(RG_ENV_EXCLUDE[0]), 'the kit glob comes after the user glob');
  } else {
    assert.match(rg, /program not found: rg/);
    t.diagnostic('rg is not installed: the rg receipts were not checked (skipped)');
  }
  // Argv order: the kit's excludes come after every user option.
  const named = (re) => run.calls.filter((c) => re.test(c.bin));
  const greps = named(/(^|[\\/])grep(\.exe)?$/i);
  assert.equal(greps.length, 2);
  for (const c of greps) {
    const at = c.args.indexOf(GREP_ENV_EXCLUDE[0]);
    assert.ok(at > 0, JSON.stringify(c.args));
    assert.deepEqual(c.args.slice(at, at + 2), GREP_ENV_EXCLUDE);
    const userOpts = c.args.map((a, i) => (a.startsWith('-') && !GREP_ENV_EXCLUDE.includes(a) ? i : -1)).filter((i) => i >= 0);
    assert.ok(userOpts.every((i) => i < at), `kit excludes come last: ${JSON.stringify(c.args)}`);
    // ... and right before the first operand: only the path follows (the pattern is an -e value).
    assert.deepEqual(c.args.slice(at + 2).map((x) => x.replace(/\\/g, '/').endsWith('/config')), [true], JSON.stringify(c.args));
  }
  const inc = greps.find((c) => c.args.includes('--include=*.ts'));
  assert.ok(inc && inc.args.indexOf('--include=*.ts') < inc.args.indexOf(GREP_ENV_EXCLUDE[0]));
  const gitGreps = named(/(^|[\\/])git(\.exe)?$/i).filter((c) => c.args.includes('grep'));
  assert.equal(gitGreps.length, 2);
  for (const c of gitGreps) assert.deepEqual(c.args.slice(-2), GIT_ENV_EXCLUDE);
  assert.ok(Array.isArray(RG_ENV_EXCLUDE) && RG_ENV_EXCLUDE[0].startsWith('--iglob=!'));
});

test('the kit puts its excludes after the step options, never inside an option value', () => {
  const { optionsEnd, TABLES } = require('../tooling/run-evidence');
  assert.equal(optionsEnd(['-n', '-e', 'x', '--', 'p'], TABLES.grep), 3);
  assert.equal(optionsEnd(['-e', '--', 'x'], TABLES.grep), -1, 'a "--" that is the value of -e');
  assert.equal(optionsEnd(['--regexp', '--', 'p'], TABLES.grep), -1);
  assert.equal(optionsEnd(['-g', '--', 'x'], TABLES.rg), -1);
  assert.equal(optionsEnd(['-n', 'x', '--', 'p'], TABLES.rg), 2);
  const { beforeFirstOperand } = require('../tooling/run-evidence');
  const K = ['KIT'];
  // After the user's own file patterns, right before the first operand (pattern or path).
  assert.deepEqual(beforeFirstOperand(['-rn', '--include=*.ts', 'pat', '/r/src'], TABLES.grep, K), ['-rn', '--include=*.ts', 'KIT', 'pat', '/r/src']);
  assert.deepEqual(beforeFirstOperand(['-rn', '--include', '*.ts', '-e', 'x', '/r/src'], TABLES.grep, K), ['-rn', '--include', '*.ts', '-e', 'x', 'KIT', '/r/src']);
  assert.deepEqual(beforeFirstOperand(['-rn', '-e', '--', '/r/src'], TABLES.grep, K), ['-rn', '-e', '--', 'KIT', '/r/src'], 'an -e value is not an operand');
  assert.deepEqual(beforeFirstOperand(['-rn', '--', 'pat', '/r'], TABLES.grep, K), ['-rn', 'KIT', '--', 'pat', '/r']);
  assert.deepEqual(beforeFirstOperand(['-n', '-g', '*.ts', 'pat', '/r'], TABLES.rg, K), ['-n', '-g', '*.ts', 'KIT', 'pat', '/r']);
});

test('include patterns that name an .env file are refused; broad patterns run', () => {
  const { globCouldMatchEnv } = require('../tooling/run-evidence');
  for (const g of ['.env', '.env.local', '.env*', '.env.staging', '.env.st?ging', '.en?', '*.env*', '.en[v]', '.?nv', '*', '?*',
    '.{env,cfg}', '.EN[V]*', '*env*', '.env/*.ts']) {
    assert.equal(globCouldMatchEnv(g), true, g);
  }
  for (const g of ['*.ts', '*.json', 'src/*.ts', 'src/**/*.ts', '*/x.ts', '*.e2e.ts', '.envrc', '!.env*', '?', '*.{ts,tsx}', 'app.config', 'environment.ts']) {
    assert.equal(globCouldMatchEnv(g), false, g);
  }
});

test('lexer and sed parser details', () => {
  const lx = lex("grep -e 'a b' \"c\\\"d\" e\\ f {repo:x} '{repo:x}' {repo:x}/s", (k) => (k === 'repo' ? 'R' : null));
  assert.deepEqual(lx.steps[0].words.map((w) => w.v), ['grep', '-e', 'a b', 'c"d', 'e f', 'R', 'R', 'R/s']);
  assert.deepEqual(lx.steps[0].words.map((w) => w.repo), [null, null, null, null, null, 'x', 'x', null]);
  assert.equal(sedScriptProblem('/start/,/end/{p}'), null);
  assert.equal(sedScriptProblem('$!N;P;D'), null);
  assert.match(sedScriptProblem('r /x'), /command "r"/);
});

// ---------- the pipeline on the fixture repo ----------

test('pin, doctor, evidence, check-unchanged and scan-secrets on the fixture repo', (t) => {
  const { ws, repo } = setup(t, 'evidence');

  const before = kit(['doctor', ws, '--no-optional']);
  assert.equal(before.code, 1, 'doctor is red before pinning');
  assert.match(before.out, /FAIL pins/);

  const pin = kit(['pin', ws]);
  assert.equal(pin.code, 0, pin.out + pin.err);
  const pins = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'pins.json'), 'utf8'));
  assert.deepEqual(validatePins(pins), []);
  assert.equal(pins.repos['notes-api'].sha, repo.sha);
  assert.equal(pins.repos['notes-api'].short, repo.sha.slice(0, 10));
  assert.equal(pins.allow_dirty, false);
  const baseline = fs.readFileSync(path.join(ws, 'work', 'phase0-baseline.md'), 'utf8');
  assert.match(baseline, new RegExp(repo.sha.slice(0, 10)));
  assert.ok(!baseline.includes(repo.path), 'no folder path in the baseline');

  const doctor = kit(['doctor', ws]);
  assert.equal(doctor.code, 0, doctor.out + doctor.err);
  assert.match(doctor.out, /all required checks passed/);
  assert.match(doctor.out, /claude --model \S+ --effort \S+ --add-dir "/);
  assert.match(doctor.out, /\/hooks/);

  const dry = kit(['evidence', ws, '--dry-run']);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /1 would run, 1 skipped-live, 7 skipped-unsafe; nothing written/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'phase3', 'receipts')));

  const receipts = path.join(ws, 'work', 'phase3', 'receipts');
  const first = kit(['evidence', ws]);
  assert.equal(first.code, 0, first.out + first.err);
  const run1 = readDir(receipts);
  const second = kit(['evidence', ws]);
  assert.equal(second.code, 0, second.out + second.err);
  assert.deepEqual(readDir(receipts), run1, 'receipts are byte-identical across runs');

  const index = JSON.parse(run1['_index.json']);
  assert.deepEqual(index.totals, { ran: 1, failed: 0, skipped_live: 1, skipped_unsafe: 7, skipped_error: 0 });
  const reasons = Object.fromEntries(index.candidates.map((c) => [c.id, c.commands[0]]));
  assert.equal(reasons['SVC-JOBS-01'].status, 'ran');
  assert.equal(reasons['DATA-INDEX-01'].status, 'skipped-live');
  const unsafe = {
    'SVC-IMPORT-01': /"awk" is never run/, 'SVC-IMPORT-02': /-i is not on the allowlist for sed/, 'DATA-INDEX-02': /-o is not on the allowlist for sort/,
    'OPS-RUNTIME-01': /--output is not on the allowlist/, 'SVC-JOBS-02': /redirection/, 'SVC-IMPORT-03': /"tee"/, 'DATA-INDEX-03': /"find"/,
  };
  for (const [id, re] of Object.entries(unsafe)) {
    assert.equal(reasons[id].status, 'skipped-unsafe', id);
    assert.match(reasons[id].reason, re, id);
  }
  const ran = run1['SVC-JOBS-01.md'];
  assert.match(ran, /^receipt: [0-9a-f]{12}\n/);
  assert.match(ran, /removeOnFail: false/);
  assert.match(ran, /date: 2027-03-08/);
  assert.match(ran, new RegExp(`pins: notes-api@${repo.sha}`));
  assert.match(ran, /classification: ran\nexit code: 0/);
  for (const text of Object.values(run1)) assert.ok(!text.includes(repo.path) && !text.includes(repo.path.replace(/\\/g, '/')), 'no local folder in receipts');

  assert.equal(kit(['check', 'unchanged', ws]).code, 0, 'nothing changed the repo');

  const clean = kit(['check', 'secrets', ws]);
  assert.equal(clean.code, 0, clean.out + clean.err);
  const rec = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'secrets-scan.json'), 'utf8'));
  assert.equal(rec.result, 'clean');
  for (const f of ['audit.config.json', 'work/candidates.json', 'work/pins.json', 'work/phase0-baseline.md', 'work/phase3/receipts/_index.json', 'work/phase3/receipts/SVC-JOBS-01.md']) {
    assert.ok(rec.files.includes(f), `${f} scanned`);
  }
  assert.ok(fs.existsSync(path.join(ws, 'work', 'secrets-scan.md')));

  const key = 'AK' + 'IA' + 'NOTESFIXTURE0001';
  fs.mkdirSync(path.join(ws, 'system-docs'));
  fs.writeFileSync(path.join(ws, 'HANDOFF.md'), `# Handoff\n\nA pasted key: ${key}\n`);
  const dirty = kit(['check', 'secrets', ws]);
  assert.equal(dirty.code, 1, dirty.out + dirty.err);
  const rec2 = fs.readFileSync(path.join(ws, 'work', 'secrets-scan.json'), 'utf8');
  assert.equal(JSON.parse(rec2).result, 'hits');
  assert.deepEqual(JSON.parse(rec2).hits.map((h) => [h.file, h.line, h.label]), [['HANDOFF.md', 3, 'cloud-access-key']]);
  assert.ok(!rec2.includes(key), 'the hit is masked in the record');
  assert.ok(!dirty.out.includes(key), 'the hit is masked on the console');

  fs.appendFileSync(path.join(repo.path, 'src', 'jobs', 'notify.queue.ts'), '// edited\n');
  const changed = kit(['check', 'unchanged', ws]);
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /FAIL notes-api: 1 uncommitted change/);
  assert.equal(kit(['doctor', ws, '--no-optional']).code, 1, 'doctor is red once a repo changed');
});

test('the runner wires pipes, keeps 2>&1, and withholds output that matches a secret pattern', (t) => {
  const base = JSON.parse(fs.readFileSync(path.join(DATA, 'fixture-candidates.json'), 'utf8')).candidates[0];
  const cand = (id, cmd) => ({ ...base, id, evidence: [{ cmd, expect: 'see the output' }] });
  const { ws, repo } = setup(t, 'runner', [
    cand('SVC-JOBS-11', 'git -C {repo:notes-api} show {pin:notes-api}:package.json | head -n 3 | tail -n 1'),
    cand('SVC-JOBS-12', 'cat {repo:notes-api}/config/keys.txt'),
    cand('SVC-JOBS-13', 'git -C {repo:notes-api} log -1 {pin:notes-api}'),
    cand('SVC-JOBS-14', "git -C {repo:notes-api} log -1 --format='%h %an %s' {pin:notes-api}"),
    cand('SVC-JOBS-15', 'git -C {repo:notes-api} show {pin:notes-api}:missing.txt 2>&1 | wc -l'),
    cand('SVC-JOBS-16', 'rg -n removeOnFail {repo:notes-api}/src'),
  ]);
  fs.mkdirSync(path.join(repo.path, 'config'));
  fs.writeFileSync(path.join(repo.path, 'config', 'keys.txt'), `key = ${'AK' + 'IA' + 'NOTESFIXTURE0002'}\n`);
  git(repo.path, ['add', '-A']);
  git(repo.path, ['commit', '-q', '-m', 'add keys']);
  assert.equal(kit(['pin', ws]).code, 0);

  // --only: one candidate, one command, printed and not written
  const one = kit(['evidence', ws, '--only', 'SVC-JOBS-11', '--cmd', '1']);
  assert.equal(one.code, 0, one.out + one.err);
  assert.match(one.out, /^receipt: [0-9a-f]{12}\n# Evidence receipt: SVC-JOBS-11/);
  assert.match(one.out, /"version": "0.1.0",/);
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'phase3', 'receipts')), '--only writes nothing');
  assert.match(kit(['evidence', ws, '--only', 'SVC-JOBS-99']).err, /no candidate "SVC-JOBS-99"/);
  assert.equal(kit(['evidence', ws, '--only', 'SVC-JOBS-11', '--cmd', '2']).code, 2);
  assert.equal(kit(['evidence', ws, '--cmd', '1']).code, 2);

  const r = kit(['evidence', ws]);
  assert.equal(r.code, 0, r.out + r.err);
  const dir = path.join(ws, 'work', 'phase3', 'receipts');
  const read = (id) => fs.readFileSync(path.join(dir, `${id}.md`), 'utf8');
  assert.match(read('SVC-JOBS-11'), /exit code: 0\noutput \(1 line\):\n```\n {2}"version": "0.1.0",\n```/);
  assert.match(read('SVC-JOBS-12'), /\[output withheld: cloud-access-key\]/);
  assert.ok(!read('SVC-JOBS-12').includes('NOTESFIXTURE0002'));
  assert.match(read('SVC-JOBS-13'), /\[output withheld: email-address\]/);
  assert.match(read('SVC-JOBS-14'), /output \(1 line\):\n```\n[0-9a-f]{7,} Fixture Author add keys\n```/);
  assert.match(read('SVC-JOBS-15'), /output \(1 line\):\n```\n1\n```/, 'the error line went down the pipe');
  assert.equal(one.out.split('\n').slice(0, 1)[0], read('SVC-JOBS-11').split('\n')[0], '--only gives the same receipt as a full run');
  // rg is allowed but may not be installed: then it is a readable skipped-error
  const rg = read('SVC-JOBS-16');
  assert.ok(/classification: ran/.test(rg) || /classification: skipped-error\nreason: program not found: rg/.test(rg), rg);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

test('pin refuses a dirty repo unless --allow-dirty, and later edits are detected', (t) => {
  const { ws, repo } = setup(t, 'dirty');
  fs.mkdirSync(path.join(repo.path, 'scratch'));
  fs.writeFileSync(path.join(repo.path, 'scratch', 'one.txt'), 'local note\n');
  fs.writeFileSync(path.join(repo.path, 'scratch', 'two.txt'), 'another note\n');
  const refused = kit(['pin', ws]);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /notes-api: 2 uncommitted changes/, 'every untracked file counts');
  assert.ok(!fs.existsSync(path.join(ws, 'work', 'pins.json')));

  const allowed = kit(['pin', ws, '--allow-dirty']);
  assert.equal(allowed.code, 0, allowed.out + allowed.err);
  const pins = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'pins.json'), 'utf8'));
  assert.equal(pins.allow_dirty, true);
  assert.equal(pins.repos['notes-api'].porcelain, 2);
  assert.match(fs.readFileSync(path.join(ws, 'work', 'phase0-baseline.md'), 'utf8'), /--allow-dirty/);
  assert.equal(kit(['check', 'unchanged', ws]).code, 0, 'the same changes as at pin time pass');

  fs.writeFileSync(path.join(repo.path, 'scratch', 'one.txt'), 'edited note\n');
  assert.equal(kit(['check', 'unchanged', ws]).code, 1, 'an edit to an untracked file is detected');
  fs.writeFileSync(path.join(repo.path, 'scratch', 'one.txt'), 'local note\n');
  assert.equal(kit(['check', 'unchanged', ws]).code, 0);
  fs.appendFileSync(path.join(repo.path, 'package.json'), '\n');
  assert.equal(kit(['check', 'unchanged', ws]).code, 1, 'an edit to a tracked file is detected');
});

test('evidence without pins is a readable usage error', (t) => {
  const { ws } = setup(t, 'nopins');
  const r = kit(['evidence', ws]);
  assert.equal(r.code, 2);
  assert.match(r.err, /run `kit pin`/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});
