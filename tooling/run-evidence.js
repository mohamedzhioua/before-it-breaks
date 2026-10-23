'use strict';
/*
 * run-evidence.js - re-run every candidate's evidence commands and keep a
 * receipt of what they printed.
 *
 * Usage:
 *   node tooling/run-evidence.js [<workspace>] [--dry-run]
 *   node tooling/run-evidence.js [<workspace>] --only <candidate-id> [--cmd <n>]
 *
 * Reads <work>/candidates.json ({ "candidates": [...] }, shape in
 * tooling/lib/shapes.js) and <work>/pins.json. For each candidate writes
 * <work>/phase3/receipts/<id>.md and, for all of them,
 * <work>/phase3/receipts/_index.json (which also records, per candidate,
 * the sha of the whole candidate object it ran, from lib/content-sha.js, so
 * synthesis can tell a receipt of an older version). --dry-run only prints
 * how each command would be classified and writes nothing. --only re-runs the commands of
 * one candidate (or only its command number n), with the same rules and
 * environment, and prints that receipt on stdout; it writes nothing. The
 * verifier agent uses it to re-check a receipt.
 *
 * SAFETY: THIS IS AN ALLOWLIST, NOT A SANDBOX.
 * The commands were written by AI agents that read untrusted code. What the
 * runner guarantees, and nothing more:
 *   - No shell. A command is split into words by a small parser of the
 *     shell's quoting rules, and each pipeline step is started directly as
 *     a program with an argument list (shell: false). Node feeds one step's
 *     output to the next. So globs, $VAR, ~, $(...), backticks, redirection
 *     and chains are never interpreted; the parser refuses them outright
 *     (unquoted * ? [ { } too, a leading ~ or #, ( ), < and >, ; & || and
 *     new lines, VAR=value prefixes) so nobody mistakes them for working.
 *     Unquoted words and quoted text are handled as the shell would remove
 *     the quotes, and every rule below looks at the words after that.
 *   - Programs: only those in evidence.allowed_heads that the kit also has
 *     an option table for: git, grep, rg, cat, head, tail, sed, wc, sort,
 *     uniq, cut, tr, ls. awk and jq are never run, whatever the config says:
 *     their languages can reach programs or files in ways a checker cannot
 *     see (gawk indirect calls, jq import/include). Each program is found by
 *     name in Git's own folders (Windows) and then PATH, and started by full
 *     path.
 *   - Arguments: no argument may start with "@" or contain a control
 *     character (NUL, tab, new line ...). Outside git, glob characters
 *     (* ? [) are allowed only in pattern and script values (grep/rg
 *     patterns, -e, --include/--exclude/--exclude-dir, rg -g/--glob, sed
 *     scripts, tr sets); in file operands and every other value they are
 *     refused.
 *   - Options: each program, and each git subcommand in
 *     evidence.git_read_subcommands that the kit knows (show, log, diff,
 *     grep, blame, cat-file, ls-files, ls-tree, rev-parse), has a list of
 *     allowed options. Any other option is refused, and so is any long
 *     option that is not spelled out in full (the tools would read --out
 *     as --output). Long options whose value is optional must use --opt=x.
 *   - Paths: every file or folder operand (also "-", standard input) must be
 *     an absolute path inside a repo folder, normally written as
 *     {repo:<name>}/..., and must stay inside that repo folder after
 *     following symlinks (checked on the nearest part that exists).
 *     Relative paths, ~, ".." segments and absolute paths elsewhere
 *     (/dev/..., /proc/..., other folders) are refused. grep -R and rg -L,
 *     which follow symlinks while walking, are not allowed.
 *     git must be given -C {repo:<name>} (that placeholder alone as the
 *     word), and besides it only --no-pager, before its subcommand. Its
 *     revisions must look like revisions (no leading - or /, no ".."
 *     segment), rev:path and pathspecs must be relative without ".." or
 *     pathspec magic (or an absolute path inside the repo). git diff must
 *     name two revisions and git blame one, so they never read the working
 *     tree.
 *   - Program-specific: sed scripts may use only p d D n N P g G h H x l z
 *     = q Q { } s y and no s///w or s///e flag, and sed runs with --sandbox
 *     when the installed sed supports it (checked once per run; --dry-run
 *     says when it does not).
 *   - A file or folder named .env, or .env followed by '.', '-' or '_' (any case), is never read by name and is excluded from folder searches (grep, rg, git grep) and from git show, git diff and git log with a patch or file list (not with -L or --follow, which take no extra pathspecs). A file operand that is a link to such a name is refused too. The kit never promises that a secret cannot reach a receipt: the output detectors are the last line, and a withheld output is the signal to look.
 *     Such names are refused as file operands, rev:path and option values
 *     (also glued to an option; search patterns and sed scripts may name
 *     .env), git pathspecs after -- may hold wildcards unless they could
 *     match an .env file (as rg -g), grep --include and
 *     rg -g patterns that name an .env file are refused, file patterns
 *     after the first operand are refused, and grep and rg get .env excludes
 *     right before their first operand (git grep: exclude pathspecs);
 *     git --format/--pretty takes
 *     a built-in format name (oneline short medium full fuller reference
 *     raw; git ignores a pretty.* alias with those names) or a string with
 *     only plain % placeholders (no %G, which runs gpg), never a bare
 *     alias name; uniq takes at most one file.
 *   - Environment: a new empty temp folder is the working folder; HOME,
 *     USERPROFILE, TMP, TEMP and TMPDIR point into a new temp folder; PATH
 *     holds only the folders of the programs in the pipeline (plus
 *     System32 on Windows); of your own variables only SystemRoot/WINDIR
 *     are passed on; LC_ALL=C; stdin of the first step is empty. git runs
 *     with GIT_CONFIG_GLOBAL set to an empty file,
 *     GIT_CONFIG_NOSYSTEM=1, GIT_ATTR_NOSYSTEM=1, GIT_ATTR_SOURCE set to the
 *     empty tree (so the repo's .gitattributes cannot name filters or diff
 *     drivers), -c core.attributesFile=, -c core.fsmonitor=false,
 *     -c log.showSignature=false, -c gpg.program=, and --no-ext-diff /
 *     --no-textconv where the subcommand takes them. On Windows the child
 *     also gets MSYS=noglob and MSYS2_ARG_CONV_EXCL=*, so Git Bash's tools
 *     (grep, sed ... from Git's usr/bin) neither expand globs nor convert
 *     path-like arguments after the checks above.
 *   - On Windows, prefer git grep / git show / git log at the pin for
 *     evidence: git.exe is a native program that reads its arguments as
 *     given, while the usr/bin tools go through the MSYS runtime, whose
 *     argument handling (globs, @file, path conversion) the kit can only
 *     switch off and refuse around, not inspect. Reading at the pin also
 *     makes the receipt independent of the working tree.
 *   - Limits: evidence.timeout_ms covers the whole pipeline; a step that is
 *     still running when the time is up is killed. Each step's output is
 *     capped at 4 MiB while it is produced (the step is killed at the cap).
 *     The steps run one after another, so a step sees all of the previous
 *     step's (capped) output at once.
 * What it does NOT guarantee: that a program has no bug, that a repo pinned
 * with --trust-git-dir has a harmless .git folder (its filter and diff
 * drivers can then run; lib/git-env.js gitDirCheck), or that reading inside
 * the repo folders is free of secrets. For code you do not trust, run the
 * kit in a container or VM with the repos mounted read-only, and review
 * candidates.json (or use --dry-run) first. Ways around these rules are
 * security bugs; please report them (see SECURITY.md).
 *
 * Classification of one command (first match wins): skipped-live when it
 * starts with one of evidence.live_prefixes (recorded, never run);
 * skipped-unsafe when any rule above refuses it, with the reason;
 * skipped-error when it passed the rules but could not be started (a
 * program not found, or the system refused to start it); ran otherwise. Only "2>/dev/null" (drop the step's errors) and "2>&1" (merge
 * them into its output) are accepted as redirections.
 *
 * Placeholders: {repo:<name>} is the repo folder, {pin:<name>} the full
 * pinned commit. In the receipt, repo folders and the temp folder (every
 * spelling, Git Bash /c/... form included) are written back as
 * {repo:<name>} and <tmp>. If the output or the error text of a command
 * then matches any built-in must-zero pattern of check-clean.js (home
 * paths, credentialed connection strings and http(s)://user:pass@ URLs, JWTs,
 * live payment keys, Google API keys, cloud keys, private keys, token
 * prefixes, email addresses) or evidence.secret_patterns, the WHOLE output
 * of that command is replaced by "[output withheld: <pattern>]". Use git
 * --format without author emails to keep git log output. The command text
 * itself is shown with matches masked. Output is cut after
 * evidence.max_lines lines.
 *
 * Receipts contain no clock time (only the config's audit.date), so running
 * twice on the same pins gives byte-identical files. Line 1 of each receipt
 * is "receipt: <id>", the first 12 hex characters of the sha256 of the rest.
 *
 * Exit codes: 0 done (commands may still have failed or been skipped; see
 * the summary), 2 usage, config, pins or candidates error.
 *
 * Exports: classify(cmd, ev, ctx), lex, buildMasks, mask, detect,
 * sedScriptProblem, makeRoots. ctx = { expand(kind, name) -> string|null,
 * roots: makeRoots({ name: folder }) }.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, ConfigError } = require('./lib/config');
const { validateCandidates } = require('./lib/shapes');
const { contentSha } = require('./lib/content-sha');
const { readPins } = require('./pin');
const { buildMasks, mask, detect } = require('./lib/mask');
const { GIT_PRE, NO_FETCH, gitEnv, gitDirCheck } = require('./lib/git-env');

class CliError extends Error {}

const MAX_STEP_BYTES = 4 * 1024 * 1024;
const WIN = process.platform === 'win32';

// ---------- lexer ----------

const PLACEHOLDER = /^\{(repo|pin):([a-z0-9]+(?:-[a-z0-9]+)*)\}/;

// Splits a command into pipeline steps the way the shell's quoting would,
// refusing every other shell feature. Returns { steps: [{ words, stderr }] }
// where each word is { v, repo } (repo: the repo name when the whole word is
// one {repo:..} placeholder) and stderr is "keep", "null" or "merge"; or
// { error }.
function lex(cmd, expand) {
  const steps = [{ words: [], stderr: 'keep' }];
  let word = null;
  let state = 'none';
  let i = 0;
  const fail = (error) => ({ error });
  const cur = () => steps[steps.length - 1];
  // parts counts the pieces of a word: literal characters and placeholders.
  const start = () => { if (word === null) word = { v: '', parts: 0, repo: null, quoted: false }; };
  const add = (s) => { start(); word.v += s; word.parts++; };
  const endWord = () => {
    if (word !== null) cur().words.push({ v: word.v, repo: word.parts === 1 ? word.repo : null });
    word = null;
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    const rest = cmd.slice(i);
    if (ch === '{' && /^\{(repo|pin):/.test(rest)) {
      const m = PLACEHOLDER.exec(rest);
      if (!m) return fail(`malformed placeholder near "${rest.slice(0, 30)}"`);
      const val = expand(m[1], m[2]);
      if (typeof val !== 'string') return fail(`unknown placeholder ${m[0]}`);
      start();
      if (m[1] === 'repo' && word.parts === 0) word.repo = m[2];
      add(val);
      i += m[0].length;
      continue;
    }
    if ((ch < ' ' || ch === '\x7f') && !(state === 'none' && (ch === '\t' || ch === '\n' || ch === '\r'))) {
      return fail('control characters (NUL, tab or new line inside quotes, ...) are not allowed');
    }
    if (state === 'single') {
      if (ch === "'") state = 'none';
      else add(ch);
      i++;
      continue;
    }
    if (state === 'double') {
      if (ch === '"') { state = 'none'; i++; continue; }
      if (ch === '`') return fail('command substitution (backticks) is not allowed');
      if (ch === '$' && cmd[i + 1] === '(') return fail('command substitution $(...) is not allowed');
      if (ch === '$' && /[A-Za-z0-9_{@*#?$!-]/.test(cmd[i + 1] || '')) return fail('shell expansion ($...) is not allowed');
      if (ch === '\\') {
        const nx = cmd[i + 1];
        if (nx === undefined || nx === '\n' || nx === '\r') return fail('a backslash may not end a line');
        add('$`"\\'.includes(nx) ? nx : '\\' + nx);
        i += 2;
        continue;
      }
      add(ch);
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); i++; continue; }
    if (ch === "'" || ch === '"') { state = ch === "'" ? 'single' : 'double'; start(); word.quoted = true; i++; continue; }
    if (ch === '\\') {
      const nx = cmd[i + 1];
      if (nx === undefined || nx === '\n' || nx === '\r') return fail('a backslash may not end a line');
      add(nx);
      i += 2;
      continue;
    }
    if (ch === '|') {
      if (cmd[i + 1] === '|') return fail('command chains (||) are not allowed; use one pipeline');
      if (cmd[i + 1] === '&') return fail('|& is not allowed');
      endWord();
      if (!cur().words.length) return fail('empty pipeline step');
      steps.push({ words: [], stderr: 'keep' });
      i++;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '\n' || ch === '\r') {
      return fail('command chains (; && & or a new line) are not allowed; use one pipeline');
    }
    if (ch === '>' || ch === '<') {
      const ok = ch === '>' && word && word.v === '2' && word.parts === 1 && !word.quoted && /^>(\/dev\/null|&1)(?=$|[ \t|])/.exec(rest);
      if (!ok) return fail('redirection and process substitution (> >> < <( >( ) are not allowed; output is captured for you');
      cur().stderr = ok[1] === '&1' ? 'merge' : 'null';
      word = null;
      i += ok[0].length;
      continue;
    }
    if (ch === '`') return fail('command substitution (backticks) is not allowed');
    if (ch === '$') {
      const nx = cmd[i + 1] || '';
      if (nx === '(') return fail('command substitution $(...) is not allowed');
      if (/[A-Za-z0-9_{@*#?$!'"-]/.test(nx)) return fail('shell expansion ($...) is not allowed');
    }
    if (ch === '(' || ch === ')') return fail('subshells and grouping ( ) are not allowed');
    if (ch === '{') return fail('unquoted { } (brace expansion) is not allowed; quote it');
    if (ch === '#' && word === null) return fail('comments (#) are not allowed');
    if (ch === '~' && word === null) return fail('~ (home folder) is not allowed');
    if ((ch === '*' || ch === '?' || ch === '[') && state === 'none') return fail('unquoted glob characters (* ? [) are not expanded here; quote them or use the tool\'s own include option');
    add(ch);
    i++;
  }
  if (state !== 'none') return fail('unterminated quote');
  endWord();
  if (!cur().words.length) return fail('empty pipeline step');
  return { steps };
}

// ---------- paths ----------

function norm(p) {
  const r = path.resolve(p);
  return WIN ? r.toLowerCase() : r;
}

function inside(child, root) {
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Nearest existing folder or file of p, resolved through symlinks. Walks up
// only while the name does not exist (ENOENT, ENOTDIR); null when a name
// exists but cannot be resolved (a dangling or looping link, no access).
function realNearest(p) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      return fs.realpathSync.native(cur);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null;
      try {
        fs.lstatSync(cur);
        return null; // the name is there (a link) but leads nowhere
      } catch (e2) {
        if (e2.code !== 'ENOENT' && e2.code !== 'ENOTDIR') return null;
      }
      const up = path.dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

function makeRoots(dirs) {
  return Object.entries(dirs).filter(([, d]) => d).map(([name, dir]) => ({ name, dir: path.resolve(dir), real: realNearest(dir) }));
}

function hasDotDot(p) {
  return p.split(/[\\/]+/).includes('..');
}

// Error text, or null when p is a file or folder inside a repo.
function pathProblem(p, roots) {
  if (p === '-') return null;
  if (p.startsWith('~')) return `"${p}": ~ is not allowed`;
  if (hasDotDot(p)) return `"${p}": ".." is not allowed in paths`;
  if (!path.isAbsolute(p)) return `"${p}": paths must start with {repo:<name>}`;
  const root = roots.find((r) => inside(p, r.dir));
  if (!root) return `"${p}" is outside the repos`;
  const real = realNearest(p);
  if (!real || !root.real) return `"${p}" cannot be resolved (a broken or looping link, or no access)`;
  if (!inside(real, root.real)) return `"${p}" leads outside repo ${root.name} through a symlink`;
  return null;
}

// ---------- option tables ----------
// f = flag, v = takes a value, n = takes a number, o = optional value (only
// as --name=value), fmt = git format (checked), v2 = takes two values.

const NUM = /^[+-]?[0-9]+$/;
const flags = (s) => Object.fromEntries(s.split(' ').filter(Boolean).map((k) => [k, 'f']));

const TABLES = {
  cat: { short: flags('n b s A v E T'), long: flags('number'), operands: 'paths' },
  head: { short: { n: 'n', c: 'n', ...flags('q v') }, long: { lines: 'n', bytes: 'n' }, numeric: true, operands: 'paths' },
  tail: { short: { n: 'n', c: 'n', ...flags('q v') }, long: { lines: 'n', bytes: 'n' }, numeric: true, operands: 'paths' },
  wc: { short: flags('l c w m L'), long: flags('lines words bytes chars'), operands: 'paths' },
  cut: { short: { d: 'v', f: 'v', c: 'v', b: 'v', ...flags('s') }, long: { delimiter: 'v', fields: 'v', characters: 'v', bytes: 'v', ...flags('complement only-delimited') }, operands: 'paths' },
  tr: { short: flags('d s c C'), long: {}, operands: 'sets' },
  sort: { short: { k: 'v', t: 'v', ...flags('n r u f b h V s g M d i') }, long: { key: 'v', 'field-separator': 'v', ...flags('numeric-sort reverse unique ignore-case human-numeric-sort version-sort stable') }, operands: 'paths' },
  uniq: { short: { f: 'n', s: 'n', w: 'n', ...flags('c d u i') }, long: { 'skip-fields': 'n', 'skip-chars': 'n', 'check-chars': 'n', ...flags('count repeated unique ignore-case') }, operands: 'paths', maxOperands: 1 },
  ls: { short: flags('l a A R 1 h d t S r F p'), long: {}, operands: 'paths' },
  grep: {
    short: { e: 'v', A: 'n', B: 'n', C: 'n', m: 'n', ...flags('n i E F G w x v l L c o r h H s q I a') },
    long: {
      regexp: 'v', include: 'v', exclude: 'v', 'exclude-dir': 'v', 'binary-files': 'v', color: 'o', colour: 'o',
      'after-context': 'n', 'before-context': 'n', context: 'n', 'max-count': 'n',
      ...flags('line-number ignore-case extended-regexp fixed-strings basic-regexp word-regexp line-regexp invert-match files-with-matches files-without-match count only-matching recursive no-filename with-filename no-messages quiet'),
    },
    numeric: true,
    operands: 'pattern',
    patternOpts: ['e', 'regexp', 'include', 'exclude', 'exclude-dir'],
  },
  rg: {
    short: { e: 'v', g: 'v', t: 'v', T: 'v', A: 'n', B: 'n', C: 'n', m: 'n', ...flags('n i F w l c S s v o H') },
    long: {
      regexp: 'v', glob: 'v', type: 'v', 'type-not': 'v', color: 'v', 'after-context': 'n', 'before-context': 'n', context: 'n', 'max-count': 'n',
      ...flags('line-number ignore-case fixed-strings word-regexp files-with-matches count smart-case case-sensitive invert-match only-matching no-heading with-filename no-filename json hidden no-ignore'),
    },
    operands: 'pattern',
    patternOpts: ['e', 'regexp', 'g', 'glob'],
  },
  sed: { short: { e: 'v', ...flags('n E r s u z') }, long: { expression: 'v', ...flags('quiet silent regexp-extended null-data separate unbuffered posix sandbox debug') }, operands: 'sed', patternOpts: ['e', 'expression'] },
};

const DIFF_OUT = flags('stat name-only name-status numstat shortstat patch no-patch no-color no-ext-diff no-textconv ignore-all-space ignore-space-change');
const GIT = {
  show: { short: flags('p s w'), long: { ...DIFF_OUT, unified: 'o', 'diff-filter': 'v', format: 'fmt', pretty: 'fmt', date: 'v', ...flags('oneline abbrev-commit') }, fixed: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'] },
  log: {
    short: { n: 'n', S: 'v', G: 'v', L: 'v', ...flags('p s w i E F') },
    long: {
      ...DIFF_OUT, unified: 'o', 'diff-filter': 'v', format: 'fmt', pretty: 'fmt', date: 'v', 'max-count': 'n', skip: 'n',
      since: 'v', until: 'v', after: 'v', before: 'v', author: 'v', grep: 'v',
      ...flags('oneline abbrev-commit follow reverse no-merges merges first-parent regexp-ignore-case extended-regexp fixed-strings'),
    },
    numeric: true,
    fixed: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
  },
  diff: { short: flags('p w'), long: { ...DIFF_OUT, unified: 'o', 'diff-filter': 'v' }, fixed: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'], revs: 2 },
  grep: {
    short: { e: 'v', A: 'n', B: 'n', C: 'n', m: 'n', ...flags('n i E F G P w l L c v h H o I p W') },
    long: {
      'max-count': 'n', 'after-context': 'n', 'before-context': 'n', context: 'n',
      ...flags('line-number ignore-case extended-regexp fixed-strings basic-regexp perl-regexp word-regexp files-with-matches files-without-match count invert-match only-matching heading break full-name no-color show-function function-context and or not all-match no-textconv'),
    },
    fixed: ['--no-textconv'],
    pattern: true,
  },
  blame: { short: { L: 'v', ...flags('l s w n f M C b t') }, long: { date: 'v', ...flags('porcelain line-porcelain show-number show-name root no-textconv') }, fixed: ['--no-textconv'], revs: 1 },
  'cat-file': { short: flags('p t s e'), long: {} },
  'ls-files': { short: flags('s c o d m t z'), long: flags('stage cached others deleted modified exclude-standard full-name') },
  'ls-tree': { short: flags('r t d l z'), long: flags('name-only name-status full-name full-tree long object-only') },
  'rev-parse': { short: flags('q'), long: { short: 'o', 'abbrev-ref': 'o', ...flags('verify show-toplevel quiet is-inside-work-tree') } },
};

const FMT_TOKENS = ['%%', '%n', '%H', '%h', '%T', '%t', '%P', '%p', '%an', '%aN', '%ad', '%ar', '%as', '%aI', '%ai', '%at',
  '%cn', '%cN', '%cd', '%cr', '%cs', '%cI', '%ci', '%ct', '%s', '%f', '%b', '%B', '%d', '%D', '%x09', '%x20', '%x00']
  .sort((a, b) => b.length - a.length);
const NAMED_FORMATS = ['oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'raw'];

function formatProblem(v) {
  let body = v;
  if (NAMED_FORMATS.includes(v)) return null;
  const m = /^(t?format):(.*)$/s.exec(v);
  if (m) body = m[2];
  else if (!v.includes('%')) return `git format "${v}" is neither a built-in format (${NAMED_FORMATS.join(', ')}) nor a %-placeholder string`;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '%') continue;
    const tok = FMT_TOKENS.find((t) => body.startsWith(t, i));
    if (!tok) return `git format placeholder "${body.slice(i, i + 3)}" is not allowed (only plain ones such as %H %h %an %ad %s)`;
    i += tok.length - 1;
  }
  return null;
}

// Parses options against a table. -> { opts: [{ name, value }], operands } or { error }.
function parseOptions(head, args, table) {
  const opts = [];
  const operands = [];
  let ended = false;
  const bad = (o) => ({ error: `option ${o} is not on the allowlist for ${head}` });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ended || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { ended = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const type = Object.prototype.hasOwnProperty.call(table.long, name) ? table.long[name] : null;
      if (!type) return bad(`--${name}`);
      let value = eq < 0 ? undefined : a.slice(eq + 1);
      if (type === 'f' && value !== undefined) return { error: `option --${name} takes no value` };
      if (type === 'o' && value === undefined) { opts.push({ name, value: null }); continue; }
      if (type === 'v2') {
        if (value !== undefined || i + 2 >= args.length) return { error: `option --${name} needs two values` };
        opts.push({ name, value: args[i + 1] }, { name, value: args[i + 2] });
        i += 2;
        continue;
      }
      if (type !== 'f' && value === undefined) {
        if (i + 1 >= args.length) return { error: `option --${name} needs a value` };
        value = args[++i];
      }
      if (type === 'n' && !NUM.test(value)) return { error: `option --${name} needs a number (got "${value}")` };
      if (type === 'fmt') { const p = formatProblem(value); if (p) return { error: p }; }
      opts.push({ name, value: value === undefined ? null : value });
      continue;
    }
    if (table.numeric && /^-[0-9]+$/.test(a)) { opts.push({ name: 'N', value: a.slice(1) }); continue; }
    for (let k = 1; k < a.length; k++) {
      const letter = a[k];
      const type = Object.prototype.hasOwnProperty.call(table.short, letter) ? table.short[letter] : null;
      if (!type) return bad(`-${letter}`);
      if (type === 'f') { opts.push({ name: letter, value: null }); continue; }
      let value = a.slice(k + 1);
      if (value === '') {
        if (i + 1 >= args.length) return { error: `option -${letter} needs a value` };
        value = args[++i];
      }
      if (type === 'n' && !NUM.test(value)) return { error: `option -${letter} needs a number (got "${value}")` };
      opts.push({ name: letter, value });
      break;
    }
  }
  return { opts, operands };
}

// Accepts only a small, harmless part of the sed language.
function sedScriptProblem(s) {
  let i = 0;
  let depth = 0;
  const n = s.length;
  const digits = () => { while (i < n && s[i] >= '0' && s[i] <= '9') i++; };
  const blanks = () => { while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; };
  const closeOn = (d) => {
    while (i < n) {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === '\n') return false;
      if (s[i++] === d) return true;
    }
    return false;
  };
  const address = () => {
    const c = s[i];
    if (c >= '0' && c <= '9') { digits(); if (s[i] === '~') { i++; digits(); } return true; }
    if (c === '$') { i++; return true; }
    if (c === '/' || c === '\\') {
      const d = c === '/' ? '/' : s[i + 1];
      if (!d || d === '\n') return null;
      i += c === '/' ? 1 : 2;
      if (!closeOn(d)) return null;
      while (s[i] === 'I' || s[i] === 'M') i++;
      return true;
    }
    return false;
  };
  while (i < n) {
    while (i < n && ' \t\n;'.includes(s[i])) i++;
    if (i >= n) break;
    if (s[i] === '}') {
      if (!depth) return 'sed script has an unmatched }';
      depth--;
      i++;
      continue;
    }
    const a1 = address();
    if (a1 === null) return 'sed address is not closed';
    if (a1) {
      blanks();
      if (s[i] === ',') {
        i++;
        blanks();
        if (s[i] === '+' || s[i] === '~') { i++; digits(); } else if (address() !== true) return 'sed second address is not valid';
      }
    }
    blanks();
    if (s[i] === '!') { i++; blanks(); }
    const c = s[i++];
    if (c === undefined) return 'sed address without a command';
    if ('pdDnNPgGhHxlz='.includes(c)) {
      // no argument
    } else if (c === 'q' || c === 'Q') {
      blanks();
      digits();
    } else if (c === '{') {
      depth++;
      continue;
    } else if (c === 's' || c === 'y') {
      const d = s[i];
      if (!d || d === '\\' || d === '\n' || d === ' ') return `sed ${c} command has no valid delimiter`;
      i++;
      if (!closeOn(d) || !closeOn(d)) return `sed ${c} command is not closed`;
      if (c === 's') {
        while (i < n && /[gpiImM0-9]/.test(s[i])) i++;
        if (s[i] === 'w' || s[i] === 'W' || s[i] === 'e') return `sed s///${s[i]} flag is not allowed (it writes a file or runs a program)`;
      }
    } else {
      return `sed command "${c}" is not allowed (w, W and e write files or run programs; only p d q s y = and similar are accepted)`;
    }
    blanks();
    if (i < n && !';\n}'.includes(s[i])) return `sed script has "${s[i]}" after the ${c} command`;
  }
  if (depth) return 'sed script has an unmatched {';
  return null;
}

// Operand rules for the plain tools. -> error text or null.
function operandProblem(head, table, parsed, roots) {
  const { opts, operands } = parsed;
  let files = operands;
  if (table.operands === 'sets') return operands.length > 2 ? 'tr takes at most two sets' : null;
  if (table.operands === 'pattern') {
    if (!opts.some((o) => o.name === 'e' || o.name === 'regexp')) {
      if (!operands.length) return `${head} needs a pattern`;
      files = operands.slice(1);
    }
  }
  if (table.operands === 'sed') {
    const scripts = opts.filter((o) => o.name === 'e' || o.name === 'expression').map((o) => o.value);
    if (!scripts.length) {
      if (!operands.length) return 'sed needs a script';
      scripts.push(operands[0]);
      files = operands.slice(1);
    }
    for (const s of scripts) { const p = sedScriptProblem(s); if (p) return p; }
  }
  if (table.maxOperands !== undefined && files.length > table.maxOperands) {
    return `${head} takes at most ${table.maxOperands} file (a second one would be written to)`;
  }
  for (const o of opts) {
    // .env names count in file operands and option values, but not in search
    // patterns or sed scripts (they read no file), nor in exclusions.
    const exclusion = ['exclude', 'exclude-dir'].includes(o.name) || (['g', 'glob'].includes(o.name) && String(o.value).startsWith('!'));
    if (typeof o.value === 'string' && !SEARCH_OPTS.includes(o.name) && !exclusion && ENV_GLOB.test(o.value)) return 'reads an .env file';
    if (['include', 'g', 'glob'].includes(o.name) && globCouldMatchEnv(String(o.value))) {
      return `"${o.value}": this file pattern could match an .env file; name the file types you need (for example *.ts)`;
    }
    if (typeof o.value === 'string' && GLOB.test(o.value) && !(table.patternOpts || []).includes(o.name)) {
      return `glob characters (* ? [) are not allowed in the value of ${o.name.length === 1 ? '-' : '--'}${o.name}`;
    }
  }
  for (const f of files) {
    if (ENV_NAME.test(f)) return 'reads an .env file';
    if (GLOB.test(f)) return `"${f}": glob characters (* ? [) are not allowed in file operands`;
    const p = pathProblem(f, roots);
    if (p) return p;
    // A link with an ordinary name can still lead to an .env file in the repo.
    const real = realNearest(f);
    const root = roots.find((r) => inside(f, r.dir));
    if (real && root && root.real && ENV_NAME.test(path.sep + path.relative(root.real, real))) return 'reads an .env file (through a link)';
  }
  return null;
}

const GLOB = /[*?[]/;
// Options whose value is a search pattern or a sed script, not a file.
const SEARCH_OPTS = ['e', 'regexp', 'expression'];
const GIT_SEARCH_OPTS = ['e', 'S', 'G', 'grep'];

const REV = /^[A-Za-z0-9._/@{}^~-]+$/;
const COMMIT_REV = /^[0-9a-f]{7,40}(?:[~^][0-9]*)*$/;

// An .env name (.env, or .env followed by ".", "-" or "_"; any case), after
// "/", "\", ":" (git rev:path, e.g. HEAD:.env) or "=" (--include=.env.x),
// and as a file or a folder (.env/x).
const ENV_NAME = /(^|[/\\:=])\.env([._-][^/\\]*)?(?=$|[/\\])/i;
// The same in a glob or an option value, where the suffix may hold glob
// characters (.env*, .env.st?ging, .env.[lp]*); .envrc is another name.
const ENV_GLOB = /(^|[/\\:=])\.env([._*?[-][^/\\]*)?(?=$|[/\\])/i;
const ENV_SAMPLES = ['.env', '.ENV', '.Env', '.env.local', '.env.production.local', '.env.local.bak', '.env-local', '.env_backup'];

// Brace alternatives of a glob, expanded ({a,b}c -> ac, bc); null when
// there are too many to check.
function expandBraces(glob, limit = 64) {
  let open = -1;
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '\\') { i++; continue; }
    if (glob[i] === '{') { if (depth++ === 0) open = i; }
    else if (glob[i] === '}' && depth && --depth === 0) {
      const parts = [];
      let d = 0;
      let start = open + 1;
      for (let k = open + 1; k < i; k++) {
        if (glob[k] === '\\') { k++; continue; }
        if (glob[k] === '{') d++;
        else if (glob[k] === '}') d--;
        else if (glob[k] === ',' && d === 0) { parts.push(glob.slice(start, k)); start = k + 1; }
      }
      parts.push(glob.slice(start, i));
      const out = [];
      for (const p of parts) {
        const sub = expandBraces(glob.slice(0, open) + p + glob.slice(i + 1), limit);
        if (!sub) return null;
        out.push(...sub);
        if (out.length > limit) return null;
      }
      return out;
    }
  }
  return [glob];
}

// Tokens of one path segment: star, any (?), cls (a [...] class), lit.
function globTokens(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\' && i + 1 < seg.length) { out.push({ t: 'lit', c: seg[++i] }); continue; }
    if (c === '*') out.push({ t: 'star' });
    else if (c === '?') out.push({ t: 'any' });
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) { out.push({ t: 'lit', c }); continue; }
      let body = seg.slice(i + 1, end);
      if (body[0] === '!') body = '^' + body.slice(1);
      let re;
      try { re = new RegExp('^[' + body.replace(/\\/g, '\\\\') + ']$'); } catch (e) { re = /^[\s\S]$/; }
      out.push({ t: 'cls', re });
      i = end;
    } else out.push({ t: 'lit', c });
  }
  return out;
}

function tokensRegExp(tokens) {
  const src = tokens.map((x) => (x.t === 'star' ? '.*' : x.t === 'any' ? '.' : x.t === 'cls' ? x.re.source.slice(1, -1) : escapeRe(x.c))).join('');
  try { return new RegExp('^' + src + '$', 'i'); } catch (e) { return null; }
}

// True when an include glob (grep --include, rg -g/--glob) names an .env
// file: its last segment (braces expanded) matches one of ENV_SAMPLES, or
// the value itself holds an .env name, glob suffixes too (.env*, .env/*.ts).
// Broad globs such as *.ts or src/**/*.ts pass; the excludes the runner
// adds keep .env out.
// rg exclusions ("!...") are allowed.
function globCouldMatchEnv(glob) {
  if (glob.startsWith('!')) return false;
  if (ENV_GLOB.test(glob)) return true;
  const alts = expandBraces(glob);
  if (!alts) return true;
  for (const alt of alts) {
    const last = alt.split('/').pop();
    const rx = tokensRegExp(globTokens(last));
    if (!rx || ENV_SAMPLES.some((s) => rx.test(s))) return true;
  }
  return false;
}

