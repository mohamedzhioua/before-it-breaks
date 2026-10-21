'use strict';
/*
 * build-measurements.js - the catalogue of read-only live checks that
 * would measure what the code reading could only calculate. The measure
 * phase is designed, not yet proven: this page lists the checks, it does
 * not run them.
 *
 * Usage: node tooling/build-measurements.js [<workspace>]
 *
 * Reads: candidates.json (the commands), phase3/receipts/_index.json (which
 * commands were "skipped-live"), phase3/final-verdicts.json (verdicts) and
 * the config's measure section:
 *   measure.kinds   kind -> regular expression, tried in key order against
 *                   each command (a leading "LIVE" marker is ignored); the
 *                   first match wins, the rest go under "other".
 *   measure.access  [{ kind, safe_form, unlocks }]: the minimum access table.
 * Candidates that were refuted, out of scope, removed or merged are left
 * out (their count is shown). Writes <outputs.measurements>.
 *
 * Exit codes: 0 written, 2 usage, config or input error.
 */

const path = require('path');
const { validateReceiptIndex } = require('./lib/shapes');
const T = require('./tiers');

const GENERATOR = 'tooling/build-measurements.js';
const DROPPED = ['REFUTED', 'OUT-OF-SCOPE', 'REMOVED', 'MERGED'];

function kindOf(cmd, kinds) {
  const bare = cmd.replace(/^\s*LIVE\b:?\s*/, '');
  for (const [k, re] of kinds) if (re.test(bare)) return k;
  return 'other';
}

function build(ws, io) {
  const { config, paths } = T.loadWorkspace(ws);
  const doc = T.readFinal(paths);
  const open = T.openIds(doc, io);
  const cands = T.readCandidates(paths);
  const index = T.readOptional(path.join(paths.work, 'phase3', 'receipts', '_index.json'), 'work/phase3/receipts/_index.json', null);
  if (index) T.problems('work/phase3/receipts/_index.json', validateReceiptIndex(index));
  const measure = config.measure || {};
  const kinds = Object.entries(measure.kinds || {}).map(([k, re]) => [k, new RegExp(re)]);
  const access = measure.access || [];
  const byId = new Map(doc.findings.map((f) => [f.id, f]));
  const file = paths.outputs.measurements;
  const reported = doc.findings.filter((f) => f.in_report);

  const checks = [];
  let dropped = 0;
  for (const e of index ? index.candidates : []) {
    const c = cands.get(e.id);
    const f = byId.get(e.id);
    for (const x of e.commands) {
      if (x.status !== 'skipped-live' || !c || !c.evidence[x.n - 1]) continue;
      if (f && DROPPED.includes(f.verdict)) { dropped++; continue; }
      const cmd = c.evidence[x.n - 1].cmd;
      checks.push({ id: e.id, n: x.n, cmd, expect: c.evidence[x.n - 1].expect, kind: kindOf(cmd, kinds), f });
    }
  }
  const groups = kinds.map(([k]) => k).concat('other');
  const ids = new Set(checks.map((c) => c.id));
  const proven = reported.filter((f) => f.verdict === 'PROVEN').length;
  const L = [];

  L.push(T.pageTop({
    title: `Measurements: ${T.one(config.audit.name)}`,
    generator: GENERATOR,
    measured: proven,
    open,
    total: reported.length,
    intro: [
      '**Designed, not yet proven.** The measure phase of this kit has not yet been run end to end on a real audit. Treat this page as a prepared checklist, not as results.',
      '',
      `**Status:** ${checks.length} read-only live check${checks.length === 1 ? '' : 's'} prepared for ${ids.size} candidate${ids.size === 1 ? '' : 's'}${dropped ? ` (${dropped} more ${dropped === 1 ? 'is' : 'are'} left out because the candidate was refuted, out of scope, removed or merged)` : ''}; ${proven} of ${reported.length} reported findings measured (PROVEN).`,
      '',
      `Each check below was written by an agent as evidence, and the evidence runner did not run it because it needs a live system. Running one can turn a PROVEN-STATIC finding into PROVEN, or settle an UNPROVEN one. The findings themselves are in [the audit report](${T.rel(file, paths.outputs.report)}).`,
    ].join('\n'),
  }));

  L.push('## Rules for running these checks', '',
    '- Read only. Use a replica, a snapshot or pasted output; never write to a shared system.',
    '- Load tests only on staging or a local copy, in a window agreed with the owners. Never on production.',
    '- Ask the audit owner before any check that scans a whole collection, keyspace or cluster.',
    '- Never paste a secret into a file. Write the name of a variable, not its value.',
    '- Record each result with the command, the environment, the time (UTC), who ran it and the raw output, and name the finding it changes.',
    '');

  if (access.length) {
    L.push('## Minimum access', '', 'The smallest access that unlocks each kind of check.', '', '| Kind | Safe way to grant it | What it unlocks |', '|---|---|---|',
      ...access.map((a) => `| ${T.cell(a.kind)} | ${T.cell(a.safe_form)} | ${T.cell(a.unlocks)} |`), '');
  }

  const accessOf = new Map(access.map((a) => [a.kind, a]));
  for (const g of groups) {
    const list = checks.filter((c) => c.kind === g);
    if (!list.length) continue;
    L.push(`## Checks: ${g}`, '');
    if (accessOf.has(g)) L.push(`Needs: ${T.one(accessOf.get(g).safe_form)}`, '');
    L.push('| # | Candidate | Live check | It should show |', '|---|---|---|---|',
      ...list.map((c, i) => `| ${i + 1} | ${c.id}${c.f ? ` (${c.f.verdict}, ${c.f.severity && c.f.severity !== 'none' ? T.cap(c.f.severity) : '-'})` : ''} | ${T.code(c.cmd)} | ${T.cell(c.expect)} |`), '');
  }
  if (!checks.length) L.push('## Checks', '', 'No evidence command was set aside as needing a live system.', '');

  L.push('## Results', '', 'Nothing recorded yet. When a check has been run, give it its own subsection, following the rules above.', '');

  T.writeFile(file, L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'));
  io.out(`checks ${checks.length}: ${groups.map((g) => `${g} ${checks.filter((c) => c.kind === g).length}`).join(', ')}; left out ${dropped}`);
  io.out(`wrote ${file}`);
  return 0;
}

function main(argv, io) {
  return T.runCli(argv, io, { name: 'build-measurements', usage: 'usage: node tooling/build-measurements.js [<workspace>]' }, (ws, opts, out) => build(ws, out));
}

module.exports = { main, kindOf };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
