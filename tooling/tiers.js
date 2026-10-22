'use strict';
/*
 * tiers.js - size tiers, the maturity rule, number formatting, and the
 * small rendering pieces every builder shares (the verdict legend, the
 * "how far to trust this" line, Markdown escaping, relative links).
 *
 * Tiers come from config.scale.tiers (strictly ascending, the last one is
 * normally the target). Labels carry no unit, because one row holds
 * findings sized in different units. With tiers [a, b, c]:
 *   T0     breaks already, at any size              (breaks_at = 0)
 *   T1     up to a                                  (0 < breaks_at <= a)
 *   T2     above a, up to b                         (a < breaks_at <= b)
 *   T3     above b, up to c
 *   T4     above c (toward scale.platform_target when one is set)
 *   grows  slower or costlier as size grows, no single breaking point
 *          (breaks_at null)
 *   n/s    not size-driven (breaks_at_basis "not size-driven")
 * Each size counts whatever the finding's breaks_at_basis names, so a
 * per-file threshold and a per-workspace threshold share one ladder.
 *
 * Maturity of an area, by rule, from its severity counts (levels in rubric
 * order, most severe first):
 *   Weak          any finding at the top level, or 3+ at the second
 *   Moderate      any finding at the second level
 *   Satisfactory  any finding at the third level
 *   Strong        lower levels only
 *   (no findings) "-"
 *
 * Exports: buildTiers(config) -> [{ id, label, max? }], tierOf(item, config)
 *   -> tier id, maturity(counts, levels), fmtN(n), breaksText(item),
 *   levelsOf(config); text helpers cap, one, prose, cell, code, rel(from, to,
 *   anchor), hasRecommendations(paths); pageTop(opts), legend(),
 *   trustLine(measured, total, link),
 *   kitDocUrl(page); workspace helpers loadWorkspace(ws, opts?),
 *   readCandidates, readFinal, checkFresh, checkSynthesis, readInputs,
 *   sortFindings, countBy, readJson, readJsonSha, readOptional, problems,
 *   writeFile, byStr; runCli(argv, io, spec, fn), strictExit(strict,
 *   warnings, io); BuildError, StaleError (exit 1 from runCli),
 *   REPORTED, NOT_SIZE_DRIVEN, VERDICT_MEANING; main(argv) prints the
 *   tier ladder of a workspace.
 */

const fs = require('fs');
const path = require('path');
const { ConfigError } = require('./lib/config');
const { buildMasks, mask } = require('./lib/mask');

const NOT_SIZE_DRIVEN = 'not size-driven';
// Verdicts that put a finding in the report.
const REPORTED = ['PROVEN', 'PROVEN-STATIC', 'UNPROVEN'];

const VERDICT_MEANING = {
  PROVEN: 'measured on a running system.',
  'PROVEN-STATIC': 'the cited code was re-read at the pinned commit, a verifier re-ran the evidence, and the skeptics failed to knock it down. Not measured.',
  UNPROVEN: 'the skeptics accept the mechanism, but the evidence could not be re-run here (for example, it needs a live system).',
  REFUTED: 'the skeptics or the evidence showed that it does not hold.',
  'OUT-OF-SCOPE': 'real or not, it lies outside the question of this audit.',
  'NEEDS-REVIEW': 'the voting rules could not settle it; a person has to decide.',
  HELD: 'held back from the report by the audit owner, with a recorded reason.',
  MERGED: 'the same problem as another finding; counted there.',
  REMOVED: 'withdrawn by the audit owner, with a recorded reason.',
  'NOT-CHECKED': 'for a claim from earlier work: no candidate tested it, so the audit says nothing about it.',
};

class BuildError extends Error {}
// The builder's input is out of date (runCli exits 1, not 2).
class StaleError extends BuildError {}

// ---------- tiers and maturity ----------

function fmtN(n) {
  if (n === null || n === undefined) return '-';
  if (n === 0) return 'any size';
  const short = (v, unit) => `${Number.isInteger(v) ? v : Number(v.toFixed(1))}${unit}`;
  if (n >= 1e9) return short(n / 1e9, 'G');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'k');
  return String(n);
}

