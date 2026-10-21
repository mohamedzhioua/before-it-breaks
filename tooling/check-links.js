'use strict';
/*
 * check-links.js - every relative Markdown link must reach an existing
 * file, and every #anchor must reach a heading or an explicit
 * <a id="..."> / <a name="..."> in its target.
 *
 * Usage:
 *   node tooling/check-links.js [<workspace>] [--host github|gitlab|any] [<root>...]
 *
 *   <workspace>  folder the roots are relative to (default: current folder).
 *   <root>       a .md file, or a folder searched for .md files. Default:
 *                the top-level *.md files of the workspace, plus the
 *                config's docs folder when the workspace has an
 *                audit.config.json.
 *   --host       which heading-slug rules an anchor may follow. github:
 *                lower case, punctuation removed, each space becomes "-".
 *                gitlab: the same, then runs of "-" become one. any (the
 *                default without a config): either. With a config the
 *                default is publish.docs_host.
 * Links with a scheme (https:, mailto: ...) are not checked; nor is
 * anything inside code blocks or inline code.
 *
 * Exit codes: 0 no broken link, 1 broken links (listed), 2 usage error or
 * no Markdown file found.
 */

const fs = require('fs');
const path = require('path');

const USAGE = 'usage: node tooling/check-links.js [<workspace>] [--host github|gitlab|any] [<root>...]';
const HOSTS = ['github', 'gitlab', 'any'];

function walk(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return p.endsWith('.md') ? [p] : [];
  return fs.readdirSync(p).sort().flatMap((f) => (f === '.git' || f === 'node_modules' ? [] : walk(path.join(p, f))));
}

// Blank out fenced blocks and inline code, keeping line numbers.
function stripCode(text) {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/``[^\n]*?``|`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

function headingText(raw) {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    // _emphasis_ loses its underscores; an underscore inside a word stays.
    .replace(/(^|[^\p{L}\p{N}_])_+([^_]+?)_+(?=[^\p{L}\p{N}_]|$)/gu, '$1$2')
    .trim()
    .toLowerCase();
}

function slugGithub(text) {
  return text.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');
}

function slugGitlab(text) {
  return text.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-').replace(/-+/g, '-');
}

const cache = new Map();
function anchorsOf(file, host) {
  const key = `${host}\0${file}`;
  if (cache.has(key)) return cache.get(key);
  const raw = fs.readFileSync(file, 'utf8');
  const noFences = raw.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '');
  const set = new Set();
  const rules = host === 'any' ? [slugGithub, slugGitlab] : [host === 'gitlab' ? slugGitlab : slugGithub];
  for (const rule of rules) {
    const seen = new Map();
    for (const m of noFences.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
      const base = rule(headingText(m[1]));
      const n = seen.get(base) || 0;
      set.add(n ? `${base}-${n}` : base);
      seen.set(base, n + 1);
    }
  }
  for (const m of stripCode(raw).matchAll(/<a\s+(?:[^>]*\s)?(?:id|name)="([^"]+)"/g)) set.add(m[1].toLowerCase());
  cache.set(key, set);
  return set;
}

function checkFiles(files, host, base) {
  let checked = 0;
  const broken = [];
  for (const file of files) {
    const lines = stripCode(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const href = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
        checked++;
        const hash = href.indexOf('#');
        const rawPath = hash < 0 ? href : href.slice(0, hash);
        const anchor = hash < 0 ? '' : href.slice(hash + 1);
        let target;
        try {
          target = rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
        } catch (e) {
          broken.push(`${path.relative(base, file).split(path.sep).join('/')}:${i + 1}  bad escape  ${href}`);
          continue;
        }
        const where = `${path.relative(base, file).split(path.sep).join('/')}:${i + 1}`;
        if (!fs.existsSync(target)) { broken.push(`${where}  missing file  ${href}`); continue; }
        if (anchor && target.endsWith('.md') && !anchorsOf(target, host).has(decodeURIComponent(anchor).toLowerCase())) {
          broken.push(`${where}  missing anchor  ${href}`);
        }
      }
    });
  }
  return { checked, broken };
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  let ws = null;
  let host = null;
  const roots = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { io.out(USAGE); return 0; }
    if (a === '--host') {
      host = argv[++i];
      if (!HOSTS.includes(host)) { io.err(`check-links: --host must be one of ${HOSTS.join(', ')}`); return 2; }
    } else if (a.startsWith('-')) { io.err(`check-links: unknown option ${a}\n${USAGE}`); return 2; } else if (ws === null) ws = a;
    else roots.push(a);
  }
  const base = path.resolve(ws || '.');
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) { io.err(`check-links: workspace folder not found: ${base}`); return 2; }
  let docsDir = null;
  if (fs.existsSync(path.join(base, 'audit.config.json'))) {
    const { loadConfig, ConfigError } = require('./lib/config');
    try {
      const { config, paths } = loadConfig(base);
      docsDir = paths.docs;
      if (!host) host = config.publish.docs_host;
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      io.err(`check-links: ${e.message}`);
      return 2;
    }
  }
  host = host || 'any';
  let files;
  try {
    if (roots.length) files = roots.flatMap((r) => walk(path.resolve(base, r)));
    else {
      files = fs.readdirSync(base).sort().filter((f) => f.endsWith('.md')).map((f) => path.join(base, f));
      if (docsDir && fs.existsSync(docsDir)) files = files.concat(walk(docsDir));
    }
  } catch (e) {
    io.err(`check-links: cannot read ${e.path || ''} (${e.code || e.message})`);
    return 2;
  }
  if (!files.length) { io.err('check-links: no Markdown file found'); return 2; }
  const { checked, broken } = checkFiles(files, host, base);
  io.out(`files: ${files.length}  relative links checked: ${checked}  broken: ${broken.length}  (anchor rules: ${host})`);
  for (const b of broken) io.out(`  ${b}`);
  return broken.length ? 1 : 0;
}

module.exports = { main, slugGithub, slugGitlab, headingText };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
