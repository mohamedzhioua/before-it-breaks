'use strict';
/*
 * shapes.js - the data shapes passed between audit phases, as plain JSON
 * Schema objects, plus small validators.
 *
 * This file is the single source of truth. The workflow scripts cannot
 * require() anything, so they carry inline copies of the schemas they hand
 * to agents; keep those copies in step with this file.
 *
 * Shapes
 *   CANDIDATE       one suspected finding written by a hunter (Phase 2).
 *                   work/candidates.json is { "candidates": [CANDIDATE...] }.
 *   LOCATION        { repo, path, line }; cited in text as
 *                   repo@<10-char pin>:path:line (see citeLocation).
 *   EVIDENCE        { cmd, expect }: a read-only shell command and what its
 *                   output should show. cmd may use {repo:<name>} (absolute
 *                   repo folder) and {pin:<name>} (full pinned commit).
 *   VOTE            one skeptic's vote on one candidate (Phase 3).
 *   VOTE_SET        { kind: "vote", batch, lens, votes: [VOTE...] }: what
 *                   one skeptic agent returns for one batch.
 *   CHECK           the verifier's result for one candidate.
 *   VERIFIER_SET    { kind: "verify", batch, checks: [CHECK...] }.
 *   RUN_OUTPUT      what a verify workflow run returns and the lead saves
 *                   as work/phase3/votes-<name>.json:
 *                   { batches, missing, results: [VOTE_SET | VERIFIER_SET] }.
 *   RECEIPT_INDEX   work/phase3/receipts/_index.json, written by
 *                   run-evidence.js.
 *   PINS            work/pins.json, written by pin.js.
 *   VERDICT         one entry of work/phase3/verdicts.json.
 *   VERDICTS        work/phase3/verdicts.json, written by
 *                   synthesize-verdicts.js.
 *
 * Validators return string[] (empty = valid); messages look like
 * `candidates[2].locations[0].line: must be at least 1 (got 0)`.
 *   validateCandidate(obj, config?)
 *   validateCandidates(fileOrArray, config?)  also: unique ids, and with a
 *       config: repo, group and lens exist, and the id starts with the group
 *       key.
 *   validateVotes(voteSet, config?)        with a config: lens is a skeptic
 *       lens and severities are rubric levels (or "none").
 *   validateVerifier(verifierSet)
 *   validateRunOutput(obj, config?)
 *   validateReceiptIndex(obj)
 *   validatePins(obj)
 *   validateVerdicts(obj)                  also: unique ids
 *
 * The schema checks reuse the validator of tooling/lib/config.js (it accepts
 * any schema object). Only the keywords it supports are used here: type,
 * required, properties, additionalProperties, enum, const, items, minItems,
 * pattern, minimum and local $ref.
 */

const { validateConfig } = require('./config');

const NAME = '^[a-z0-9]+(-[a-z0-9]+)*$';
const GROUP = '^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$';
const CANDIDATE_ID = '^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-[0-9]{2,}$';
const NON_EMPTY = '\\S';
const LEVEL = '^[a-z][a-z0-9-]*$';

const VOTE_VALUES = ['REAL', 'PARTIAL', 'REFUTED', 'OUT_OF_SCOPE'];
const CHECK_VALUES = ['CONFIRMED', 'REFUTED', 'UNVERIFIABLE'];
const GATE_RESULTS = ['PASS', 'FAIL', 'UNKNOWN'];
const RECEIPT_STATUS = ['ran', 'skipped-live', 'skipped-unsafe', 'skipped-error'];

const str = (description, pattern) => ({ type: 'string', description, ...(pattern ? { pattern } : {}) });
const strList = (description) => ({ type: 'array', description, items: { type: 'string', pattern: NON_EMPTY } });

const LOCATION = {
  type: 'object',
  description: 'A place in the code, at the pinned commit of its repo.',
  required: ['repo', 'path', 'line'],
  additionalProperties: false,
  properties: {
    repo: str('Repo name from the config.', NAME),
    path: str('Path relative to the repo root, with / separators.', '^(?![/\\\\]|[A-Za-z]:)[^\\\\]*\\S$'),
    line: { type: 'integer', minimum: 1, description: 'First line of the cited code.' },
  },
};

