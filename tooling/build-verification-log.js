'use strict';
/*
 * build-verification-log.js - the record of how every candidate (and every
 * claim from earlier work) was checked.
 *
 * Usage: node tooling/build-verification-log.js [<workspace>]
 *
 * Reads (under the config's work folder):
 *   pins.json, candidates.json, phase3/verdicts.json      required
 *   phase3/receipts/_index.json                           optional
 *   claims.json   [{ id, wording, source }] (or { claims: [...] })  optional
 *   run-log.json  (record-run.js)                         optional
 * Writes:
 *   <outputs.log>                    the verification log page
 *   phase3/final-verdicts.json       one entry per candidate, with its
 *                                    citations and whether it is reported;
 *                                    every other builder reads this file
 *   phase3/claim-verdicts.json       one verdict per claim
 *
 * A claim takes the best verdict of the candidates that name it in their
 * source ("prior-claim:<id>"); a merged candidate counts with the verdict
 * of the finding it was merged into. A claim no candidate checked gets
 * NOT-CHECKED (never UNPROVEN: nothing was looked at). The output
 * depends only on the input files, so a rebuild is byte-identical.
 *
 * Exit codes: 0 written, 2 usage, config or input error.
 */

const path = require('path');
const fs = require('fs');
const { validateVerdicts, validateReceiptIndex, citeLocation, VERDICT_VALUES } = require('./lib/shapes');
const T = require('./tiers');

const GENERATOR = 'tooling/build-verification-log.js';
const VOTE_CODE = { REAL: 'R', PARTIAL: 'P', REFUTED: 'X', OUT_OF_SCOPE: 'O' };
const GATES = [
  ['g1_reachable', '1 Reachable', 'process', '1 Process'],
  ['g2_trigger', '2 Realistic trigger', 'reachability', '2 Reachability'],
  ['g3_mechanism', '3 Mechanism', 'real_impact', '3 Real impact (read as scale and reliability)'],
  ['g4_bounds', '4 Bounds', 'poc_validation', '4 PoC validation'],
  ['g5_no_mitigation', '5 No mitigation', 'math_bounds', '5 Math bounds'],
  ['g6_reproduces', '6 Reproduces', 'environment', '6 Environment'],
];
// Best first, for claim roll-ups.
const CLAIM_RANK = ['PROVEN', 'PROVEN-STATIC', 'UNPROVEN', 'NEEDS-REVIEW', 'HELD', 'REFUTED', 'OUT-OF-SCOPE', 'REMOVED', 'NOT-CHECKED'];

function readClaims(paths) {
  const doc = T.readOptional(path.join(paths.work, 'claims.json'), 'work/claims.json', null);
  if (doc === null) return null;
  const list = Array.isArray(doc) ? doc : doc && doc.claims;
  if (!Array.isArray(list)) throw new T.BuildError('work/claims.json must be an array of { id, wording, source }');
  const errs = [];
  const seen = new Set();
  list.forEach((c, i) => {
    if (!c || typeof c.id !== 'string' || !c.id.trim()) errs.push(`claims[${i}].id: required`);
    else if (seen.has(c.id)) errs.push(`claims[${i}].id: duplicate "${c.id}"`);
    else seen.add(c.id);
    if (!c || typeof c.wording !== 'string' || !c.wording.trim()) errs.push(`claims[${i}].wording: required`);
  });
  T.problems('work/claims.json', errs);
  return list;
}

function finalVerdicts(verdicts, cands, full) {
  return verdicts.map((v) => {
    const c = cands.get(v.id);
    return {
      id: v.id,
      title: v.title,
      repo: v.repo,
      group: v.group,
      lens: v.lens,
      source: v.source,
      verdict: v.verdict,
      in_report: T.REPORTED.includes(v.verdict),
      severity: v.severity,
      corrected: v.corrected,
      receipt: v.receipt,
      why: v.why,
      merged_into: v.merged_into || null,
      merged_from: v.merged_from || [],
      synthesized_verdict: v.synthesized_verdict || null,
      override: v.override || null,
      citations: c ? c.locations.map((l) => citeLocation(l, full)) : [],
    };
  });
}

