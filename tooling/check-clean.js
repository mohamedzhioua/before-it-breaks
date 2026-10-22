'use strict';
/*
 * check-clean.js - maintainer leak gate.
 *
 * Scans files (or stdin, or the git index) for text that must never be
 * published: user-home paths, credentialed connection strings, keys and
 * tokens, email addresses, plus any project-specific terms listed in a
 * private denylist file.
 *
 * Usage:
 *   node tooling/check-clean.js [--denylist <file>] [--stdin] [--staged]
 *                               [--strict] [--ngram-source <path>]...
 *                               [<path>...]
 *
 *   <path>            file or directory to scan (default: current directory).
 *                     Inside a git work tree the file set is
 *                     `git ls-files -co --exclude-standard` under that path;
 *                     otherwise the directory is walked (.git and
 *                     node_modules skipped). Symlinks are not followed; the
 *                     link's target string is scanned as text.
 *   --denylist <file> private rule file (format below). Keep it OUTSIDE the
 *                     repository you are scanning. Without it a warning is
 *                     printed and only the built-in checks run.
 *   --stdin           scan text read from stdin, reported as "<stdin>"
 *                     (e.g. `git log --all -p | node tooling/check-clean.js
 *                     --denylist <file> --stdin`). Paths are scanned only
 *                     when given explicitly.
 *   --staged          scan the git index (exactly what the next commit would
 *                     contain) under each <path> instead of the work tree.
 *   --strict          review hits also fail the run.
 *   --ngram-source <path>
 *                     repeatable; file or directory. Any run of 8 consecutive
 *                     words (lowercased, punctuation stripped) shared between
 *                     a scanned file and a source is reported. In .md, .yaml,
 *                     .yml, .txt files and stdin it is a must-zero hit; in
 *                     other files it is a review hit. A scanned file that is
 *                     itself one of the sources is not compared with itself.
 *
 * Exit codes: 0 clean, 1 must-zero hits (or review hits with --strict),
 * 2 usage, configuration or read error, or no file scanned (without --stdin).
 *
 * Denylist file format - one rule per line:
 *
 *   <severity> <class-letter> <regex>[ @except <glob>[,<glob>...]]
 *   allow <built-in-label> <glob>[,<glob>...]
 *
 *   severity      must | review          (case-insensitive regex)
 *                 must-cs | review-cs    (case-sensitive regex)
 *   class-letter  one letter A-Z, used for grouping in the summary.
 *   regex         JavaScript regular expression source (no slashes, no flags).
 *   @except       optional; a comma-separated list of globs. The rule does not
 *                 apply to files whose relative path matches one of them.
 *   allow         exempts matching paths from one built-in check, named by
 *                 the label it prints (e.g. "allow unscanned-binary
 *                 docs/img/*.svg"). Use it for files made for the kit.
 *   Globs use "/" separators: "*" = any run of characters except "/",
 *   "**" = anything, "**" + "/" = zero or more directories, "?" = one
 *   character. A glob without "/" still matches the whole relative path, so
 *   "LICENSE" allows only the top-level LICENSE file. Relative paths are
 *   relative to the scanned directory; a single scanned file is relative to
 *   its git root (or the current directory outside git). Exceptions never
 *   apply to stdin. Lines that are empty or start with "#" are ignored.
 *
 * Built-in checks (generic, no project terms):
 *   [must][D]   user-home paths (plain and URL-encoded), credentialed
 *               connection URIs and web URLs, cloud access and API keys,
 *               private-key headers, well-known token prefixes, signed
 *               web tokens, live payment keys, email addresses.
 *   [review][E] 40-hex strings and "@<10 hex>:" commit citations.
 *   [must][F]   files with extension .pptx .pdf .docx .png .jpg .jpeg .zip,
 *               files larger than 500 KB, and binary files that cannot be
 *               scanned as text (UTF-16 with a byte-order mark is decoded).
 *   [review][F] paths with a "receipts", "results", "system-docs" or "deck"
 *               directory, a "candidates.json" file, or a segment starting
 *               with "votes-", "final-verdicts" or "dashboard".
 *   [must|review][G] shared 8-word runs (only with --ngram-source).
 *
 * Output: one line per hit, `path:line: [sev][class] label: excerpt`
 * (line 0 = whole-file check), sorted by path, line, class and label, then a
 * summary line with the number of files scanned. Built-in patterns are
 * assembled from fragments so that this file's own source text cannot match
 * them; every repeat is bounded so long lines stay fast.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_BYTES = 500 * 1024;
const NGRAM = 8;
const EXCERPT = 80;
const BS = String.fromCharCode(92); // backslash
const AT = String.fromCharCode(64); // at sign

const FORBIDDEN_EXT = ['pptx', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'zip'];
const NGRAM_TEXT_EXT = ['.md', '.yaml', '.yml', '.txt'];
const SUSPECT_DIRS = ['receipts', 'results', 'system-docs', 'deck'];
const SUSPECT_FILES = ['candidates.json'];
const SUSPECT_PREFIXES = ['votes-', 'final-verdicts', 'dashboard'];

class CliError extends Error {}

function fsError(e, p) {
  if (e && e.code) return new CliError(`cannot read ${toPosix(String(p))}: ${e.code}`);
  return e;
}

// ---------- built-in patterns (joined from fragments at load time) ----------

function rx(parts, flags) {
  return new RegExp(parts.join(''), flags);
}
const S = BS + 's';
const SEP = '[' + BS + BS + '/]';
const NOT_PATH = '[^/' + BS + BS + S + '"\'<>]';
const URI_USER = '[^<"' + S + ':' + AT + '/]{0,256}';
const URI_PASS = '[^<"' + S + AT + '/]{0,256}';
const B = BS + 'b';
const B64URL = '[A-Za-z0-9_' + BS + '-]';
// Not preceded by a base64url character: a run of them starts one match
// attempt, not one per position (a word boundary would restart after
// every '-').
const NOT_AFTER_B64 = '(?<!' + B64URL + ')';
const BUILTINS = [
  { sev: 'must', cls: 'D', label: 'user-home-path',
    re: rx(['[A-Za-z]', ':', SEP, '{1,4}', 'Users', SEP], 'i') },
  { sev: 'must', cls: 'D', label: 'user-home-path',
    re: rx(['/', 'Users', '/', NOT_PATH, '{1,256}', '/'], 'i') },
  { sev: 'must', cls: 'D', label: 'user-home-path',
    re: rx([BS, BS, 'Users', BS, BS, NOT_PATH, '{1,256}', BS, BS], 'i') },
  { sev: 'must', cls: 'D', label: 'user-home-path',
    re: rx(['/', 'home', '/', NOT_PATH, '{1,256}'], 'i') },
  { sev: 'must', cls: 'D', label: 'user-home-path',
    re: rx(['%', '(?:2F|5C)', '(?:Users|home)', '%', '(?:2F|5C)', '[^%' + S + '"\'<>]{1,256}'], 'i') },
  { sev: 'must', cls: 'D', label: 'credentialed-uri',
    re: rx(['mongo', 'db(?:' + BS + '+srv)?', ':', '//', '[^<"' + S + AT + '/]{1,256}', AT], 'i') },
  { sev: 'must', cls: 'D', label: 'credentialed-uri',
    re: rx(['(?:red', 'iss?|post', 'gres(?:ql)?|my', 'sql|am', 'qps?)', ':', '//', URI_USER, ':', URI_PASS, AT], 'i') },
  // Web URL with a user and a password before the host. The user part
  // cannot hold "/", so "https://host/path@v1" is not a hit.
  { sev: 'must', cls: 'D', label: 'credentialed-uri',
    re: rx([B, 'htt', 'ps?', ':', '//', '[^<"' + S + ':' + AT + '/]{1,256}', ':', '[^<"' + S + AT + '/]{1,256}', AT], 'i') },
  { sev: 'must', cls: 'D', label: 'jwt',
    re: rx([NOT_AFTER_B64, 'ey', 'J', B64URL, '{8,4096}', BS, '.', 'ey', 'J', B64URL, '{8,4096}', BS, '.', B64URL, '{8,4096}'], '') },
  { sev: 'must', cls: 'D', label: 'payment-key',
    re: rx([B, '(?:sk|rk)', '_li', 've_', '[0-9A-Za-z]{10,256}'], '') },
  { sev: 'must', cls: 'D', label: 'cloud-api-key',
    re: rx([NOT_AFTER_B64, 'AI', 'za', '[0-9A-Za-z_' + BS + '-]{35}'], '') },
  { sev: 'must', cls: 'D', label: 'cloud-access-key',
    re: rx([B, '(?:AK|AS)', 'IA', '[0-9A-Z]{12,64}'], '') },
  { sev: 'must', cls: 'D', label: 'private-key-block',
    re: rx(['BEG', 'IN ', '[A-Z ]{0,64}', 'PRIV', 'ATE KEY'], 'i') },
  { sev: 'must', cls: 'D', label: 'token-prefix',
    re: rx([B, '(?:gl', 'pat-|gh', '[pousr]_|git', 'hub_pat_|sk', '-ant-|sk', '-proj-|xo', 'x[abpors]-)'], 'i') },
  { sev: 'must', cls: 'D', label: 'email-address',
    re: rx(['[A-Za-z0-9._%+-]{1,64}', AT, '[A-Za-z0-9.-]{1,253}', BS, '.', '[a-z]{2,63}'], 'i') },
  { sev: 'review', cls: 'E', label: 'hex-40',
    re: rx([B, '[0-9a-f]{40}', B], 'i') },
  { sev: 'review', cls: 'E', label: 'commit-citation',
    re: rx([AT, '[0-9a-f]{10}', ':'], 'i') },
];

// ---------- argument parsing ----------

function parseArgs(argv) {
  const opts = { denylist: null, stdin: false, staged: false, strict: false, ngramSources: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needValue = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new CliError(`option ${a} needs a value`);
      }
      return argv[++i];
    };
    if (a === '--denylist') opts.denylist = needValue();
    else if (a === '--stdin') opts.stdin = true;
    else if (a === '--staged') opts.staged = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--ngram-source') opts.ngramSources.push(needValue());
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-') && a !== '-') throw new CliError(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (!opts.stdin && opts.paths.length === 0) opts.paths.push('.');
  return opts;
}

// ---------- denylist ----------

function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (glob.startsWith('**/', i)) { out += '(?:.*/)?'; i += 2; }
    else if (glob.startsWith('**', i)) { out += '.*'; i += 1; }
    else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if ('.+^${}()|[]'.includes(ch) || ch === BS) out += BS + ch;
    else out += ch;
  }
  return new RegExp(out + '$');
}

