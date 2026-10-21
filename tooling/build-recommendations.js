'use strict';
/*
 * build-recommendations.js - what to change, module by module, in which
 * order, and the target design.
 *
 * Usage: node tooling/build-recommendations.js [<workspace>] [--strict]
 *
 * Reads (under the work folder): phase3/final-verdicts.json, candidates.json
 * (locations), phase5/report-inputs.json, and when present:
 *   phase6/recs/<module>.json      MODULE_PLAN (shapes.js), one per module
 *   phase6/cross-cutting.json      CROSS_CUTTING (shapes.js)
 *   phase6/diagrams/*.md           diagrams drawn by hand or by an agent,
 *                                  copied into the target-architecture page
 *   phase6/diagrams/delta.json     [{ element, current, target, why,
 *                                  section, finding_ids }]
 * Writes:
 *   <outputs.recommendations>
 *   <outputs.target_architecture>  (a file in docs_dir)
 *   phase6/finding-modules.json
 *
 * Modules come from config.modules: for each cited location, the first rule
 * whose repo matches and whose pattern matches the path gives the module;
 * $1, $2 ... in id and label are the pattern's capture groups. A finding's
 * primary module comes from the first of its locations that maps; the
 * heatmap counts primary modules only, so with the "unmapped" row it sums
 * to the number of reported findings. Coverage is checked and shown on the
 * page: unmapped findings, modules with findings but no plan, and plan or
 * roadmap entries that name unknown findings, modules or sections.
 * The dependency graph is a Mermaid flowchart.
 *
 * Each coverage problem is also printed as a `check:` line. With --strict
 * they fail the run: the pages are still written, and the exit code is 1.
 *
 * Exit codes: 0 written, 1 written but --strict and at least one `check:`
 * line, 2 usage, config or input error.
 */

const fs = require('fs');
const path = require('path');
const { validateModulePlan, validateCrossCutting } = require('./lib/shapes');
const T = require('./tiers');
const { compileModules, moduleOf, modulesOfCandidate } = require('./lib/modules');

const GENERATOR = 'tooling/build-recommendations.js';
const PHASES = ['now', 'next', 'later'];

const anchorOf = (id) => `mod-${id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
const sectionAnchor = (id) => `dr-${id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

function readPlans(paths, config) {
  const dir = path.join(paths.work, 'phase6', 'recs');
  const plans = new Map();
  if (!fs.existsSync(dir)) return plans;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(T.byStr)) {
    const plan = T.readJson(path.join(dir, name), `work/phase6/recs/${name}`);
    T.problems(`work/phase6/recs/${name}`, validateModulePlan(plan, config));
    if (plans.has(plan.module)) throw new T.BuildError(`work/phase6/recs/${name}: a second plan for module "${plan.module}"`);
    plans.set(plan.module, { ...plan, recs: plan.recs.slice().sort((a, b) => a.order - b.order) });
  }
  return plans;
}

function readDiagrams(paths) {
  const dir = path.join(paths.work, 'phase6', 'diagrams');
  if (!fs.existsSync(dir)) return { texts: [], delta: [] };
  const texts = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(T.byStr).map((f) => T.maskText(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()));
  const delta = T.readOptional(path.join(dir, 'delta.json'), 'work/phase6/diagrams/delta.json', []);
  if (!Array.isArray(delta) || delta.some((d) => !d || typeof d !== 'object' || typeof d.element !== 'string')) {
    throw new T.BuildError('work/phase6/diagrams/delta.json must be an array of { element, current, target, why, section, finding_ids }');
  }
  return { texts, delta };
}

function analyse(ctx) {
  const { config, doc, cands, inputs } = ctx;
  const levels = T.levelsOf(config);
  const rules = compileModules(config);
  const reported = T.sortFindings(doc.findings.filter((f) => f.in_report), levels, inputs);
  const modules = new Map();
  const unmapped = [];
  const findings = reported.map((f) => {
    const mods = modulesOfCandidate(cands.get(f.id), rules);
    const x = { f, in: inputs.get(f.id) || null, primary: mods[0] || null, modules: mods };
    if (!x.primary) unmapped.push(x);
    for (const m of mods) {
      if (!modules.has(m.id)) modules.set(m.id, { ...m, primary: [], touches: [] });
      modules.get(m.id)[m.id === (x.primary && x.primary.id) ? 'primary' : 'touches'].push(x);
    }
    return x;
  });
  const repoOrder = config.repos.map((r) => r.name);
  const layerOrder = [...new Set(rules.map((r) => r.layer || ''))];
  const modList = [...modules.values()].sort((a, b) => repoOrder.indexOf(a.repo) - repoOrder.indexOf(b.repo)
    || layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer) || b.primary.length - a.primary.length || T.byStr(a.id, b.id));
  return { levels, findings, modules, modList, unmapped };
}