const EVIDENCE = {
  type: 'object',
  description: 'A read-only command that reproduces a fact at the pinned commit.',
  required: ['cmd', 'expect'],
  additionalProperties: false,
  properties: {
    cmd: str('Shell command; use {repo:<name>} and {pin:<name>} instead of local paths and commits.', NON_EMPTY),
    expect: str('What the output must show for the claim to hold.', NON_EMPTY),
  },
};

const CANDIDATE = {
  type: 'object',
  description: 'One suspected finding from a hunter.',
  required: ['id', 'repo', 'group', 'lens', 'title', 'claim', 'locations', 'mechanism', 'evidence', 'source'],
  additionalProperties: false,
  properties: {
    id: str('<GROUP>-NN, e.g. SVC-JOBS-03.', CANDIDATE_ID),
    repo: str('Repo the finding lives in.', NAME),
    group: str('Hunt group key.', GROUP),
    lens: str('Hunt lens.', NAME),
    title: str('One line.', NON_EMPTY),
    claim: str('What breaks, for whom, at what size, in plain words.', NON_EMPTY),
    locations: { type: 'array', minItems: 1, items: LOCATION },
    mechanism: str('The exact code mechanism, quoting the query, loop or option.', NON_EMPTY),
    arithmetic: str('Where it breaks, with the sums shown; or "n/a: <why>".'),
    breaks_at: str('The size at which it breaks or degrades, in the config scale unit.'),
    severity_guess: str('Hint only; one of the rubric levels or "none".', LEVEL),
    evidence: { type: 'array', minItems: 1, items: EVIDENCE },
    mitigations_searched: strList('Each mitigation looked for and what was found, with a citation.'),
    source: str('"new", or "prior-claim:<ID>" for a claim from an earlier audit.', '^(new|prior-claim:\\S+)$'),
    status: { enum: ['found', 'not_found'], description: 'Optional. "not_found": the cited code does not exist at the pin (an earlier claim that no longer holds); synthesis then refutes it.' },
    rule_pattern_hint: str('If repeatable: the code shape a static rule should match; else empty.'),
    notes: str('Anything else.'),
  },
};

const GATE = {
  type: 'object',
  required: ['gate', 'result', 'reason'],
  additionalProperties: false,
  properties: {
    gate: { enum: [1, 2, 3, 4, 5, 6], description: '1 reachable, 2 realistic trigger, 3 mechanism, 4 bounds, 5 no mitigation, 6 reproduces.' },
    result: { enum: GATE_RESULTS },
    reason: str('One sentence.'),
  },
};

const VOTE = {
  type: 'object',
  required: ['id', 'vote', 'gates', 'severity', 'reason'],
  additionalProperties: false,
  properties: {
    id: str('Candidate id.', CANDIDATE_ID),
    vote: { enum: VOTE_VALUES, description: 'REAL holds as stated; PARTIAL holds once corrected; REFUTED does not hold; OUT_OF_SCOPE.' },
    gates: { type: 'array', items: GATE, description: 'Only the gates of this skeptic\'s lens.' },
    severity: str('Recommended rubric level, or "none".', LEVEL),
    corrected_threshold: str('Corrected sums or threshold when they differ; else empty.'),
    duplicate_of: str('Id of another candidate about the same code and the same problem; else empty.'),
    key_citations: strList('repo@sha10:path:line checked by the skeptic.'),
    reason: str('What was checked and why the vote.', NON_EMPTY),
  },
};

const VOTE_SET = {
  type: 'object',
  required: ['kind', 'batch', 'lens', 'votes'],
  additionalProperties: false,
  properties: {
    kind: { const: 'vote' },
    batch: str('Batch name, e.g. B1.', '^B[0-9]+$'),
    lens: str('Skeptic lens.', NAME),
    votes: { type: 'array', items: VOTE },
  },
};

const CHECK = {
  type: 'object',
  required: ['id', 'receipt', 'verdict', 'rerun', 'notes'],
  additionalProperties: false,
  properties: {
    id: str('Candidate id.', CANDIDATE_ID),
    receipt: str('Receipt id from line 1 of the receipt file.'),
    verdict: { enum: CHECK_VALUES, description: 'CONFIRMED output supports the code facts; REFUTED contradicts them; UNVERIFIABLE needs live access or shows nothing decisive.' },
    rerun: str('The one command re-run, and MATCH or MISMATCH.'),
    citation_drift: str('Cited path:line that does not show the claimed code; else empty.'),
    notes: str('Short.'),
  },
};

