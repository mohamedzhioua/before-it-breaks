'use strict';
/*
 * scan-secrets.js - done criterion: no secret or home path in what the
 * audit hands over, with a saved record of the scan.
 *
 * Usage:
 *   node tooling/scan-secrets.js [<workspace>]
 *
 * Scans every text file in the workspace (deliverables, README, HANDOFF,
 * system docs, rules and their results, issue exports, explorer data, all
 * of work/ including receipts, verdicts and the config), skipping only
 * .git folders and this scan's own record files. Files whose first 8000
 * bytes hold a NUL byte are treated as binary: listed in the record as
 * skipped_binary, not scanned. Symlinks are not followed. Patterns: the built-in must-zero patterns of
 * check-clean.js (home paths, credentialed connection strings, cloud keys,
 * private keys, token prefixes, email addresses) and
 * evidence.secret_patterns from the config.
 *
 * ALWAYS writes the record, clean or not:
 *   <work>/secrets-scan.json  { audit_date, scanned_on, files, skipped_binary, patterns,
 *                               hits: [{ file, line, label, masked }],
 *                               result: "clean" | "hits" }
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

function patterns(config) {
  const list = BUILTINS.filter((b) => b.sev === 'must' && b.cls === 'D').map((b) => ({ label: b.label, re: b.re }));
  config.evidence.secret_patterns.forEach((p, i) => list.push({ label: `secret_patterns[${i}]`, re: new RegExp(p, 'i') }));
  return list;
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
  const rel = (f) => path.relative(paths.workspace, f).split(path.sep).join('/');
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      for (const p of pats) {
        const m = p.re.exec(line);
        if (m) hits.push({ file: rel(f), line: i + 1, label: p.label, masked: masked(m[0]) });
      }
    });
  }
  const record = {
    audit_date: config.audit.date,
    scanned_on: opts.today || today(),
    files: files.map(rel),
    skipped_binary: binary.map(rel),
    patterns: pats.map((p) => p.label),
    hits,
    result: hits.length ? 'hits' : 'clean',
  };
  fs.mkdirSync(paths.work, { recursive: true });
  fs.writeFileSync(path.join(paths.work, 'secrets-scan.json'), JSON.stringify(record, null, 2) + '\n');
  const md = [
    '# Secrets scan',
    '',
    `Scanned on ${record.scanned_on} (audit date ${record.audit_date}): ${files.length} file${files.length === 1 ? '' : 's'}, `
      + `${pats.length} patterns. Result: **${record.result}**${hits.length ? ` (${hits.length} hit${hits.length === 1 ? '' : 's'})` : ''}.`,
    '',
  ];
  if (hits.length) {
    md.push('| File | Line | Pattern | Match (masked) |', '|---|---|---|---|');
    for (const h of hits) md.push(`| ${h.file} | ${h.line} | ${h.label} | ${h.masked} |`);
    md.push('', 'Remove or mask each hit, then run the scan again.', '');
  } else {
    md.push('Files scanned are listed in `secrets-scan.json`.', '');
  }
  fs.writeFileSync(path.join(paths.work, 'secrets-scan.md'), md.join('\n'));
  for (const h of hits) io.out(`${h.file}:${h.line}: ${h.label}: ${h.masked}`);
  io.out(`scanned ${files.length} files: ${hits.length ? `${hits.length} hit${hits.length === 1 ? '' : 's'}` : 'clean'}; record in work/secrets-scan.json`);
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

module.exports = { main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
