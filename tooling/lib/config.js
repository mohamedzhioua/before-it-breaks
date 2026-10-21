'use strict';
/*
 * config.js - load, complete and check an audit workspace's audit.config.json.
 *
 *   const { loadConfig } = require('./lib/config');
 *   const { config, paths } = loadConfig(wsDir, { example: false });
 *
 * loadConfig(wsDir, opts)
 *   wsDir is the workspace folder (default: cwd) or the path of a config
 *   file. The file is read, then completed in three layers, last one wins:
 *     1. config/defaults.json
 *     2. config/presets/<preset>.json, when the config names a preset
 *     3. the file itself
 *   Objects merge key by key; arrays and plain values replace (deepMerge),
 *   except evidence.secret_patterns and read_only.deny_bash: there your
 *   entries are added to the kit defaults, which can never be removed.
 *   Keys __proto__, constructor and prototype are never merged and are
 *   reported as unknown fields.
 *   Two values are then derived when left out: scale.tiers (10000 and
 *   100000 where they are below scale.target, then the target itself) and
 *   scale.unit_short (last word of scale.unit).
 *   The result is checked with validateConfig. On success
 *   { config, paths } is returned. `config` keeps repo paths exactly as
 *   written; absolute folders exist only in `paths` (see resolvePaths), so
 *   nothing built from `config` carries a local path. Repo folders do not
 *   have to exist yet (`kit doctor` checks that).
 *   On any problem a ConfigError is thrown: `.errors` is a string[] of
 *   readable messages and `.stage` is "read" (missing or unparsable file)
 *   or "validate" (the content is wrong; `.file` is the config path), or
 *   "schema" (the bundled schema uses something the validator lacks).
 *   opts.example: allow example-plan repos (url + ref instead of path, and
 *   pin "TODO").
 *
 * validateConfig(obj, opts) -> string[]
 *   Checks an already completed config in two steps: a small validator for
 *   the JSON Schema subset used by config/audit.config.schema.json (type,
 *   required, properties, additionalProperties, enum, const, items,
 *   minItems, pattern, minimum, local $ref without sibling keywords;
 *   default/description/... are annotations), then rules a schema cannot say:
 *     - repo names are kebab-case and unique; a repo has `path`, or in
 *       example mode `url` + `ref`; pin "TODO" only in example mode
 *     - scale.tiers strictly ascending, every tier <= scale.target, and
 *       scale.platform_target >= scale.target
 *     - every lens is bundled (BUNDLED_LENSES) or listed in custom_lenses
 *     - lenses and skeptic lenses unique; verify.survive_votes <= number
 *       of skeptic lenses
 *     - group keys upper-case (A-Z, 0-9, single hyphens) and unique; each
 *       group's repo exists and is not context_only; its lens is in lenses
 *     - concurrency.max_concurrent <= concurrency.max_agents_per_workflow
 *     - modules[].repo exists; modules[].pattern, evidence.secret_patterns
 *       and measure.kinds values compile as regular expressions
 *     - kit.root is absolute; output paths contain no ".." segment
 *     - on Windows, no Git Bash style path (/c/...) in repo paths, kit.root
 *       or outputs
 *   Messages look like `repos[1].name: duplicate "notes-api"`.
 *
 * resolvePaths(config, wsDir) -> { workspace, configFile, kit, repos,
 *   outputs, work, docs, rules }
 *   All absolute. repos maps repo name -> folder (null for an example repo
 *   without a path); outputs maps each outputs key -> file or folder.
 */

const fs = require('fs');
const path = require('path');

const KIT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(KIT_ROOT, 'config');
const SCHEMA_FILE = path.join(CONFIG_DIR, 'audit.config.schema.json');
const DEFAULTS_FILE = path.join(CONFIG_DIR, 'defaults.json');
const CONFIG_NAME = 'audit.config.json';

// Prefixes kept free so new audits never reuse group ids from older work.
const DEFAULT_TIERS = [10000, 100000];
// Lens method files shipped with the kit; any other lens must be declared in
// custom_lenses (and needs its own lens file).
const BUNDLED_LENSES = ['performance', 'reliability', 'data', 'infra', 'frontend'];
// Keys that could reach an object's prototype; never merged, always an error.
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
// Safety lists where a config may only add entries to the kit defaults.
const UNION_FIELDS = [['evidence', 'secret_patterns'], ['read_only', 'deny_bash']];
// A Git Bash style path such as /c/work; Node on Windows reads it as C:/c/work.
const MSYS_PATH = /^\/[a-zA-Z]\//;