const VERIFIER_SET = {
  type: 'object',
  required: ['kind', 'batch', 'checks'],
  additionalProperties: false,
  properties: {
    kind: { const: 'verify' },
    batch: str('Batch name.', '^B[0-9]+$'),
    checks: { type: 'array', items: CHECK },
  },
};

const RUN_OUTPUT = {
  type: 'object',
  required: ['results'],
  additionalProperties: false,
  properties: {
    batches: strList('Batches of this run.'),
    missing: strList('Labels of agents that returned nothing.'),
    results: { type: 'array', items: { type: 'object' } },
  },
};

const COUNTS = {
  ran: { type: 'integer', minimum: 0 },
  failed: { type: 'integer', minimum: 0 },
  skipped_live: { type: 'integer', minimum: 0 },
  skipped_unsafe: { type: 'integer', minimum: 0 },
  skipped_error: { type: 'integer', minimum: 0 },
};

const RECEIPT_INDEX = {
  type: 'object',
  required: ['date', 'pins', 'totals', 'candidates'],
  additionalProperties: false,
  properties: {
    date: str('Audit date from the config.', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    pins: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9a-f]{40}$' } },
    totals: { type: 'object', required: Object.keys(COUNTS), additionalProperties: false, properties: COUNTS },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'receipt', 'commands', ...Object.keys(COUNTS)],
        additionalProperties: false,
        properties: {
          id: str('Candidate id.', CANDIDATE_ID),
          receipt: str('sha256 of the receipt body, first 12 hex characters.', '^[0-9a-f]{12}$'),
          ...COUNTS,
          commands: {
            type: 'array',
            items: {
              type: 'object',
              required: ['n', 'status', 'reason', 'exit'],
              additionalProperties: false,
              properties: {
                n: { type: 'integer', minimum: 1 },
                status: { enum: RECEIPT_STATUS },
                reason: { type: 'string' },
                exit: { type: ['integer', 'string', 'null'], description: 'Exit code; "timeout" or an error code; null when skipped.' },
              },
            },
          },
        },
      },
    },
  },
};

const SHA = '^[0-9a-f]{40}$';

