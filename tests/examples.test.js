'use strict';
// Tests for the configs under examples/: the planned public worked example is
// valid only in example mode, and the invented demo config is valid as is.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');
const NOVU = path.join(ROOT, 'examples', 'novu-v3.19.0');
const DEMO = path.join(ROOT, 'examples', 'demo-config');

function validate(args) {
  const res = spawnSync(process.execPath, [KIT, 'validate', ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test('novu example plan validates in example mode', () => {
  const r = validate([NOVU, '--example']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.trim(), 'OK');
});

test('novu example plan fails readably without --example', () => {
  const r = validate([NOVU]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /audit\.config\.json: \d+ errors?/);
  assert.match(r.out, /repos\[0\]\.path: required \(a url\/ref repo without a path is allowed only in example mode/);
  assert.match(r.out, /repos\[0\]\.pin: "TODO" is allowed only in example mode/);
  assert.doesNotMatch(r.out + r.err, /\n\s+at /, 'no stack trace');
});

test('novu example plan keeps its pin as TODO and stays out of the enterprise folders', () => {
  const cfg = require(path.join(NOVU, 'audit.config.json'));
  const repo = cfg.repos[0];
  assert.equal(repo.pin, 'TODO');
  assert.equal(repo.ref, 'v3.19.0');
  assert.ok(repo.exclude.includes('enterprise/'));
  assert.ok(!repo.include.some((p) => p.startsWith('enterprise')));
});

test('demo config validates without --example', () => {
  const r = validate([DEMO]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.trim(), 'OK');
});
