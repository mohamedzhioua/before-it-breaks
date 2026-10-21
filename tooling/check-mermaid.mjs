// check-mermaid.mjs - parse every ```mermaid block in the audit pages, so a
// diagram with a syntax error is caught before anyone publishes it.
//
// Usage:
//   node tooling/check-mermaid.mjs [<workspace>] --modules <dir>
//                                  [--mermaid-version <v>] [<root>...]
//
//   --modules <dir>   a folder, OUTSIDE the kit and the audited repos, in
//                     which mermaid and jsdom are installed. They are
//                     third-party code and never a kit dependency. Once:
//                       mkdir <dir> && cd <dir> && npm init -y
//                       npm install --ignore-scripts mermaid@<v> jsdom
//                     Pick <v> to match the Mermaid version your docs host
//                     renders with (check its documentation).
//   --mermaid-version the version the installed mermaid must have; a
//                     different one stops the check (exit 2). Default:
//                     DEFAULT_MERMAID_VERSION below, the version GitHub was
//                     taken to render with when this kit was written. Hosts
//                     upgrade without notice: check the version your host
//                     uses, and pass it here. "any" skips the comparison.
//   <root>            .md files or folders, relative to the workspace.
//                     Default: the top-level *.md files plus the config's
//                     docs folder (when the workspace has a config).
// This checks that each block parses, not how it looks: the host's own
// preview has the last word.
//
// Exit codes: 0 every block parses, 1 a block failed, 2 usage, or mermaid
// or jsdom not found.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Check this against your docs host before relying on it (see --mermaid-version).
export const DEFAULT_MERMAID_VERSION = '11.4.1';
const USAGE = 'usage: node tooling/check-mermaid.mjs [<workspace>] --modules <dir> [--mermaid-version <v>|any] [<root>...]\n'
  + `  default --mermaid-version: ${DEFAULT_MERMAID_VERSION} (assumed GitHub version; check what your host renders)`;
const require = createRequire(import.meta.url);

function walk(p) {
  if (!fs.statSync(p).isDirectory()) return p.endsWith('.md') ? [p] : [];
  return fs.readdirSync(p).sort().flatMap((f) => (f === '.git' || f === 'node_modules' ? [] : walk(path.join(p, f))));
}

export function blocks(text) {
  const out = [];
  const re = /^ {0,3}```mermaid[^\n]*\r?\n([\s\S]*?)^ {0,3}```/gm;
  let m;
  while ((m = re.exec(text))) out.push({ body: m[1], line: text.slice(0, m.index).split('\n').length });
  return out;
}

async function loadMermaid(dir) {
  const pkgFile = path.join(dir, 'node_modules', 'mermaid', 'package.json');
  const domFile = path.join(dir, 'node_modules', 'jsdom', 'package.json');
  if (!fs.existsSync(pkgFile) || !fs.existsSync(domFile)) return null;
  const local = createRequire(path.join(dir, 'package.json'));
  const { JSDOM } = local('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'DOMParser', 'MutationObserver', 'getComputedStyle']) {
    if (!(k in globalThis)) Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : dom.window[k], configurable: true, writable: true });
  }
  const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  const entry = path.join(dir, 'node_modules', 'mermaid', 'dist', 'mermaid.core.mjs');
  const mod = await import(pathToFileURL(fs.existsSync(entry) ? entry : local.resolve('mermaid')).href);
  const mermaid = mod.default || mod;
  mermaid.initialize({ startOnLoad: false });
  return { mermaid, version };
}

export async function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  let ws = null;
  let modules = null;
  let want = DEFAULT_MERMAID_VERSION;
  const roots = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { io.out(USAGE); return 0; }
    if (a === '--modules' || a === '--mermaid-version') {
      const v = argv[++i];
      if (v === undefined) { io.err(`check-mermaid: ${a} needs a value`); return 2; }
      if (a === '--modules') modules = v; else want = v;
    } else if (a.startsWith('-')) { io.err(`check-mermaid: unknown option ${a}\n${USAGE}`); return 2; } else if (ws === null) ws = a;
    else roots.push(a);
  }
  if (!modules) {
    io.err('check-mermaid: mermaid is not available. Install mermaid and jsdom in a folder outside the kit and the repos, then pass it with --modules <dir>.');
    io.err(USAGE);
    return 2;
  }
  const base = path.resolve(ws || '.');
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) { io.err(`check-mermaid: workspace folder not found: ${base}`); return 2; }
  let docsDir = null;
  if (!roots.length && fs.existsSync(path.join(base, 'audit.config.json'))) {
    const { loadConfig } = require('./lib/config.js');
    try {
      docsDir = loadConfig(base).paths.docs;
    } catch (e) {
      io.err(`check-mermaid: ${e.message}`);
      return 2;
    }
  }
  let loaded;
  try {
    loaded = await loadMermaid(path.resolve(modules));
  } catch (e) {
    io.err(`check-mermaid: could not load mermaid from ${path.resolve(modules)} (${String(e.message || e).split('\n')[0]})`);
    return 2;
  }
  if (!loaded) {
    io.err(`check-mermaid: mermaid and jsdom were not found in ${path.join(path.resolve(modules), 'node_modules')}. Install them there (see the header of this file); they are never part of the kit.`);
    return 2;
  }
  if (want !== 'any' && loaded.version !== want) {
    io.err(`check-mermaid: the installed mermaid is ${loaded.version}, not ${want}; install the version your docs host uses, or pass --mermaid-version <v> ("any" to skip)`);
    return 2;
  }
  let files = roots.length ? roots.flatMap((r) => walk(path.resolve(base, r)))
    : fs.readdirSync(base).sort().filter((f) => f.endsWith('.md')).map((f) => path.join(base, f));
  if (docsDir && fs.existsSync(docsDir)) files = files.concat(walk(docsDir));
  let total = 0;
  let failed = 0;
  for (const file of files) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    for (const b of blocks(fs.readFileSync(file, 'utf8'))) {
      total++;
      const first = b.body.trim().split('\n')[0];
      try {
        const r = await loaded.mermaid.parse(b.body);
        io.out(`ok    ${rel}:${b.line}  ${(r && r.diagramType) || first}`);
      } catch (e) {
        failed++;
        io.out(`FAIL  ${rel}:${b.line}  ${first}\n      ${String(e.message || e).split('\n').slice(0, 4).join('\n      ')}`);
      }
    }
  }
  io.out(`mermaid ${loaded.version}: ${files.length} files, ${total} blocks, ${failed} failed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
