'use strict';
/*
 * pin.js - Phase 0: record the exact commit of every repo before anyone
 * looks at the code.
 *
 * Usage:
 *   node tooling/pin.js [<workspace>] [--allow-dirty]
 *
 * For each repo in the config that has a path, records the HEAD commit (full
 * and 10-character short form), the branch, the commit date and the number
 * of uncommitted changes (`git status --porcelain --untracked-files=all`
 * lines, so every untracked file counts) plus a sha256 of those changes:
 * the status lines, `git diff HEAD --binary`, and the name and content of
 * every untracked, not ignored file. Writes:
 *   <work>/pins.json            read by every later step
 *   <work>/phase0-baseline.md   the same facts as a table for people
 * Folder paths are not written, only repo names.
 *
 * A repo with uncommitted changes is refused: findings must point at a
 * commit anyone can check out. --allow-dirty pins anyway and says so in both
 * files; check-unchanged then expects exactly the same uncommitted changes,
 * contents included.
 *
 * Exit codes: 0 pinned, 1 a repo is dirty (nothing written), 2 usage,
 * config or git error.
 *
 * Exports (used by doctor.js, check-unchanged.js and others):
 *   repoState(dir) -> { sha, short, branch, commit_date, porcelain,
 *                       changes_sha256 }     throws ConfigError
 *   readPins(paths) -> pins.json object, checked against shapes PINS;
 *                       throws ConfigError
 *   pinsFile(paths) -> absolute path of pins.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, ConfigError } = require('./lib/config');
const { validatePins } = require('./lib/shapes');

class CliError extends Error {}

// git with a fixed, quiet environment; never takes optional locks, so
// reading state does not touch the repo's index. attrTree: read attributes
// from that tree (the empty tree) so the repo cannot name filter programs.
function git(dir, args, raw, attrTree) {
  const env = {
    ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    // A repo's own .git/config must not start a program on `git status`.
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  };
  if (attrTree) env.GIT_ATTR_SOURCE = attrTree;
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: raw ? 'buffer' : 'utf8',
    input: '',
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 60000,
    windowsHide: true,
    env,
  });
  if (res.error) throw new ConfigError(`git could not run (${res.error.code || res.error.message})`);
  return { code: res.status, out: res.stdout || (raw ? Buffer.alloc(0) : ''), err: String(res.stderr || '').trim() };
}

function repoState(dir) {
  if (!fs.existsSync(dir)) throw new ConfigError(`folder not found: ${dir}`);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new ConfigError(`not a git repository: ${dir}`);
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (head.code !== 0) throw new ConfigError(`no commit yet in ${dir}`);
  const sha = head.out.trim();
  const empty = git(dir, ['hash-object', '-t', 'tree', '--stdin']).out.trim() || null;
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const date = git(dir, ['log', '-1', '--format=%cI', 'HEAD']).out.trim();
  const status = git(dir, ['status', '--porcelain', '--untracked-files=all'], false, empty);
  if (status.code !== 0) throw new ConfigError(`git status failed in ${dir}: ${status.err}`);
  const lines = status.out.split('\n').filter((l) => l.trim() !== '');
  const hash = crypto.createHash('sha256').update(lines.join('\n'));
  if (lines.length) {
    const diff = git(dir, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'], true, empty);
    if (diff.code !== 0) throw new ConfigError(`git diff failed in ${dir}: ${diff.err}`);
    hash.update('\0diff\0').update(diff.out);
    const others = git(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const rel of others.out.split('\0').filter(Boolean).sort()) {
      hash.update(`\0file\0${rel}\0`);
      try {
        hash.update(fs.readFileSync(path.join(top.out.trim(), rel)));
      } catch (e) {
        hash.update(`unreadable:${e.code}`);
      }
    }
  }
  return {
    sha,
    short: sha.slice(0, 10),
    branch: branch === 'HEAD' ? '(detached)' : branch,
    commit_date: date,
    porcelain: lines.length,
    changes_sha256: hash.digest('hex'),
  };
}

function pinsFile(paths) {
  return path.join(paths.work, 'pins.json');
}

function readPins(paths) {
  const file = pinsFile(paths);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new ConfigError('no pins yet: run `kit pin` (Phase 0) first');
    throw new ConfigError(`cannot read pins.json (${e.code || e.message})`);
  }
  let pins;
  try {
    pins = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`pins.json is not valid JSON (${e.message}); run \`kit pin\` again`);
  }
  const errs = validatePins(pins);
  if (errs.length) throw new ConfigError(`pins.json is not valid (${errs.slice(0, 3).join('; ')}); run \`kit pin\` again`);
  return pins;
}

function pinnable(config) {
  return config.repos.filter((r) => typeof r.path === 'string');
}

function baseline(config, pins) {
  const out = [
    `# Phase 0 baseline: ${config.audit.name}`,
    '',
    `Audit date: ${config.audit.date}.`,
    'Every citation in this audit points at the commits below. The repos are only read, never changed.',
    '',
    '| Repo | Role | Branch | Commit | Commit date | Uncommitted changes |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of pinnable(config)) {
    const p = pins.repos[r.name];
    out.push(`| ${r.name} | ${r.role}${r.context_only ? ' (context only)' : ''} | ${p.branch} | \`${p.short}\` | ${p.commit_date} | ${p.porcelain} |`);
  }
  out.push('');
  if (pins.allow_dirty) {
    out.push('**Pinned with uncommitted changes (`--allow-dirty`).** Results for a repo with changes describe the working tree,');
    out.push('which nobody else can check out. The end-of-audit check expects exactly the same changes.');
  } else {
    out.push('All repos were clean when pinned.');
  }
  out.push('', 'Full commits are in `pins.json`.', '');
  return out.join('\n');
}

function run(opts, io) {
  const { config, paths } = loadConfig(opts.workspace);
  const repos = pinnable(config);
  if (!repos.length) throw new CliError('no repo with a path in the config; nothing to pin');
  const pins = { date: config.audit.date, allow_dirty: opts.allowDirty, repos: {} };
  const dirty = [];
  for (const r of repos) {
    let st;
    try {
      st = repoState(paths.repos[r.name]);
    } catch (e) {
      throw new ConfigError(`repo ${r.name}: ${e.message}`);
    }
    if (st.porcelain > 0) dirty.push(`${r.name}: ${st.porcelain} uncommitted change${st.porcelain === 1 ? '' : 's'}`);
    pins.repos[r.name] = st;
  }
  if (dirty.length && !opts.allowDirty) {
    io.err('pin: refusing to pin repos with uncommitted changes:');
    for (const d of dirty) io.err(`  ${d}`);
    io.err('Commit or stash them in the repo yourself, or pin anyway with --allow-dirty (recorded).');
    return 1;
  }
  fs.mkdirSync(paths.work, { recursive: true });
  fs.writeFileSync(pinsFile(paths), JSON.stringify(pins, null, 2) + '\n');
  fs.writeFileSync(path.join(paths.work, 'phase0-baseline.md'), baseline(config, pins));
  for (const r of repos) {
    const p = pins.repos[r.name];
    io.out(`${r.name} ${p.short} ${p.branch} ${p.commit_date} uncommitted=${p.porcelain}`);
  }
  io.out(`pinned ${repos.length} repo${repos.length === 1 ? '' : 's'}${opts.allowDirty && dirty.length ? ' (with --allow-dirty)' : ''}`);
  return 0;
}

function parseArgs(argv) {
  const opts = { workspace: null, allowDirty: false, help: false };
  for (const a of argv) {
    if (a === '--allow-dirty') opts.allowDirty = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (opts.workspace !== null) throw new CliError(`only one workspace may be given (got ${opts.workspace} and ${a})`);
    else opts.workspace = a;
  }
  opts.workspace = opts.workspace || '.';
  return opts;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.out('usage: node tooling/pin.js [<workspace>] [--allow-dirty]');
      return 0;
    }
    return run(opts, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`pin: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, repoState, readPins, pinsFile };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