function parseGlobs(list) {
  return list.split(',').map((g) => g.trim()).filter(Boolean);
}

function parseDenylist(text, file) {
  const rules = [];
  const allows = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const al = /^allow\s+([a-z0-9-]+)\s+(.+)$/.exec(line);
    if (al) {
      const globs = parseGlobs(al[2]);
      if (!globs.length) { errors.push(`${file}:${lineNo}: allow needs at least one glob`); return; }
      allows.push({ label: al[1], globs: globs.map(globToRegExp) });
      return;
    }
    const m = /^(must|review|must-cs|review-cs)\s+([A-Za-z])\s+(.+)$/.exec(line);
    if (!m) { errors.push(`${file}:${lineNo}: expected "<must|review>[-cs] <class-letter> <regex>" or "allow <label> <globs>"`); return; }
    let body = m[3];
    let except = [];
    const ex = body.lastIndexOf(' @except ');
    if (ex !== -1) {
      except = parseGlobs(body.slice(ex + 9));
      body = body.slice(0, ex).trim();
      if (except.length === 0) { errors.push(`${file}:${lineNo}: @except needs at least one glob`); return; }
    }
    const cs = m[1].endsWith('-cs');
    let re;
    try { re = new RegExp(body, cs ? '' : 'i'); }
    catch (e) { errors.push(`${file}:${lineNo}: invalid regex: ${e.message}`); return; }
    rules.push({
      sev: m[1].replace('-cs', ''), cls: m[2].toUpperCase(), label: `denylist:${lineNo}`,
      re, except: except.map(globToRegExp),
    });
  });
  if (errors.length) throw new CliError(`denylist errors:\n  ${errors.join('\n  ')}`);
  return { rules, allows };
}