class ConfigError extends Error {
  constructor(message, errors, stage) {
    super(message);
    this.name = 'ConfigError';
    this.errors = errors && errors.length ? errors : [message];
    this.stage = stage || 'read'; // read | validate | schema
  }
}

// ---------- small helpers ----------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function deepMerge(base, override) {
  if (override === undefined) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const k of Object.keys(override)) {
    if (FORBIDDEN_KEYS.includes(k)) continue;
    out[k] = deepMerge(Object.prototype.hasOwnProperty.call(base, k) ? base[k] : undefined, override[k]);
  }
  return out;
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new ConfigError(`${label}: file not found`);
    throw new ConfigError(`${label}: cannot read (${e.code || e.message})`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${label}: invalid JSON (${e.message})`);
  }
}

let schemaCache = null;
function loadSchema() {
  if (!schemaCache) schemaCache = readJson(SCHEMA_FILE, 'config/audit.config.schema.json');
  return schemaCache;
}

function show(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function key(at, k) {
  return at ? `${at}.${k}` : k;
}

function compiles(source) {
  try {
    new RegExp(source); // eslint-disable-line no-new
    return null;
  } catch (e) {
    return e.message;
  }
}

// ---------- schema-subset validator ----------

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', '$defs', 'title', 'description', 'examples', 'default']);
const KEYWORDS = new Set(['$ref', 'type', 'required', 'properties', 'additionalProperties', 'enum', 'const', 'items', 'minItems', 'pattern', 'minimum']);

const SUPPORTED_KEYWORDS = [...ANNOTATIONS, ...KEYWORDS];

function schemaError(msg) {
  return new ConfigError(`config/audit.config.schema.json: ${msg}`, null, 'schema');
}

function resolveRef(ref, root) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(String(ref));
  if (!m || !isPlainObject(root.$defs) || !Object.prototype.hasOwnProperty.call(root.$defs, m[1])) {
    throw schemaError(`unsupported or unknown $ref ${show(ref)}`);
  }
  return root.$defs[m[1]];
}

function checkSchema(schema, value, at, errs, root) {
  if (!isPlainObject(schema)) throw schemaError(`a schema node is not an object at ${at || '(root)'}`);
  for (const k of Object.keys(schema)) {
    if (!ANNOTATIONS.has(k) && !KEYWORDS.has(k)) throw schemaError(`unsupported keyword "${k}" at ${at || '(root)'}`);
  }
  if (schema.$ref !== undefined) {
    const extra = Object.keys(schema).filter((k) => k !== '$ref' && !ANNOTATIONS.has(k));
    if (extra.length) throw schemaError(`$ref with sibling keywords (${extra.join(', ')}) at ${at || '(root)'}`);
    return checkSchema(resolveRef(schema.$ref, root), value, at, errs, root);
  }
  const label = at || '(config)';

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errs.push(`${label}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errs.push(`${label}: must be ${show(schema.const)} (got ${show(value)})`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${label}: must be one of ${schema.enum.join(', ')} (got ${show(value)})`);
    return;
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errs.push(value.trim() === '' && schema.pattern === '\\S'
      ? `${label}: must not be empty`
      : `${label}: does not match ${schema.pattern} (got ${show(value)})`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errs.push(`${label}: must be at least ${schema.minimum} (got ${value})`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errs.push(`${label}: needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'} (got ${value.length})`);
    }
    if (schema.items) value.forEach((item, i) => checkSchema(schema.items, item, `${at}[${i}]`, errs, root));
  }
  if (isPlainObject(value)) {
    for (const r of schema.required || []) {
      if (value[r] === undefined) errs.push(`${key(at, r)}: required`);
    }
    const props = schema.properties || {};
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.includes(k)) {
        errs.push(`${key(at, k)}: unknown field`);
      } else if (Object.prototype.hasOwnProperty.call(props, k)) {
        checkSchema(props[k], value[k], key(at, k), errs, root);
      } else if (schema.additionalProperties === false) {
        errs.push(`${key(at, k)}: unknown field`);
      } else if (isPlainObject(schema.additionalProperties)) {
        checkSchema(schema.additionalProperties, value[k], key(at, k), errs, root);
      }
    }
  }
}

