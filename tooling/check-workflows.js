'use strict';
/*
 * check-workflows.js - static checks for the Workflow scripts in workflows/.
 *
 * Usage:
 *   node tooling/check-workflows.js [--workspace <ws>] [<file-or-folder>...]
 *   (default: the kit's workflows/ folder)
 *
 * For every *.js file:
 *   - `export const meta = { ... }` appears exactly once and is a pure
 *     literal: objects, arrays, strings, numbers, true, false and null only.
 *     It is parsed by a small literal parser here, never evaluated.
 *   - meta.name equals the file name without .js, and meta.description is
 *     a non-empty string (whenToUse and phases are checked when present).
 *   - The rest of the file compiles as the body of an async function (the
 *     way the Workflow runtime runs it: top-level await and return are
 *     allowed). It is compiled with vm.Script, never run.
 *   - The code (comments and string text left out) names none of these
 *     identifiers anywhere: Date, performance, crypto, eval, Function,
 *     constructor, globalThis, Reflect, process, require, import; and uses
 *     neither Math.random nor fs. Workflow scripts must be deterministic and
 *     cannot reach files, the clock or the environment; banning the names
 *     themselves, not only Date.now, also closes indirect routes such as
 *     globalThis['Date'] or Function('...'). A slash after ) ] or } is read
 *     as division, so it cannot hide code as a regex.
 *   - The body never changes meta (meta.x = ..., meta[k] = ...,
 *     Object.assign(meta, ...), delete meta.x): meta must stay the literal.
 * With --workspace, also: every lens in the workspace config has a lens
 * file, method/lenses/<lens>.md in the kit for a bundled lens, or
 * <ws>/method/lenses/<lens>.md for a custom lens; and every skeptic lens
 * (verify.skeptic_lenses) has its brief, method/skeptics/<name>.md in the
 * kit or in the workspace. validate and doctor run the same check.
 *
 * Exit codes: 0 all checks pass, 1 a check failed, 2 usage, no workflow
 * files found, or an unreadable workspace config.
 *
 * Exports: main(argv, io), checkWorkflow(file, text) -> string[],
 *   splitWorkflow(text) -> { meta, metaText, body } (throws WorkflowError),
 *   parseLiteral(text) -> value (throws WorkflowError), maskCode(text),
 *   checkLensFiles(wsDir, loaded?) -> string[]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadConfig, ConfigError, BUNDLED_LENSES, BUNDLED_SKEPTICS, KIT_ROOT } = require('./lib/config');

class CliError extends Error {}
class WorkflowError extends Error {}

// Identifiers a workflow may not name at all, with the reason.
const BANNED_NAMES = [
  ['Date', 'the clock; use args.date'],
  ['performance', 'the clock; use args.date'],
  ['crypto', 'randomness; workflows must be deterministic'],
  ['eval', 'code built from strings'],
  ['Function', 'code built from strings'],
  ['constructor', 'code built from strings, through .constructor'],
  ['globalThis', 'indirect access to globals'],
  ['Reflect', 'indirect calls and construction'],
  ['process', 'the environment'],
  ['require', 'loading modules'],
  ['import', 'loading modules'],
];

const FORBIDDEN = BANNED_NAMES.map(([name, why]) => [new RegExp(`(?<![\\w$])${name}(?![\\w$])`), `${name} (${why})`]).concat([
  [/\bMath\s*\.\s*random\b/, 'Math.random (workflows must be deterministic)'],
  [/(?<![\w$.])fs\s*\./, 'fs. (workflows cannot reach files)'],
  [/(?<![\w$.])meta\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)/, 'an assignment to meta (meta must stay the literal)'],
  [/\bObject\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*meta\b/, 'a change to meta through Object (meta must stay the literal)'],
  [/\bdelete\s+meta\s*[.[]/, 'delete on meta (meta must stay the literal)'],
]);

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

// ---------- masking: blank out comments and the text of strings ----------

// Returns a copy of `src` of the same length in which comments, string and
// template text and regex bodies are spaces (new lines kept), so that code
// patterns can be searched without matching prose. Code inside template
// `${...}` stays.
function maskCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const depth = []; // open template expressions: brace depth inside each
  let prev = '';
  let opened = false;

  function template(j) {
    const start = j;
    opened = false;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { blank(start, j); return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { blank(start, j); depth.push(0); opened = true; return j + 2; }
      j++;
    }
    blank(start, n);
    return n;
  }

  function regexAllowed() {
    if (prev === '') return true;
    if (/^[A-Za-z_$0-9]+$/.test(prev)) return KEYWORDS_BEFORE_REGEX.has(prev);
    return !/^[)\]}]$/.test(prev); // after ) ] or } a slash divides
  }

  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = 'x';
      continue;
    }
    if (ch === '`') {
      i = template(i + 1);
      prev = opened ? '{' : 'x';
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') cls = true;
        else if (c === ']') cls = false;
        else if (c === '/' && !cls) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      while (i < n && /[A-Za-z]/.test(src[i])) i++;
      prev = 'x';
      continue;
    }
    if (ch === '{' && depth.length) depth[depth.length - 1]++;
    if (ch === '}' && depth.length) {
      if (depth[depth.length - 1] === 0) {
        depth.pop();
        i = template(i + 1);
        prev = opened ? '{' : 'x';
        continue;
      }
      depth[depth.length - 1]--;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z_$0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z_$0-9]/.test(src[j])) j++;
      prev = src.slice(i, j);
      i = j;
      continue;
    }
    prev = ch;
    i++;
  }
  return out.join('');
}

// ---------- a parser for pure literals ----------

function parseLiteral(text) {
  let i = 0;
  const fail = (what) => {
    throw new WorkflowError(`meta is not a pure literal: ${what} at line ${lineOf(text, i)}`);
  };
  function skip() {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        const e = text.indexOf('\n', i);
        i = e < 0 ? text.length : e;
      } else if (text.startsWith('/*', i)) {
        const e = text.indexOf('*/', i + 2);
        if (e < 0) fail('an unclosed comment');
        i = e + 2;
      } else return;
    }
  }
  function string() {
    const q = text[i++];
    let s = '';
    while (i < text.length && text[i] !== q) {
      const c = text[i];
      if (q === '`' && c === '$' && text[i + 1] === '{') fail('a template expression ${...}');
      if (c === '\n' && q !== '`') fail('a new line inside a string');
      if (c === '\\') {
        const e = text[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a bad \\u escape');
          s += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        if (e === '\n') { i += 2; continue; }
        s += Object.prototype.hasOwnProperty.call(map, e) ? map[e] : e;
        i += 2;
        continue;
      }
      s += c;
      i++;
    }
    if (i >= text.length) fail('an unclosed string');
    i++;
    return s;
  }
  function value() {
    skip();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'" || c === '`') return string();
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (word) {
      if (word[0] === 'true' || word[0] === 'false' || word[0] === 'null') {
        i += word[0].length;
        return word[0] === 'true' ? true : word[0] === 'false' ? false : null;
      }
      fail(`the name "${word[0]}" (only literal values are allowed)`);
    }
    fail(c === undefined ? 'the end of the text' : `"${c}"`);
    return undefined;
  }
  function array() {
    i++;
    const list = [];
    for (;;) {
      skip();
      if (text[i] === ']') { i++; return list; }
      if (text.startsWith('...', i)) fail('a spread');
      list.push(value());
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return list; }
      fail(text[i] === undefined ? 'the end of the text' : `"${text[i]}" (expected , or ])`);
    }
  }
  function object() {
    i++;
    const obj = {};
    for (;;) {
      skip();
      if (text[i] === '}') { i++; return obj; }
      if (text.startsWith('...', i)) fail('a spread');
      let key;
      const c = text[i];
      if (c === '"' || c === "'") key = string();
      else {
        const word = /^[A-Za-z_$][\w$]*|^\d+/.exec(text.slice(i));
        if (!word) fail(c === '[' ? 'a computed key' : `"${c}" (expected a key)`);
        key = word[0];
        i += key.length;
      }
      skip();
      if (text[i] !== ':') fail(`"${text[i] === undefined ? 'end' : text[i]}" after the key "${key}" (expected :, so no methods or shorthand)`);
      i++;
      obj[key] = value();
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return obj; }
      fail(text[i] === undefined ? 'the end of the text' : `"${text[i]}" (expected , or })`);
    }
  }
  const v = value();
  skip();
  if (i < text.length) fail(`extra text "${text.slice(i, i + 20)}"`);
  return v;
}

// ---------- splitting meta from the body ----------

function splitWorkflow(text) {
  const masked = maskCode(text);
  const re = /\bexport\s+const\s+meta\s*=\s*/g;
  const found = [];
  let m;
  while ((m = re.exec(masked))) found.push(m);
  if (!found.length) throw new WorkflowError('no "export const meta = { ... }" found');
  if (found.length > 1) throw new WorkflowError(`"export const meta" appears ${found.length} times`);
  const start = found[0].index;
  const open = start + found[0][0].length;
  if (masked[open] !== '{') throw new WorkflowError(`meta is not a pure literal: it must start with { (line ${lineOf(text, open)})`);
  let depthCount = 0;
  let close = -1;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === '{') depthCount++;
    else if (masked[k] === '}' && --depthCount === 0) { close = k; break; }
  }
  if (close < 0) throw new WorkflowError('the meta object is never closed');
  const metaText = text.slice(open, close + 1);
  const meta = parseLiteral(metaText);
  let end = close + 1;
  while (end < text.length && /[ \t]/.test(text[end])) end++;
  if (text[end] === ';') end++;
  const keep = (s) => s.replace(/[^\r\n]/g, ' ');
  const body = text.slice(0, start) + keep(text.slice(start, end)) + text.slice(end);
  if (/\bexport\b/.test(maskCode(body))) throw new WorkflowError('only "export const meta" may be exported');
  return { meta, metaText, body };
}

function checkMeta(meta, file) {
  const errs = [];
  const want = path.basename(file).replace(/\.js$/, '');
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return ['meta: must be an object'];
  if (typeof meta.name !== 'string' || !meta.name) errs.push('meta.name: must be a non-empty string');
  else if (meta.name !== want) errs.push(`meta.name: "${meta.name}" must equal the file name "${want}"`);
  if (typeof meta.description !== 'string' || !meta.description.trim()) errs.push('meta.description: must be a non-empty string');
  if ('whenToUse' in meta && typeof meta.whenToUse !== 'string') errs.push('meta.whenToUse: must be a string');
  if ('phases' in meta) {
    if (!Array.isArray(meta.phases)) errs.push('meta.phases: must be a list');
    else meta.phases.forEach((p, i) => {
      if (p === null || typeof p !== 'object' || typeof p.title !== 'string' || !p.title) errs.push(`meta.phases[${i}].title: must be a non-empty string`);
      else if ('detail' in p && typeof p.detail !== 'string') errs.push(`meta.phases[${i}].detail: must be a string`);
    });
  }
  return errs;
}

// All problems of one workflow file, as "file:line: message" strings.
function checkWorkflow(file, text) {
  const name = path.basename(file);
  let parts;
  try {
    parts = splitWorkflow(text);
  } catch (e) {
    if (e instanceof WorkflowError) return [`${name}: ${e.message}`];
    throw e;
  }
  const errs = checkMeta(parts.meta, file).map((m) => `${name}: ${m}`);
  try {
    // Compiled only, never run. Line 1 of the wrapper is the function head.
    new vm.Script(`(async function () {\n${parts.body}\n})`, { filename: name, lineOffset: -1 });
  } catch (e) {
    const where = /:(\d+)\s*$/.exec(String(e.stack || '').split('\n')[0] || '');
    errs.push(`${name}${where ? ':' + where[1] : ''}: does not compile as an async function body (${e.message})`);
  }
  const masked = maskCode(parts.body);
  for (const [re, what] of FORBIDDEN) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(masked))) errs.push(`${name}:${lineOf(masked, m.index)}: uses ${what}`);
  }
  return errs;
}

// ---------- lens files of a workspace ----------

// Every configured lens and skeptic lens needs its method file: bundled
// ones in <kit>/method/lenses|skeptics/, others in
// <workspace>/method/lenses|skeptics/<name>.md. loaded: an already loaded
// { config, paths } (validate and doctor pass theirs), else wsDir is loaded.
function checkLensFiles(wsDir, loaded) {
  const { config, paths } = loaded || loadConfig(wsDir);
  const kit = paths.kit || KIT_ROOT;
  const errs = [];
  const sets = [
    ['lens', 'lens file', 'lenses', config.lenses || [], BUNDLED_LENSES, 'write its checklist there'],
    ['skeptic lens', 'skeptic brief', 'skeptics', (config.verify && config.verify.skeptic_lenses) || [], BUNDLED_SKEPTICS, 'write its brief there'],
  ];
  for (const [what, file, dir, names, bundledList, todo] of sets) {
    for (const name of names) {
      const bundled = bundledList.includes(name);
      const at = bundled ? path.join(kit, 'method', dir, `${name}.md`) : path.join(paths.workspace, 'method', dir, `${name}.md`);
      if (!fs.existsSync(at)) {
        errs.push(`${what} "${name}": no ${file} at ${at}${bundled ? ` (a bundled ${what}: the kit is incomplete)` : ` (a custom ${what}: ${todo})`}`);
      }
    }
  }
  return errs;
}

// ---------- command line ----------

function listFiles(target) {
  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    throw new CliError(`not found: ${target}`);
  }
  if (st.isDirectory()) {
    return fs.readdirSync(target).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(target, f));
  }
  return [target];
}

function parseArgs(argv) {
  const opts = { workspace: null, targets: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--workspace') {
      opts.workspace = argv[++i];
      if (opts.workspace === undefined) throw new CliError('--workspace needs a folder');
    } else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else opts.targets.push(a);
  }
  return opts;
}

const USAGE = 'usage: node tooling/check-workflows.js [--workspace <ws>] [<file-or-folder>...]';

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }
    const targets = opts.targets.length ? opts.targets : [path.join(KIT_ROOT, 'workflows')];
    const files = targets.flatMap(listFiles);
    if (!files.length) throw new CliError(`no workflow files found in ${targets.join(', ')}`);
    const problems = [];
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (e) {
        throw new CliError(`cannot read ${f} (${e.code || e.message})`);
      }
      const errs = checkWorkflow(f, text.replace(/^﻿/, ''));
      problems.push(...errs);
      if (!errs.length) io.out(`ok ${path.basename(f)}`);
    }
    if (opts.workspace !== null) {
      const lensErrs = checkLensFiles(opts.workspace);
      problems.push(...lensErrs);
      if (!lensErrs.length) io.out('ok lens files of the workspace');
    }
    if (problems.length) {
      problems.forEach((p) => io.err(`FAIL ${p}`));
      io.err(`workflows: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
      return 1;
    }
    io.out(`workflows: ${files.length} file${files.length === 1 ? '' : 's'} checked, no problems`);
    return 0;
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`check-workflows: ${e.message}`);
      if (e instanceof ConfigError && e.errors && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, checkWorkflow, splitWorkflow, parseLiteral, maskCode, checkLensFiles, WorkflowError };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
