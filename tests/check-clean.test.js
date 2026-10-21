'use strict';
// Tests for tooling/check-clean.js. Dirty strings are assembled at runtime so
// that this file itself scans clean.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tooling', 'check-clean.js');
const tool = require(TOOL);
const BS = String.fromCharCode(92);
const AT = String.fromCharCode(64);
const HAS_GIT = spawnSync('git', ['--version']).status === 0;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `check-clean-${name}-`));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 60000, ...opts });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function sh(cwd, args, input) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', input });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// A workspace with one clean note and nothing else.
function cleanTree() {
  const root = tmpDir('clean');
  write(root, 'notes/welcome.md', '# Welcome\n\nWorkspaces hold notes; users import them.\n');
  return root;
}

function denyFile(content) {
  return write(tmpDir('priv'), 'deny.txt', content);
}

test('clean tree exits 0 and reports the file count', () => {
  const root = cleanTree();
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /summary: files=1 must=0 review=0/);
  assert.match(r.err, /warning: no --denylist given/);
});

test('user-home path is a must-zero hit', () => {
  const root = cleanTree();
  const home = ['C', ':', BS, 'Users', BS, 'someone', BS, 'notes'].join('');
  write(root, 'notes/setup.md', `Clone into ${home} first.\n`);
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /notes\/setup\.md:1: \[must\]\[D\] user-home-path:/);
});

test('extended built-ins: home forms, tokens, cloud keys, credentialed URIs', () => {
  const root = cleanTree();
  const samples = [
    ['/', 'home', '/', 'someone'].join(''),
    [BS, 'Users', BS, 'someone', BS, 'x'].join(''),
    ['%2F', 'Users', '%2F', 'someone'].join(''),
    ['g', 'ho_', 'abc123'].join(''),
    ['g', 'hs_', 'abc123'].join(''),
    ['xo', 'xb-', '1234'].join(''),
    ['sk', '-proj-', 'abcd'].join(''),
    ['AS', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['post', 'gresql', '://', 'app', ':', 'secret', AT, 'db.local/notes'].join(''),
    ['my', 'sql', '://', 'app', ':', 'secret', AT, 'db.local'].join(''),
    ['am', 'qps', '://', 'app', ':', 'secret', AT, 'mq.local'].join(''),
  ];
  write(root, 'notes/leaks.txt', samples.join('\n') + '\n');
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  samples.forEach((_, i) => assert.match(r.out, new RegExp(`leaks\\.txt:${i + 1}: \\[must\\]\\[D\\]`), `sample ${i + 1}`));
  // Ordinary words must not trip the case-sensitive cloud-key rule.
  write(root, 'notes/words.txt', 'the asiapacificregions report\nopen /homepage now\n');
  assert.doesNotMatch(run(['.'], { cwd: root }).out, /words\.txt/);
});

test('email address is a must-zero hit', () => {
  const root = cleanTree();
  write(root, 'notes/contact.txt', `line one\nwrite to ops${AT}notes-platform.example now\n`);
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /notes\/contact\.txt:2: \[must\]\[D\] email-address:/);
});

test('UTF-16 files with a byte-order mark are decoded and scanned', () => {
  const root = cleanTree();
  const text = `first\nmail ops${AT}notes-platform.example\n`;
  write(root, 'notes/le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const be = Buffer.from(text, 'utf16le').swap16();
  write(root, 'notes/be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /notes\/le\.txt:2: \[must\]\[D\] email-address:/);
  assert.match(r.out, /notes\/be\.txt:2: \[must\]\[D\] email-address:/);
  assert.doesNotMatch(r.out, /unscanned-binary/);
});

test('undecodable binary is a must-zero hit, exemptable with allow', () => {
  const root = cleanTree();
  write(root, 'exports/notes.gz', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x41]));
  write(root, 'assets/logo.bin', Buffer.from([0x00, 0x01, 0x02]));
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /exports\/notes\.gz:0: \[must\]\[F\] unscanned-binary:/);
  assert.match(r.out, /assets\/logo\.bin:0: \[must\]\[F\] unscanned-binary:/);
  const deny = denyFile('allow unscanned-binary assets/*.bin\n');
  const r2 = run(['--denylist', deny, '.'], { cwd: root });
  assert.doesNotMatch(r2.out, /logo\.bin/);
  assert.match(r2.out, /notes\.gz:0: \[must\]\[F\] unscanned-binary/);
});