// ---------- rules the schema cannot express ----------

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GROUP_KEY = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/;

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function duplicates(list, at, field, errs) {
  const seen = new Set();
  list.forEach((item, i) => {
    const v = field ? (isPlainObject(item) ? item[field] : undefined) : item;
    if (typeof v !== 'string') return;
    const where = field ? `${at}[${i}].${field}` : `${at}[${i}]`;
    if (seen.has(v)) errs.push(`${where}: duplicate ${show(v)}`);
    seen.add(v);
  });
}

// Unknown-repo messages are skipped while a repo has no name, so one missing
// name does not echo through every group and module that uses it.
function allReposNamed(cfg) {
  return arr(cfg.repos).every((r) => isPlainObject(r) && typeof r.name === 'string');
}

function checkRepos(cfg, opts, errs) {
  const repos = arr(cfg.repos);
  repos.forEach((r, i) => {
    if (!isPlainObject(r)) return;
    const at = `repos[${i}]`;
    if (typeof r.name === 'string' && !KEBAB.test(r.name)) {
      errs.push(`${at}.name: must be kebab-case: lower-case letters, digits and single hyphens (got ${show(r.name)})`);
    }
    if (r.path === undefined) {
      if (!opts.example) {
        errs.push(r.url !== undefined
          ? `${at}.path: required (a url/ref repo without a path is allowed only in example mode, --example)`
          : `${at}.path: required`);
      } else if (r.url === undefined || r.ref === undefined) {
        errs.push(`${at}: needs a path, or a url and a ref`);
      }
    }
    if (r.pin === 'TODO' && !opts.example) errs.push(`${at}.pin: "TODO" is allowed only in example mode (--example)`);
  });
  duplicates(repos, 'repos', 'name', errs);
}

function checkScale(cfg, errs) {
  const s = cfg.scale;
  if (!isPlainObject(s)) return;
  const tiers = arr(s.tiers);
  const target = Number.isInteger(s.target) ? s.target : null;
  tiers.forEach((t, i) => {
    if (!Number.isInteger(t)) return;
    if (i > 0 && Number.isInteger(tiers[i - 1]) && t <= tiers[i - 1]) {
      errs.push(`scale.tiers[${i}]: ${t} must be above the previous tier ${tiers[i - 1]} (tiers go strictly up)`);
    }
    if (target !== null && t > target) errs.push(`scale.tiers[${i}]: ${t} is above scale.target ${target}`);
  });
  if (target !== null && Number.isInteger(s.platform_target) && s.platform_target < target) {
    errs.push(`scale.platform_target: ${s.platform_target} is below scale.target ${target}`);
  }
}

function checkGroups(cfg, errs) {
  const repoByName = new Map();
  for (const r of arr(cfg.repos)) if (isPlainObject(r) && typeof r.name === 'string') repoByName.set(r.name, r);
  const lenses = new Set(arr(cfg.lenses));
  const groups = arr(cfg.groups);
  groups.forEach((g, i) => {
    if (!isPlainObject(g)) return;
    const at = `groups[${i}]`;
    if (typeof g.key === 'string') {
      if (!GROUP_KEY.test(g.key)) {
        errs.push(`${at}.key: must be upper-case letters and digits in hyphen-separated parts, e.g. "SVC-JOBS" (got ${show(g.key)})`);
      }
    }
    if (typeof g.repo === 'string') {
      const repo = repoByName.get(g.repo);
      if (!repo) {
        if (allReposNamed(cfg)) errs.push(`${at}.repo: unknown repo ${show(g.repo)}`);
      }
      else if (repo.context_only === true) errs.push(`${at}.repo: ${show(g.repo)} is context_only and cannot be hunted`);
    }
    if (typeof g.lens === 'string' && !lenses.has(g.lens)) {
      errs.push(`${at}.lens: ${show(g.lens)} is not in lenses (${[...lenses].join(', ') || 'none'})`);
    }
  });
  duplicates(groups, 'groups', 'key', errs);
}

function checkLenses(cfg, errs) {
  duplicates(arr(cfg.lenses), 'lenses', null, errs);
  duplicates(arr(cfg.custom_lenses), 'custom_lenses', null, errs);
  const custom = new Set(arr(cfg.custom_lenses));
  arr(cfg.lenses).forEach((l, i) => {
    if (typeof l !== 'string' || BUNDLED_LENSES.includes(l) || custom.has(l)) return;
    errs.push(`lenses[${i}]: ${show(l)} is not a bundled lens (${BUNDLED_LENSES.join(', ')}); `
      + 'a lens of your own must also be listed in custom_lenses');
  });
}