// ---------- file collection ----------
// An entry is { key, display, rel, load() -> { buf, link } }.

function toPosix(p) { return p.split(path.sep).join('/'); }

function git(dir, args, opts = {}) {
  const res = spawnSync('git', ['-C', dir, ...args], { maxBuffer: 1024 * 1024 * 1024, ...opts });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

function gitTopLevel(dir) {
  const out = git(dir, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return out ? out.trim() : null;
}

// Relative path used for @except / allow matching on a single file argument.
function relForFile(file) {
  const top = gitTopLevel(path.dirname(path.resolve(file)));
  return toPosix(path.relative(top || process.cwd(), path.resolve(file)));
}

function diskLoader(abs) {
  return () => {
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return { buf: Buffer.from(fs.readlinkSync(abs), 'utf8'), link: true };
      return { buf: fs.readFileSync(abs), link: false };
    } catch (e) { throw fsError(e, abs); }
  };
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw fsError(e, dir); }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() || e.isSymbolicLink()) out.push(full);
  }
}

function statRoot(root) {
  try { return fs.lstatSync(root); } catch (e) {
    if (e.code === 'ENOENT') throw new CliError(`path not found: ${root}`);
    throw fsError(e, root);
  }
}

function collectWorkTree(root) {
  const st = statRoot(root);
  if (!st.isDirectory()) {
    const abs = path.resolve(root);
    return [{ key: abs, display: toPosix(root), rel: relForFile(root), load: diskLoader(abs) }];
  }
  let files = null;
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' });
  if (listed !== null && gitTopLevel(root)) {
    files = listed.split('\0').filter(Boolean).map((rel) => path.join(root, rel))
      .filter((f) => { try { fs.lstatSync(f); return true; } catch { return false; } }); // tracked but deleted
  } else {
    files = [];
    walk(root, files);
  }
  return files.map((f) => {
    const rel = toPosix(path.relative(root, f));
    return { key: path.resolve(f), display: toPosix(path.join(root, rel)), rel, load: diskLoader(path.resolve(f)) };
  });
}