function buildTiers(config) {
  const s = config.scale || {};
  const tiers = Array.isArray(s.tiers) ? s.tiers : [];
  const out = [{ id: 'T0', label: 'breaks already, at any size' }];
  tiers.forEach((t, i) => {
    const label = i === 0 ? `up to ${fmtN(t)}` : `${fmtN(tiers[i - 1])} to ${fmtN(t)}`;
    out.push({ id: `T${i + 1}`, label, max: t });
  });
  if (tiers.length) {
    const toward = Number.isInteger(s.platform_target) && s.platform_target > tiers[tiers.length - 1]
      ? ` (toward ${fmtN(s.platform_target)} platform-wide)` : '';
    out.push({ id: `T${tiers.length + 1}`, label: `above ${fmtN(tiers[tiers.length - 1])}${toward}` });
  }
  out.push({ id: 'grows', label: 'slows with size, no single breaking point' });
  out.push({ id: 'n/s', label: NOT_SIZE_DRIVEN });
  return out;
}

function tierOf(item, config) {
  if (!item) return 'grows';
  if (item.breaks_at_basis === NOT_SIZE_DRIVEN) return 'n/s';
  if (item.breaks_at === null || item.breaks_at === undefined) return 'grows';
  if (item.breaks_at === 0) return 'T0';
  const tiers = (config.scale && config.scale.tiers) || [];
  for (let i = 0; i < tiers.length; i++) if (item.breaks_at <= tiers[i]) return `T${i + 1}`;
  return `T${tiers.length + 1}`;
}

function levelsOf(config) {
  return Object.keys(config.severity_rubric || {});
}

function maturity(counts, levels) {
  const n = (i) => (levels[i] !== undefined ? counts[levels[i]] || 0 : 0);
  const total = levels.reduce((a, l) => a + (counts[l] || 0), 0);
  if (!total) return '-';
  if (n(0) || n(1) >= 3) return 'Weak';
  if (n(1)) return 'Moderate';
  if (n(2)) return 'Satisfactory';
  return 'Strong';
}

function breaksText(item) {
  if (!item) return '-';
  if (item.breaks_at_basis === NOT_SIZE_DRIVEN) return NOT_SIZE_DRIVEN;
  if (item.breaks_at === null || item.breaks_at === undefined) return `no hard break (${item.breaks_at_basis})`;
  if (item.breaks_at === 0) return 'any size';
  return `${fmtN(item.breaks_at)} (${item.breaks_at_basis})`;
}