const PINS = {
  type: 'object',
  required: ['date', 'allow_dirty', 'repos'],
  additionalProperties: false,
  properties: {
    date: str('Audit date from the config.', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    allow_dirty: { type: 'boolean', description: 'true when pinned with --allow-dirty.' },
    repos: {
      type: 'object',
      description: 'Repo name -> its state at pin time.',
      additionalProperties: {
        type: 'object',
        required: ['sha', 'short', 'branch', 'commit_date', 'porcelain', 'changes_sha256'],
        additionalProperties: false,
        properties: {
          sha: str('Full commit.', SHA),
          short: str('First 10 characters, used in citations.', '^[0-9a-f]{10}$'),
          branch: str('Branch name, or "(detached)".'),
          commit_date: str('Commit date, ISO 8601.'),
          porcelain: { type: 'integer', minimum: 0, description: 'Number of uncommitted changes.' },
          changes_sha256: str('sha256 of the uncommitted changes, contents included.', '^[0-9a-f]{64}$'),
        },
      },
    },
  },
};

const VERDICT_VALUES = ['PROVEN', 'PROVEN-STATIC', 'UNPROVEN', 'REFUTED', 'OUT-OF-SCOPE', 'NEEDS-REVIEW', 'REMOVED', 'MERGED', 'HELD'];
const GATE_VALUE = { enum: GATE_RESULTS };

const VERDICT = {
  type: 'object',
  required: ['id', 'title', 'repo', 'group', 'lens', 'source', 'verdict', 'why', 'severity', 'corrected', 'votes', 'verifier', 'receipt', 'gates', 'fp_check'],
  additionalProperties: false,
  properties: {
    id: str('Candidate id.', CANDIDATE_ID),
    title: str('Title (after a re-scope, the new one).'),
    repo: str('Repo.', NAME),
    group: str('Hunt group.', GROUP),
    lens: str('Hunt lens.', NAME),
    source: str('As in the candidate.'),
    status: { enum: ['found', 'not_found'] },
    verdict: { enum: VERDICT_VALUES, description: 'Final verdict, after master overrides.' },
    why: str('One line: the rule that decided it.'),
    severity: str('Rubric level or "none".', LEVEL),
    corrected: { type: 'boolean', description: 'Survived, but at least one skeptic corrected it.' },
    votes: { type: 'object', description: 'Skeptic lens -> its vote, or null when missing.', additionalProperties: { type: ['object', 'null'] } },
    verifier: { type: ['object', 'null'] },
    receipt: { type: ['string', 'null'] },
    gates: {
      type: 'object',
      required: ['g1_reachable', 'g2_trigger', 'g3_mechanism', 'g4_bounds', 'g5_no_mitigation', 'g6_reproduces'],
      additionalProperties: false,
      properties: { g1_reachable: GATE_VALUE, g2_trigger: GATE_VALUE, g3_mechanism: GATE_VALUE, g4_bounds: GATE_VALUE, g5_no_mitigation: GATE_VALUE, g6_reproduces: GATE_VALUE },
    },
    fp_check: {
      type: 'object',
      required: ['process', 'reachability', 'real_impact', 'poc_validation', 'math_bounds', 'environment'],
      additionalProperties: false,
      properties: { process: GATE_VALUE, reachability: GATE_VALUE, real_impact: GATE_VALUE, poc_validation: GATE_VALUE, math_bounds: GATE_VALUE, environment: GATE_VALUE },
    },
    override: {
      type: 'object',
      required: ['action', 'reason'],
      additionalProperties: false,
      properties: { action: { enum: ['remove', 'merge', 're-scope', 'hold'] }, reason: str('Why.', NON_EMPTY), approved_by: str('Who approved the override.', NON_EMPTY) },
    },
    synthesized_verdict: { enum: VERDICT_VALUES, description: 'Verdict before a remove, merge or hold override.' },
    merged_into: str('Candidate this one was merged into.', CANDIDATE_ID),
    merged_from: { type: 'array', items: { type: 'string', pattern: CANDIDATE_ID } },
    original_title: str('Title before a re-scope.'),
    original_severity: str('Severity before a re-scope.', LEVEL),
  },
};

const VERDICTS = {
  type: 'object',
  required: ['date', 'skeptic_lenses', 'survive_votes', 'missing_agents', 'unknown_ids', 'verdicts'],
  additionalProperties: false,
  properties: {
    date: str('Audit date.', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    skeptic_lenses: { type: 'array', items: { type: 'string', pattern: NAME } },
    survive_votes: { type: 'integer', minimum: 1 },
    missing_agents: strList('Agents that returned nothing.'),
    unknown_ids: strList('Ids voted on that are not candidates.'),
    verdicts: { type: 'array', items: VERDICT },
  },
};

// ---------- validators ----------

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Schema check only; `at` prefixes every message.
function check(schema, value, at) {
  const errs = validateConfig(value, { schema, platform: 'none' });
  return errs.map((m) => {
    if (m.startsWith('(config)')) return at + m.slice('(config)'.length);
    return at ? `${at}.${m}` : m;
  });
}

function levels(config) {
  const rubric = config && isObj(config.severity_rubric) ? Object.keys(config.severity_rubric) : [];
  return rubric.concat('none');
}

function validateCandidate(obj, config, at) {
  at = at || 'candidate';
  const errs = check(CANDIDATE, obj, at);
  if (!config || !isObj(obj)) return errs;
  const repos = new Set((config.repos || []).map((r) => r.name));
  const groups = new Map((config.groups || []).map((g) => [g.key, g]));
  const lenses = new Set(config.lenses || []);
  if (typeof obj.repo === 'string' && !repos.has(obj.repo)) errs.push(`${at}.repo: unknown repo "${obj.repo}"`);
  if (typeof obj.group === 'string') {
    if (!groups.has(obj.group)) errs.push(`${at}.group: unknown group "${obj.group}"`);
    if (typeof obj.id === 'string' && !obj.id.startsWith(obj.group + '-')) {
      errs.push(`${at}.id: "${obj.id}" must start with its group key "${obj.group}-"`);
    }
  }
  if (typeof obj.lens === 'string' && !lenses.has(obj.lens)) errs.push(`${at}.lens: unknown lens "${obj.lens}"`);
  if (typeof obj.severity_guess === 'string' && !levels(config).includes(obj.severity_guess)) {
    errs.push(`${at}.severity_guess: must be one of ${levels(config).join(', ')}`);
  }
  (Array.isArray(obj.locations) ? obj.locations : []).forEach((l, i) => {
    if (isObj(l) && typeof l.repo === 'string' && !repos.has(l.repo)) errs.push(`${at}.locations[${i}].repo: unknown repo "${l.repo}"`);
  });
  return errs;
}

// Accepts { candidates: [...] } or a bare array.
function validateCandidates(input, config) {
  const list = isObj(input) ? input.candidates : input;
  if (!Array.isArray(list)) return ['candidates: expected an array (or an object with a "candidates" array)'];
  const errs = [];
  const seen = new Set();
  list.forEach((c, i) => {
    errs.push(...validateCandidate(c, config, `candidates[${i}]`));
    if (isObj(c) && typeof c.id === 'string') {
      if (seen.has(c.id)) errs.push(`candidates[${i}].id: duplicate "${c.id}"`);
      seen.add(c.id);
    }
  });
  return errs;
}

function validateVotes(obj, config, at) {
  at = at || 'votes';
  const errs = check(VOTE_SET, obj, at);
  if (!config || !isObj(obj)) return errs;
  const lenses = (config.verify && config.verify.skeptic_lenses) || [];
  if (typeof obj.lens === 'string' && !lenses.includes(obj.lens)) errs.push(`${at}.lens: "${obj.lens}" is not a skeptic lens (${lenses.join(', ')})`);
  (Array.isArray(obj.votes) ? obj.votes : []).forEach((v, i) => {
    if (isObj(v) && typeof v.severity === 'string' && !levels(config).includes(v.severity)) {
      errs.push(`${at}.votes[${i}].severity: must be one of ${levels(config).join(', ')}`);
    }
  });
  return errs;
}

function validateVerifier(obj, at) {
  return check(VERIFIER_SET, obj, at || 'verifier');
}

function validateRunOutput(obj, config, at) {
  at = at || 'output';
  const errs = check(RUN_OUTPUT, obj, at);
  if (!isObj(obj) || !Array.isArray(obj.results)) return errs;
  obj.results.forEach((r, i) => {
    const where = `${at}.results[${i}]`;
    if (isObj(r) && r.kind === 'vote') errs.push(...validateVotes(r, config, where));
    else if (isObj(r) && r.kind === 'verify') errs.push(...validateVerifier(r, where));
    else errs.push(`${where}.kind: must be "vote" or "verify"`);
  });
  return errs;
}

function validateReceiptIndex(obj) {
  return check(RECEIPT_INDEX, obj, 'receipts');
}

function validatePins(obj) {
  return check(PINS, obj, 'pins');
}

function validateVerdicts(obj) {
  const errs = check(VERDICTS, obj, 'verdicts');
  const seen = new Set();
  (isObj(obj) && Array.isArray(obj.verdicts) ? obj.verdicts : []).forEach((v, i) => {
    if (!isObj(v) || typeof v.id !== 'string') return;
    if (seen.has(v.id)) errs.push(`verdicts.verdicts[${i}].id: duplicate "${v.id}"`);
    seen.add(v.id);
  });
  return errs;
}

// repo@<10-char pin>:path:line, from a LOCATION and { repo: fullSha }.
function citeLocation(loc, pins) {
  const sha = pins && pins[loc.repo];
  const short = typeof sha === 'string' ? sha.slice(0, 10) : 'UNPINNED';
  return `${loc.repo}@${short}:${loc.path}:${loc.line}`;
}

module.exports = {
  LOCATION,
  EVIDENCE,
  CANDIDATE,
  GATE,
  VOTE,
  VOTE_SET,
  CHECK,
  VERIFIER_SET,
  RUN_OUTPUT,
  RECEIPT_INDEX,
  PINS,
  VERDICT,
  VERDICTS,
  VERDICT_VALUES,
  VOTE_VALUES,
  CHECK_VALUES,
  GATE_RESULTS,
  RECEIPT_STATUS,
  validateCandidate,
  validateCandidates,
  validateVotes,
  validateVerifier,
  validateRunOutput,
  validateReceiptIndex,
  validatePins,
  validateVerdicts,
  citeLocation,
};