// Index entries under root, with blob content read through one cat-file call.
function collectStaged(root) {
  const st = statRoot(root);
  const dir = st.isDirectory() ? root : path.dirname(root);
  const top = gitTopLevel(dir);
  if (!top) throw new CliError(`--staged needs a git work tree: ${root}`);
  const args = ['ls-files', '-s', '-z'];
  if (!st.isDirectory()) args.push('--', path.basename(root));
  const listed = git(dir, args, { encoding: 'utf8' });
  if (listed === null) throw new CliError(`git ls-files failed in ${dir}`);
  const items = [];
  const seen = new Set();
  for (const rec of listed.split('\0').filter(Boolean)) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(rec);
    if (!m || m[1] === '160000' || seen.has(m[4])) continue; // skip submodules and extra merge stages
    seen.add(m[4]);
    items.push({ mode: m[1], sha: m[2], relToDir: m[4] });
  }
  if (!items.length) return [];
  const out = git(dir, ['cat-file', '--batch'], { input: items.map((x) => x.sha).join('\n') + '\n' });
  if (out === null) throw new CliError(`git cat-file failed in ${dir}`);
  const blobs = [];
  let pos = 0;
  for (let n = 0; n < items.length; n++) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.slice(pos, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (nl < 0 || header[1] === 'missing' || !Number.isInteger(size)) {
      throw new CliError(`git cat-file could not read blob ${items[n].sha} (${items[n].relToDir})`);
    }
    blobs.push(out.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return items.map((x, n) => {
    const abs = path.resolve(dir, x.relToDir);
    const rel = st.isDirectory() ? x.relToDir : toPosix(path.relative(top, abs));
    const display = toPosix(st.isDirectory() ? path.join(root, x.relToDir) : root);
    return { key: 'index:' + abs, display, rel, load: () => ({ buf: blobs[n], link: x.mode === '120000' }) };
  });
}

// Returns text, or null for binary content that cannot be decoded.
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.slice(2, 2 + ((buf.length - 2) & ~1))); // copy, even length
    return body.swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null;
  return buf.toString('utf8');
}