test('long single lines finish quickly (bounded patterns)', () => {
  const root = cleanTree();
  const unit = ['red', 'is://', 'u'.repeat(100), ':', 'p'.repeat(90)].join('') +
    ['mongo', 'db://', 'h'.repeat(80)].join('') + 'x'.repeat(10);
  const line = unit.repeat(300);
  assert.ok(line.length >= 60 * 1024, `line is ${line.length} chars`);
  write(root, 'notes/long.txt', line + '\n');
  const t0 = Date.now();
  const r = run(['.'], { cwd: root });
  const ms = Date.now() - t0;
  assert.equal(r.code, 0, r.out);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test('denylist rule honours @except and is case-insensitive', () => {
  const root = cleanTree();
  const deny = denyFile('# private\nmust A quillfern @except LICENSE\nreview-cs Q Zebrine\n');
  write(root, 'LICENSE', 'Copyright quillfern\n');
  write(root, 'docs/guide.md', 'intro\nBuilt by Quillfern.\nzebrine lowercase is fine\n');
  const r = run(['--denylist', deny, '.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/guide\.md:2: \[must\]\[A\] denylist:2:/);
  assert.doesNotMatch(r.out, /LICENSE:/);
  assert.doesNotMatch(r.out, /\[Q\]/, 'case-sensitive rule must not match lowercase');
  assert.match(r.out, /A=1\/0/);
  assert.doesNotMatch(r.err, /warning/);
});

test('glob "**/" matches zero or more directories', () => {
  const any = tool.globToRegExp('**/LICENSE');
  assert.ok(any.test('LICENSE'));
  assert.ok(any.test('a/b/LICENSE'));
  assert.ok(!any.test('xLICENSE'));
  const docs = tool.globToRegExp('docs/**/*.md');
  assert.ok(docs.test('docs/a.md'));
  assert.ok(docs.test('docs/x/y/a.md'));
  assert.ok(!docs.test('docsx/a.md'));
  assert.ok(!tool.globToRegExp('docs/*.md').test('docs/x/a.md'));
});

test('single file path: @except matches the path relative to the git root', { skip: !HAS_GIT }, () => {
  const repo = tmpDir('repo');
  sh(repo, ['init', '-q']);
  write(repo, 'docs/NOTE.md', 'by quillfern\n');
  const deny = denyFile('must A quillfern @except docs/NOTE.md\n');
  assert.equal(run(['--denylist', deny, 'docs/NOTE.md'], { cwd: repo }).code, 0);
  assert.equal(run(['--denylist', deny, 'NOTE.md'], { cwd: path.join(repo, 'docs') }).code, 0);
  const other = denyFile('must A quillfern @except NOTE.md\n');
  assert.equal(run(['--denylist', other, 'docs/NOTE.md'], { cwd: repo }).code, 1);
});

test('--stdin scans piped text', () => {
  const deny = denyFile('must A quillfern\n');
  const r = run(['--denylist', deny, '--stdin'], { input: 'commit one\n+ added Quillfern here\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /<stdin>:2: \[must\]\[A\] denylist:1:/);
  const clean = run(['--denylist', deny, '--stdin'], { input: 'nothing to see\n' });
  assert.equal(clean.code, 0);
});

test('--stdin with a NUL byte still scans (never fails open)', () => {
  const deny = denyFile('must A quillfern\n');
  const r = run(['--denylist', deny, '--stdin'], { input: 'bin\0ary\n+ Quillfern\n' });
  assert.equal(r.code, 1);
});

test('--staged scans index content, including symlink targets', { skip: !HAS_GIT }, () => {
  const repo = tmpDir('staged');
  sh(repo, ['init', '-q']);
  const deny = denyFile('must A quillfern\n');
  write(repo, 'notes/a.md', 'clean text\n');
  sh(repo, ['add', 'notes/a.md']);
  write(repo, 'notes/a.md', 'now by quillfern\n'); // work tree dirty, index clean
  assert.equal(run(['--denylist', deny, '--staged', '.'], { cwd: repo }).code, 0);
  assert.equal(run(['--denylist', deny, '.'], { cwd: repo }).code, 1);
  sh(repo, ['add', 'notes/a.md']);
  const r = run(['--denylist', deny, '--staged', '.'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.out, /notes\/a\.md:1: \[must\]\[A\]/);
  // A staged symlink whose target string leaks a home path.
  const repo2 = tmpDir('staged-link');
  sh(repo2, ['init', '-q']);
  const target = ['/', 'home', '/', 'someone', '/notes'].join('');
  const sha = sh(repo2, ['hash-object', '-w', '--stdin'], target);
  sh(repo2, ['update-index', '--add', '--cacheinfo', `120000,${sha},link`]);
  const r2 = run(['--staged', '.'], { cwd: repo2 });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /link:1: \[must\]\[D\] user-home-path/);
  assert.equal(run(['--staged', '.'], { cwd: tmpDir('not-git') }).code, 2);
});

test('work-tree symlinks are scanned as their target string', (t) => {
  const root = cleanTree();
  const target = ['/', 'home', '/', 'someone', '/notes'].join('');
  try { fs.symlinkSync(target, path.join(root, 'link')); }
  catch (e) { t.skip(`symlinks unavailable: ${e.code}`); return; }
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /link:1: \[must\]\[D\] user-home-path/);
});

test('shared 8-gram: must in markdown, review in code', () => {
  const priv = tmpDir('src');
  const sentence = 'the importer reads each note before it writes the index';
  write(priv, 'source.md', `Original: ${sentence}.\n`);
  const root = cleanTree();
  write(root, 'docs/copy.md', `Intro.\nHere, The Importer reads each note, before it writes the index!\n`);
  write(root, 'lib/copy.js', `// ${sentence}\n`);
  const r = run(['--ngram-source', priv, '.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/copy\.md:2: \[must\]\[G\] shared-8-gram:/);
  assert.match(r.out, /lib\/copy\.js:1: \[review\]\[G\] shared-8-gram:/);
  // one hit per shared run, not one per overlapping gram
  assert.equal((r.out.match(/docs\/copy\.md/g) || []).length, 1);

  const codeOnly = cleanTree();
  write(codeOnly, 'lib/copy.js', `// ${sentence}\n`);
  assert.equal(run(['--ngram-source', priv, '.'], { cwd: codeOnly }).code, 0);
  assert.equal(run(['--strict', '--ngram-source', priv, '.'], { cwd: codeOnly }).code, 1);
});

test('forbidden extension and oversize file are must-zero; suspect paths are review', () => {
  const root = cleanTree();
  write(root, 'slides.pptx', 'not really slides');
  write(root, 'big.txt', 'x'.repeat(500 * 1024 + 1));
  write(root, 'out/receipts/run.json', '{}\n');
  write(root, 'out/results/run.json', '{}\n');
  write(root, 'out/system-docs/a.md', 'a\n');
  write(root, 'work/candidates.json', '[]\n');
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.out, /slides\.pptx:0: \[must\]\[F\] forbidden-extension: \.pptx/);
  assert.match(r.out, /big\.txt:0: \[must\]\[F\] file-too-large:/);
  for (const p of ['out/receipts/run.json', 'out/results/run.json', 'out/system-docs/a.md', 'work/candidates.json']) {
    assert.match(r.out, new RegExp(p.replace(/[./]/g, (c) => BS + c) + ':0: \\[review\\]\\[F\\] suspect-path:'));
  }
});

test('review-only hits exit 0, or 1 with --strict', () => {
  const root = cleanTree();
  write(root, 'notes/ref.md', `pinned at ${'ab'.repeat(20)}\n`);
  const r = run(['.'], { cwd: root });
  assert.equal(r.code, 0);
  assert.match(r.out, /\[review\]\[E\] hex-40:/);
  assert.equal(run(['--strict', '.'], { cwd: root }).code, 1);
});

test('usage and config errors exit 2', () => {
  const root = cleanTree();
  assert.equal(run(['--bogus'], { cwd: root }).code, 2);
  assert.equal(run(['--denylist'], { cwd: root }).code, 2);
  assert.equal(run(['--denylist', path.join(root, 'missing.txt'), '.'], { cwd: root }).code, 2);
  assert.equal(run(['no-such-dir'], { cwd: root }).code, 2);
  const empty = run(['.'], { cwd: tmpDir('empty') });
  assert.equal(empty.code, 2);
  assert.match(empty.err, /no files to scan/);
  const bad = denyFile('must A (unclosed\n');
  const r = run(['--denylist', bad, '.'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.err, /deny\.txt:1: invalid regex/);
  assert.equal(run(['--denylist', denyFile('maybe A word\n'), '.'], { cwd: root }).code, 2);
});

test('fs read errors give one readable line and exit 2', (t) => {
  const root = cleanTree();
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).endsWith('welcome.md')) {
      const e = new Error('resource busy');
      e.code = 'EBUSY';
      throw e;
    }
    return real.call(fs, p, ...rest);
  });
  const out = [];
  const err = [];
  const code = tool.main([root], { out: (s) => out.push(s), err: (s) => err.push(s), readStdin: () => Buffer.alloc(0) });
  assert.equal(code, 2);
  assert.ok(err.some((l) => /cannot read .*welcome\.md: EBUSY/.test(l)), err.join('\n'));
  assert.ok(!err.some((l) => /\n\s+at /.test(l)), 'no stack trace');
});

test('output order is deterministic', () => {
  const root = cleanTree();
  write(root, 'b.md', `x ${AT}${'c'.repeat(10)}: y\n`);
  write(root, 'a.md', `x ${AT}${'d'.repeat(10)}: y\n`);
  const one = run(['.'], { cwd: root }).out;
  const two = run(['.'], { cwd: root }).out;
  assert.equal(one, two);
  assert.ok(one.indexOf('a.md') < one.indexOf('b.md'));
});