// spec: a pathspec after "--" (git reads it as a glob); rev:path and -L
// paths are literal.
function gitPathProblem(p, roots, spec) {
  // Wildcards are fine unless the pattern names an .env file (the rule of rg
  // -g); git applies the kit's exclude pathspecs whatever the order.
  if (spec && GLOB.test(p) && globCouldMatchEnv(p)) return `"${p}": this pathspec could match an .env file; name the file types you need (for example *.ts)`;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return pathProblem(p, roots);
  if (p.startsWith(':')) return `git pathspec magic "${p}" is not allowed`;
  if (p.startsWith('~')) return `"${p}": ~ is not allowed`;
  if (hasDotDot(p)) return `"${p}": ".." is not allowed in paths`;
  return null;
}

function gitProblem(words, ev, roots) {
  const args = words.map((w) => w.v);
  let i = 0;
  let repo = null;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') {
      const w = words[i + 1];
      if (!w || !w.repo) return 'git -C must be followed by {repo:<name>} and nothing else';
      repo = w.repo;
      i += 2;
    } else if (args[i] === '--no-pager') {
      i++;
    } else {
      return `git option "${args[i]}" before the subcommand is not allowed (only -C {repo:<name>})`;
    }
  }
  if (!repo) return 'git needs -C {repo:<name>}';
  const sub = args[i];
  if (!sub) return 'git without a subcommand';
  if (!ev.git_read_subcommands.includes(sub)) return `"git ${sub}" is not in evidence.git_read_subcommands`;
  const table = GIT[sub];
  if (!table) return `"git ${sub}" has no option list in this kit, so it is not run`;
  const rest = args.slice(i + 1);
  const dd = rest.indexOf('--');
  const parsed = parseOptions(`git ${sub}`, dd < 0 ? rest : rest.slice(0, dd), table);
  if (parsed.error) return parsed.error;
  let revs = parsed.operands;
  const paths = dd < 0 ? [] : rest.slice(dd + 1);
  if (table.pattern && !parsed.opts.some((o) => o.name === 'e')) {
    if (!revs.length) return 'git grep needs a pattern';
    revs = revs.slice(1);
  }
  // .env names count in paths, rev:path and option values, but not in
  // search patterns (-e, and log's -S, -G, --grep).
  for (const o of parsed.opts) {
    if (typeof o.value === 'string' && !GIT_SEARCH_OPTS.includes(o.name) && ENV_GLOB.test(o.value)) return 'reads an .env file';
  }
  if (revs.concat(paths).some((r) => ENV_NAME.test(r))) return 'reads an .env file';
  // -L <range>:<file> carries a path of its own.
  for (const o of parsed.opts) {
    if (o.name === 'L' && typeof o.value === 'string' && o.value.includes(':')) {
      const p = gitPathProblem(o.value.slice(o.value.lastIndexOf(':') + 1), roots);
      if (p) return p;
    }
  }
  let revCount = 0;
  for (const r of revs) {
    const colon = r.indexOf(':');
    const rev = colon < 0 ? r : r.slice(0, colon);
    if (!REV.test(rev) || rev.startsWith('-') || rev.startsWith('/')) return `"${r}" is not a revision this kit accepts`;
    if (/(^|\/)\.\.(\/|$)/.test(rev)) return `"${r}": ".." is not allowed in paths`;
    if (colon >= 0) { const p = gitPathProblem(r.slice(colon + 1), roots); if (p) return p; }
    // Where a revision count is required, a path must not pass for a revision.
    if (table.revs && !rev.split(/\.\.\.?/).every((side) => COMMIT_REV.test(side))) {
      return `git ${sub}: "${r}" is not a commit id; name revisions as {pin:<name>} (or a commit sha) and put paths after --`;
    }
    revCount += rev.includes('..') ? 2 : 1;
  }
  for (const p of paths) { const q = gitPathProblem(p, roots, true); if (q) return q; }
  if (table.revs && revCount < table.revs) {
    return `git ${sub} must name ${table.revs === 2 ? 'two revisions (A B or A..B)' : 'a revision'} so it does not read the working tree`;
  }
  return null;
}

