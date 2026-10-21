'use strict';
/*
 * build-explorer-data.js - one JSON file with everything a findings
 * explorer (a dashboard, a spreadsheet, a small web page) needs: findings,
 * totals, tiers, areas, the module heatmap and the roadmap.
 *
 * Usage: node tooling/build-explorer-data.js [<workspace>]
 *
 * Reads: phase6/finding-modules.json (from `kit build recommendations`),
 * phase3/final-verdicts.json, pins.json and, when present,
 * phase6/cross-cutting.json and phase3/claim-verdicts.json.
 * Writes <work>/explorer-data.json.
 *
 * Before writing, the numbers must agree with each other: the severity
 * totals add up to the finding count, and so do the tier ladder, the area
 * table and the heatmap (with its unmapped row) for every severity; the
 * finding count equals the reported findings in final-verdicts.json; every
 * roadmap finding id is a reported finding. If any check fails, nothing is
 * written and the exit code is 1.
 *
 * Exit codes: 0 written, 1 a count check failed, 2 usage, config or input
 * error.
 */

const path = require('path');
const { validateCrossCutting } = require('./lib/shapes');
const T = require('./tiers');

const GENERATOR = 'tooling/build-explorer-data.js';
const PHASES = ['now', 'next', 'later'];

function build(ws, io) {
  const { config, paths, pins } = T.loadWorkspace(ws);
  const fm = T.readJson(path.join(paths.work, 'phase6', 'finding-modules.json'), 'work/phase6/finding-modules.json (run `kit build recommendations` first)');
  const final = T.readFinal(paths);
  const cross = T.readOptional(path.join(paths.work, 'phase6', 'cross-cutting.json'), 'work/phase6/cross-cutting.json', null);
  if (cross) T.problems('work/phase6/cross-cutting.json', validateCrossCutting(cross));
  const claimsDoc = T.readOptional(path.join(paths.work, 'phase3', 'claim-verdicts.json'), 'work/phase3/claim-verdicts.json', null);
  const levels = T.levelsOf(config);
  const tiers = T.buildTiers(config);
  const sevCounts = (list) => Object.fromEntries(levels.map((l) => [l, list.filter((f) => f.severity === l).length]));

  const roadmap = cross ? PHASES.flatMap((ph) => cross.roadmap[ph].map((r, i) => ({
    id: `${ph}-${i + 1}`, phase: ph, change: T.one(r.change), effort: r.effort, modules: r.modules || [], depends_on: r.depends_on || [], finding_ids: r.finding_ids,
  }))) : [];
  const modules = new Map(fm.modules.map((m) => [m.id, m]));
  const findings = fm.findings.map((f) => {
    const rows = roadmap.filter((r) => r.finding_ids.includes(f.id));
    const m = f.primary ? modules.get(f.primary) : null;
    return {
      id: f.id, severity: f.severity, verdict: f.verdict, repo: f.repo, area: f.area, effort: f.effort,
      tier: f.tier, breaks_at: f.breaks_at, breaks_at_basis: f.breaks_at_basis,
      module: f.primary, module_label: m ? m.label : null, modules: f.modules,
      phase: PHASES.find((p) => rows.some((r) => r.phase === p)) || null, roadmap: rows.map((r) => r.id),
      plain: T.one(f.plain), fix_direction: f.fix_direction === null ? null : T.one(f.fix_direction),
    };
  });

  const tierTable = tiers.map((t) => { const g = findings.filter((f) => f.tier === t.id); return { tier: t.id, label: t.label, ...sevCounts(g), total: g.length }; });
  const undrafted = findings.filter((f) => f.tier === null);
  if (undrafted.length) tierTable.push({ tier: null, label: 'not drafted yet', ...sevCounts(undrafted), total: undrafted.length });
  const areaNames = config.areas.concat(findings.some((f) => f.area === null) ? [null] : []);
  const areaTable = areaNames.map((a) => {
    const g = findings.filter((f) => f.area === a);
    return { area: a, ...sevCounts(g), total: g.length, maturity: T.maturity(sevCounts(g), levels) };
  });
  const heatmap = fm.modules.filter((m) => m.primary.length).map((m) => {
    const g = findings.filter((f) => f.module === m.id);
    return { module: m.id, label: m.label, repo: m.repo, ...sevCounts(g), total: g.length };
  });
  const unmapped = findings.filter((f) => f.module === null);
  if (unmapped.length) heatmap.push({ module: null, label: 'unmapped', repo: null, ...sevCounts(unmapped), total: unmapped.length });
  const totals = { findings: findings.length, ...sevCounts(findings), measured: findings.filter((f) => f.verdict === 'PROVEN').length,
    proven_static: findings.filter((f) => f.verdict === 'PROVEN-STATIC').length, unproven: findings.filter((f) => f.verdict === 'UNPROVEN').map((f) => f.id),
    open: T.openIds(final, io) };
  const claims = claimsDoc ? { total: claimsDoc.claims.length, ...T.countBy(claimsDoc.claims, (c) => c.verdict) } : null;

  // Must-hold checks.
  const fail = [];
  const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
  const sevSum = levels.reduce((n, l) => n + totals[l], 0);
  if (sevSum !== totals.findings) fail.push(`severity totals add up to ${sevSum}, not ${totals.findings} (a finding has a severity outside the rubric)`);
  for (const [name, rows] of [['tier ladder', tierTable], ['area table', areaTable], ['heatmap', heatmap]]) {
    if (sum(rows, 'total') !== totals.findings) fail.push(`${name} adds up to ${sum(rows, 'total')}, not ${totals.findings}`);
    for (const l of levels) if (sum(rows, l) !== totals[l]) fail.push(`${name}: ${l} adds up to ${sum(rows, l)}, not ${totals[l]}`);
  }
  const reported = final.findings.filter((f) => f.in_report).length;
  if (reported !== totals.findings) fail.push(`finding-modules.json has ${totals.findings} findings, final-verdicts.json reports ${reported} (rebuild the recommendations)`);
  const known = new Set(findings.map((f) => f.id));
  for (const r of roadmap) for (const id of r.finding_ids) if (!known.has(id)) fail.push(`roadmap ${r.id}: "${id}" is not a reported finding`);
  if (fail.length) {
    io.err('build-explorer-data: count checks failed; nothing written');
    fail.forEach((m) => io.err(`  - ${m}`));
    return 1;
  }

  const out = path.join(paths.work, 'explorer-data.json');
  const data = {
    generated_by: `${GENERATOR}; do not edit`,
    date: config.audit.date,
    audit: { name: config.audit.name, question: config.audit.question, type: config.audit.type },
    scope: { repos: config.repos.map((r) => ({ name: r.name, role: r.role, context_only: r.context_only === true })), out_of_scope: config.out_of_scope || [] },
    scale: { unit: config.scale.unit, unit_short: config.scale.unit_short, target: config.scale.target, platform_target: config.scale.platform_target || null, tiers: config.scale.tiers },
    pins,
    levels,
    totals,
    claims,
    tiers: tierTable,
    areas: areaTable,
    heatmap,
    roadmap,
    findings,
  };
  T.writeFile(out, JSON.stringify(data, null, 2) + '\n');
  io.out(`findings ${totals.findings}, ladder ${tierTable.map((t) => t.total).join('/')}, roadmap ${roadmap.length}, heatmap rows ${heatmap.length}; checks ok`);
  io.out(`wrote ${out}`);
  return 0;
}

function main(argv, io) {
  return T.runCli(argv, io, { name: 'build-explorer-data', usage: 'usage: node tooling/build-explorer-data.js [<workspace>]' }, (ws, opts, out) => build(ws, out));
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