// ---------- 8-grams ----------

function words(text) {
  // Lowercase, drop apostrophes, treat every other non-letter/digit as a break.
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const toks = lines[i].toLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
    for (const t of toks) out.push({ w: t, line: i + 1 });
  }
  return out;
}

function buildNgramIndex(sourceRoots) {
  const set = new Set();
  const files = new Set();
  for (const root of sourceRoots) {
    for (const f of collectWorkTree(root)) {
      const text = decode(f.load().buf);
      if (text === null) continue;
      files.add(f.key);
      const ws = words(text).map((x) => x.w);
      for (let i = 0; i + NGRAM <= ws.length; i++) set.add(ws.slice(i, i + NGRAM).join(' '));
    }
  }
  return { set, files };
}

function ngramHits(text, index, display, sev) {
  const ws = words(text);
  const hits = [];
  let lastEnd = -1;
  for (let i = 0; i + NGRAM <= ws.length; i++) {
    const gram = ws.slice(i, i + NGRAM).map((x) => x.w).join(' ');
    if (!index.set.has(gram)) continue;
    // One hit per maximal shared run: skip grams overlapping the previous hit's run.
    if (i <= lastEnd) { lastEnd = i + NGRAM - 1; continue; }
    lastEnd = i + NGRAM - 1;
    hits.push({ path: display, line: ws[i].line, sev, cls: 'G', label: 'shared-8-gram', excerpt: gram });
  }
  return hits;
}

// ---------- scanning ----------

function excerptOf(line, idx) {
  const start = Math.max(0, idx - 20);
  return line.slice(start, start + EXCERPT).replace(/\s+/g, ' ').trim();
}

function scanText(text, file, rules) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  const active = rules.filter((r) => !(file.rel !== null && r.except.some((g) => g.test(file.rel))));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const labels = new Set(); // several built-ins share a label; report it once per line
    for (const r of active) {
      const m = r.re.exec(line);
      if (!m || labels.has(r.label)) continue;
      labels.add(r.label);
      hits.push({ path: file.display, line: i + 1, sev: r.sev, cls: r.cls, label: r.label, excerpt: excerptOf(line, m.index) });
    }
  }
  return hits;
}

function fileChecks(file, size, binary) {
  const hits = [];
  const add = (sev, label, excerpt) => hits.push({ path: file.display, line: 0, sev, cls: 'F', label, excerpt });
  const ext = path.extname(file.rel).slice(1).toLowerCase();
  if (FORBIDDEN_EXT.includes(ext)) add('must', 'forbidden-extension', '.' + ext);
  if (size > MAX_BYTES) add('must', 'file-too-large', `${size} bytes > ${MAX_BYTES}`);
  if (binary) add('must', 'unscanned-binary', 'binary content, not scanned as text');
  const segs = file.rel.toLowerCase().split('/');
  const flagged = segs.slice(0, -1).some((d) => SUSPECT_DIRS.includes(d)) ||
    SUSPECT_FILES.includes(segs[segs.length - 1]) ||
    segs.some((s) => SUSPECT_PREFIXES.some((p) => s.startsWith(p)));
  if (flagged) add('review', 'suspect-path', file.rel);
  return hits;
}

function isAllowed(hit, rel, allows) {
  return rel !== null && allows.some((a) => a.label === hit.label && a.globs.some((g) => g.test(rel)));
}