const NEVER = {
  awk: '"awk" is never run: gawk can reach system() through indirect calls that no checker can see; use grep, sed or cut',
  gawk: '"gawk" is never run: it can reach system() through indirect calls; use grep, sed or cut',
  jq: '"jq" is never run: its filters can import and include files; use grep or sed on the JSON text',
};

function stepProblem(words, ev, roots) {
  const head = words[0].v;
  for (const w of words) {
    if (w.v.startsWith('@')) return `"${w.v}": an argument may not start with @ (some tools read it as "the contents of this file")`;
  }
  if (Object.prototype.hasOwnProperty.call(NEVER, head)) return NEVER[head];
  if (words[0].repo || /[/\\]/.test(head)) return `"${head}": give the program name only, not a path`;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return 'setting variables before a command (VAR=value) is not allowed';
  if (!ev.allowed_heads.includes(head)) return `"${head}" is not in evidence.allowed_heads`;
  if (head === 'git') return gitProblem(words.slice(1), ev, roots);
  const table = TABLES[head];
  if (!table) return `"${head}" has no option list in this kit, so it is not run`;
  const parsed = parseOptions(head, words.slice(1).map((w) => w.v), table);
  if (parsed.error) return parsed.error;
  const late = filePatternLate(head, words.slice(1).map((w) => w.v));
  if (late) return `${late.length === 1 ? '-' : '--'}${late} comes after the pattern or a path: put file patterns before the paths`;
  return operandProblem(head, table, parsed, roots);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -> { status: 'run' | 'skipped-live' | 'skipped-unsafe', reason, steps? }
function classify(cmd, ev, ctx) {
  ctx = ctx || {};
  const text = String(cmd == null ? '' : cmd).trim();
  if (!text) return { status: 'skipped-unsafe', reason: 'empty command' };
  for (const p of ev.live_prefixes) {
    if (new RegExp('^' + escapeRe(p) + '(?=$|[\\s:])', 'i').test(text)) {
      return { status: 'skipped-live', reason: `needs a live system (starts with "${p}"); run it yourself during the measure step` };
    }
  }
  const lx = lex(text, ctx.expand || (() => null));
  if (lx.error) return { status: 'skipped-unsafe', reason: lx.error };
  for (const s of lx.steps) {
    const p = stepProblem(s.words, ev, ctx.roots || []);
    if (p) return { status: 'skipped-unsafe', reason: p };
  }
  return {
    status: 'run',
    reason: '',
    steps: lx.steps.map((s) => ({ head: s.words[0].v, args: s.words.slice(1).map((w) => w.v), stderr: s.stderr })),
  };
}

// ---------- programs, environment, masking ----------

function programDirs() {
  const dirs = [];
  if (WIN) {
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) {
      const root = path.resolve(r.stdout.trim(), '..', '..', '..');
      dirs.push(path.join(root, 'usr', 'bin'), path.join(root, 'mingw64', 'bin'), path.join(root, 'cmd'));
    }
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d && path.isAbsolute(d)) dirs.push(d);
  return [...new Set(dirs)];
}