function checkWindowsPaths(cfg, platform, errs) {
  if (platform !== 'win32') return;
  const flag = (at, p) => {
    if (typeof p === 'string' && MSYS_PATH.test(p)) {
      errs.push(`${at}: ${show(p)} is a Git Bash style path; on Windows write it as ${p[1].toUpperCase()}:/${p.slice(3)}`);
    }
  };
  arr(cfg.repos).forEach((r, i) => { if (isPlainObject(r)) flag(`repos[${i}].path`, r.path); });
  if (isPlainObject(cfg.kit)) flag('kit.root', cfg.kit.root);
  if (isPlainObject(cfg.outputs)) for (const [k, p] of Object.entries(cfg.outputs)) flag(`outputs.${k}`, p);
}

function checkRest(cfg, errs) {

  const v = cfg.verify;
  if (isPlainObject(v)) {
    duplicates(arr(v.skeptic_lenses), 'verify.skeptic_lenses', null, errs);
    if (Number.isInteger(v.survive_votes) && Array.isArray(v.skeptic_lenses) && v.survive_votes > v.skeptic_lenses.length) {
      errs.push(`verify.survive_votes: ${v.survive_votes} is more than the ${v.skeptic_lenses.length} skeptic lenses`);
    }
  }

  const c = cfg.concurrency;
  if (isPlainObject(c) && Number.isInteger(c.max_concurrent) && Number.isInteger(c.max_agents_per_workflow)
      && c.max_concurrent > c.max_agents_per_workflow) {
    errs.push(`concurrency.max_concurrent: ${c.max_concurrent} is more than max_agents_per_workflow ${c.max_agents_per_workflow}`);
  }

  const repoNames = new Set(arr(cfg.repos).map((r) => (isPlainObject(r) ? r.name : undefined)));
  arr(cfg.modules).forEach((m, i) => {
    if (!isPlainObject(m)) return;
    if (typeof m.repo === 'string' && !repoNames.has(m.repo) && allReposNamed(cfg)) errs.push(`modules[${i}].repo: unknown repo ${show(m.repo)}`);
    if (typeof m.pattern === 'string') {
      const bad = compiles(m.pattern);
      if (bad) errs.push(`modules[${i}].pattern: not a valid regular expression (${bad})`);
    }
  });

  if (isPlainObject(cfg.evidence)) {
    arr(cfg.evidence.secret_patterns).forEach((p, i) => {
      if (typeof p !== 'string') return;
      const bad = compiles(p);
      if (bad) errs.push(`evidence.secret_patterns[${i}]: not a valid regular expression (${bad})`);
    });
  }
  if (isPlainObject(cfg.measure) && isPlainObject(cfg.measure.kinds)) {
    for (const [k, p] of Object.entries(cfg.measure.kinds)) {
      if (typeof p !== 'string') continue;
      const bad = compiles(p);
      if (bad) errs.push(`measure.kinds.${k}: not a valid regular expression (${bad})`);
    }
  }

  if (isPlainObject(cfg.kit) && typeof cfg.kit.root === 'string' && !path.isAbsolute(cfg.kit.root)) {
    errs.push(`kit.root: must be an absolute path (got ${show(cfg.kit.root)})`);
  }
  if (isPlainObject(cfg.outputs)) {
    for (const [k, p] of Object.entries(cfg.outputs)) {
      if (typeof p === 'string' && p.split(/[\\/]/).includes('..')) {
        errs.push(`outputs.${k}: must stay inside the workspace (no ".." segment)`);
      }
    }
  }
}

// opts.example: example-plan mode. opts.platform: defaults to
// process.platform (tests use "win32"). opts.schema: a schema object used
// instead of the bundled file (tests only). Throws a ConfigError with stage
// "schema" when the schema itself uses something outside the subset.
function validateConfig(obj, opts) {
  opts = opts || {};
  const schema = opts.schema || loadSchema();
  const errs = [];
  checkSchema(schema, obj, '', errs, schema);
  if (!isPlainObject(obj)) return errs;
  checkRepos(obj, opts, errs);
  checkScale(obj, errs);
  checkLenses(obj, errs);
  checkGroups(obj, errs);
  checkRest(obj, errs);
  checkWindowsPaths(obj, opts.platform || process.platform, errs);
  return [...new Set(errs)];
}