function claimVerdicts(claims, final) {
  const byId = new Map(final.map((f) => [f.id, f]));
  const effective = (f) => (f.verdict === 'MERGED' && byId.has(f.merged_into) ? byId.get(f.merged_into) : f);
  return claims.map((c) => {
    const linked = final.filter((f) => f.source === `prior-claim:${c.id}`);
    let verdict = 'NOT-CHECKED';
    let note = 'no candidate checked this claim';
    if (linked.length) {
      const best = linked.map(effective).sort((a, b) => CLAIM_RANK.indexOf(a.verdict) - CLAIM_RANK.indexOf(b.verdict))[0];
      verdict = best.verdict;
      if (T.REPORTED.includes(verdict)) note = linked.map(effective).some((f) => f.corrected) ? 'holds, with corrections from the skeptics' : 'holds as worded';
      else note = '';
    }
    return {
      id: c.id,
      wording: c.wording,
      source: c.source || '',
      verdict,
      note,
      candidates: linked.map((f) => ({ id: f.id, verdict: f.verdict, severity: f.severity, ...(f.merged_into ? { merged_into: f.merged_into } : {}) })),
    };
  });
}

function tally(list, key, order) {
  const t = T.countBy(list, (x) => x[key]);
  const keys = order ? order.filter((k) => t[k]) : Object.keys(t).sort(T.byStr);
  return keys.map((k) => `${k} ${t[k]}`).join(' · ') || 'none';
}

function sev(s) {
  return s && s !== 'none' ? T.cap(s) : '-';
}