function findProgram(name, dirs) {
  for (const d of dirs) {
    const p = path.join(d, WIN ? `${name}.exe` : name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (e) {
      // keep looking
    }
  }
  return null;
}

function childEnv(tmp, binDirs) {
  const home = path.join(tmp, 'home');
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(gitconfig, '');
  const env = {};
  for (const k of Object.keys(process.env)) if (['SYSTEMROOT', 'WINDIR'].includes(k.toUpperCase())) env[k] = process.env[k];
  const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const sys = WIN && sysRoot ? [path.join(sysRoot, 'System32')] : [];
  return Object.assign(env, NO_FETCH, {
    PATH: [...binDirs, ...sys].join(path.delimiter),
    HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
    LC_ALL: 'C', LANG: 'C', NO_COLOR: '1', MSYS_NO_PATHCONV: '1',
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  }, WIN ? { MSYS: 'noglob', MSYS2_ARG_CONV_EXCL: '*' } : {});
}

// GIT_PRE (the -c settings before every git subcommand) is shared with pin.js.

// Fixed arguments put before every sed step when the installed sed accepts
// them: GNU sed's --sandbox refuses the e, r and w commands itself, on top
// of sedScriptProblem.
const SED_FIXED = ['--sandbox'];

// Asks a sed binary, in the given child environment, whether it knows
// --sandbox. The runner asks once per run, at the first sed step.
function sedSandbox(bin, env, cwd) {
  if (!bin) return false;
  const r = spawnSync(bin, [...SED_FIXED, '--version'], { cwd, env, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false, input: '' });
  return r.status === 0;
}

// The same question for --dry-run, in a throwaway child environment.
// -> true, false, or null when no sed is installed.
function probeSed(dirs) {
  const bin = findProgram('sed', dirs);
  if (!bin) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-sedprobe-'));
  try {
    return sedSandbox(bin, childEnv(tmp, [path.dirname(bin)]), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SED_NO_SANDBOX = 'note: the installed sed does not support --sandbox; the kit\'s own sed script check is the only guard';

// Added to every searching step so a folder read never shows a file or
// folder named .env or .env followed by '.', '-' or '_' (any case; .envrc
// is another name)
// or anything inside such a folder. GNU grep's first file pattern decides what
// an unmatched file does and the last matching one wins; BSD grep stops
// reading options at the first operand. So these go after the step's own
// options and right before its first operand (the step may not give file
// patterns after its paths, see filePatternLate). git grep gets exclude
// pathspecs after "--".
const GREP_ENV_EXCLUDE = ['--exclude=.[eE][nN][vV]', '--exclude=.[eE][nN][vV].*', '--exclude=.[eE][nN][vV]-*', '--exclude=.[eE][nN][vV]_*', '--exclude-dir=.[eE][nN][vV]', '--exclude-dir=.[eE][nN][vV].*', '--exclude-dir=.[eE][nN][vV]-*', '--exclude-dir=.[eE][nN][vV]_*'];
const RG_ENV_EXCLUDE = ['--iglob=!.env', '--iglob=!.env.*', '--iglob=!.env-*', '--iglob=!.env_*'];
const GIT_ENV_EXCLUDE = [':(exclude,icase,glob)**/.env', ':(exclude,icase,glob)**/.env.*', ':(exclude,icase,glob)**/.env-*', ':(exclude,icase,glob)**/.env_*', ':(exclude,icase,glob)**/.env/**', ':(exclude,icase,glob)**/.env.*/**', ':(exclude,icase,glob)**/.env-*/**', ':(exclude,icase,glob)**/.env_*/**'];
const FILE_PATTERN_OPTS = { grep: ['include', 'exclude', 'exclude-dir'], rg: ['g', 'glob', 'iglob'] };

// Whether a git step can print the content or names of files from a tree,
// so it gets GIT_ENV_EXCLUDE after "--". show always does: git's last option
// wins (-s -p prints a patch), and on a blob or with -s the pathspec changes
// nothing. log does when it is given a patch or file-list option, unless -L
// or --follow is given (they take no extra pathspecs); a plain listing does not.
const LOG_FILE_OUTPUT = ['p', 'patch', 'unified', 'stat', 'numstat', 'shortstat', 'name-only', 'name-status'];
function gitShowsFiles(sub, rest) {
  if (sub === 'grep' || sub === 'diff' || sub === 'show') return true;
  if (sub !== 'log') return false;
  const sep = optionsEnd(rest, GIT.log);
  const { opts = [] } = parseOptions('git log', sep < 0 ? rest : rest.slice(0, sep), GIT.log);
  const names = opts.map((o) => o.name);
  return names.some((n) => LOG_FILE_OUTPUT.includes(n)) && !names.some((n) => n === 'L' || n === 'follow');
}

// How args are laid out, read with the same table as parseOptions (so an
// option value, such as an -e pattern or a "--" given to -e, is not an
// operand): sep = index of the "--" that ends the options, first = index of
// the first operand (-1 when none), late = names of options given after it.
function argLayout(args, table) {
  const out = { sep: -1, first: -1, late: [] };
  const seen = (name) => { if (out.first >= 0) out.late.push(name); };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.sep = i; if (out.first < 0 && i + 1 < args.length) out.first = i + 1; break; }
    if (a === '-' || !a.startsWith('-')) { if (out.first < 0) out.first = i; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const type = table.long[name];
      seen(name);
      if (eq < 0 && type === 'v2') i += 2;
      else if (eq < 0 && type && !['f', 'o'].includes(type)) i++;
      continue;
    }
    if (table.numeric && /^-[0-9]+$/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const type = table.short[a[k]];
      seen(a[k]);
      if (!type || type === 'f') continue;
      if (k === a.length - 1) i++;
      break;
    }
  }
  return out;
}

// Index of the "--" that ends the options of args, or -1.
function optionsEnd(args, table) {
  return argLayout(args, table).sep;
}

// The step's own file pattern given after its first operand, or null.
function filePatternLate(head, args) {
  const names = FILE_PATTERN_OPTS[head];
  if (!names) return null;
  return argLayout(args, TABLES[head]).late.find((n) => names.includes(n)) || null;
}

// Puts extra options right before the first operand (or the "--"), so they
// follow every option the step gave itself.
function beforeFirstOperand(args, table, extra) {
  const { sep, first } = argLayout(args, table);
  const at = first >= 0 && (sep < 0 || first < sep) ? first : sep >= 0 ? sep : args.length;
  return [...args.slice(0, at), ...extra, ...args.slice(at)];
}

// Detectors and masks (buildMasks, mask, detect) live in lib/mask.js, shared
// with the builders.

// Every spelling of a folder a program might print.
function spellings(dir) {
  const out = [dir];
  try { out.push(fs.realpathSync.native(dir)); } catch (e) { /* gone */ }
  for (const d of out.slice()) {
    const fwd = d.replace(/\\/g, '/');
    out.push(fwd);
    const drive = /^([A-Za-z]):\/(.*)$/.exec(fwd);
    if (drive) out.push(`/${drive[1].toLowerCase()}/${drive[2]}`, `/${drive[1].toUpperCase()}/${drive[2]}`);
  }
  return [...new Set(out)];
}

function replaceAll(text, replacements) {
  let t = text.replace(/\r\n/g, '\n');
  for (const [from, to] of replacements) t = t.split(from).join(to);
  return t;
}

function fence(text) {
  const runs = text.match(/`{3,}/g) || [];
  const len = Math.max(3, ...runs.map((r) => r.length + 1));
  return '`'.repeat(len);
}

function block(text, maxLines) {
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  if (total > maxLines) lines = lines.slice(0, maxLines).concat(`[... ${total - maxLines} more lines not shown]`);
  const body = lines.join('\n');
  const f = fence(body);
  return { total, text: `${f}\n${body}\n${f}` };
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// ---------- running ----------

// Runs the steps one after another, each step's output feeding the next.
// -> { exit, stdout, stderr, tmp } or { startError, tmp } when a step could
// not be started at all.
function execute(steps, ctx, ev) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-evidence-'));
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd);
  try {
    const bins = steps.map((s) => findProgram(s.head, ctx.dirs));
    const missing = steps.find((s, k) => !bins[k]);
    if (missing) return { startError: `program not found: ${missing.head}`, tmp };
    const env = childEnv(tmp, [...new Set(bins.map((b) => path.dirname(b)))]);
    const deadline = Date.now() + ev.timeout_ms;
    let input = Buffer.alloc(0);
    let stderr = '';
    let exit = 0;
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k];
      let args = s.args;
      if (s.head === 'git') {
        // classify() allowed only -C <repo> and --no-pager before the subcommand
        let sub = 0;
        while (args[sub].startsWith('-')) sub += args[sub] === '-C' ? 2 : 1;
        const fixed = GIT[args[sub]].fixed || [];
        const root = ctx.roots.find((r) => norm(r.dir) === norm(args[args.indexOf('-C') + 1]));
        let rest = args.slice(sub + 1);
        if (gitShowsFiles(args[sub], rest)) rest = optionsEnd(rest, GIT[args[sub]]) < 0 ? [...rest, '--', ...GIT_ENV_EXCLUDE] : [...rest, ...GIT_ENV_EXCLUDE];
        args = [...GIT_PRE, ...args.slice(0, sub + 1), ...fixed, ...rest];
        if (root && ctx.emptyTree[root.name]) env.GIT_ATTR_SOURCE = ctx.emptyTree[root.name];
      }
      if (s.head === 'grep') args = beforeFirstOperand(args, TABLES.grep, GREP_ENV_EXCLUDE);
      if (s.head === 'rg') args = beforeFirstOperand(args, TABLES.rg, RG_ENV_EXCLUDE);
      if (s.head === 'sed') {
        if (ctx.sedSandbox === undefined) ctx.sedSandbox = sedSandbox(bins[k], env, cwd);
        if (ctx.sedSandbox) args = [...SED_FIXED, ...args];
      }
      const left = deadline - Date.now();
      if (left <= 0) return { exit: 'timeout', stdout: input.toString('utf8'), stderr, tmp };
      let r;
      try {
        r = spawnSync(bins[k], args, {
          cwd, env, input, timeout: left, killSignal: 'SIGKILL', maxBuffer: MAX_STEP_BYTES, windowsHide: true, shell: false,
        });
      } catch (e) {
        return { startError: `could not start step ${k + 1} (${s.head}): ${e.code || e.message}`, tmp };
      }
      delete env.GIT_ATTR_SOURCE;
      if (r.error && !['ETIMEDOUT', 'ENOBUFS'].includes(r.error.code) && r.pid === 0) {
        return { startError: `could not start step ${k + 1} (${s.head}): ${r.error.code || r.error.message}`, tmp };
      }
      const out = r.stdout || Buffer.alloc(0);
      const err = r.stderr || Buffer.alloc(0);
      if (s.stderr === 'merge') input = Buffer.concat([out, err]);
      else {
        input = out;
        if (s.stderr === 'keep') stderr += err.toString('utf8');
      }
      if (r.error) {
        const code = r.error.code === 'ETIMEDOUT' ? 'timeout' : r.error.code === 'ENOBUFS' ? `output limit (${MAX_STEP_BYTES} bytes) reached` : String(r.error.code || 'error');
        return { exit: `${code} in step ${k + 1} (${s.head})`, stdout: input.toString('utf8'), stderr, tmp };
      }
      exit = r.status === null ? `signal ${r.signal}` : r.status;
    }
    return { exit, stdout: input.toString('utf8'), stderr, tmp };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function placeholderRepos(cmd) {
  const out = [];
  const re = /\{(?:repo|pin):([a-z0-9]+(?:-[a-z0-9]+)*)\}/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1]);
  return out;
}

