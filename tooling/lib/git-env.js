'use strict';
/*
 * git-env.js - how the kit runs git on a repo it did not create, and the
 * check of a repo's .git folder made before the first git call.
 *
 *   const { GIT_PRE, NO_FETCH, gitEnv, systemCarry, gitDirCheck } = require('./lib/git-env');
 *
 *   GIT_PRE          -c settings put before every git subcommand: no
 *                    attributes file, no fsmonitor, no signature check, no
 *                    gpg program of any kind, no pager, and a bare
 *                    repository is used only when named explicitly.
 *   NO_FETCH         environment that stops git from fetching anything:
 *                    no lazy fetch of missing objects (git 2.44 or later)
 *                    and no transport protocol allowed.
 *   gitEnv(base?)    a copy of base (default process.env) for a git child,
 *                    with every inherited GIT_* variable dropped; the
 *                    user's global and system git config are ignored
 *                    (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1,
 *                    GIT_ATTR_NOSYSTEM=1), NO_FETCH, no prompt, no optional
 *                    locks, LC_ALL=C.
 *   systemCarry(env) env with the settings carried over from the system and
 *                    global git config (global wins, as in plain git):
 *                    only core.autocrlf and core.eol (they decide
 *                    how the working tree compares to the index). Read once
 *                    per process, outside any repo, and given to git as a
 *                    system config file of their own, so a repo's own
 *                    value still wins.
 *   gitDirCheck(dir) -> { gitDir, top, notRepo, problems: string[] }.
 *                    Finds the .git of dir by walking up from its real
 *                    path (git is not run) and reads its config and
 *                    info/attributes as text. notRepo (a reason) when no
 *                    .git is found or it is not a git folder. A problem is
 *                    anything that lets the repo folder start a program,
 *                    fetch, or send git to another folder:
 *                    - a level of the walk that is itself a git folder
 *                      (a bare repository, or a folder inside .git);
 *                    - .git is a file (worktree or submodule checkout) or
 *                      a link; a commondir file; objects/info/alternates;
 *                    - config, config.worktree or info/attributes that is
 *                      not a regular file, or is larger than 1 MiB;
 *                    - a config key core.worktree, core.hooksPath,
 *                      core.sshCommand, core.fsmonitor, core.askpass,
 *                      core.gitProxy, filter.*, diff.<driver>.command,
 *                      diff.<driver>.textconv, diff.external, trace2.*, gpg.*, include.*,
 *                      includeIf.*, alias.*, extensions.*, protocol.*,
 *                      credential.*, remote.<name>.promisor, .uploadpack,
 *                      .receivepack or .vcs;
 *                    - an info/attributes line that names filter= or diff=.
 *                    Included files are never read: an include is refused
 *                    on sight.
 *
 * Git's own setting `safe.directory` lives in the global config, so a repo
 * owned by another user fails with "dubious ownership" here; the kit does
 * not add it back.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_PRE = [
  '-c', 'core.attributesFile=', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.pager=cat',
  '-c', 'gpg.program=', '-c', 'gpg.ssh.program=', '-c', 'gpg.x509.program=', '-c', 'safe.bareRepository=explicit',
];

// GIT_ALLOW_PROTOCOL names a protocol that does not exist, so none is allowed.
const NO_FETCH = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'kit-no-protocol' };

function gitEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base || process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return Object.assign(env, NO_FETCH, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C',
  });
}

const CARRY = [['core.autocrlf', /^(true|false|input|yes|no|on|off|1|0)$/i], ['core.eol', /^(lf|crlf|native)$/i]];
let carried = null;

// The carried keys go into a system config file of the kit's own (not -c),
// so they keep system precedence: a repo that sets core.autocrlf itself
// still wins, as it does for plain git.
function carryFile() {
  if (carried !== null) return carried;
  carried = '';
  const env = gitEnv();
  delete env.GIT_CONFIG_NOSYSTEM;
  env.GIT_DIR = path.join(os.tmpdir(), `kit-no-repo-${process.pid}`); // never look for a repo
  const lines = [];
  for (const [key, ok] of CARRY) {
    // Global over system, as plain git reads them (no includes either way).
    let value = null;
    for (const scope of ['--system', '--global']) {
      const scopeEnv = { ...env };
      if (scope === '--global') delete scopeEnv.GIT_CONFIG_GLOBAL; // the user's own ~/.gitconfig
      const res = spawnSync('git', ['config', scope, '--get', key], {
        cwd: os.tmpdir(), env: scopeEnv, encoding: 'utf8', input: '', timeout: 20000, windowsHide: true,
      });
      const v = res.status === 0 ? String(res.stdout).trim() : '';
      if (ok.test(v)) value = v;
    }
    if (value !== null) lines.push(`\t${key.slice('core.'.length)} = ${value}`);
  }
  if (!lines.length) return carried;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-git-'));
  carried = path.join(dir, 'system.gitconfig');
  fs.writeFileSync(carried, ['[core]', ...lines, ''].join('\n'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return carried;
}

// systemCarry(env) -> env, given the carried keys at system level.
function systemCarry(env) {
  const file = carryFile();
  if (file) {
    delete env.GIT_CONFIG_NOSYSTEM;
    env.GIT_CONFIG_SYSTEM = file;
  }
  return env;
}

// ---------- config text ----------

// Every key a git config text sets: [{ name: 'section.sub.key' with section
// and key lower case, line }]. Throws Error(line message) on text git
// would not accept either.
function configKeys(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i].replace(/^\s+/, '');
    if (s.startsWith('[')) {
      const h = header(s, i + 1);
      section = h.name;
      s = h.rest.replace(/^\s+/, '');
    }
    if (s === '' || s[0] === '#' || s[0] === ';') continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(=|$|[#;\s])/.exec(s);
    if (!m) throw new Error(`line ${i + 1}: not a setting`);
    if (section === null) throw new Error(`line ${i + 1}: setting before any [section]`);
    out.push({ name: `${section}.${m[1].toLowerCase()}`, line: i + 1 });
    // Skip the value: a backslash at the end of a line (outside a comment)
    // goes on to the next line, and a quote stays open across it.
    let st = scanValue(s.slice(m[1].length), false);
    while (st.cont && i + 1 < lines.length) st = scanValue(lines[++i], st.inQuote);
    if (st.inQuote) throw new Error(`line ${i + 1}: unclosed quote`);
  }
  return out;
}

// '[section]', '[section "sub"]' or legacy '[section.sub]' -> name, rest.
function header(s, line) {
  const quoted = /^\[\s*([A-Za-z0-9.-]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(s);
  if (quoted) {
    const sub = quoted[2].replace(/\\(.)/g, '$1');
    return { name: `${quoted[1].toLowerCase()}.${sub}`, rest: s.slice(quoted[0].length) };
  }
  const plain = /^\[\s*([A-Za-z0-9.-]+)\s*\]/.exec(s);
  if (plain) return { name: plain[1].toLowerCase(), rest: s.slice(plain[0].length) };
  throw new Error(`line ${line}: bad section header`);
}

// One line of a value, read the way git reads it. -> { cont: the line ends
// with a backslash outside a comment, inQuote: a quote is still open }.
function scanValue(v, inQuote) {
  for (let j = 0; j < v.length; j++) {
    const c = v[j];
    if (c === '\\') {
      if (j === v.length - 1) return { cont: true, inQuote };
      j++;
    } else if (c === '"') inQuote = !inQuote;
    else if (!inQuote && (c === '#' || c === ';')) return { cont: false, inQuote };
  }
  return { cont: false, inQuote };
}

const KEY_RULES = [
  [/^core\.(worktree|hookspath|sshcommand|fsmonitor|askpass|gitproxy)$/, 'runs a program or moves the work tree'],
  [/^filter\./, 'a filter driver runs a program'],
  [/^diff\..+\.(command|textconv)$/, 'a diff driver runs a program'],
  [/^diff\.external$/, 'an external diff program runs'],
  [/^trace2\./, 'trace2 can write to files or sockets'],
  [/^gpg\./, 'gpg settings name a program'],
  [/^include\./, 'includes another config file (not followed)'],
  [/^includeif\./, 'includes another config file (not followed)'],
  [/^alias\./, 'an alias can run a program'],
  // worktreeConfig (config.worktree is checked too), objectFormat and
  // refStorage only change the storage format.
  [/^extensions\.(?!(worktreeconfig|objectformat|refstorage)$)/, 'a repository extension changes how git reads the repo'],
  [/^remote\..+\.(promisor|uploadpack|receivepack|vcs)$/, 'can make git fetch or run a program'],
  [/^protocol\./, 'changes which transports git may use'],
  [/^credential\./, 'a credential helper runs a program'],
];

function keyProblem(name) {
  for (const [re, why] of KEY_RULES) if (re.test(name)) return why;
  return null;
}

// ---------- the .git folder ----------

const MAX_TEXT = 1024 * 1024;

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

function isDir(p) {
  const st = lstat(p);
  return Boolean(st && st.isDirectory());
}

// HEAD, objects and refs: what git needs to take a folder as a git folder.
function looksLikeGitDir(p) {
  return Boolean(lstat(path.join(p, 'HEAD'))) && isDir(path.join(p, 'objects')) && isDir(path.join(p, 'refs'));
}

// Text of a small regular file; null when it does not exist.
function readSmall(p, label, problems) {
  let st;
  try {
    st = lstat(p);
  } catch (e) {
    problems.push(`${label} cannot be read (${e.code || e.message})`);
    return null;
  }
  if (!st) return null;
  if (!st.isFile()) {
    problems.push(`${label} is not a regular file`);
    return null;
  }
  if (st.size > MAX_TEXT) {
    problems.push(`${label} is larger than 1 MiB`);
    return null;
  }
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    problems.push(`${label} cannot be read (${e.code || e.message})`);
    return null;
  }
}

function gitDirCheck(dir) {
  const problems = [];
  const none = { gitDir: null, top: null, notRepo: null, problems };
  let cur;
  try {
    cur = fs.realpathSync.native(path.resolve(dir));
  } catch (e) {
    problems.push(`the folder cannot be resolved (${e.code || e.message})`);
    return none;
  }
  let found = null;
  try {
    for (;;) {
      const st = lstat(path.join(cur, '.git'));
      if (st) {
        found = { top: cur, gitDir: path.join(cur, '.git'), st };
        break;
      }
      if (looksLikeGitDir(cur)) {
        problems.push(`${cur} is itself a git folder (a bare repository, or a folder inside .git): git would use it`);
        return none;
      }
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  } catch (e) {
    problems.push(`${cur} cannot be read (${e.code || e.message})`);
    return none;
  }
  if (!found) return { ...none, notRepo: 'no .git in it or above it' };
  const { gitDir, top, st } = found;
  const base = { gitDir, top, notRepo: null, problems };
  if (st.isSymbolicLink()) problems.push('.git is a link: git would read the folder it points to');
  else if (st.isFile()) problems.push('.git is a file (a worktree or submodule checkout): git would read another folder');
  else if (!st.isDirectory()) problems.push('.git is not a folder');
  if (problems.length) return base;
  if (!looksLikeGitDir(gitDir)) return { ...base, notRepo: '.git has no HEAD, objects or refs' };

  if (lstat(path.join(gitDir, 'commondir'))) problems.push('.git/commondir exists: git would read another folder');
  if (lstat(path.join(gitDir, 'objects', 'info', 'alternates'))) problems.push('.git/objects/info/alternates exists: git would read objects from another folder');

  for (const file of ['config', 'config.worktree']) {
    const text = readSmall(path.join(gitDir, file), `.git/${file}`, problems);
    if (text === null) continue;
    let keys;
    try {
      keys = configKeys(text);
    } catch (e) {
      problems.push(`.git/${file} cannot be parsed (${e.message})`);
      continue;
    }
    for (const k of keys) {
      const why = keyProblem(k.name);
      if (why) problems.push(`.git/${file} line ${k.line} sets ${k.name}: ${why}`);
    }
  }

  const attrs = readSmall(path.join(gitDir, 'info', 'attributes'), '.git/info/attributes', problems);
  if (attrs !== null) {
    attrs.split(/\r?\n/).forEach((l, i) => {
      const t = l.trim();
      if (t === '' || t.startsWith('#')) return;
      const m = /(?:^|\s)!?-?(filter|diff)=/.exec(t);
      if (m) problems.push(`.git/info/attributes line ${i + 1} names ${m[1]}=: a ${m[1]} driver runs a program`);
    });
  }
  return base;
}

module.exports = { GIT_PRE, NO_FETCH, gitEnv, systemCarry, gitDirCheck, configKeys };