function sortHits(hits) {
  return hits.sort((a, b) =>
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line ||
    (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0) ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
    (a.excerpt < b.excerpt ? -1 : a.excerpt > b.excerpt ? 1 : 0));
}

function summarize(hits, files) {
  const must = hits.filter((h) => h.sev === 'must').length;
  const review = hits.length - must;
  const per = {};
  for (const h of hits) {
    per[h.cls] = per[h.cls] || { must: 0, review: 0 };
    per[h.cls][h.sev]++;
  }
  const parts = Object.keys(per).sort().map((k) => `${k}=${per[k].must}/${per[k].review}`);
  return {
    must, review,
    line: `summary: files=${files} must=${must} review=${review}` + (parts.length ? ` | per class (must/review): ${parts.join(' ')}` : ''),
  };
}

function scanEntry(file, rules, allows, index) {
  const { buf, link } = file.load();
  const text = decode(buf);
  let hits = fileChecks(file, link ? 0 : buf.length, text === null);
  if (text !== null) {
    hits.push(...scanText(text, file, rules));
    if (index && !index.files.has(file.key)) {
      const sev = NGRAM_TEXT_EXT.includes(path.extname(file.rel).toLowerCase()) ? 'must' : 'review';
      hits.push(...ngramHits(text, index, file.display, sev));
    }
  }
  return hits.filter((h) => !isAllowed(h, file.rel, allows));
}

function run(opts, io) {
  const rules = BUILTINS.map((b) => ({ ...b, except: [] }));
  let allows = [];
  if (opts.denylist) {
    let text;
    try { text = fs.readFileSync(opts.denylist, 'utf8'); }
    catch { throw new CliError(`cannot read denylist: ${opts.denylist}`); }
    const parsed = parseDenylist(text, opts.denylist);
    rules.push(...parsed.rules);
    allows = parsed.allows;
  } else {
    io.err('check-clean: warning: no --denylist given; only the built-in generic checks run');
  }
  for (const s of opts.ngramSources) {
    if (!fs.existsSync(s)) throw new CliError(`ngram source not found: ${s}`);
  }
  const index = opts.ngramSources.length ? buildNgramIndex(opts.ngramSources) : null;

  const hits = [];
  if (opts.stdin) {
    // Never fail open: undecodable stdin is scanned with NULs stripped.
    const raw = io.readStdin();
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    const text = decode(buf) ?? buf.toString('utf8').replace(/\0/g, '');
    const file = { rel: null, display: '<stdin>' };
    hits.push(...scanText(text, file, rules));
    if (index) hits.push(...ngramHits(text, index, file.display, 'must'));
  }
  const seen = new Set();
  for (const root of opts.paths) {
    const entries = opts.staged ? collectStaged(root) : collectWorkTree(root);
    for (const file of entries) {
      if (seen.has(file.key)) continue;
      seen.add(file.key);
      hits.push(...scanEntry(file, rules, allows, index));
    }
  }
  if (!opts.stdin && seen.size === 0) {
    throw new CliError(`no files to scan under: ${opts.paths.join(', ')}`);
  }
  sortHits(hits);
  for (const h of hits) io.out(`${h.path}:${h.line}: [${h.sev}][${h.cls}] ${h.label}: ${h.excerpt.slice(0, EXCERPT)}`);
  const sum = summarize(hits, seen.size);
  io.out(sum.line);
  if (sum.must > 0 || (opts.strict && sum.review > 0)) return 1;
  return 0;
}

function main(argv, io) {
  io = io || {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    readStdin: () => fs.readFileSync(0),
  };
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.out('usage: node tooling/check-clean.js [--denylist <file>] [--stdin] [--staged] [--strict] [--ngram-source <path>]... [<path>...]');
      return 0;
    }
    return run(opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`check-clean: ${e.message}`);
      return 2;
    }
    if (e && e.code) {
      io.err(`check-clean: ${e.code}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { main, parseDenylist, globToRegExp, BUILTINS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