function coverageProblems(a, plans, cross, delta, reportedIds) {
  const out = [];
  const sections = new Set(cross ? cross.sections.map((s) => s.id) : []);
  const known = (d) => sections.has(d) || a.modules.has(d);
  const checkIds = (where, ids) => { for (const id of ids || []) if (!reportedIds.has(id)) out.push(`${where}: "${id}" is not a reported finding`); };
  for (const m of a.modList) if (m.primary.length && !plans.has(m.id)) out.push(`module ${m.id}: has findings but no plan in work/phase6/recs/`);
  for (const [id, p] of plans) {
    if (!a.modules.has(id)) out.push(`plan ${id}: no reported finding maps to this module`);
    p.recs.forEach((r, i) => {
      checkIds(`plan ${id} recs[${i}]`, r.finding_ids);
      for (const d of r.depends_on) if (!known(d)) out.push(`plan ${id} recs[${i}]: depends on unknown "${d}"`);
    });
  }
  if (cross) {
    for (const s of cross.sections) {
      checkIds(`section ${s.id}`, s.finding_ids);
      for (const d of s.depends_on || []) if (!sections.has(d)) out.push(`section ${s.id}: depends on unknown section "${d}"`);
    }
    for (const ph of PHASES) {
      cross.roadmap[ph].forEach((r, i) => {
        checkIds(`roadmap ${ph}[${i}]`, r.finding_ids);
        for (const m of r.modules || []) if (!a.modules.has(m)) out.push(`roadmap ${ph}[${i}]: unknown module "${m}"`);
        for (const d of r.depends_on || []) if (!known(d)) out.push(`roadmap ${ph}[${i}]: depends on unknown "${d}"`);
      });
    }
  }
  for (const d of delta) {
    checkIds(`delta "${d.element}"`, d.finding_ids);
    if (d.section && !known(d.section)) out.push(`delta "${d.element}": unknown section "${d.section}"`);
  }
  return out;
}

function graph(a, plans, cross) {
  if (!cross) return null;
  const hot = a.modList.filter((m) => m.primary.some((x) => x.f.severity === a.levels[0] || x.f.severity === a.levels[1]));
  const ids = new Map();
  const used = new Set();
  const nid = (id) => {
    if (ids.has(id)) return ids.get(id);
    let base = `n_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    ids.set(id, n);
    return n;
  };
  // Mermaid entity codes, so quotes, angle brackets and backticks in a title cannot break the diagram.
  const label = (s) => T.one(s).replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/`/g, '#96;');
  const nodes = [...cross.sections.map((s) => [s.id, s.title]), ...hot.map((m) => [m.id, `${m.label} (${m.id})`])];
  if (!nodes.length) return null;
  const isNode = new Set(nodes.map(([id]) => id));
  const edges = new Set();
  const edge = (from, to) => { if (isNode.has(from) && isNode.has(to) && from !== to) edges.add(`  ${nid(from)} --> ${nid(to)}`); };
  for (const s of cross.sections) for (const d of s.depends_on || []) edge(d, s.id);
  for (const [id, p] of plans) for (const r of p.recs) for (const d of r.depends_on) edge(d, id);
  for (const ph of PHASES) for (const r of cross.roadmap[ph]) for (const m of r.modules || []) for (const d of r.depends_on || []) edge(d, m);
  const lines = ['```mermaid', 'flowchart LR', ...nodes.map(([id, l]) => `  ${nid(id)}["${label(l)}"]`), ...[...edges].sort(T.byStr)];
  if (cross.sections.length) {
    lines.push('  classDef decision fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e', `  class ${cross.sections.map((s) => nid(s.id)).join(',')} decision`);
  }
  lines.push('```');
  return ['An arrow runs from a change to the change it unlocks. Blue boxes are cross-cutting decisions; every other box is a module holding a finding at one of the two highest severity levels.', '', ...lines].join('\n');
}

function earliest(m) {
  const sized = m.primary.filter((x) => x.in && typeof x.in.breaks_at === 'number' && x.in.breaks_at > 0 && x.in.breaks_at_basis !== T.NOT_SIZE_DRIVEN)
    .sort((p, q) => p.in.breaks_at - q.in.breaks_at)[0];
  if (sized) return `${T.fmtN(sized.in.breaks_at)} (${sized.in.breaks_at_basis})`;
  return m.primary.some((x) => x.in && x.in.breaks_at === 0) ? 'any size' : '-';
}

