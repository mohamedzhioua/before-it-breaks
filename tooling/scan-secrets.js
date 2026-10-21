'use strict';
/*
 * scan-secrets.js - done criterion: no secret or home path in what the
 * audit hands over, with a saved record of the scan.
 *
 * Usage:
 *   node tooling/scan-secrets.js [<workspace>]
 *
 * Scans every text file in the workspace, skipping only .git folders and
 * this scan's own record files. Files whose first 8000 bytes hold a NUL
 * byte are treated as binary: listed in the record as skipped_binary, not
 * scanned. Symlinks are not followed.
 *
 * Two sets of files, two sets of patterns:
 *   every file      secrets: the built-in must-zero patterns of check-clean.js
 *                   for credentialed connection strings, cloud keys, private
 *                   keys and token prefixes, plus evidence.secret_patterns
 *                   from the config.
 *   published set   the same, plus home paths and email addresses. These are
 *                   the files an audit hands over: the outputs.* pages
 *                   (01-05), everything in outputs.docs_dir, work/phase3/
 *                   receipts/, work/phase3/{verdicts,final-verdicts,
 *                   claim-verdicts}.json, work/phase6/issues.*,
 *                   work/explorer-data.json, rules/results/ and the
 *                   workspace README.md.
 *   Everything else (the config, prompts, .claude/settings.json, HANDOFF,
 *   work notes) stays with the audit team and names local folders on
 *   purpose, so home paths there are not hits.
 * Built-in patterns that match overlapping text on one line count once
 * (a Windows home path matches two of them).
 *
 * ALWAYS writes the record, clean or not:
 *   <work>/secrets-scan.json  { audit_date, scanned_on, files, published,
 *                               skipped_binary, patterns: { all, published },
 *                               hits: [{ file, line, label, masked, set }],
 *                               result: "clean" | "hits" }
 *                             files: every file scanned; published: the
 *                             ones in the published set; set: "published"
 *                             or "workspace".
 *   <work>/secrets-scan.md    the same in short form
 * File names are relative to the workspace; a hit is recorded masked (its
 * first three characters and its length), never in full.
 *
 * Exit codes: 0 clean, 1 hits found, 2 usage or config error.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');
const { BUILTINS } = require('./check-clean');

class CliError extends Error {}

const RECORDS = ['secrets-scan.json', 'secrets-scan.md'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

function targets(paths) {
  const files = [];
  walk(paths.workspace, files);
  const own = RECORDS.map((r) => path.join(paths.work, r));
  return files.filter((f) => !own.includes(f)).sort();
}

// Built-in labels that only count in the published set.
const PUBLISHED_ONLY = ['user-home-path', 'email-address'];

// { all, published }: patterns for every file, and the extra ones for the
// published set. builtin marks the ones whose overlapping hits count once.
function patterns(config) {
  const builtins = BUILTINS.filter((b) => b.sev === 'must' && b.cls === 'D').map((b) => ({ label: b.label, re: b.re, builtin: true }));
  const all = builtins.filter((b) => !PUBLISHED_ONLY.includes(b.label));
  config.evidence.secret_patterns.forEach((p, i) => all.push({ label: `secret_patterns[${i}]`, re: new RegExp(p, 'i'), builtin: false }));
  return { all, published: builtins.filter((b) => PUBLISHED_ONLY.includes(b.label)) };
}

// Is the file part of what the audit hands over?
function publishedTest(paths) {
  const o = paths.outputs;
  const exact = new Set(Object.entries(o).filter(([k]) => !['docs_dir', 'work_dir', 'target_architecture'].includes(k)).map(([, p]) => p));
  for (const n of ['verdicts', 'final-verdicts', 'claim-verdicts']) exact.add(path.join(paths.work, 'phase3', `${n}.json`));
  exact.add(path.join(paths.work, 'explorer-data.json'));
  exact.add(path.join(paths.workspace, 'README.md'));
  const dirs = [o.docs_dir, path.join(paths.work, 'phase3', 'receipts'), path.join(paths.rules, 'results')].filter(Boolean);
  const issues = path.join(paths.work, 'phase6');
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const exactN = new Set([...exact].map(norm));
  const dirsN = dirs.map((d) => norm(d) + path.sep);
  return (file) => {
    const f = norm(file);
    return exactN.has(f) || dirsN.some((d) => f.startsWith(d))
      || (norm(path.dirname(file)) === norm(issues) && /^issues\./i.test(path.basename(file)));
  };
}

// Hits on one line: each pattern's first match; built-in matches that
// overlap an earlier built-in match on the line are dropped.
function lineHits(line, pats) {
  const kept = [];
  const out = [];
  for (const p of pats) {
    const m = p.re.exec(line);
    if (!m) continue;
    const from = m.index;
    const to = m.index + m[0].length;
    if (p.builtin) {
      if (kept.some(([a, b]) => from < b && a < to)) continue;
      kept.push([from, to]);
    }
    out.push({ label: p.label, text: m[0] });
  }
  return out;
}

function masked(s) {
  return `${s.slice(0, 3)}*** (${s.length} chars)`;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function run(opts, io) {
  const { config, paths } = loadConfig(opts.workspace);
  const all = targets(paths);
  const binary = [];
  const files = [];
  for (const f of all) {
    const buf = fs.readFileSync(f);
    if (buf.subarray(0, 8000).includes(0)) binary.push(f);
    else files.push(f);
  }
  const pats = patterns(config);
  const isPublished = publishedTest(paths);
  const rel = (f) => path.relative(paths.workspace, f).split(path.sep).join('/');
  const hits = [];
  const published = [];
  for (const f of files) {
    const pub = isPublished(f);
    if (pub) published.push(f);
    // Published-only patterns go first, so a home path is reported as one.
    const list = pub ? pats.published.concat(pats.all) : pats.all;
    const text = fs.readFileSync(f, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      for (const h of lineHits(line, list)) hits.push({ file: rel(f), line: i + 1, label: h.label, masked: masked(h.text), set: pub ? 'published' : 'workspace' });
    });
  }
  const labels = (list) => [...new Set(list.map((p) => p.label))];
  const record = {
    audit_date: config.audit.date,
    scanned_on: opts.today || today(),
    files: files.map(rel),
    published: published.map(rel),
    skipped_binary: binary.map(rel),
    patterns: { all: labels(pats.all), published: labels(pats.published) },
    hits,
    result: hits.length ? 'hits' : 'clean',
  };
  fs.mkdirSync(paths.work, { recursive: true });
  fs.writeFileSync(path.join(paths.work, 'secrets-scan.json'), JSON.stringify(record, null, 2) + '\n');
  const md = [
    '# Secrets scan',
    '',
    `Scanned on ${record.scanned_on} (audit date ${record.audit_date}): ${files.length} file${files.length === 1 ? '' : 's'}, `
      + `${published.length} of them in the published set (also checked for home paths and email addresses). Result: **${record.result}**${hits.length ? ` (${hits.length} hit${hits.length === 1 ? '' : 's'})` : ''}.`,
    '',
  ];
  if (hits.length) {
    md.push('| File | Set | Line | Pattern | Match (masked) |', '|---|---|---|---|---|');
    for (const h of hits) md.push(`| ${h.file} | ${h.set} | ${h.line} | ${h.label} | ${h.masked} |`);
    md.push('', 'Remove or mask each hit, then run the scan again.', '');
  } else {
    md.push('Files scanned are listed in `secrets-scan.json`.', '');
  }
  fs.writeFileSync(path.join(paths.work, 'secrets-scan.md'), md.join('\n'));
  for (const h of hits) io.out(`${h.file}:${h.line}: ${h.label}: ${h.masked}`);
  io.out(`scanned ${files.length} files (${published.length} published): ${hits.length ? `${hits.length} hit${hits.length === 1 ? '' : 's'}` : 'clean'}; record in work/secrets-scan.json`);
  return hits.length ? 1 : 0;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const pos = [];
    for (const a of argv) {
      if (a === '--help' || a === '-h') {
        io.out('usage: node tooling/scan-secrets.js [<workspace>]');
        return 0;
      }
      if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      pos.push(a);
    }
    if (pos.length > 1) throw new CliError('only one workspace may be given');
    return run({ workspace: pos[0] || '.' }, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`scan-secrets: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, publishedTest, lineHits };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