// ---------- text ----------

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const one = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
// Agent-written text placed in Markdown prose: one line, with "<" written as
// &lt; (no raw HTML) and "![" as "!\[" (no image that loads from elsewhere).
// one() keeps the raw text; code() keeps the raw text inside backticks.
const prose = (s) => one(s).replace(/</g, '&lt;').replace(/!\[/g, '!\\[');
const cell = (s) => prose(s).replace(/\|/g, '\\|') || '-';
// A code span that always holds: the fence is one backtick longer than the
// longest backtick run inside, padded with a space when the text starts or
// ends with a backtick (CommonMark).
function code(s) {
  const t = one(s).replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(t.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

// True when the recommend phase saved a result: at least one module plan in
// work/phase6/recs/ or work/phase6/cross-cutting.json. Pages decide from
// these inputs, never from whether 05 has been generated yet.
function hasRecommendations(paths) {
  const dir = path.join(paths.work, 'phase6');
  const recs = path.join(dir, 'recs');
  const plans = fs.existsSync(recs) && fs.readdirSync(recs).some((f) => /\.json$/i.test(f));
  return plans || fs.existsSync(path.join(dir, 'cross-cutting.json'));
}

// Relative Markdown link target from one file to another, with / separators.
function rel(fromFile, toFile, anchor) {
  let r = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  if (!r) r = path.basename(toFile);
  return anchor ? `${r}#${anchor}` : r;
}

let kitHome = null;
function kitDocUrl(page) {
  if (kitHome === null) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
      kitHome = String(manifest.homepage || '').replace(/\/$/, '');
    } catch (e) {
      kitHome = '';
    }
  }
  return kitHome ? `${kitHome}/blob/main/${page}` : page;
}

function legend() {
  const lines = Object.entries(VERDICT_MEANING).map(([v, m]) => `> - **${v}**: ${m}`);
  return `> **Verdict words used on this page**\n>\n${lines.join('\n')}`;
}

// measured / total: how many reported findings were measured (PROVEN).
// open: ids of candidates still NEEDS-REVIEW (neither in nor out yet).
function trustLine(measured, total, measurementsLink, open) {
  const where = measurementsLink ? ` The checks that would measure them are listed in [the measurements page](${measurementsLink}).` : '';
  const n = open ? open.length : 0;
  const pending = n ? ` ${n} more candidate${n === 1 ? ' is' : 's are'} still open (NEEDS-REVIEW: ${open.join(', ')}) and counted nowhere until a person decides.` : '';
  if (!total) return `**How far to trust this:** no finding survived verification, so there is nothing measured or calculated to report.${where}${pending}`;
  if (!measured) return `**How far to trust this:** none of the ${total} findings has been measured. Every threshold here is calculated from the code at the pinned commits, not measured.${where}${pending}`;
  return `**How far to trust this:** ${measured} of ${total} findings ${measured === 1 ? 'was' : 'were'} measured on a running system (PROVEN). Every other threshold is calculated from the code at the pinned commits, not measured.${where}${pending}`;
}

// The first lines of every generated page. headline: an optional one-line
// summary placed right after the trust line.
function pageTop({ title, intro, measured, total, measurementsLink, generator, open, headline }) {
  return [
    `# ${title}`,
    '',
    `> This page is built by \`${generator}\` out of the work folder. To change it, change the data there and rebuild.`,
    '',
    trustLine(measured, total, measurementsLink, open),
    '',
    ...(headline ? [headline, ''] : []),
    legend(),
    '',
    ...(intro ? [intro, ''] : []),
  ].join('\n');
}

// Ids of candidates still open; warns on the given io when there are any.
function openIds(final, io) {
  const ids = final.findings.filter((f) => f.verdict === 'NEEDS-REVIEW').map((f) => f.id);
  if (ids.length && io) io.out(`warning: ${ids.length} candidate${ids.length === 1 ? ' is' : 's are'} still NEEDS-REVIEW (open): ${ids.join(', ')}`);
  return ids;
}

// ---------- files and command line ----------

// Masks for secrets and private paths (lib/mask.js). loadWorkspace turns
// them on; from then on every JSON file read through readJson has each of
// its strings masked, and every .md or .csv page written through writeFile
// is masked once more as a last net. Agent-written text (commands, expected
// output, reasons, notes) therefore never reaches a page unmasked.
let activeMasks = null;

function scrub(v, masks) {
  if (typeof v === 'string') return mask(v, masks);
  if (Array.isArray(v)) return v.map((x) => scrub(x, masks));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, masks)]));
  return v;
}

function maskText(s) {
  return activeMasks ? mask(s, activeMasks) : s;
}

function readJson(file, label) {
  return readJsonSha(file, label).value;
}

// { value, sha }: the parsed (and masked) JSON and the sha256 of the very
// bytes it was parsed from.
function readJsonSha(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw new BuildError(`${label} is missing (${file})`);
    throw new BuildError(`cannot read ${label} (${e.code || e.message})`);
  }
  const sha = require('crypto').createHash('sha256').update(bytes).digest('hex');
  return { value: parseJson(bytes.toString('utf8'), label), sha };
}

function parseJson(text, label) {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return activeMasks ? scrub(value, activeMasks) : value;
  } catch (e) {
    if (e instanceof BuildError) throw e;
    throw new BuildError(`${label} is not valid JSON (${e.message})`);
  }
}

function readOptional(file, label, fallback) {
  return fs.existsSync(file) ? readJson(file, label) : fallback;
}

function problems(label, errs) {
  if (!errs.length) return;
  const shown = errs.slice(0, 20).map((m) => `  - ${m}`);
  if (errs.length > 20) shown.push(`  ... and ${errs.length - 20} more`);
  throw new BuildError(`${label} is not valid:\n${shown.join('\n')}`);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, /\.(md|csv)$/i.test(file) ? maskText(text) : text);
}

// Plain code-point order, the same on every machine.
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- workspace data shared by the builders ----------

// { config, paths, pins: { repo: short }, full: { repo: sha } }. When
// final-verdicts.json exists, it must still match verdicts.json (see
// checkFresh); only `kit build log`, which rewrites it, passes
// { fresh: false }.
function loadWorkspace(ws, opts) {
  const { loadConfig } = require('./lib/config');
  const { readPins } = require('./pin');
  const { config, paths } = loadConfig(ws);
  activeMasks = buildMasks(config);
  const p = readPins(paths);
  const pins = {};
  const full = {};
  for (const [name, r] of Object.entries(p.repos)) { pins[name] = r.short; full[name] = r.sha; }
  if (!(opts && opts.fresh === false) && fs.existsSync(FINAL_FILE(paths))) checkFresh(paths);
  return { config, paths, pins, full };
}