// only: a command number, or null for all of them.
function receiptFor(c, ctx, only) {
  const ev = ctx.config.evidence;
  const repos = new Set([c.repo, ...c.locations.map((l) => l.repo)]);
  c.evidence.forEach((e) => placeholderRepos(e.cmd).forEach((r) => repos.add(r)));
  const pinLines = [...repos].sort().map((r) => `${r}@${ctx.pins.repos[r] ? ctx.pins.repos[r].sha : 'UNPINNED'}`);
  const parts = [
    `# Evidence receipt: ${c.id}`,
    '',
    `title: ${mask(oneLine(c.title), ctx.masks)}`,
    `source: ${oneLine(c.source)}`,
    `date: ${ctx.config.audit.date}`,
    `pins: ${pinLines.join(', ')}`,
    '',
  ];
  const entry = { id: c.id, receipt: '', sha: contentSha(c), ran: 0, failed: 0, skipped_live: 0, skipped_unsafe: 0, skipped_error: 0, commands: [] };
  c.evidence.forEach((e, idx) => {
    const n = idx + 1;
    if (only && n !== only) return;
    const cl = classify(e.cmd, ev, ctx);
    const shownCmd = mask(String(e.cmd).trim(), ctx.masks);
    const f = fence(shownCmd);
    parts.push(`## Command ${n} of ${c.evidence.length}`, '', 'command:', f, shownCmd, f, `expect: ${mask(oneLine(e.expect), ctx.masks)}`);
    if (cl.status !== 'run') {
      entry[cl.status === 'skipped-live' ? 'skipped_live' : 'skipped_unsafe']++;
      entry.commands.push({ n, status: cl.status, reason: cl.reason, exit: null });
      parts.push(`classification: ${cl.status}`, `reason: ${cl.reason}`, 'exit code: not run', '');
      return;
    }
    const r = execute(cl.steps, ctx, ev);
    if (r.startError) {
      entry.skipped_error++;
      entry.commands.push({ n, status: 'skipped-error', reason: r.startError, exit: null });
      parts.push('classification: skipped-error', `reason: ${r.startError}`, 'exit code: not run', '');
      return;
    }
    const repl = ctx.replacements.concat(spellings(r.tmp).map((s) => [s, '<tmp>']))
      .sort((a, b) => b[0].length - a[0].length);
    const stdout = replaceAll(r.stdout, repl);
    const stderr = replaceAll(r.stderr, repl);
    entry.ran++;
    if (r.exit !== 0) entry.failed++;
    entry.commands.push({ n, status: 'ran', reason: '', exit: r.exit });
    parts.push('classification: ran', `exit code: ${r.exit}`);
    const hit = detect(stdout, ctx.masks) || detect(stderr, ctx.masks);
    if (hit) {
      parts.push(`[output withheld: ${hit}]`, '');
      return;
    }
    const out = block(stdout, ev.max_lines);
    const err = block(stderr, ev.max_lines);
    parts.push(`output (${out.total} line${out.total === 1 ? '' : 's'}):`, out.text);
    if (err.total) parts.push(`errors (${err.total} line${err.total === 1 ? '' : 's'}):`, err.text);
    parts.push('');
  });
  const body = parts.join('\n');
  entry.receipt = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return { text: `receipt: ${entry.receipt}\n${body}`, entry };
}