// Paths of prototype-related keys anywhere in a raw (unmerged) config; the
// merge drops them, so they are reported from the raw file.
function forbiddenKeyErrors(v, at, out) {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeyErrors(x, `${at}[${i}]`, out));
  else if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.includes(k)) out.push(`${key(at, k)}: unknown field`);
      else forbiddenKeyErrors(v[k], key(at, k), out);
    }
  }
  return out;
}

// ---------- defaults, paths, loading ----------

// Layers defaults and the named preset under a raw config and fills the
// derived scale values. Does not validate.
function withDefaults(raw) {
  let merged = readJson(DEFAULTS_FILE, 'config/defaults.json');
  if (isPlainObject(raw) && typeof raw.preset === 'string' && /^[a-z-]+$/.test(raw.preset)) {
    const file = path.join(CONFIG_DIR, 'presets', `${raw.preset}.json`);
    if (fs.existsSync(file)) merged = deepMerge(merged, readJson(file, `config/presets/${raw.preset}.json`));
  }
  const base = merged;
  merged = deepMerge(merged, raw);
  for (const [section, field] of UNION_FIELDS) {
    const kept = isPlainObject(base[section]) ? base[section][field] : undefined;
    const sec = merged[section];
    if (Array.isArray(kept) && isPlainObject(sec) && Array.isArray(sec[field])) {
      sec[field] = kept.concat(sec[field].filter((x) => !kept.includes(x)));
    }
  }
  const s = merged.scale;
  if (isPlainObject(s)) {
    if (s.tiers === undefined && Number.isInteger(s.target) && s.target > 0) {
      s.tiers = DEFAULT_TIERS.filter((t) => t < s.target).concat(s.target);
    }
    if (s.unit_short === undefined && typeof s.unit === 'string' && s.unit.trim()) {
      s.unit_short = s.unit.trim().split(/\s+/).pop();
    }
  }
  return merged;
}

function resolvePaths(config, wsDir) {
  const workspace = path.resolve(wsDir || '.');
  const kit = isPlainObject(config.kit) && typeof config.kit.root === 'string'
    ? path.resolve(config.kit.root)
    : KIT_ROOT;
  const repos = {};
  for (const r of arr(config.repos)) {
    if (!isPlainObject(r)) continue;
    repos[r.name] = typeof r.path === 'string' ? path.resolve(workspace, r.path) : null;
  }
  const outputs = {};
  for (const [k, p] of Object.entries(config.outputs || {})) outputs[k] = path.resolve(workspace, p);
  return {
    workspace,
    configFile: path.join(workspace, CONFIG_NAME),
    kit,
    repos,
    outputs,
    work: outputs.work_dir,
    docs: outputs.docs_dir,
    rules: path.join(workspace, 'rules'),
  };
}

function loadConfig(wsDir, opts) {
  opts = opts || {};
  let target = path.resolve(wsDir || '.');
  let file = path.join(target, CONFIG_NAME);
  try {
    if (fs.statSync(target).isFile()) {
      file = target;
      target = path.dirname(target);
    }
  } catch (e) {
    if (e.code === 'ENOENT') throw new ConfigError(`workspace not found: ${target}`);
    throw new ConfigError(`cannot read ${target} (${e.code || e.message})`);
  }
  const raw = readJson(file, file);
  if (!isPlainObject(raw)) throw new ConfigError(`${file}: the config must be a JSON object`);
  const merged = withDefaults(raw);
  const errors = [...new Set(forbiddenKeyErrors(raw, '', []).concat(validateConfig(merged, opts)))];
  if (errors.length) {
    const err = new ConfigError(`${file}: ${errors.length} error${errors.length === 1 ? '' : 's'}`, errors, 'validate');
    err.file = file;
    throw err;
  }
  const paths = resolvePaths(merged, target);
  paths.configFile = file;
  return { config: merged, paths };
}

module.exports = {
  loadConfig,
  validateConfig,
  resolvePaths,
  deepMerge,
  withDefaults,
  ConfigError,
  BUNDLED_LENSES,
  SUPPORTED_KEYWORDS,
  KIT_ROOT,
  SCHEMA_FILE,
  DEFAULTS_FILE,
};