function pinList(config, pins) {
  return config.repos.filter((r) => pins[r.name]).map((r) => `\`${r.name}@${pins[r.name]}\``).join(', ') || 'none recorded';
}

function readCandidates(paths) {
  const { validateCandidates } = require('./lib/shapes');
  const doc = readJson(path.join(paths.work, 'candidates.json'), 'work/candidates.json');
  const list = Array.isArray(doc) ? doc : doc && doc.candidates;
  problems('work/candidates.json', validateCandidates(list));
  return new Map(list.map((c) => [c.id, c]));
}

const FINAL_FILE = (paths) => path.join(paths.work, 'phase3', 'final-verdicts.json');

// Throws StaleError (exit 1) when phase3/verdicts.json is no longer the
// file `kit build log` read (its sha256 must equal the verdicts_sha256 that
// build log recorded in final-verdicts.json), or when synthesis itself is out
// of date (checkSynthesis).
function checkFresh(paths) {
  const { fileSha } = require('./lib/content-sha');
  let recorded;
  try {
    // The recorded sha, read without masking.
    recorded = JSON.parse(fs.readFileSync(FINAL_FILE(paths), 'utf8').replace(/^\uFEFF/, '')).verdicts_sha256;
  } catch (e) {
    throw new BuildError(`cannot read work/phase3/final-verdicts.json (${e.code || e.message}); run \`kit build log\` again`);
  }
  const now = fileSha(path.join(paths.work, 'phase3', 'verdicts.json'));
  if (now === null) throw new StaleError('work/phase3/verdicts.json is missing, but final-verdicts.json was built from it; run `kit synthesize` and `kit build log` again');
  if (recorded !== now) {
    throw new StaleError(typeof recorded === 'string'
      ? 'work/phase3/verdicts.json changed after `kit build log`; re-run it'
      : 'work/phase3/final-verdicts.json does not record which verdicts.json it was built from; re-run `kit build log`');
  }
  checkSynthesis(paths);
}

// Throws StaleError (exit 1) when candidates.json or master-overrides.json
// changed after `kit synthesize`: every verdict's sha must be the contentSha
// of the candidate with its id, with the same ids on both sides, and
// verdicts.json's overrides_sha256 must be the sha256 of the overrides file
// (null when there is none); and when pins.json or receipts/_index.json
// changed (pins_sha256, receipts_sha256; null for an absent file, and null
// against a sha counts as a change). Files are read raw (no masking), as
// synthesis read them.
function checkSynthesis(paths) {
  const { contentSha, fileSha } = require('./lib/content-sha');
  const raw = (file, label) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new BuildError(`cannot read ${label} (${e.code || e.message})`);
    }
  };
  const vdoc = raw(path.join(paths.work, 'phase3', 'verdicts.json'), 'work/phase3/verdicts.json');
  const cdoc = raw(path.join(paths.work, 'candidates.json'), 'work/candidates.json');
  const cands = Array.isArray(cdoc) ? cdoc : cdoc && Array.isArray(cdoc.candidates) ? cdoc.candidates : [];
  const now = new Map(cands.map((c) => [c && c.id, contentSha(c)]));
  const list = vdoc && Array.isArray(vdoc.verdicts) ? vdoc.verdicts : [];
  const same = list.length === now.size && list.every((v) => v && now.get(v.id) === v.sha)
    && vdoc.overrides_sha256 === fileSha(path.join(paths.work, 'phase3', 'master-overrides.json'));
  if (!same) throw new StaleError('candidates or overrides changed after `kit synthesize`; run it again');
  if (vdoc.pins_sha256 !== fileSha(path.join(paths.work, 'pins.json'))
    || vdoc.receipts_sha256 !== fileSha(path.join(paths.work, 'phase3', 'receipts', '_index.json'))) {
    throw new StaleError('pins or evidence receipts changed after `kit synthesize`; run `kit evidence` and `kit synthesize` again');
  }
}

// final-verdicts.json, after checkFresh.
function readFinal(paths) {
  const doc = readJson(FINAL_FILE(paths), 'work/phase3/final-verdicts.json (run `kit build log` first)');
  if (!doc || !Array.isArray(doc.findings)) throw new BuildError('work/phase3/final-verdicts.json has no "findings" array; run `kit build log` again');
  checkFresh(paths);
  return doc;
}

