'use strict';
/*
 * build-issues.js - one issue per roadmap change, ready to import into a
 * tracker, each listing the findings it closes.
 *
 * Usage:
 *   node tooling/build-issues.js [<workspace>] [--tracker gitlab|markdown]
 *                                [--base-url <url>]
 *
 *   --tracker gitlab    <work>/phase6/issues.csv: the two columns a GitLab
 *                       CSV import reads (title, description), CRLF lines.
 *   --tracker markdown  <work>/phase6/issues.md: a checklist to paste into
 *                       any tracker.
 *   Default: publish.tracker of the config (gitlab -> gitlab, github ->
 *   markdown; none -> nothing is written).
 *   --base-url          web address of the folder that holds the published
 *                       pages; default publish.base_url. Empty: the CSV
 *                       names files in plain text and the checklist uses
 *                       relative links.
 *
 * Reads: phase6/cross-cutting.json (the roadmap), phase6/finding-modules.json
 * (from `kit build recommendations`) and phase3/final-verdicts.json (for
 * the open items in the trust line). Writes the file above.
 *
 * Exit codes: 0 written (or nothing to do), 2 usage, config or input error.
 */

const path = require('path');
const { validateCrossCutting } = require('./lib/shapes');
const T = require('./tiers');

const PHASES = ['now', 'next', 'later'];
const USAGE = 'usage: node tooling/build-issues.js [<workspace>] [--tracker gitlab|markdown] [--base-url <url>]';

function shortTitle(change) {
  let t = T.one(change).split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, '');
  if (t.length > 80) t = t.slice(0, 80).replace(/[\s,]+\S*$/, '') + '...';
  return t;
}

// A cell a spreadsheet could read as a formula gets a leading ' first.
const csv = (v) => `"${String(v).replace(/^[=+\-@\t\r]/, (c) => `'${c}`).replace(/"/g, '""')}"`;

function build(ws, opts, io) {
  const { config, paths } = T.loadWorkspace(ws);
  let tracker = opts.tracker;
  if (tracker === undefined) tracker = { gitlab: 'gitlab', github: 'markdown', none: null }[config.publish.tracker];
  if (tracker === null) { io.out('build-issues: publish.tracker is "none"; nothing written (pass --tracker gitlab or --tracker markdown)'); return 0; }
  if (!['gitlab', 'markdown'].includes(tracker)) throw new T.BuildError(`--tracker must be gitlab or markdown (got "${tracker}")`);
  const base = String(opts.baseUrl !== undefined ? opts.baseUrl : config.publish.base_url || '').replace(/\/+$/, '');

  const cross = T.readJson(path.join(paths.work, 'phase6', 'cross-cutting.json'), 'work/phase6/cross-cutting.json (the roadmap)');
  T.problems('work/phase6/cross-cutting.json', validateCrossCutting(cross));
  const fm = T.readJson(path.join(paths.work, 'phase6', 'finding-modules.json'), 'work/phase6/finding-modules.json (run `kit build recommendations` first)');
  const byId = new Map(fm.findings.map((f) => [f.id, f]));
  const levels = T.levelsOf(config);
  const sectionTitle = new Map(cross.sections.map((s) => [s.id, s.title]));
  const label = new Map(fm.modules.map((m) => [m.id, m.label]));
  const outFile = path.join(paths.work, 'phase6', tracker === 'gitlab' ? 'issues.csv' : 'issues.md');
  const page = (p) => path.relative(paths.workspace, p).split(path.sep).join('/');
  const link = (target, anchor, text) => {
    if (base) return `[${text}](${base}/${page(target)}${anchor ? `#${anchor}` : ''})`;
    if (tracker === 'markdown') return `[${text}](${T.rel(outFile, target, anchor)})`;
    return `${text} (\`${page(target)}${anchor ? `#${anchor}` : ''}\`)`;
  };
  const measured = fm.findings.filter((f) => f.verdict === 'PROVEN').length;
  const open = T.openIds(T.readFinal(paths), io);
  const trust = T.trustLine(measured, fm.findings.length, null, open);
  const effort = config.effort_scale || {};

  const issues = [];
  for (const ph of PHASES) {
    for (const item of cross.roadmap[ph]) {
      const rank = (s) => { const i = levels.indexOf(s); return i < 0 ? levels.length : i; };
      const list = item.finding_ids.map((id) => byId.get(id) || { id, severity: 'none', verdict: '?', tier: null, plain: 'not a reported finding' })
        .sort((a, b) => rank(a.severity) - rank(b.severity) || T.byStr(a.id, b.id));
      const body = [
        T.prose(item.change),
        '',
        `- **When:** ${ph} · **Effort:** ${item.effort}${effort[item.effort] ? ` (${T.prose(effort[item.effort])})` : ''}`,
        `- **Modules:** ${(item.modules || []).map((m) => `\`${m}\`${label.has(m) ? ` ${T.prose(label.get(m))}` : ''}`).join(', ') || '-'}`,
        `- **Waits for:** ${(item.depends_on || []).map((d) => T.prose(sectionTitle.get(d) || label.get(d) || d)).join(', ') || '-'}`,
        '',
        `**Findings (${list.length}):**`,
        ...list.map((f) => `- ${link(paths.outputs.report, f.id.toLowerCase(), f.id)} · ${T.cap(f.severity)}${f.verdict === 'PROVEN-STATIC' ? '' : ` (${f.verdict})`} · tier ${f.tier || '-'} · ${T.prose(f.plain)}`),
        '',
        `Source: ${link(paths.outputs.recommendations, 'roadmap', 'the roadmap')}. ${trust.replace(/\*\*/g, '')}`,
        '',
        'Name the finding ids in every change request for this issue.',
      ].join('\n');
      const short = shortTitle(item.change);
      issues.push({ title: `[${ph}] ${tracker === 'markdown' ? T.prose(short) : short}`, body });
    }
  }

  let text;
  if (tracker === 'gitlab') {
    text = [['title', 'description'], ...issues.map((i) => [i.title, i.body])].map((r) => r.map(csv).join(',')).join('\r\n') + '\r\n';
  } else {
    const L = [T.pageTop({
      title: `Issues: ${T.prose(config.audit.name)}`,
      generator: 'tooling/build-issues.js',
      measured,
      open,
      total: fm.findings.length,
      measurementsLink: T.rel(outFile, paths.outputs.measurements),
      intro: `One issue per change on the roadmap, in roadmap order. Copy each into your tracker. The roadmap itself: ${link(paths.outputs.recommendations, 'roadmap', 'recommendations')}.`,
    })];
    issues.forEach((i, n) => L.push(`## ${n + 1}. ${i.title.replace(/^\[(\w+)\]/, '$1:')}`, '', `- [ ] ${i.title}`, '', i.body, ''));
    text = L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  }
  T.writeFile(outFile, text);
  io.out(`issues ${issues.length} (${tracker}); links: ${base || '(relative)'}`);
  io.out(`wrote ${outFile}`);
  return 0;
}

function main(argv, io) {
  return T.runCli(argv, io, { name: 'build-issues', usage: USAGE, options: { '--tracker': 'tracker', '--base-url': 'baseUrl' } }, build);
}

module.exports = { main, csv };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
