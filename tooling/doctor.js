'use strict';
/*
 * doctor.js - check that a workspace is ready for the next audit phase.
 *
 * Usage:
 *   node tooling/doctor.js [<workspace>] [--no-optional]
 *
 * Prints one line per check, "ok" or "FAIL" (required) / "--" (optional):
 *   required  Node >= 20, git >= 2.40 (the evidence runner sets
 *             GIT_ATTR_SOURCE so a repo's .gitattributes cannot name filter
 *             or diff programs; older git ignores it), the config is valid, every repo
 *             folder exists and is a git repo, pins exist (`kit pin`), and
 *             every repo is still at its pin with a clean tree. bash too when
 *             rules.enabled: the rule tests (rules/semgrep/run-tests.sh) need
 *             it. It is found from evidence.shell: "auto" means Git Bash on
 *             Windows and "bash" elsewhere; or give a full path. (The evidence
 *             runner itself starts no shell.)
 *   optional  bash when rules are off, semgrep (rules stage), claude (the
 *             Claude Code CLI). Skip semgrep and claude with --no-optional.
 * Prints a WARNING (not a failure) for each value kit init filled with a
 * neutral default that is still unchanged (audit.placeholders).
 * Then prints the line that starts Claude Code (lead model and effort from
 * the config) with read access to every repo, and a reminder to check /hooks for Stop hooks from other plugins.
 *
 * Exit codes: 0 every required check is ok, 1 a required check failed,
 * 2 usage error or workspace not found.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, ConfigError } = require('./lib/config');
const { repoState, readPins } = require('./pin');
const { compareToPins } = require('./check-unchanged');
const { launchLine, placeholderWarnings } = require('./init-workspace');

class CliError extends Error {}

function version(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    shell: process.platform === 'win32' && !path.isAbsolute(cmd), // finds .cmd shims on Windows
  });
  if (res.error || res.status !== 0) return null;
  return `${res.stdout || ''}${res.stderr || ''}`.trim().split(/\r?\n/)[0];
}

// Finds bash from evidence.shell. -> { shell } or { error }
function findShell(ev) {
  const env = process.env;
  if (ev.shell !== 'auto') {
    if (path.isAbsolute(ev.shell) && !fs.existsSync(ev.shell)) return { error: `evidence.shell not found: ${ev.shell}` };
    return { shell: ev.shell };
  }
  if (process.platform !== 'win32') return { shell: 'bash' };
  const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
  for (const r of roots.filter(Boolean)) {
    const p = path.join(r, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return { shell: p };
  }
  const res = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (res.status === 0 && res.stdout.trim()) {
    const p = path.resolve(res.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return { shell: p };
  }
  return { error: 'Git Bash not found: install Git for Windows, or set evidence.shell to the full path of bash.exe' };
}

function atLeast(text, min) {
  const m = /(\d+)\.(\d+)/.exec(text || '');
  if (!m) return false;
  const [maj, minr] = [Number(m[1]), Number(m[2])];
  return maj > min[0] || (maj === min[0] && minr >= min[1]);
}

function run(opts, io) {
  if (!fs.existsSync(opts.workspace)) throw new CliError(`workspace not found: ${opts.workspace}`);
  const checks = [];
  const add = (required, ok, name, detail) => checks.push({ required, ok, name, detail });

  add(true, atLeast(process.versions.node, [20, 0]), 'node >= 20', `node ${process.versions.node}`);
  const git = version('git', ['--version']);
  const gitOk = atLeast(git, [2, 40]);
  add(true, gitOk, 'git >= 2.40', !git ? 'git not found'
    : gitOk ? git : `${git}: too old; 2.40 or later is needed so the evidence runner can stop a repo's .gitattributes from naming filter or diff programs (GIT_ATTR_SOURCE)`);

  let config = null;
  let paths = null;
  try {
    ({ config, paths } = loadConfig(opts.workspace));
    add(true, true, 'config', 'audit.config.json is valid');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    add(true, false, 'config', e.errors.join('; '));
  }

  const ev = config ? config.evidence : { shell: 'auto' };
  const sh = findShell(ev);
  const bash = sh.shell ? version(sh.shell, ['--version']) : null;
  add(!config || config.rules.enabled, Boolean(bash), 'bash (rule tests)', bash ? `${sh.shell}: ${bash}` : (sh.error || `${sh.shell} did not run`));

  let reposOk = false;
  if (config) {
    reposOk = true;
    for (const r of config.repos) {
      if (typeof r.path !== 'string') continue;
      try {
        repoState(paths.repos[r.name]);
        add(true, true, `repo ${r.name}`, 'git repository found');
      } catch (e) {
        reposOk = false;
        add(true, false, `repo ${r.name}`, e.message);
      }
    }
  }
  let pins = null;
  if (config) {
    try {
      pins = readPins(paths);
      add(true, true, 'pins', 'work/pins.json present');
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      add(true, false, 'pins', e.message);
    }
  }
  if (pins && reposOk) {
    for (const r of compareToPins(config, paths, pins)) {
      add(true, r.ok, `unchanged ${r.repo}`, r.ok ? `at ${r.short}, clean` : r.problem);
    }
  }

  if (opts.optional) {
    const semgrep = version('semgrep', ['--version']);
    add(false, Boolean(semgrep), 'semgrep (optional)', semgrep ? `semgrep ${semgrep}` : 'not found; the rules stage needs it');
    const claude = version('claude', ['--version']);
    add(false, Boolean(claude), 'claude (optional)', claude || 'not found; install Claude Code to run the agent phases');
  }

  for (const c of checks) io.out(`${c.ok ? 'ok  ' : c.required ? 'FAIL' : '--  '} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => c.required && !c.ok).length;
  if (config) for (const w of placeholderWarnings(config)) io.out(`WARNING ${w}`);

  if (config) {
    const dirs = config.repos.filter((r) => paths.repos[r.name]).map((r) => paths.repos[r.name]);
    io.out('');
    io.out('Start Claude Code from the workspace with read access to the repos:');
    io.out(`  cd "${paths.workspace}"`);
    io.out(`  ${launchLine(config, dirs)}`);
    io.out('Then run /hooks and check that no other plugin adds a Stop hook: one that blocks stopping can stall long workflow runs.');
  }
  io.out('');
  io.out(failed ? `${failed} required check${failed === 1 ? '' : 's'} failed` : 'all required checks passed');
  return failed ? 1 : 0;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = { workspace: null, optional: true };
    for (const a of argv) {
      if (a === '--help' || a === '-h') {
        io.out('usage: node tooling/doctor.js [<workspace>] [--no-optional]');
        return 0;
      }
      if (a === '--no-optional') opts.optional = false;
      else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      else if (opts.workspace !== null) throw new CliError('only one workspace may be given');
      else opts.workspace = a;
    }
    opts.workspace = path.resolve(opts.workspace || '.');
    return run(opts, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`doctor: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