function loadCandidates(paths, config) {
  const file = path.join(paths.work, 'candidates.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError('no candidates yet: work/candidates.json is missing (Phase 2 writes it)');
    throw new CliError(`cannot read work/candidates.json (${e.code || e.message})`);
  }
  const errs = validateCandidates(data, config);
  if (errs.length) {
    const shown = errs.slice(0, 20).map((m) => `  - ${m}`);
    if (errs.length > 20) shown.push(`  ... and ${errs.length - 20} more`);
    throw new CliError(`work/candidates.json has ${errs.length} problem${errs.length === 1 ? '' : 's'}:\n${shown.join('\n')}`);
  }
  return Array.isArray(data) ? data : data.candidates;
}

// The empty tree of each repo (its object format decides the id).
function emptyTrees(roots) {
  const out = {};
  for (const r of roots) {
    const res = spawnSync('git', ['-C', r.dir, ...GIT_PRE, 'hash-object', '-t', 'tree', '--stdin'], {
      input: '', encoding: 'utf8', timeout: 20000, windowsHide: true, env: gitEnv(),
    });
    if (res.status === 0) out[r.name] = res.stdout.trim();
  }
  return out;
}

function run(opts, io) {
  const { config, paths } = loadConfig(opts.workspace);
  const pins = readPins(paths);
  const candidates = loadCandidates(paths, config);
  const ev = config.evidence;
  const expand = (kind, name) => {
    if (kind === 'pin') return pins.repos[name] ? pins.repos[name].sha : null;
    return paths.repos[name] ? paths.repos[name].replace(/\\/g, '/') : null;
  };
  const roots = makeRoots(paths.repos);
  const base = { expand, roots };
  // The .git check of kit pin, again, before git runs on any repo.
  const refused = [];
  for (const r of roots) {
    if (pins.repos[r.name] && pins.repos[r.name].trust_git_dir) continue;
    const chk = gitDirCheck(r.dir);
    const why = chk.notRepo ? [`not a git repository (${chk.notRepo})`] : chk.problems;
    if (why.length) refused.push(`${r.name}: ${why.join('; ')}`);
  }
  if (refused.length) {
    const list = refused.map((m) => `  - ${m}`).join('\n');
    throw new CliError(`refusing to run git on these repos; their .git folder can start programs or point git elsewhere:\n${list}\nClone the repo again from a remote you trust, or re-pin with --trust-git-dir (recorded).`);
  }

  if (opts.dryRun) {
    const tally = { run: 0, 'skipped-live': 0, 'skipped-unsafe': 0 };
    let usesSed = false;
    for (const c of candidates) {
      c.evidence.forEach((e, i) => {
        const cl = classify(e.cmd, ev, base);
        tally[cl.status]++;
        if (cl.status === 'run' && cl.steps.some((s) => s.head === 'sed')) usesSed = true;
        io.out(`${c.id} #${i + 1} ${cl.status === 'run' ? 'would run' : cl.status}${cl.reason ? ': ' + cl.reason : ''}`);
      });
    }
    if (usesSed && probeSed(programDirs()) === false) io.out(SED_NO_SANDBOX);
    io.out(`dry run: ${tally.run} would run, ${tally['skipped-live']} skipped-live, ${tally['skipped-unsafe']} skipped-unsafe; nothing written`);
    return 0;
  }

  const replacements = [];
  for (const [name, dir] of Object.entries(paths.repos)) {
    if (dir) for (const s of spellings(dir)) replacements.push([s, `{repo:${name}}`]);
  }
  const dirs = programDirs();
  const ctx = { ...base, config, pins, masks: buildMasks(config), replacements, dirs, emptyTree: emptyTrees(roots) };
  const noteSed = () => { if (ctx.sedSandbox === false) io.err(SED_NO_SANDBOX); };

  if (opts.only) {
    const c = candidates.find((x) => x.id === opts.only);
    if (!c) throw new CliError(`--only: no candidate "${opts.only}" in work/candidates.json`);
    if (opts.cmd !== null && opts.cmd > c.evidence.length) {
      throw new CliError(`--cmd ${opts.cmd}: ${c.id} has ${c.evidence.length} command${c.evidence.length === 1 ? '' : 's'}`);
    }
    io.out(receiptFor(c, ctx, opts.cmd).text);
    noteSed();
    return 0;
  }

  const outDir = path.join(paths.work, 'phase3', 'receipts');
  fs.mkdirSync(outDir, { recursive: true });
  const ids = new Set(candidates.map((c) => c.id));
  for (const f of fs.readdirSync(outDir)) {
    const m = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{2,})\.md$/.exec(f);
    if (m && !ids.has(m[1])) fs.rmSync(path.join(outDir, f)); // receipt of a candidate that is gone
  }
  const index = {
    date: config.audit.date,
    pins: Object.fromEntries(Object.entries(pins.repos).map(([k, v]) => [k, v.sha])),
    totals: { ran: 0, failed: 0, skipped_live: 0, skipped_unsafe: 0, skipped_error: 0 },
    candidates: [],
  };
  for (const c of candidates) {
    const { text, entry } = receiptFor(c, ctx);
    fs.writeFileSync(path.join(outDir, `${c.id}.md`), text);
    index.candidates.push(entry);
    for (const k of Object.keys(index.totals)) index.totals[k] += entry[k];
  }
  fs.writeFileSync(path.join(outDir, '_index.json'), JSON.stringify(index, null, 2) + '\n');
  const t = index.totals;
  io.out(`${candidates.length} receipts; ran ${t.ran} (non-zero exit ${t.failed}), skipped-live ${t.skipped_live}, skipped-unsafe ${t.skipped_unsafe}, skipped-error ${t.skipped_error}`);
  const none = index.candidates.filter((x) => x.ran - x.failed === 0).map((x) => x.id);
  io.out(`candidates with no command that ran cleanly: ${none.join(', ') || 'none'}`);
  noteSed();
  return 0;
}

