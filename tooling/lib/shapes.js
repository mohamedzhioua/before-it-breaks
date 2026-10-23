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
 *                   { batches, missing, results: [VOTE_SET | VERIFIER_SET],
 *                   bound_to?: { plan, shas } }.
 *   RECEIPT_INDEX   work/phase3/receipts/_index.json, written by
 *                   run-evidence.js.
 *   PINS            work/pins.json, written by pin.js.
 *   VERDICT         one entry of work/phase3/verdicts.json.
 *   VERDICTS        work/phase3/verdicts.json, written by
 *                   synthesize-verdicts.js.
 *   MAP_RESULT      { repo, text }: one mapper's Markdown map of one repo
 *                   (Phase 1).
 *   REPORT_INPUT    the plain-language fields of one surviving finding
 *                   (Phase 5). work/phase5/report-inputs.json is
 *                   { "items": [REPORT_INPUT...] }.
 *   MODULE_PLAN     the architect's plan for one module (Phase 6), saved as
 *                   work/phase6/recs/<module>.json.
 *   CROSS_CUTTING   decision records and the now/next/later roadmap
 *                   (Phase 6), saved as work/phase6/cross-cutting.json.
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
 *   validateMapResult(obj, config?)        with a config: the repo exists.
 *   validateReportInputs(obj, config?)     also: unique ids; with a config:
 *       breaks_at_basis is one of scale.bases and area one of areas.
 *   validateModulePlan(obj, config?)       with a config: the repo exists.
 *   validateCrossCutting(obj)              also: unique section ids.
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
    breaks_at: { type: ['string', 'null'], description: 'The size at which it breaks or degrades, in the config scale unit; null when not size-driven.' },
    breaks_at_basis: str('What the breaking size counts: one of the config scale.bases ("not size-driven" when breaks_at is null).', NON_EMPTY),
    severity_guess: str('Hint only; one of the rubric levels or "none".', LEVEL),
    evidence: { type: 'array', minItems: 1, items: EVIDENCE },
    mitigations_searched: strList('Each mitigation looked for and what was found, with a citation.'),
    library_facts: {
      type: 'array',
      description: 'Library behaviour the claim relies on, each with where it was checked.',
      items: {
        type: 'object',
        required: ['library', 'version', 'fact', 'source'],
        additionalProperties: false,
        properties: {
          library: str('Package name.', NON_EMPTY),
          version: str('Version from the lockfile, or "unknown".', NON_EMPTY),
          fact: str('The behaviour the claim relies on.', NON_EMPTY),
          source: { enum: ['lockfile', 'package-source', 'docs', 'unverified'], description: '"unverified" when it could not be checked.' },
        },
      },
    },
    source: str('"new", or "prior-claim:<ID>" for a claim from an earlier audit.', '^(new|prior-claim:\\S+)$'),
    status: { enum: ['found', 'fixed', 'not_found'], description: 'Optional. "fixed": the claim held earlier but is fixed at the pin; "not_found": the cited code does not exist at the pin. Synthesis refutes both, and they are not batched for voting.' },
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
    batches: { type: 'array', description: 'Batches of this run.', items: { type: 'string', pattern: '^B[0-9]+$' } },
    missing: strList('Labels of agents that returned nothing.'),
    results: { type: 'array', items: { type: 'object' } },
    bound_to: {
      type: 'object',
      description: 'Copied by the verify workflow from its args, never written by an agent: the batch-plan id and the sha of each candidate the skeptics were given.',
      required: ['plan', 'shas'],
      additionalProperties: false,
      properties: {
        plan: str('Batch-plan id from kit batches.', '^[0-9a-f]{12}$'),
        shas: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
      },
    },
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
        required: ['id', 'receipt', 'sha', 'commands', ...Object.keys(COUNTS)],
        additionalProperties: false,
        properties: {
          id: str('Candidate id.', CANDIDATE_ID),
          receipt: str('sha256 of the receipt body, first 12 hex characters.', '^[0-9a-f]{12}$'),
          sha: str('sha256 of the whole candidate object the commands came from (lib/content-sha.js).', '^[0-9a-f]{64}$'),
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
          trust_git_dir: { type: 'boolean', description: 'true when the .git folder check found problems and --trust-git-dir pinned anyway.' },
          git_dir_problems: strList('The .git folder problems found when --trust-git-dir pinned anyway (for display).'),
          git_dir_digest: str('sha256 of the .git control files when --trust-git-dir pinned anyway; later checks refuse the repo if it changes.', '^[0-9a-f]{64}$'),
        },
      },
    },
  },
};

const VERDICT_VALUES = ['PROVEN', 'PROVEN-STATIC', 'UNPROVEN', 'REFUTED', 'OUT-OF-SCOPE', 'NEEDS-REVIEW', 'REMOVED', 'MERGED', 'HELD'];
const GATE_VALUE = { enum: GATE_RESULTS };

