#!/usr/bin/env node
'use strict';
/*
 * run-all.js - every check a contributor runs before a pull request, in
 * one command, with a summary table at the end.
 *
 * Usage:
 *   node tests/run-all.js [--verbose]
 *
 *   --verbose  print the full output of every step (by default only the
 *              last lines of a step that failed are printed).
 *
 * Steps, in order (each runs from the kit root, with stdin closed and a
 * time limit):
 *   1. node --check on every .js / .mjs file git tracks or would add
 *      (untracked files that are not ignored count too)
 *   2. node --test tests/*.test.js
 *   3. node tooling/check-workflows.js
 *   4. node tooling/check-plugin.js
 *   5. node tooling/validate-config.js examples/demo-config
 *   6. node tooling/validate-config.js examples/novu-v3.19.0 --example
 *   7. node tooling/check-links.js . README.md docs examples
 *   8. node tooling/check-clean.js .  (the built-in generic checks; with
 *      the BIB_DENYLIST environment variable set to a private denylist
 *      file, that file is passed as --denylist)
 *   9. bash rules/semgrep/run-tests.sh   (SKIP when semgrep is not on PATH)
 *  10. claude plugin validate . --strict (SKIP when claude is not on PATH)
 *
 * Exit codes: 0 every step that ran passed, 1 at least one step failed,
 * 2 usage error.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TAIL_LINES = 40;
const MIN = 60 * 1000;

// Finds a command on PATH; returns its full path or null. On Windows only
// files with a PATHEXT extension count: an extension-less file there is
// usually a shell script for Git Bash, which spawnSync cannot start.
function which(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

// The .js / .mjs files git tracks, plus untracked files that are not ignored.
function sourceFiles() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: MIN });
  if (r.error || r.status !== 0) return { error: `git ls-files failed: ${r.error ? r.error.message : (r.stderr || '').trim()}` };
  return { files: r.stdout.split('\0').filter((f) => /\.(js|mjs)$/.test(f) && fs.existsSync(path.join(ROOT, f))).sort() };
}

function testFiles() {
  return fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('tests', f));
}

// Runs one command; returns { ok, code, output, ms }.
function run(cmd, args, timeoutMs) {
  const start = Date.now();
  // .cmd / .bat shims on Windows only start through the shell; the
  // arguments here are fixed strings without spaces or quotes.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(shell ? `"${cmd}"` : cmd, args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, shell, maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - start;
  let output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error && r.error.code === 'ETIMEDOUT') output += `\n[run-all] timed out after ${Math.round(timeoutMs / 1000)} s`;
  else if (r.error) output += `\n[run-all] could not start ${cmd}: ${r.error.message}`;
  return { ok: !r.error && r.status === 0, code: r.status, output, ms };
}

function steps() {
  const denylist = process.env.BIB_DENYLIST;
  const semgrep = which('semgrep');
  const claude = which('claude');
  const bash = which('bash');
  return [
    {
      name: 'node --check',
      fn() {
        const src = sourceFiles();
        if (src.error) return { ok: false, output: src.error, ms: 0 };
        const start = Date.now();
        const bad = [];
        for (const f of src.files) {
          const r = run(NODE, ['--check', f], MIN);
          if (!r.ok) bad.push(`FAIL ${f}\n${r.output.trim()}`);
        }
        return { ok: bad.length === 0, output: bad.join('\n') || `${src.files.length} files ok`, ms: Date.now() - start, note: `${src.files.length} files` };
      },
    },
    { name: 'node --test', fn: () => run(NODE, ['--test', ...testFiles()], 15 * MIN) },
    { name: 'check-workflows', fn: () => run(NODE, ['tooling/check-workflows.js'], 2 * MIN) },
    { name: 'check-plugin', fn: () => run(NODE, ['tooling/check-plugin.js'], 2 * MIN) },
    { name: 'validate demo-config', fn: () => run(NODE, ['tooling/validate-config.js', 'examples/demo-config'], 2 * MIN) },
    { name: 'validate novu example', fn: () => run(NODE, ['tooling/validate-config.js', 'examples/novu-v3.19.0', '--example'], 2 * MIN) },
    { name: 'check-links', fn: () => run(NODE, ['tooling/check-links.js', '.', 'README.md', 'docs', 'examples'], 2 * MIN) },
    {
      name: 'check-clean',
      fn() {
        const r = run(NODE, ['tooling/check-clean.js', ...(denylist ? ['--denylist', denylist] : []), '.'], 5 * MIN);
        r.note = denylist ? 'with BIB_DENYLIST' : 'generic patterns only';
        return r;
      },
    },
    {
      name: 'semgrep rule tests',
      skip: !semgrep ? 'semgrep not on PATH' : !bash ? 'bash not on PATH' : null,
      fn: () => run(bash, ['rules/semgrep/run-tests.sh'], 20 * MIN),
    },
    {
      name: 'claude plugin validate',
      skip: claude ? null : 'claude not on PATH',
      fn: () => run(claude, ['plugin', 'validate', '.', '--strict'], 3 * MIN),
    },
  ];
}

function tail(text, n) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return (lines.length > n ? ['...', ...lines.slice(-n)] : lines).join('\n');
}

function main(argv, io = { out: (s) => process.stdout.write(s + '\n') }) {
  let verbose = false;
  for (const a of argv) {
    if (a === '--verbose') verbose = true;
    else if (a === '-h' || a === '--help') { io.out('usage: node tests/run-all.js [--verbose]'); return 0; }
    else { io.out(`run-all: unknown argument ${a}\nusage: node tests/run-all.js [--verbose]`); return 2; }
  }
  const rows = [];
  for (const step of steps()) {
    if (step.skip) { rows.push({ name: step.name, status: 'SKIP', secs: '-', note: step.skip }); io.out(`-- ${step.name}: SKIP (${step.skip})`); continue; }
    io.out(`-- ${step.name} ...`);
    const r = step.fn();
    const status = r.ok ? 'PASS' : 'FAIL';
    rows.push({ name: step.name, status, secs: (r.ms / 1000).toFixed(1), note: r.note || (r.ok ? '' : `exit ${r.code === null || r.code === undefined ? '-' : r.code}`) });
    if (verbose) io.out(r.output.replace(/\s+$/, ''));
    else if (!r.ok) io.out(tail(r.output, TAIL_LINES));
    io.out(`-- ${step.name}: ${status}`);
  }
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  io.out('');
  io.out(`${'step'.padEnd(w)}  result  seconds  note`);
  io.out(`${'-'.repeat(w)}  ------  -------  ----`);
  for (const r of rows) io.out(`${r.name.padEnd(w)}  ${r.status.padEnd(6)}  ${String(r.secs).padStart(7)}  ${r.note}`);
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  io.out('');
  io.out(failed ? `run-all: ${failed} step(s) FAILED` : 'run-all: every step that ran passed');
  return failed ? 1 : 0;
}

module.exports = { main, which };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