function parseArgs(argv) {
  const opts = { workspace: null, dryRun: false, help: false, only: null, cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') {
      opts.only = argv[++i];
      if (!opts.only) throw new CliError('--only needs a candidate id');
    } else if (a === '--cmd') {
      const v = argv[++i];
      if (!/^[1-9][0-9]*$/.test(v || '')) throw new CliError('--cmd needs a command number from 1');
      opts.cmd = Number(v);
    }
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (opts.workspace !== null) throw new CliError('only one workspace may be given');
    else opts.workspace = a;
  }
  opts.workspace = opts.workspace || '.';
  if (opts.cmd !== null && !opts.only) throw new CliError('--cmd needs --only <candidate-id>');
  if (opts.only && opts.dryRun) throw new CliError('--only and --dry-run cannot be combined');
  return opts;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.out('usage: node tooling/run-evidence.js [<workspace>] [--dry-run | --only <candidate-id> [--cmd <n>]]   (an allowlist, NOT a sandbox)');
      return 0;
    }
    return run(opts, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`run-evidence: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, classify, lex, buildMasks, mask, detect, sedScriptProblem, sedSandbox, probeSed, globCouldMatchEnv, optionsEnd, argLayout, beforeFirstOperand, makeRoots, TABLES, GIT, SED_FIXED, GREP_ENV_EXCLUDE, RG_ENV_EXCLUDE, GIT_ENV_EXCLUDE };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