function whoRan(config, runLog) {
  const entries = runLog && Array.isArray(runLog.entries) ? runLog.entries : [];
  if (entries.length) {
    const rows = entries.map((e) => `| ${T.cell(e.phase)} | ${T.cell(e.run)} | ${e.agents === null || e.agents === undefined ? '-' : e.agents} | ${T.cell(e.agent_type)} | ${T.cell(e.model)} | ${T.cell(e.effort)} |`);
    return ['Who ran each step, as recorded in `work/run-log.json` (the model is the one the harness reported, not the one asked for):', '',
      '| Step | Run | Agents | Agent type | Model | Effort |', '|---|---|---|---|---|---|', ...rows].join('\n');
  }
  const ns = (config.agents && config.agents.namespace) || '';
  const types = (config.agents && config.agents.types) || {};
  const rows = Object.entries(config.models || {}).map(([role, m]) => `| ${role} | ${types[role] ? `\`${ns}${types[role]}\`` : '-'} | ${m.model === 'inherit' ? 'inherit (the session model)' : T.cell(m.model)} | ${T.cell(m.effort)} |`);
  return ['`work/run-log.json` has no entries, so the models that actually ran are not recorded. The roles below are **as configured**, not as observed:', '',
    '| Role | Agent type | Model | Effort |', '|---|---|---|---|', ...rows].join('\n');
}

function liveChecks(index, cands) {
  const out = new Map();
  if (!index) return out;
  for (const e of index.candidates) {
    const c = cands.get(e.id);
    const cmds = e.commands.filter((x) => x.status === 'skipped-live').map((x) => c && c.evidence[x.n - 1] ? c.evidence[x.n - 1].cmd : null).filter(Boolean);
    if (cmds.length) out.set(e.id, cmds);
  }
  return out;
}

function render(ctx) {
  const { config, paths, pins, final, claims, verdictsDoc, cands, index, runLog } = ctx;
  const logFile = paths.outputs.log;
  const reported = final.filter((f) => f.in_report);
  const lenses = verdictsDoc.skeptic_lenses;
  const levels = T.levelsOf(config);
  const receiptLink = (f) => (f.receipt ? `[\`${f.receipt}\`](${T.rel(logFile, path.join(paths.work, 'phase3', 'receipts', `${f.id}.md`))})` : '-');
  const live = liveChecks(index, cands);
  const L = [];

  L.push(T.pageTop({
    title: `Verification log: ${T.one(config.audit.name)}`,
    generator: GENERATOR,
    measured: reported.filter((f) => f.verdict === 'PROVEN').length,
    open: final.filter((f) => f.verdict === 'NEEDS-REVIEW').map((f) => f.id),
    total: reported.length,
    measurementsLink: T.rel(logFile, paths.outputs.measurements),
    intro: `This page shows how each candidate finding was tested and which verdict it got. Audit date ${config.audit.date}; pinned commits ${T.pinList(config, pins)}. The findings that survived are written up in [the audit report](${T.rel(logFile, paths.outputs.report)}).`,
  }));

  const t = index ? index.totals : null;
  L.push('## Summary', '', '| | |', '|---|---|',
    `| Candidates checked | ${final.length} |`,
    `| Verdicts | ${tally(final, 'verdict', VERDICT_VALUES)} |`,
    `| Reported findings by severity | ${tally(reported, 'severity', levels)} |`,
    `| Survived, with a correction from the skeptics | ${reported.filter((f) => f.corrected).length} |`,
    `| Still open, waiting for a decision (NEEDS-REVIEW) | ${final.filter((f) => f.verdict === 'NEEDS-REVIEW').map((f) => f.id).join(', ') || 'none'} |`,
    `| Merged into another finding | ${final.filter((f) => f.verdict === 'MERGED').length} |`,
    `| Changed by an owner override | ${final.filter((f) => f.override).length} |`,
    ...(claims ? [`| Claims from earlier work | ${claims.length} (${tally(claims, 'verdict', CLAIM_RANK)}) |`] : []),
    ...(t ? [`| Evidence commands | ran ${t.ran} (non-zero exit ${t.failed}) · not run, need a live system ${t.skipped_live} · refused as unsafe ${t.skipped_unsafe} · could not start ${t.skipped_error} |`] : []),
    ...(verdictsDoc.missing_agents.length ? [`| Agents that returned nothing | ${T.cell(verdictsDoc.missing_agents.join(', '))} |`] : []),
    '');

  L.push('## Method', '',
    `1. **Evidence re-run.** Every candidate came with read-only commands that show its code facts. \`kit evidence\` re-ran them at the pinned commits through an allowlist of reading programs, with no shell. Commands that need a live database, cache, cluster or load test were recorded and not run. Each candidate's output is kept as a receipt in \`work/phase3/receipts/\`, named by a hash of its content.`,
    `2. **Skeptics.** For each candidate, one skeptic per lens (${lenses.map((l) => `\`${l}\``).join(', ')}) tried to refute it, each from its own angle and on its own. A vote is REAL, PARTIAL (real once corrected), REFUTED or OUT_OF_SCOPE. A candidate needs ${verdictsDoc.survive_votes} REAL or PARTIAL votes to survive.`,
    '3. **Verifier.** A separate agent compared each receipt with the code facts the candidate cites, and repeated one of its commands.',
    '4. **Synthesis.** `kit synthesize` applied fixed rules to the votes, the verifier check and the receipt. Anything the rules could not settle became NEEDS-REVIEW.',
    '5. **Owner overrides.** The audit owner may remove, merge, re-scope or hold back a candidate, always with a recorded reason, and may never add one. Each override is listed below.',
    '',
    'Library behaviour was taken from lockfiles, package source or documentation where those were available; anything else is marked unverified in the candidate record.',
    '',
    whoRan(config, runLog),
    '',
    `The six gates, the skeptic lenses and how they line up with the fp-check method are explained in [the kit's verification guide](${T.kitDocUrl('docs/verification.md')}).`,
    '');

  const overridden = final.filter((f) => f.override);
  if (overridden.length) {
    L.push('## Owner overrides', '', '| Candidate | Action | Verdict after | Reason | Approved by |', '|---|---|---|---|---|',
      ...overridden.map((f) => `| [${f.id}](#${f.id.toLowerCase()}) | ${f.override.action}${f.merged_into ? ` into ${f.merged_into}` : ''} | ${f.verdict} | ${T.cell(f.override.reason)} | ${T.cell(f.override.approved_by)} |`), '');
  }

  if (claims) {
    L.push('## Claims from earlier work', '', 'Each claim takes the best verdict of the candidates that checked it.', '',
      '| Claim | Wording | Source | Verdict | Candidates | Note |', '|---|---|---|---|---|---|',
      ...claims.map((c) => `| ${T.cell(c.id)} | ${T.cell(c.wording)} | ${T.cell(c.source)} | **${c.verdict}** | ${c.candidates.map((x) => `[${x.id}](#${x.id.toLowerCase()}) (${x.verdict})`).join(', ') || '-'} | ${T.cell(c.note)} |`), '');
  }

  L.push('## Candidates', '',
    `Each vote is one letter, one per lens in the order ${lenses.join(', ')}: R stands for REAL, P for PARTIAL, X for REFUTED, O for OUT_OF_SCOPE and - for no vote. Gates 1 to 6 read P for pass, F for fail and ? when unknown.`, '',
    '| Candidate | Title | Verdict | Severity | Votes | Gates | Receipt |', '|---|---|---|---|---|---|---|',
    ...final.map((f) => {
      const v = verdictsDoc.byId.get(f.id);
      const votes = lenses.map((l) => (v.votes[l] ? VOTE_CODE[v.votes[l].vote] || '-' : '-')).join('');
      const gates = GATES.map(([g]) => ({ PASS: 'P', FAIL: 'F' })[v.gates[g]] || '?').join('');
      return `| [${f.id}](#${f.id.toLowerCase()}) | ${T.cell(f.title)} | **${f.verdict}** | ${sev(f.severity)} | ${votes} | ${gates} | ${receiptLink(f)} |`;
    }), '');

  L.push('## Records per candidate', '');
  for (const f of final) {
    const v = verdictsDoc.byId.get(f.id);
    const c = cands.get(f.id);
    L.push(`### ${f.id}`, '', `**${T.one(f.title)}**`, '',
      `- **Verdict:** ${f.verdict}${f.merged_into ? ` (merged into [${f.merged_into}](#${f.merged_into.toLowerCase()}))` : ''} · **Severity:** ${sev(f.severity)} · **Source:** ${T.one(f.source)} · **Lens:** ${f.lens} · **Repo:** \`${f.repo}\``,
      `- **Rule that decided it:** ${T.one(f.why) || '-'}`);
    if (f.override) L.push(`- **Override:** ${f.override.action}${f.synthesized_verdict ? ` (verdict before: ${f.synthesized_verdict})` : ''}. ${T.one(f.override.reason)}${f.override.approved_by ? ` Approved by ${T.one(f.override.approved_by)}.` : ''}`);
    if (f.merged_from.length) L.push(`- **Also covers:** ${f.merged_from.map((id) => `[${id}](#${id.toLowerCase()})`).join(', ')}`);
    L.push(`- **Cited code:** ${f.citations.map((x) => `\`${x}\``).join(', ') || '-'}`, `- **Receipt:** ${receiptLink(f)}`);
    if (c) {
      L.push(`- **Claim as hunted:** ${T.one(c.claim)}`, `- **Mechanism:** ${T.one(c.mechanism)}`);
      if (c.arithmetic) L.push(`- **Arithmetic as hunted:** ${T.one(c.arithmetic)}`);
      if (c.mitigations_searched && c.mitigations_searched.length) L.push(`- **Mitigations looked for:** ${c.mitigations_searched.map(T.one).join(' · ')}`);
    }
    const corrected = lenses.map((l) => v.votes[l] && v.votes[l].corrected_threshold).filter(Boolean);
    if (corrected.length) L.push(`- **Threshold as corrected by the skeptics:** ${corrected.map(T.one).join(' / ')}`);
    if (live.has(f.id)) L.push(`- **Live checks recorded, not run:** ${live.get(f.id).map(T.code).join(' · ')}`);
    L.push('', '**Skeptic votes**', '');
    for (const l of lenses) {
      const x = v.votes[l];
      L.push(x ? `- *${l}*: **${x.vote}** (${sev(x.severity)}). ${T.one(x.reason)}${x.key_citations && x.key_citations.length ? ` Checked: ${x.key_citations.map((k) => `\`${T.one(k)}\``).join(', ')}.` : ''}` : `- *${l}*: no vote`);
    }
    L.push('', '| Gate | Result | fp-check gate | Result |', '|---|---|---|---|',
      ...GATES.map(([g, gl, fp, fpl]) => `| ${gl} | ${v.gates[g]} | ${fpl} | ${v.fp_check[fp]} |`), '');
    const ver = v.verifier;
    L.push(ver ? `**Verifier:** ${ver.verdict}. Re-run: ${T.one(ver.rerun) || '-'}${ver.citation_drift ? `. Citation drift: ${T.one(ver.citation_drift)}` : ''}${ver.notes ? `. ${T.one(ver.notes)}` : ''}` : '**Verifier:** no check returned.', '');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

function build(ws, io) {
  const { config, paths, pins, full } = T.loadWorkspace(ws);
  const cands = T.readCandidates(paths);
  const vdoc = T.readJson(path.join(paths.work, 'phase3', 'verdicts.json'), 'work/phase3/verdicts.json (run `kit synthesize` first)');
  T.problems('work/phase3/verdicts.json', validateVerdicts(vdoc));
  const indexFile = path.join(paths.work, 'phase3', 'receipts', '_index.json');
  const index = T.readOptional(indexFile, 'work/phase3/receipts/_index.json', null);
  if (index) T.problems('work/phase3/receipts/_index.json', validateReceiptIndex(index));
  const runLog = T.readOptional(path.join(paths.work, 'run-log.json'), 'work/run-log.json', null);
  const claimsIn = readClaims(paths);

  const final = finalVerdicts(vdoc.verdicts, cands, full);
  T.openIds({ findings: final }, io);
  const claims = claimsIn ? claimVerdicts(claimsIn, final) : null;
  vdoc.byId = new Map(vdoc.verdicts.map((v) => [v.id, v]));
  const md = render({ config, paths, pins, final, claims, verdictsDoc: vdoc, cands, index, runLog });

  T.writeFile(T.FINAL_FILE(paths), JSON.stringify({ date: config.audit.date, generated_by: GENERATOR, pins, findings: final }, null, 2) + '\n');
  const claimFile = path.join(paths.work, 'phase3', 'claim-verdicts.json');
  if (claims) T.writeFile(claimFile, JSON.stringify({ date: config.audit.date, claims }, null, 2) + '\n');
  else if (fs.existsSync(claimFile)) fs.unlinkSync(claimFile);
  T.writeFile(paths.outputs.log, md);
  io.out(`candidates: ${tally(final, 'verdict', VERDICT_VALUES)}`);
  if (claims) io.out(`claims: ${tally(claims, 'verdict', CLAIM_RANK)}`);
  io.out(`wrote ${paths.outputs.log}`);
  return 0;
}

function main(argv, io) {
  return T.runCli(argv, io, { name: 'build-verification-log', usage: 'usage: node tooling/build-verification-log.js [<workspace>]' }, (ws, opts, out) => build(ws, out));
}

module.exports = { main, finalVerdicts, claimVerdicts };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