const VERDICT = {
  type: 'object',
  required: ['id', 'title', 'repo', 'group', 'lens', 'source', 'sha', 'verdict', 'why', 'severity', 'corrected', 'votes', 'verifier', 'receipt', 'gates', 'fp_check'],
  additionalProperties: false,
  properties: {
    id: str('Candidate id.', CANDIDATE_ID),
    title: str('Title (after a re-scope, the new one).'),
    repo: str('Repo.', NAME),
    group: str('Hunt group.', GROUP),
    lens: str('Hunt lens.', NAME),
    source: str('As in the candidate.'),
    status: { enum: ['found', 'fixed', 'not_found'] },
    sha: str('sha256 of the whole candidate object this verdict judged (lib/content-sha.js).', '^[0-9a-f]{64}$'),
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
      required: ['action', 'reason', 'approved_by'],
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
  required: ['date', 'skeptic_lenses', 'survive_votes', 'missing_agents', 'unknown_ids', 'overrides_sha256', 'pins_sha256', 'receipts_sha256', 'verdicts'],
  additionalProperties: false,
  properties: {
    date: str('Audit date.', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    skeptic_lenses: { type: 'array', items: { type: 'string', pattern: NAME } },
    survive_votes: { type: 'integer', minimum: 1 },
    missing_agents: strList('Agents that returned nothing.'),
    unknown_ids: strList('Ids voted on that are not candidates.'),
    overrides_sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$', description: 'sha256 of work/phase3/master-overrides.json as synthesis read it; null when there was none.' },
    pins_sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$', description: 'sha256 of work/pins.json when synthesis ran; null when there was none.' },
    receipts_sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$', description: 'sha256 of work/phase3/receipts/_index.json as synthesis read it; null when there was none.' },
    verdicts: { type: 'array', items: VERDICT },
  },
};

const MAP_RESULT = {
  type: 'object',
  description: 'A mapper\'s Markdown description of one repo.',
  required: ['repo', 'text'],
  additionalProperties: false,
  properties: {
    repo: str('Repo name from the config.', NAME),
    text: str('The map, as Markdown.', NON_EMPTY),
  },
};

const EFFORTS = ['S', 'M', 'L'];

const REPORT_INPUT = {
  type: 'object',
  description: 'Plain-language report fields for one finding that survived verification.',
  required: ['id', 'plain', 'threshold', 'breaks_at', 'breaks_at_basis', 'fix_direction', 'effort', 'area'],
  additionalProperties: false,
  properties: {
    id: str('Finding id.', CANDIDATE_ID),
    plain: str('One line a non-engineer can follow: what goes wrong, for whom.', NON_EMPTY),
    threshold: str('The size at which it breaks, with the sums as the skeptics checked them; "n/a: <why>" when not size-driven.'),
    breaks_at: { type: ['number', 'null'], minimum: 0, description: 'Size at which it breaks, in the unit of breaks_at_basis; 0 = at any size; null = no hard break.' },
    breaks_at_basis: str('What the size counts: one of the config scale.bases.', NON_EMPTY),
    fix_direction: str('The direction of the fix, in one or two sentences.', NON_EMPTY),
    effort: { enum: EFFORTS, description: 'S, M or L, as in the config effort_scale.' },
    area: str('One of the config areas.', NON_EMPTY),
  },
};

// Other top-level keys a workflow run adds (for example a list of failed
// agents) are kept and not checked.
const REPORT_INPUTS = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: REPORT_INPUT } },
};

const MODULE_ID = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

const MODULE_PLAN = {
  type: 'object',
  description: 'Recommended changes for one module.',
  required: ['module', 'repo', 'summary', 'recs'],
  additionalProperties: false,
  properties: {
    module: str('Module id, as built from the config modules rules.', MODULE_ID),
    repo: str('Repo of the module.', NAME),
    summary: str('What the module should become, in two or three sentences.', NON_EMPTY),
    recs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['finding_ids', 'change', 'target', 'effort', 'effort_note', 'depends_on', 'order'],
        additionalProperties: false,
        properties: {
          finding_ids: { type: 'array', minItems: 1, items: { type: 'string', pattern: CANDIDATE_ID } },
          change: str('The change to make.', NON_EMPTY),
          target: str('The component or behaviour after the change.', NON_EMPTY),
          effort: { enum: EFFORTS },
          effort_note: str('Why this size; empty when obvious.'),
          depends_on: { type: 'array', items: { type: 'string', pattern: MODULE_ID }, description: 'Ids of cross-cutting sections or modules that must change first.' },
          order: { type: 'integer', minimum: 1, description: 'Position of this change within the module plan, 1 first.' },
        },
      },
    },
  },
};

