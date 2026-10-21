'use strict';
/*
 * build-report.js - the audit report: every finding that survived
 * verification, in plain words, with its citations and verdict.
 *
 * Usage: node tooling/build-report.js [<workspace>]
 *
 * Reads (under the work folder): phase3/final-verdicts.json (from
 * `kit build log`), candidates.json, pins.json and, when present,
 * phase5/report-inputs.json ({ items: [REPORT_INPUT...] }, shapes.js).
 * Writes <outputs.report>.
 *
 * Order: severity (the key order of severity_rubric, most severe first),
 * then the size at which a finding breaks (smallest first; no hard break
 * and not size-driven last), then id. Tables: by severity, by tier (the
 * ladder of tiers.js), by area (config.areas, with the maturity rule of
 * tiers.js), and an index. A finding without report inputs is still listed,
 * with its title and "not drafted yet"; their ids are printed on stdout.
 *
 * Exit codes: 0 written, 2 usage, config or input error.
 */

const path = require('path');
const T = require('./tiers');

const GENERATOR = 'tooling/build-report.js';

function build(ws, io) {
  const { config, paths, pins } = T.loadWorkspace(ws);
  const doc = T.readFinal(paths);
  const cands = T.readCandidates(paths);
  const inputs = T.readInputs(paths, config);
  const levels = T.levelsOf(config);
  const tiers = T.buildTiers(config);
  const file = paths.outputs.report;
  const findings = T.sortFindings(doc.findings.filter((f) => f.in_report), levels, inputs);
  const open = T.openIds(doc, io);
  const others = doc.findings.filter((f) => !f.in_report && f.verdict !== 'NEEDS-REVIEW');
  const missing = findings.filter((f) => !inputs.has(f.id)).map((f) => f.id);
  const inp = (f) => inputs.get(f.id) || null;
  const areaOf = (f) => (inp(f) ? inp(f).area : 'not classified yet');
  const row = (list) => levels.map((l) => list.filter((f) => f.severity === l).length);
  const sevHead = levels.map(T.cap);
  const measured = findings.filter((f) => f.verdict === 'PROVEN').length;
  const s = config.scale;
  const L = [];
  const sized = findings.filter((f) => inp(f) && typeof inp(f).breaks_at === 'number' && inp(f).breaks_at_basis !== T.NOT_SIZE_DRIVEN)
    .sort((a, b) => inp(a).breaks_at - inp(b).breaks_at || levels.indexOf(a.severity) - levels.indexOf(b.severity) || T.byStr(a.id, b.id))[0];
  const top = levels[0] ? findings.filter((f) => f.severity === levels[0]).length : 0;
  const headline = `**In short:** ${findings.length} finding${findings.length === 1 ? '' : 's'}, ${top || 'none'} of them ${levels[0] || 'top severity'}. `
    + (sized ? `The first to break is [${sized.id}](#${sized.id.toLowerCase()}), at ${T.breaksText(inp(sized))}.` : 'No finding has a known breaking size yet.');

  L.push(T.pageTop({
    title: `Audit report: ${T.one(config.audit.name)}`,
    generator: GENERATOR,
    measured,
    open,
    headline,
    total: findings.length,
    measurementsLink: T.rel(file, paths.outputs.measurements),
    intro: [
      `**The question:** ${T.one(config.audit.question)}`,
      '',
      `The size that matters is **${T.one(s.unit)}**, with a target of ${T.fmtN(s.target)}${s.platform_target ? ` and ${T.fmtN(s.platform_target)} across the whole platform` : ''}. Audit date ${config.audit.date}; pinned commits ${T.pinList(config, pins)}. Citations read \`repo@commit:path:line\`.`,
      '',
      `Findings appear most severe first; within one severity, the one that fails at the smallest size comes first. How each one was tested: [the verification log](${T.rel(file, paths.outputs.log)}). What to change, module by module: [the recommendations](${T.rel(file, paths.outputs.recommendations)}).`,
    ].join('\n'),
  }));

  L.push('### Severity levels', '', ...levels.map((l) => `- **${T.cap(l)}**: ${T.one(config.severity_rubric[l])}`), '',
    '### Effort sizes', '', ...Object.entries(config.effort_scale || {}).map(([k, v]) => `- **${k}**: ${T.one(v)}`), '');

  L.push('## Summary', '', '| Severity | Findings |', '|---|---|',
    ...levels.map((l, i) => `| ${sevHead[i]} | ${row(findings)[i]} |`), `| **Total** | **${findings.length}** |`, '');

  L.push('### By tier', '',
    `Where findings break as the system grows. Each finding is sized in its own unit, its \`breaks_at_basis\` (for example ${T.one(config.scale.bases.slice(0, 2).join(' or '))}), so one row can hold findings measured in different units; the "Breaks at" column of the index names the unit of each.`, '',
    `| Tier | Size range | ${sevHead.join(' | ')} | Count |`, `|---|---|${levels.map(() => '---|').join('')}---|`,
    ...tiers.map((t) => {
      const g = findings.filter((f) => T.tierOf(inp(f), config) === t.id && inp(f));
      return `| ${t.id} | ${t.label} | ${row(g).join(' | ')} | ${g.length} |`;
    }));
  if (missing.length) L.push(`| - | not drafted yet | ${row(findings.filter((f) => !inp(f))).join(' | ')} | ${missing.length} |`);
  L.push('');

  const areas = config.areas.concat(findings.some((f) => !inp(f)) ? ['not classified yet'] : []);
  L.push('### By area', '', `| Area | ${sevHead.join(' | ')} | Total | Maturity |`, `|---|${levels.map(() => '---|').join('')}---|---|`,
    ...areas.map((a) => {
      const g = findings.filter((f) => areaOf(f) === a);
      const counts = T.countBy(g, (f) => f.severity);
      return `| ${T.cell(a)} | ${row(g).join(' | ')} | ${g.length} | ${T.maturity(counts, levels)} |`;
    }), '',
    `*Maturity* follows one rule: **Weak** when an area has any ${T.cap(levels[0] || '')} finding or three or more ${T.cap(levels[1] || '')}; **Moderate** with any ${T.cap(levels[1] || '')}; **Satisfactory** with any ${T.cap(levels[2] || '')}; **Strong** otherwise; "-" when the area has no finding.`, '');

  L.push('### Index', '', '| # | Finding | Severity | Area | Tier | Breaks at | Effort |', '|---|---|---|---|---|---|---|',
    ...findings.map((f, i) => {
      const x = inp(f);
      return `| ${i + 1} | [${f.id}](#${f.id.toLowerCase()}) ${T.cell(x ? x.plain : f.title)} | ${T.cap(f.severity)}${f.verdict === 'PROVEN-STATIC' ? '' : ` (${f.verdict})`} | ${T.cell(areaOf(f))} | ${x ? T.tierOf(x, config) : '-'} | ${T.cell(T.breaksText(x))} | ${x ? x.effort : '-'} |`;
    }), '');

  levels.forEach((l, li) => {
    const group = findings.filter((f) => f.severity === l);
    if (!group.length) return;
    L.push(`## ${sevHead[li]} (${group.length})`, '');
    for (const f of group) {
      const x = inp(f);
      const c = cands.get(f.id);
      const receipt = f.receipt ? `[\`${f.receipt}\`](${T.rel(file, path.join(paths.work, 'phase3', 'receipts', `${f.id}.md`))})` : '-';
      L.push(`### ${f.id}`, '', `**${T.one(x ? x.plain : f.title)}**`, '', '| | |', '|---|---|',
        `| Verdict | ${f.verdict} |`,
        `| Severity | ${sevHead[li]} |`,
        `| Area | ${T.cell(areaOf(f))} · repo \`${f.repo}\` |`,
        `| Tier | ${x ? T.tierOf(x, config) : '-'} |`,
        `| Breaks at | ${T.cell(T.breaksText(x))} |`,
        `| Effort | ${x ? x.effort : '-'} |`,
        `| Also covers | ${f.merged_from.length ? f.merged_from.join(', ') : '-'} |`,
        `| Receipt | ${receipt} |`, '');
      if (c) L.push(`**What happens.** ${T.one(c.claim)}`, '', `**Mechanism.** ${T.one(c.mechanism)}`, '');
      L.push(`**Threshold.** ${x && x.threshold ? T.one(x.threshold) : '*not drafted yet*'}${f.corrected ? ' *(corrected by the skeptics; the original sums are in the verification log)*' : ''}`, '',
        `**Evidence.** ${f.citations.map((k) => `\`${k}\``).join(' · ') || '-'}`, '',
        `**Fix direction.** ${x ? T.one(x.fix_direction) : '*not drafted yet*'}`, '');
    }
  });

  if (open.length) {
    L.push('## Open: waiting for a decision', '', 'The voting rules could not settle these candidates, so they are neither findings nor dismissed. A person has to decide each one; the votes are in the verification log.', '',
      '| Candidate | Title | Why it is open |', '|---|---|---|',
      ...doc.findings.filter((f) => f.verdict === 'NEEDS-REVIEW').map((f) => `| ${f.id} | ${T.cell(f.title)} | ${T.cell(f.why)} |`), '');
  }

  L.push('## Not in this report', '', 'Candidates that did not survive, or that the audit owner held back. Each one keeps its record in the verification log.', '',
    '| Candidate | Verdict | Why |', '|---|---|---|',
    ...others.map((f) => `| ${f.id} | ${f.verdict}${f.merged_into ? ` (into ${f.merged_into})` : ''} | ${T.cell(f.override ? f.override.reason : f.why)} |`), '');

  T.writeFile(file, L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'));
  const counts = levels.map((l, i) => `${l} ${row(findings)[i]}`).join(', ');
  io.out(`findings ${findings.length} (${counts}); not drafted: ${missing.join(', ') || 'none'}`);
  io.out(`wrote ${file}`);
  return 0;
}

function main(argv, io) {
  return T.runCli(argv, io, { name: 'build-report', usage: 'usage: node tooling/build-report.js [<workspace>]' }, (ws, opts, out) => build(ws, out));
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
