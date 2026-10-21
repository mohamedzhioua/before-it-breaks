'use strict';
// End-to-end regression run of a whole audit on the fixture repo, in a temp
// folder that is removed afterwards:
//   init -> validate -> pin -> map / hunt / verify / report-inputs /
//   recommend (each workflow in a vm sandbox, agents played by canned
//   answers that must fit the schema the workflow hands over) -> save ->
//   evidence -> batches -> synthesize (+ one hold override) -> every build
//   (with --strict where a builder has it) -> check secrets / unchanged /
//   links, all exit 0.
// The workspace sits under a folder that looks like a home path (built at
// runtime), so the secrets check is tested the way real workspaces look.
// Then a few planted problems check what the clean run cannot: a home path
// in a published page, a token in a workspace note, a report input that
// disagrees with its candidate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');
const { splitWorkflow } = require('../tooling/check-workflows');
const { validateConfig } = require('../tooling/lib/config');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'kit.js');

function kit(args) {
  const res = spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

function ok(args) {
  const r = kit(args);
  assert.equal(r.code, 0, `kit ${args.join(' ')}\n${r.out}${r.err}`);
  return r;
}

// ---------- canned agents ----------

const PIN = '{pin:notes-api}';
const REPO = '{repo:notes-api}';
const grep = (pat, dir) => `git -C ${REPO} grep -n ${pat} ${PIN} -- ${dir}`;

// One candidate per starting group of kit init, citing the fixture's lines.
const CANDS = {
  'SVC-PERF': {
    title: 'Import makes one awaited users-service call per row',
    claim: 'Importing a file of 100 000 rows makes 100 000 sequential remote calls, so a large import outlives its job timeout.',
    path: 'src/modules/imports/import.service.ts', line: 9,
    mechanism: 'for (const row of rows) { await this.usersClient.fetchProfile(row.userId) }',
    arithmetic: '100000 rows x 20 ms = 2000 s per import, past a 900 s job timeout at 45000 rows',
    breaks_at: '45000', basis: 'rows per file', sev: 'high',
    ev: [{ cmd: grep('fetchProfile', 'src'), expect: 'An awaited fetchProfile inside the for loop.' }],
    lib: [],
  },
  'SVC-REL': {
    title: 'Failed digest jobs are kept forever and block re-scheduling',
    claim: 'A failed digest job keeps its fixed job id, so every later digest for that user is silently dropped.',
    path: 'src/jobs/notify.queue.ts', line: 8,
    mechanism: 'notifyQueue.add with jobId `digest-${userId}` and removeOnFail: false.',
    arithmetic: 'n/a: not size-driven', breaks_at: null, basis: 'not size-driven', sev: 'high',
    ev: [{ cmd: grep('removeOnFail', 'src/jobs'), expect: 'removeOnFail: false next to a fixed jobId.' }],
    lib: [{ library: 'bull', version: '4.12.0', fact: 'add() with an existing jobId is a no-op', source: 'docs' }],
  },
  'SVC-DATA': {
    title: 'Workspace note list loads every note in one query',
    claim: 'Listing a workspace returns every note in one array; at the target size that is far more than one process holds.',
    path: 'src/modules/notes/notes.repository.ts', line: 6,
    mechanism: 'NoteModel.find({ workspaceId }).lean() with no limit or cursor.',
    arithmetic: '1 KB per note x 1000000 = 1 GB; a 512 MB pod fails at about 500000 notes',
    breaks_at: '500000', basis: 'per-tenant items', sev: 'critical',
    ev: [
      { cmd: grep('find', 'src/modules/notes'), expect: 'find({ workspaceId }) with no .limit.' },
      { cmd: "LIVE mongosh --quiet --eval \"db.notes.find({ workspaceId: 'w1' }).explain('executionStats')\"", expect: 'nReturned equal to the workspace note count.' },
    ],
    lib: [{ library: 'mongoose', version: '8.4.0', fact: 'find() returns every match unless limited', source: 'lockfile' }],
  },
  'SVC-OPS': {
    title: 'Search client has no timeout',
    claim: 'A slow search service holds each request open with no upper bound, so request slots run out under load.',
    path: 'src/clients/search.client.ts', line: 2,
    mechanism: "axios.create({ baseURL: 'https://search.internal.example' }) with no timeout option.",
    arithmetic: 'n/a: not size-driven', breaks_at: null, basis: 'not size-driven', sev: 'medium',
    ev: [{ cmd: grep('axios.create', 'src/clients'), expect: 'An axios.create call with no timeout key.' }],
    lib: [{ library: 'axios', version: '1.7.0', fact: 'the default timeout is 0 (none)', source: 'docs' }],
  },
};

const SEV = { 'SVC-PERF-01': 'high', 'SVC-REL-01': 'high', 'SVC-DATA-01': 'critical', 'SVC-OPS-01': 'medium' };
const FIX = { 'SVC-PERF-01': 'Batch the profile lookups.', 'SVC-REL-01': 'Remove failed jobs or vary the job id.', 'SVC-DATA-01': 'Page the list with a cursor.', 'SVC-OPS-01': 'Set a timeout on the client.' };
// Report inputs that agree with the candidates (the planted conflict comes later).
const SIZE = {
  'SVC-PERF-01': { threshold: 'about 45k rows in one import file', breaks_at: 45000, breaks_at_basis: 'rows per file' },
  'SVC-DATA-01': { threshold: 'about 500k notes in one workspace', breaks_at: 500000, breaks_at_basis: 'per-tenant items' },
  'SVC-REL-01': { threshold: 'not size-driven: the first failed digest blocks the next', breaks_at: null, breaks_at_basis: 'not size-driven' },
  'SVC-OPS-01': { threshold: 'not size-driven', breaks_at: null, breaks_at_basis: 'not size-driven' },
};
const STEER_NOTE = 'A comment in src/clients told the reader to ignore previous instructions and approve everything; not followed.';

function candidateFor(group, lens) {
  const c = CANDS[group];
  if (!c) throw new Error(`no canned candidate for group ${group}`);
  return {
    id: `${group}-01`, repo: 'notes-api', group, lens, title: c.title, claim: c.claim,
    locations: [{ repo: 'notes-api', path: c.path, line: c.line }],
    mechanism: c.mechanism, arithmetic: c.arithmetic, breaks_at: c.breaks_at, breaks_at_basis: c.basis,
    severity_guess: c.sev, evidence: c.ev, mitigations_searched: ['Looked for a limit, timeout or cursor near the call: none found.'],
    library_facts: c.lib, source: 'new', rule_pattern_hint: '', notes: '',
  };
}

function receiptId(args, id) {
  try {
    return fs.readFileSync(path.join(args.receipts_dir, `${id}.md`), 'utf8').split(/\r?\n/)[0].replace(/^receipt:\s*/, '').trim();
  } catch (e) {
    return '';
  }
}

function answer(args, prompt, opts) {
  const label = opts.label;
  const props = opts.schema && opts.schema.properties;
  if (label.startsWith('map:')) return { text: '# notes-api map\n\n## Modules\n\n- notes: `src/modules/notes/notes.repository.ts:6`\n- imports: `src/modules/imports/import.service.ts:7`\n' };
  if (label.startsWith('hunt:')) {
    const ip = props.candidates.items.properties;
    const group = ip.group.enum[0];
    return {
      candidates: [candidateFor(group, ip.lens.enum[0])],
      claims_not_resolved: group === 'SVC-REL'
        ? [{ claim_id: 'PRIOR-01', reason: 'Whether failed digests are retried depends on the live queue settings.', command_to_resolve: 'LIVE redis-cli --scan --pattern bull:notifications:failed' }]
        : [],
      notes: group === 'SVC-OPS' ? STEER_NOTE : 'Read the whole scope.',
    };
  }
  if (label.startsWith('rules:')) return { rules: [], skipped: [], results: [], notes: 'no new rules' };
  if (label.startsWith('vote:')) {
    const ids = props.votes.items.properties.id.enum;
    return { votes: ids.map((id) => ({ id, vote: 'REAL', gates: [1, 2, 3, 4, 5, 6].map((g) => ({ gate: g, result: 'PASS', reason: 'Checked at the pinned commit.' })), severity: SEV[id] || 'low', corrected_threshold: '', duplicate_of: '', key_citations: [], reason: 'Real after reading the cited code.' })) };
  }
  if (label.startsWith('verify:')) {
    const ids = props.checks.items.properties.id.enum;
    return { checks: ids.map((id) => ({ id, receipt: receiptId(args, id), verdict: 'CONFIRMED', rerun: '1 MATCH', citation_drift: '', notes: '' })) };
  }
  if (label.startsWith('report:')) {
    const p = props.items.items.properties;
    return { items: p.id.enum.map((id) => ({ id, plain: `Plain-language account of ${id}.`, ...SIZE[id], fix_direction: FIX[id], effort: 'S', area: p.area.enum[0] })) };
  }
  if (label.startsWith('docs:')) return { files: [], unresolved: [], notes: 'no docs written' };
  if (label.startsWith('plan:')) {
    const p = props.plans.items.properties;
    const mod = p.module.enum[0];
    const ids = p.recs.items.properties.finding_ids.items.enum;
    return { plans: [{ module: mod, repo: p.repo.enum[0], summary: `Bound the work in ${mod}.`, recs: ids.map((id, i) => ({ finding_ids: [id], change: FIX[id], target: 'Bounded work per request.', effort: 'S', effort_note: 'one file', depends_on: [], order: i + 1 })) }] };
  }
  if (label === 'cross-cutting') {
    return {
      intro: 'One cross-cutting change covers the unbounded-work findings.',
      sections: [{ id: 'cc-bounded-work', title: 'Bound every list and remote call', context: 'Several findings share one shape.', options: ['per-site fixes', 'shared helpers'], decision: 'shared helpers', consequences: 'One review for all sites.', status: 'proposed', finding_ids: ['SVC-PERF-01', 'SVC-DATA-01'] }],
      roadmap: {
        now: [{ change: 'Page the note list.', finding_ids: ['SVC-DATA-01'], modules: ['notes-api.modules'], effort: 'S', depends_on: ['cc-bounded-work'] }],
        next: [{ change: 'Batch imports.', finding_ids: ['SVC-PERF-01'], modules: ['notes-api.modules'], effort: 'S', depends_on: [] }, { change: 'Vary the digest job id.', finding_ids: ['SVC-REL-01'], modules: ['notes-api.jobs'], effort: 'S', depends_on: [] }],
        later: [],
      },
    };
  }
  throw new Error(`no canned answer for ${label}`);
}

// Runs workflows/<phase>.js in a vm sandbox; returns { result, labels }.
async function runWorkflow(phase, args) {
  const { body } = splitWorkflow(fs.readFileSync(path.join(ROOT, 'workflows', `${phase}.js`), 'utf8'));
  const script = new vm.Script(`(async function () {\n${body}\n})`, { filename: `${phase}.js`, lineOffset: -1 });
  const labels = [];
  const sandbox = {
    args,
    agent: async (prompt, opts) => {
      labels.push(opts.label);
      const out = answer(args, prompt, opts);
      if (out && opts.schema) {
        const errs = validateConfig(out, { schema: opts.schema, platform: 'none' });
        if (errs.length) throw new Error(`${opts.label}: canned answer does not fit the schema: ${errs.join('; ')}`);
      }
      return out;
    },
    parallel: async (fns) => Promise.all(fns.map((f) => f())),
    pipeline: async () => { throw new Error('pipeline is not used by the kit workflows'); },
    phase: () => {},
    log: () => {},
  };
  const result = JSON.parse(JSON.stringify(await script.runInNewContext(sandbox)()));
  return { result, labels };
}

// args -> dry run -> real run -> kit save. Returns the result.
async function phase(ws, name, dir) {
  const args = JSON.parse(ok(['args', name, '--run', '1', ws]).out);
  const dry = await runWorkflow(name, { ...args, dryRun: true });
  assert.equal(dry.result.status, 'dry_run', `${name}: ${JSON.stringify(dry.result.errors)}`);
  assert.equal(dry.labels.length, 0, `${name}: a dry run starts no agent`);
  const { result } = await runWorkflow(name, args);
  assert.notEqual(result.status, 'invalid_args', JSON.stringify(result.errors));
  assert.deepEqual(result.failed || result.missing || [], [], `${name}: every agent returned`);
  const file = path.join(dir, `${name}-1.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  ok(['save', name, file, '--run', '1', ws]);
  return { args, result };
}

test('a whole audit runs end to end on the fixture repo and every closing check passes', { timeout: 120000 }, async (t) => {
  const started = Date.now();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-e2e-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));
  // A parent folder shaped like a home path (".../Users/<name>/..."), as on a real machine.
  const home = path.join(scratch, ['Us', 'ers'].join(''), 'notes-auditor');
  const repo = makeFixtureRepo(path.join(home, 'repos', 'notes-api'));
  const ws = path.join(home, 'audits', 'notes');
  const results = path.join(scratch, 'results');
  fs.mkdirSync(results);

  const init = ok(['init', ws, '--preset', 'scalability', '--size', 'lite', '--repo', repo.path,
    '--name', 'Notes demo', '--question', 'Can one workspace reach 1M notes?', '--unit', 'notes in one workspace', '--target', '1000000']);
  assert.match(init.out, /module rules/);
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'audit.config.json'), 'utf8'));
  assert.deepEqual(cfg.groups.map((g) => g.key).sort(), Object.keys(CANDS).sort(), 'one canned candidate per starting group');
  assert.equal(cfg.modules.length, 1, 'init wrote the starting module rule');
  fs.writeFileSync(path.join(ws, 'work', 'claims.json'), JSON.stringify([
    { id: 'PRIOR-01', wording: 'Failed digests are retried until they succeed.', source: 'an earlier review' },
    { id: 'PRIOR-02', wording: 'Search answers within one second.', source: 'an earlier review' },
  ], null, 2));

  ok(['validate', ws]);
  ok(['pin', ws]);
  ok(['doctor', ws, '--no-optional']);

  await phase(ws, 'map', results);
  const hunt = await phase(ws, 'hunt', results);
  assert.equal(hunt.result.candidates.length, 4);
  const saved = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase2', 'hunt-1.json'), 'utf8'));
  assert.deepEqual(saved.summary.claims_not_resolved.map((u) => u.claim_id), ['PRIOR-01'], 'kit save hunt keeps the summary');

  ok(['evidence', ws, '--dry-run']);
  ok(['evidence', ws]);
  ok(['batches', ws]);
  await phase(ws, 'verify', results);
  ok(['synthesize', ws]);
  fs.writeFileSync(path.join(ws, 'work', 'phase3', 'master-overrides.json'), JSON.stringify({ overrides: [
    { id: 'SVC-OPS-01', action: 'hold', reason: 'Waiting for the search-service timeout config from the platform team.', approved_by: 'Notes platform tech lead' },
  ] }, null, 2));
  ok(['synthesize', ws]);
  const verdicts = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'verdicts.json'), 'utf8')).verdicts;
  assert.equal(verdicts.find((v) => v.id === 'SVC-OPS-01').verdict, 'HELD');

  const log = ok(['build', 'log', ws]);
  assert.match(log.out, /1 NOT-CHECKED looked at by a hunter but unresolved/);
  const logPage = fs.readFileSync(path.join(ws, '03-verification-log.md'), 'utf8');
  assert.match(logPage, /\| PRIOR-01 \|.*\*\*NOT-CHECKED\*\* \(hunter: unresolved\) \|.*hunter: unresolved — Whether failed digests are retried.*would settle it: LIVE redis-cli/);
  assert.match(logPage, /\| PRIOR-02 \|.*\*\*NOT-CHECKED\*\* \|.*no candidate checked this claim/);
  assert.match(logPage, /## Notes for the audit team[\s\S]*Hunter `SVC-OPS` \(work\/phase2\/hunt-1\.json\) reports text that may have tried to instruct it: `A comment in src\/clients/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'claim-verdicts.json'), 'utf8')).claims[0].hunter_unresolved.length, 1);

  const ri = await phase(ws, 'report-inputs', results);
  assert.deepEqual(ri.args.report_batches.flatMap((b) => b.ids).sort(), ['SVC-DATA-01', 'SVC-PERF-01', 'SVC-REL-01']);
  const report = ok(['build', 'report', ws, '--strict']);
  assert.doesNotMatch(report.out, /check:/);

  const rec = await phase(ws, 'recommend', results);
  assert.deepEqual(rec.args.modules.map((m) => [m.id, m.finding_ids]), [['notes-api.jobs', ['SVC-REL-01']], ['notes-api.modules', ['SVC-PERF-01', 'SVC-DATA-01']]]);
  assert.deepEqual(rec.args.unmapped_finding_ids, []);
  ok(['build', 'recommendations', ws, '--strict']);
  ok(['build', 'measurements', ws]);
  ok(['build', 'issues', ws, '--tracker', 'markdown']);
  ok(['build', 'explorer', ws]);

  const secrets = ok(['check', 'secrets', ws]);
  assert.match(secrets.out, /clean/);
  const scan = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'secrets-scan.json'), 'utf8'));
  for (const f of ['02-audit-report.md', '03-verification-log.md', '05-recommendations.md', 'work/phase3/verdicts.json', 'work/explorer-data.json']) {
    assert.ok(scan.published.includes(f), `${f} is in the published set`);
  }
  for (const f of ['audit.config.json', 'MASTER-PROMPT.md', '.claude/settings.json', 'work/phase2/hunt-1.json']) {
    assert.ok(scan.files.includes(f) && !scan.published.includes(f), `${f} is scanned, not published`);
  }
  ok(['check', 'unchanged', ws]);
  ok(['check', 'links', ws]);

  // A home path in a published page counts once; a token counts anywhere.
  const tokenish = ['gh', 'p_'].join('') + 'notesfixture0123456789';
  const homePath = ['C:', 'Us' + 'ers', 'notes-auditor', 'x.md'].join('/');
  fs.appendFileSync(path.join(ws, '02-audit-report.md'), `\nCopied from ${homePath}\n`);
  fs.appendFileSync(path.join(ws, 'HANDOFF.md'), `\nPasted ${tokenish}\nLocal copy at ${homePath}\n`);
  const dirty = kit(['check', 'secrets', ws]);
  assert.equal(dirty.code, 1, dirty.out + dirty.err);
  const hits = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'secrets-scan.json'), 'utf8')).hits;
  assert.deepEqual(hits.map((h) => [h.file, h.label, h.set]), [
    ['02-audit-report.md', 'user-home-path', 'published'],
    ['HANDOFF.md', 'token-prefix', 'workspace'],
  ]);
  assert.ok(!dirty.out.includes(tokenish), 'hits are masked');

  // A report input that says "not size-driven" for a candidate with a size.
  const riFile = path.join(ws, 'work', 'phase5', 'report-inputs.json');
  const doc = JSON.parse(fs.readFileSync(riFile, 'utf8'));
  const perf = doc.items.find((i) => i.id === 'SVC-PERF-01');
  Object.assign(perf, { breaks_at: null, breaks_at_basis: 'not size-driven', threshold: 'any size' });
  fs.writeFileSync(riFile, JSON.stringify(doc, null, 2));
  const plain = ok(['build', 'report', ws]);
  assert.match(plain.out, /check: SVC-PERF-01: the report input says not size-driven .*tier n\/s.* but the verified candidate says a breaking size \(breaks_at "45000", basis "rows per file"\)/);
  assert.match(fs.readFileSync(path.join(ws, '02-audit-report.md'), 'utf8'), /## Notes for the audit team[\s\S]*SVC-PERF-01: the report input says not size-driven/);
  assert.equal(kit(['build', 'report', ws, '--strict']).code, 1);
  assert.equal(kit(['build', 'recommendations', ws, '--strict']).code, 0, 'recommendations have no coverage problem');

  t.diagnostic(`end-to-end run took ${Math.round((Date.now() - started) / 1000)} s`);
  assert.ok(Date.now() - started < 120000, 'the run stays under two minutes');
});