function render(ctx, a, plans, cross, diagrams, problems) {
  const { config, paths } = ctx;
  const file = paths.outputs.recommendations;
  const target = paths.outputs.target_architecture;
  const levels = a.levels;
  const total = a.findings.length;
  const measured = a.findings.filter((x) => x.f.verdict === 'PROVEN').length;
  const fid = (from, id) => `[${id}](${T.rel(from, paths.outputs.report, id.toLowerCase())})`;
  const count = (list, l) => list.filter((x) => x.f.severity === l).length;
  const sectionTitle = new Map(cross ? cross.sections.map((s) => [s.id, s.title]) : []);
  const dep = (from, d) => (sectionTitle.has(d) ? `[${T.cell(sectionTitle.get(d))}](${from === file ? '' : T.rel(from, file)}#${sectionAnchor(d)})`
    : a.modules.has(d) ? `[${T.cell(a.modules.get(d).label)}](${from === file ? '' : T.rel(from, file)}#${anchorOf(d)})` : T.cell(d));
  const g = graph(a, plans, cross);
  const L = [];

  L.push(T.pageTop({
    title: `Recommendations: ${T.one(config.audit.name)}`,
    generator: GENERATOR,
    measured,
    open: ctx.open,
    total,
    measurementsLink: T.rel(file, paths.outputs.measurements),
    intro: `Module by module: the problem, the intended end state, the size of the change and what has to happen first. A finding is filed under the first of its cited locations that a \`modules\` rule in the config matches. Finding details are in [the audit report](${T.rel(file, paths.outputs.report)}); the target design, with the same decisions, is in [the target architecture](${T.rel(file, target)}).`,
  }));

  L.push('## Coverage', '',
    `- ${total - a.unmapped.length} of ${total} reported findings map to a module; ${a.unmapped.length} ${a.unmapped.length === 1 ? 'does' : 'do'} not.`,
    `- ${a.modList.filter((m) => m.primary.length).length} modules hold findings; ${plans.size} module plan${plans.size === 1 ? '' : 's'} recorded.`,
    `- ${cross ? `${cross.sections.length} cross-cutting decision${cross.sections.length === 1 ? '' : 's'} and a roadmap of ${PHASES.reduce((n, p) => n + cross.roadmap[p].length, 0)} changes recorded.` : 'No cross-cutting decisions or roadmap recorded yet (`work/phase6/cross-cutting.json`).'}`, '');
  if (a.unmapped.length) L.push(`**Unmapped findings** (add a \`modules\` rule to place them): ${a.unmapped.map((x) => fid(file, x.f.id)).join(', ')}`, '');

  L.push('## Heatmap', '', 'Each finding is counted once, under its primary module. *Earliest break* shows the lowest size at which any finding of the module fails, counted in that finding\'s basis.', '',
    `| Module | Repo | ${levels.map(T.cap).join(' | ')} | Count | Earliest break |`, `|---|---|${levels.map(() => '---|').join('')}---|---|`,
    ...a.modList.filter((m) => m.primary.length).map((m) => `| [${T.cell(m.label)}](#${anchorOf(m.id)}) | ${m.repo} | ${levels.map((l) => count(m.primary, l) || '.').join(' | ')} | ${m.primary.length} | ${T.cell(earliest(m))} |`));
  if (a.unmapped.length) L.push(`| unmapped | - | ${levels.map((l) => count(a.unmapped, l) || '.').join(' | ')} | ${a.unmapped.length} | - |`);
  L.push(`| **All** | | ${levels.map((l) => `**${count(a.findings, l)}**`).join(' | ')} | **${total}** | |`, '');

  if (cross) {
    L.push('## Decision records', '', `${T.one(cross.intro)}`, '', 'Each record follows a short MADR form. Every record has the status *proposed*: the decision belongs to the team that owns the code.', '');
    for (const s of cross.sections) {
      L.push(`<a id="${sectionAnchor(s.id)}"></a>`, '', `### ${T.one(s.title)}`, '', '| | |', '|---|---|',
        `| Status | ${s.status} |`, `| Context | ${T.cell(s.context)} |`,
        `| Options | ${s.options.map((o, i) => `${i + 1}. ${T.cell(o)}`).join('<br>')} |`,
        `| Decision | ${T.cell(s.decision)} |`, `| Consequences | ${T.cell(s.consequences)} |`,
        `| Findings | ${s.finding_ids.map((id) => fid(file, id)).join(', ') || '-'} |`,
        ...(s.depends_on && s.depends_on.length ? [`| Depends on | ${s.depends_on.map((d) => dep(file, d)).join(', ')} |`] : []), '');
    }
    L.push('## Roadmap', '', '**Now** is the work to start first, **next** builds on it, **later** waits for the earlier steps or for the target design.', '');
    if (g) L.push('### Change dependencies', '', g, '');
    for (const ph of PHASES) {
      L.push(`### ${T.cap(ph)}`, '');
      const items = cross.roadmap[ph];
      if (!items.length) { L.push('Nothing planned.', ''); continue; }
      L.push('| Change | Modules | Findings | Effort | Depends on |', '|---|---|---|---|---|',
        ...items.map((r) => `| ${T.cell(r.change)} | ${(r.modules || []).map((m) => dep(file, m)).join(', ') || '-'} | ${r.finding_ids.map((id) => fid(file, id)).join(', ')} | ${r.effort} | ${(r.depends_on || []).map((d) => dep(file, d)).join(', ') || '-'} |`), '');
    }
  }

  L.push('## Modules', '');
  for (const repo of config.repos.map((r) => r.name)) {
    const ms = a.modList.filter((m) => m.repo === repo);
    if (!ms.length) continue;
    L.push(`### Modules in ${repo}`, '');
    for (const m of ms) {
      const p = plans.get(m.id);
      const sevs = levels.filter((l) => count(m.primary, l)).map((l) => `${count(m.primary, l)} ${l}`).join(', ') || 'none';
      L.push(`<a id="${anchorOf(m.id)}"></a>`, '', `#### ${T.one(m.label)} (\`${m.id}\`)`, '',
        `${m.layer ? `Layer: ${T.one(m.layer)}. ` : ''}Findings here: ${m.primary.length} (${sevs})${m.touches.length ? `; ${m.touches.length} more ${m.touches.length === 1 ? 'touches' : 'touch'} it` : ''}.${m.doc ? ` How it works today: [${T.one(m.doc.split('#')[0])}](${T.rel(file, path.join(paths.workspace, m.doc.split('#')[0]), m.doc.split('#')[1])}).` : ''}`, '');
      if (p) {
        L.push(`**Plan.** ${T.one(p.summary)}`, '');
        p.recs.forEach((r) => {
          L.push(`${r.order}. **${T.one(r.change)}** Target: ${T.one(r.target)} Effort ${r.effort}${r.effort_note ? ` (${T.one(r.effort_note).replace(/\.$/, '')})` : ''}.${r.depends_on.length ? ` Waits for: ${r.depends_on.map((d) => dep(file, d)).join(', ')}.` : ''} Findings: ${r.finding_ids.map((id) => fid(file, id)).join(', ')}.`);
        });
        L.push('');
      } else if (m.primary.length) L.push('*No plan recorded for this module yet.*', '');
      if (m.primary.length) {
        L.push('| Finding | Severity | Breaks at | Effort | Fix direction |', '|---|---|---|---|---|',
          ...m.primary.map((x) => `| ${fid(file, x.f.id)} | ${T.cap(x.f.severity)}${x.f.verdict === 'PROVEN-STATIC' ? '' : ` (${x.f.verdict})`} | ${T.cell(T.breaksText(x.in))} | ${x.in ? x.in.effort : '-'} | ${x.in ? T.cell(x.in.fix_direction) : '*not drafted yet*'} |`), '');
      }
      if (m.touches.length) L.push(`Also touched by: ${m.touches.map((x) => fid(file, x.f.id)).join(', ')}.`, '');
    }
  }

  const deltaTable = (from) => (diagrams.delta.length ? ['| Element | Today | Target | Why | Decision | Findings |', '|---|---|---|---|---|---|',
    ...diagrams.delta.map((d) => `| ${T.cell(d.element)} | ${T.cell(d.current)} | ${T.cell(d.target)} | ${T.cell(d.why)} | ${d.section ? dep(from, d.section) : '-'} | ${(d.finding_ids || []).map((id) => fid(from, id)).join(', ') || '-'} |`)].join('\n')
    : 'No element-by-element changes recorded yet (`work/phase6/diagrams/delta.json`).');
  if (diagrams.delta.length) L.push('## What changes', '', deltaTable(file), '');
  L.push('## Notes for the audit team', '', 'Housekeeping for the people running the audit, not for readers of the recommendations.', '',
    ...(problems.length ? problems.map((p) => `- ${T.one(p)}`) : ['- All plans, decisions and roadmap entries name known findings, modules and sections.']), '');

  const T2 = [];
  T2.push(T.pageTop({
    title: `Target architecture: ${T.one(config.audit.name)}`,
    generator: GENERATOR,
    measured,
    open: ctx.open,
    total,
    measurementsLink: T.rel(target, paths.outputs.measurements),
    intro: `${cross ? T.one(cross.intro) : 'No cross-cutting decisions have been recorded yet, so this page has no target design to show.'} The reasoning behind each change, per module: [the recommendations](${T.rel(target, file)}).`,
  }));
  T2.push('## Solution strategy', '');
  if (cross && cross.sections.length) T2.push(...cross.sections.map((s) => `- **${T.one(s.title)}.** ${T.one(s.decision)} ([record](${T.rel(target, file, sectionAnchor(s.id))}))`), '');
  else T2.push('No decisions recorded yet.', '');
  T2.push(`The order of work is in [the roadmap](${T.rel(target, file, 'roadmap')}).`, '');
  if (g) T2.push('## Change dependencies', '', g, '');
  T2.push('## Diagrams', '', ...(diagrams.texts.length ? diagrams.texts.flatMap((t) => [t, '']) : ['No diagrams drawn yet (`work/phase6/diagrams/`).', '']));
  T2.push('## What changes', '', deltaTable(target), '');

  const tidy = (lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  return { file, target, page: tidy(L), targetPage: tidy(T2) };
}

function build(ws, io, strict) {
  const { config, paths } = T.loadWorkspace(ws);
  const doc = T.readFinal(paths);
  const cands = T.readCandidates(paths);
  const inputs = T.readInputs(paths, config);
  const plans = readPlans(paths, config);
  const cross = T.readOptional(path.join(paths.work, 'phase6', 'cross-cutting.json'), 'work/phase6/cross-cutting.json', null);
  if (cross) T.problems('work/phase6/cross-cutting.json', validateCrossCutting(cross));
  const diagrams = readDiagrams(paths);
  const ctx = { config, paths, doc, cands, inputs, open: T.openIds(doc, io) };
  const a = analyse(ctx);
  const reportedIds = new Set(a.findings.map((x) => x.f.id));
  const problems = coverageProblems(a, plans, cross, diagrams.delta, reportedIds);

  // Coverage must hold: every reported finding is in exactly one primary module or unmapped.
  const placed = a.modList.reduce((n, m) => n + m.primary.length, 0) + a.unmapped.length;
  if (placed !== a.findings.length) throw new T.BuildError(`internal check failed: ${placed} findings placed, ${a.findings.length} reported`);

  const out = render(ctx, a, plans, cross, diagrams, problems);
  const fm = {
    date: config.audit.date,
    generated_by: GENERATOR,
    findings: a.findings.map((x) => ({
      id: x.f.id,
      severity: x.f.severity,
      verdict: x.f.verdict,
      repo: x.f.repo,
      area: x.in ? x.in.area : null,
      effort: x.in ? x.in.effort : null,
      tier: x.in ? T.tierOf(x.in, config) : null,
      breaks_at: x.in ? x.in.breaks_at : null,
      breaks_at_basis: x.in ? x.in.breaks_at_basis : null,
      plain: x.in ? x.in.plain : x.f.title,
      fix_direction: x.in ? x.in.fix_direction : null,
      primary: x.primary ? x.primary.id : null,
      modules: x.modules.map((m) => m.id),
    })),
    modules: a.modList.map((m) => ({ id: m.id, repo: m.repo, label: m.label, layer: m.layer, doc: m.doc, plan: plans.has(m.id), primary: m.primary.map((x) => x.f.id), touches: m.touches.map((x) => x.f.id) })),
    unmapped: a.unmapped.map((x) => x.f.id),
    problems,
  };
  T.writeFile(path.join(paths.work, 'phase6', 'finding-modules.json'), JSON.stringify(fm, null, 2) + '\n');
  T.writeFile(out.file, out.page);
  T.writeFile(out.target, out.targetPage);
  io.out(`findings ${a.findings.length}, modules ${a.modList.length} (with findings ${a.modList.filter((m) => m.primary.length).length}), unmapped ${a.unmapped.length}, plans ${plans.size}`);
  for (const p of problems) io.out(`check: ${p}`);
  io.out(`wrote ${out.file}`);
  io.out(`wrote ${out.target}`);
  return T.strictExit(strict, problems.length, io);
}

function main(argv, io) {
  return T.runCli(argv, io, { name: 'build-recommendations', usage: 'usage: node tooling/build-recommendations.js [<workspace>] [--strict]', flags: { '--strict': 'strict' } },
    (ws, opts, out) => build(ws, out, opts.strict === true));
}

module.exports = { main, moduleOf, compileModules };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