// id -> REPORT_INPUT; an empty map when the file does not exist yet.
function readInputs(paths, config) {
  const { validateReportInputs } = require('./lib/shapes');
  const file = path.join(paths.work, 'phase5', 'report-inputs.json');
  const doc = readOptional(file, 'work/phase5/report-inputs.json', null);
  if (doc === null) return new Map();
  problems('work/phase5/report-inputs.json', validateReportInputs(doc, config));
  return new Map(doc.items.map((i) => [i.id, i]));
}

// Reported findings, most severe first, then the smallest breaking size
// (no hard break and not size-driven last), then id.
function sortFindings(list, levels, inputs) {
  const rank = (s) => { const i = levels.indexOf(s); return i < 0 ? levels.length : i; };
  const size = (f) => { const i = inputs.get(f.id); return i && typeof i.breaks_at === 'number' && i.breaks_at_basis !== NOT_SIZE_DRIVEN ? i.breaks_at : Infinity; };
  return list.slice().sort((a, b) => rank(a.severity) - rank(b.severity) || size(a) - size(b) || byStr(a.id, b.id));
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

// Runs a builder: parses [<workspace>] plus the given value options
// (spec.options: flag -> key) and boolean flags (spec.flags: flag -> key),
// maps errors to exit codes (StaleError -> 1, other BuildError/ConfigError
// -> 2, a returned number otherwise). fn(ws, opts, io) returns an exit code.
function runCli(argv, io, spec, fn) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  const opts = {};
  let ws = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--help' || a === '-h') { io.out(spec.usage); return 0; }
      if (spec.flags && Object.prototype.hasOwnProperty.call(spec.flags, a)) {
        opts[spec.flags[a]] = true;
      } else if (spec.options && Object.prototype.hasOwnProperty.call(spec.options, a)) {
        const v = argv[++i];
        if (v === undefined) throw new BuildError(`${a} needs a value`);
        opts[spec.options[a]] = v;
      } else if (a.startsWith('-')) {
        throw new BuildError(`unknown option ${a}\n${spec.usage}`);
      } else if (ws === null) ws = a;
      else if (spec.rest) (opts.rest = opts.rest || []).push(a);
      else throw new BuildError(`unexpected argument ${a}\n${spec.usage}`);
    }
    return fn(ws || '.', opts, io);
  } catch (e) {
    if (e instanceof BuildError || e instanceof ConfigError) {
      io.err(`${spec.name}: ${e.message}`);
      if (e instanceof ConfigError && e.errors && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return e instanceof StaleError ? 1 : 2;
    }
    throw e;
  }
}

// Exit code of a builder that printed `check:` lines: 1 under --strict when
// there was at least one, else 0.
function strictExit(strict, warnings, io) {
  if (!strict || !warnings) return 0;
  io.out(`--strict: ${warnings} check warning${warnings === 1 ? '' : 's'}, exit 1`);
  return 1;
}

module.exports = {
  strictExit,
  NOT_SIZE_DRIVEN,
  REPORTED,
  VERDICT_MEANING,
  BuildError,
  StaleError,
  fmtN,
  buildTiers,
  tierOf,
  levelsOf,
  maturity,
  breaksText,
  cap,
  one,
  prose,
  cell,
  code,
  rel,
  hasRecommendations,
  kitDocUrl,
  legend,
  trustLine,
  pageTop,
  readJson,
  readJsonSha,
  readOptional,
  scrub,
  maskText,
  problems,
  writeFile,
  byStr,
  runCli,
  loadWorkspace,
  pinList,
  readCandidates,
  readFinal,
  checkFresh,
  checkSynthesis,
  readInputs,
  sortFindings,
  countBy,
  openIds,
  FINAL_FILE,
  main,
};

// `node tooling/tiers.js [<workspace>]` prints the tier ladder of a config.
function main(argv, io) {
  return runCli(argv, io, { name: 'tiers', usage: 'usage: node tooling/tiers.js [<workspace>]' }, (ws, opts, out) => {
    const { loadConfig } = require('./lib/config');
    const { config } = loadConfig(ws);
    for (const t of buildTiers(config)) out.out(`${t.id.padEnd(6)} ${t.label}`);
    return 0;
  });
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