const ROADMAP_ITEM = {
  type: 'object',
  required: ['change', 'finding_ids', 'effort'],
  additionalProperties: false,
  properties: {
    change: str('The change, one sentence.', NON_EMPTY),
    finding_ids: { type: 'array', minItems: 1, items: { type: 'string', pattern: CANDIDATE_ID } },
    modules: { type: 'array', items: { type: 'string', pattern: MODULE_ID } },
    effort: { enum: EFFORTS },
    depends_on: { type: 'array', items: { type: 'string', pattern: MODULE_ID }, description: 'Ids of cross-cutting sections or modules this waits for.' },
  },
};

const CROSS_CUTTING = {
  type: 'object',
  description: 'Changes that span modules, as lightweight decision records, and the order of work.',
  required: ['intro', 'sections', 'roadmap'],
  additionalProperties: false,
  properties: {
    intro: str('Two or three sentences that open the target design.', NON_EMPTY),
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'context', 'options', 'decision', 'consequences', 'status', 'finding_ids'],
        additionalProperties: false,
        properties: {
          id: str('Section id, e.g. cc-bounded-reads.', MODULE_ID),
          title: str('Short title.', NON_EMPTY),
          context: str('The problem and the forces at play.', NON_EMPTY),
          options: { type: 'array', minItems: 1, items: { type: 'string', pattern: NON_EMPTY } },
          decision: str('The proposed option and why.', NON_EMPTY),
          consequences: str('What gets better, what gets worse.', NON_EMPTY),
          status: { const: 'proposed', description: 'The audit proposes; the team decides.' },
          finding_ids: { type: 'array', items: { type: 'string', pattern: CANDIDATE_ID } },
          depends_on: { type: 'array', items: { type: 'string', pattern: MODULE_ID }, description: 'Optional: other sections that must come first.' },
        },
      },
    },
    roadmap: {
      type: 'object',
      required: ['now', 'next', 'later'],
      additionalProperties: false,
      properties: {
        now: { type: 'array', items: ROADMAP_ITEM },
        next: { type: 'array', items: ROADMAP_ITEM },
        later: { type: 'array', items: ROADMAP_ITEM },
      },
    },
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
  const list = isObj(obj) && Array.isArray(obj.candidates) ? obj.candidates : [];
  if (list.some((e) => isObj(e) && e.sha === undefined)) return ['receipts from before this version (no candidate sha): run `kit evidence` again'];
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

function repoKnown(config, repo, at, errs) {
  if (!config || typeof repo !== 'string') return;
  if (!(config.repos || []).some((r) => r.name === repo)) errs.push(`${at}.repo: unknown repo "${repo}"`);
}

function validateMapResult(obj, config, at) {
  at = at || 'map';
  const errs = check(MAP_RESULT, obj, at);
  if (isObj(obj)) repoKnown(config, obj.repo, at, errs);
  return errs;
}

function validateReportInputs(obj, config) {
  const errs = check(REPORT_INPUTS, obj, 'report_inputs');
  const items = isObj(obj) && Array.isArray(obj.items) ? obj.items : [];
  const seen = new Set();
  const bases = config && config.scale && Array.isArray(config.scale.bases) ? config.scale.bases : null;
  const areas = config && Array.isArray(config.areas) ? config.areas : null;
  items.forEach((it, i) => {
    if (!isObj(it)) return;
    const at = `report_inputs.items[${i}]`;
    if (typeof it.id === 'string') {
      if (seen.has(it.id)) errs.push(`${at}.id: duplicate "${it.id}"`);
      seen.add(it.id);
    }
    if (bases && typeof it.breaks_at_basis === 'string' && !bases.includes(it.breaks_at_basis)) {
      errs.push(`${at}.breaks_at_basis: must be one of ${bases.join(', ')} (got "${it.breaks_at_basis}")`);
    }
    if (areas && typeof it.area === 'string' && !areas.includes(it.area)) {
      errs.push(`${at}.area: must be one of ${areas.join(', ')} (got "${it.area}")`);
    }
  });
  return errs;
}

function validateModulePlan(obj, config, at) {
  at = at || 'plan';
  const errs = check(MODULE_PLAN, obj, at);
  if (isObj(obj)) repoKnown(config, obj.repo, at, errs);
  return errs;
}

function validateCrossCutting(obj) {
  const errs = check(CROSS_CUTTING, obj, 'cross_cutting');
  const seen = new Set();
  (isObj(obj) && Array.isArray(obj.sections) ? obj.sections : []).forEach((s, i) => {
    if (!isObj(s) || typeof s.id !== 'string') return;
    if (seen.has(s.id)) errs.push(`cross_cutting.sections[${i}].id: duplicate "${s.id}"`);
    seen.add(s.id);
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
  MAP_RESULT,
  REPORT_INPUT,
  REPORT_INPUTS,
  MODULE_PLAN,
  ROADMAP_ITEM,
  CROSS_CUTTING,
  EFFORTS,
  validateMapResult,
  validateReportInputs,
  validateModulePlan,
  validateCrossCutting,
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
