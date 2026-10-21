'use strict';
// The bundled TypeScript rules against the fixture repo: exactly the rules
// for the planted problems fire, each on its planted line. Skipped when
// semgrep is not on PATH (it is an external tool, never a kit dependency).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');
const { which } = require('./run-all');

const ROOT = path.join(__dirname, '..');

// rule id -> the planted file and line it must report.
const PLANTED = {
  'scale-unbounded-tenant-scoped-find': 'src/modules/notes/notes.repository.ts:6',
  'scale-await-remote-call-in-loop': 'src/modules/imports/import.service.ts:9',
  'scale-offset-pagination-loop': 'src/modules/imports/import.service.ts:19',
  'scale-http-call-without-timeout': 'src/clients/search.client.ts:2',
  'scale-queue-keeps-failed-jobs-forever': 'src/jobs/notify.queue.ts:8',
};

const semgrep = which('semgrep');

test('the bundled TypeScript rules fire exactly on the planted problems of the fixture repo', { skip: semgrep ? false : 'semgrep not on PATH', timeout: 300000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-semgrep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const repo = makeFixtureRepo(path.join(dir, 'notes-api')).path;
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(semgrep);
  const args = ['--config', path.join(ROOT, 'rules', 'semgrep', 'typescript'), '--json', '--metrics=off', '--disable-version-check', '--quiet', repo];
  const res = spawnSync(shell ? `"${semgrep}"` : semgrep, shell ? args.map((a) => `"${a}"`) : args,
    { encoding: 'utf8', timeout: 280000, maxBuffer: 64 * 1024 * 1024, shell, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(!res.error, res.error && res.error.message);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.errors, [], 'semgrep reported errors');
  const fired = out.results.map((r) => {
    const id = r.check_id.split('.').pop();
    const file = path.relative(repo, path.resolve(repo, r.path)).split(path.sep).join('/');
    return `${id} ${file}:${r.start.line}`;
  }).sort();
  t.diagnostic(`fired: ${fired.join(' | ')}`);
  assert.deepEqual(fired, Object.entries(PLANTED).map(([id, at]) => `${id} ${at}`).sort());
});
