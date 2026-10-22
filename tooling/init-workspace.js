'use strict';
/*
 * init-workspace.js - create an audit workspace from a preset and the kit
 * templates. The workspace is where every result of one audit lives; it is
 * always outside the kit, so private results cannot end up in the kit's
 * history.
 *
 * Usage:
 *   node tooling/init-workspace.js <workspace> --preset <scalability|reliability|performance>
 *        --size <lite|standard|full> --repo <folder> [--repo <folder> ...]
 *        [--name <text>] [--question <text>] [--unit <text>] [--target <N>]
 *        [--no-rules] [--force]
 *   node tooling/init-workspace.js <workspace> --refresh-prompts
 *
 *   <workspace>   folder to create. Refused when it lies inside the kit or
 *                 inside one of the repos, when a repo lies inside it, and
 *                 when it already holds an audit.config.json (init is for new
 *                 workspaces only; it never touches an audit's state).
 *                 A folder that is not empty is refused too, unless --force:
 *                 then init adds only the files that are missing and never
 *                 overwrites an existing file.
 *   --repo        a repository folder to audit (must exist). Repos are named
 *                 after their folder (kebab-case) and get role "backend";
 *                 change the role of each one in audit.config.json.
 *   --name, --question, --unit, --target
 *                 audit.name, audit.question, scale.unit, scale.target. Left
 *                 out, a neutral default is written; question, unit and
 *                 target are then listed in audit.placeholders, and
 *                 `validate` and `doctor` warn while they keep that default.
 *   --no-rules    switch the static-rules stage off (rules.enabled false) and
 *                 copy no rules.
 *   --refresh-prompts
 *                 for an existing workspace: render MASTER-PROMPT.md and
 *                 LAUNCHER-PROMPT.md again from the current audit.config.json
 *                 and the running kit. Writes those two files and, when
 *                 kit.root names another folder than the running kit (the kit
 *                 moved, e.g. after a plugin update), sets kit.root in
 *                 audit.config.json to the running kit; nothing else.
 *
 * Writes (spec layout; output names from config.outputs):
 *   audit.config.json        preset, size, audit, kit.root (a record of the
 *                            kit init ran from; the tools always use the
 *                            running kit), repos, scale, lenses, starting
 *                            hunt groups (one per repo and lens; scope = the
 *                            whole repo, to narrow) and one starting module
 *                            rule per repo (defaultModules; none for infra)
 *   README.md, HANDOFF.md, 01-executive-summary.md (outline for a person),
 *   MASTER-PROMPT.md, LAUNCHER-PROMPT.md   rendered from templates/ and
 *                            prompts/: every {{placeholder}} is filled from
 *                            the completed config; none may remain
 *   .gitignore               ignores everything: results are private
 *   .claude/settings.json    permissions.deny: Bash(<prefix>) and
 *                            Bash(<prefix> *) for every read_only.deny_bash
 *                            entry, Bash(git * <sub>) and Bash(git * <sub> *)
 *                            for its git entries (git -C and other options),
 *                            and Edit(//<repo>/**), Write(//<repo>/**) for
 *                            every repo. They reduce accidents; they are not
 *                            a security boundary.
 *   work/run-log.json, work/claims.json, work/phase3/master-overrides.json
 *   work/{args,phase1..phase6,...}/, system-docs/, rules/ (+ copies of the
 *   bundled rule sets and run-tests.sh when rules are enabled, results/)
 * Then checks the written config with the kit validator and prints the next
 * steps (validate, doctor, pin, launch).
 *
 * Exit codes: 0 created (or prompts refreshed), 1 the written workspace
 * failed a check (config or a placeholder left), 2 usage error or refused
 * target.
 *
 * Exports: main, render, denyRules(prefixes), fileDenyRules(repoDirs),
 *   startingGroups, defaultModules(repos), launchLine(config, repoDirs),
 *   placeholderWarnings(config)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, validateConfig, withDefaults, ConfigError, kitRootMoved, KIT_ROOT, SCHEMA_FILE } = require('./lib/config');

class CliError extends Error {}

const PRESETS = ['scalability', 'reliability', 'performance'];
const SIZES = ['lite', 'standard', 'full'];
const TEMPLATES = path.join(KIT_ROOT, 'templates');
const PROMPTS = path.join(KIT_ROOT, 'prompts');

const DEFAULT_QUESTION = {
  scalability: 'Can the system grow to the target size, and what gives way first?',
  reliability: 'Where does the system fail, repeat work or lose work as it grows, and in what order should that be fixed?',
  performance: 'What makes the system slow today, and what gets slower as the data grows?',
};
const DEFAULT_UNIT = 'items in one tenant';
const DEFAULT_UNIT_SHORT = 'items';
const DEFAULT_TARGET = 1000000;

// Short group-key parts per bundled lens (custom lenses use their own name).
const LENS_KEY = { performance: 'PERF', reliability: 'REL', data: 'DATA', infra: 'OPS', frontend: 'WEB' };
const LENS_FOCUS = {
  performance: 'Work that grows with the size unit: reads without a bound, one awaited call per item, pages that get larger.',
  reliability: 'Retries that repeat side effects, jobs that overlap or never end, work lost on a restart.',
  data: 'Queries no index serves, result sets without a limit, records that keep growing.',
  infra: 'Memory and connection limits, timeouts, and what happens during a deploy or a restart.',
  frontend: 'Screens that fetch or draw everything at once, and heavy work on the main thread.',
};
const ROLE_LABEL = { backend: 'backend', frontend: 'front-end', infra: 'infrastructure', other: 'other' };

// ---------- arguments ----------

function parseArgs(argv) {
  const o = { workspace: null, preset: null, size: null, repos: [], name: null, question: null, unit: null, target: null, rules: true, force: false, refresh: false, help: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--force') o.force = true;
    else if (a === '--refresh-prompts') o.refresh = true;
    else if (a === '--no-rules') o.rules = false;
    else if (a === '--preset') o.preset = value(i++, a);
    else if (a === '--size') o.size = value(i++, a);
    else if (a === '--repo') o.repos.push(value(i++, a));
    else if (a === '--name') o.name = value(i++, a);
    else if (a === '--question') o.question = value(i++, a);
    else if (a === '--unit') o.unit = value(i++, a);
    else if (a === '--target') o.target = value(i++, a);
    else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (o.workspace !== null) throw new CliError(`only one workspace may be given (got ${o.workspace} and ${a})`);
    else o.workspace = a;
  }
  if (o.help) return o;
  if (!o.workspace) throw new CliError('give the workspace folder to create');
  if (o.refresh) {
    const extra = o.preset || o.size || o.repos.length || o.name || o.question || o.unit || o.target || o.force || !o.rules;
    if (extra) throw new CliError('--refresh-prompts takes only the workspace folder: it reads everything else from audit.config.json');
    return o;
  }
  if (!o.preset) throw new CliError(`--preset is required (${PRESETS.join(', ')})`);
  if (!PRESETS.includes(o.preset)) throw new CliError(`--preset must be one of ${PRESETS.join(', ')} (got "${o.preset}")`);
  if (!o.size) throw new CliError(`--size is required (${SIZES.join(', ')})`);
  if (!SIZES.includes(o.size)) throw new CliError(`--size must be one of ${SIZES.join(', ')} (got "${o.size}")`);
  if (!o.repos.length) throw new CliError('give at least one --repo <folder>');
  for (const [flag, v] of [['--name', o.name], ['--question', o.question], ['--unit', o.unit]]) {
    if (v !== null && !v.trim()) throw new CliError(`${flag} must not be empty`);
  }
  if (o.target !== null) {
    if (!/^[1-9][0-9]*$/.test(o.target)) throw new CliError(`--target must be a whole number above 0 (got "${o.target}")`);
    o.target = Number(o.target);
    if (!Number.isSafeInteger(o.target)) throw new CliError('--target is too large');
  }
  return o;
}

// ---------- paths ----------

const posix = (p) => p.split(path.sep).join('/');

// Real path of p, also when p (or part of it) does not exist yet: the longest
// existing ancestor is resolved and the rest is appended.
function realish(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch (e) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  if (process.platform === 'win32' && path.parse(child).root.toLowerCase() !== path.parse(parent).root.toLowerCase()) return false;
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function insideReal(child, parent) {
  const c = realish(child);
  const p = realish(parent);
  return inside(c, p) || (process.platform === 'win32' && inside(c.toLowerCase(), p.toLowerCase()));
}

function kebab(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------- the config ----------

function repoEntries(opts, ws) {
  const used = new Set();
  return opts.repos.map((given, i) => {
    const abs = path.resolve(given);
    let st;
    try { st = fs.statSync(abs); } catch (e) { throw new CliError(`--repo ${given}: folder not found`); }
    if (!st.isDirectory()) throw new CliError(`--repo ${given}: not a folder`);
    if (insideReal(ws, abs)) throw new CliError(`the workspace must not be inside the repo ${given}: the audit only reads repos, and its files would change them`);
    if (insideReal(abs, ws)) throw new CliError(`--repo ${given} lies inside the workspace: keep repos outside it, so the workspace never holds a copy of the code`);
    if (insideReal(abs, KIT_ROOT) || insideReal(KIT_ROOT, abs)) throw new CliError(`--repo ${given}: the kit itself (or a folder holding it) cannot be audited from here`);
    const name = kebab(path.basename(abs)) || `repo-${i + 1}`;
    let n = name;
    for (let k = 2; used.has(n); k++) n = `${name}-${k}`;
    used.add(n);
    const rel = path.relative(ws, abs);
    const sameRoot = process.platform !== 'win32' || path.parse(abs).root.toLowerCase() === path.parse(ws).root.toLowerCase();
    return {
      name: n,
      path: sameRoot && rel ? posix(rel) : posix(abs),
      role: 'backend',
      include: [],
      exclude: [],
      context_only: false,
      known_gaps: [],
    };
  });
}

function startingGroups(repos, lenses) {
  const groups = [];
  repos.forEach((r, i) => {
    const prefix = repos.length === 1 ? 'SVC' : `SVC${i + 1}`;
    const mine = lenses.filter((l) => l !== 'frontend');
    for (const lens of mine.length ? mine : lenses) {
      groups.push({
        key: `${prefix}-${LENS_KEY[lens] || lens.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`,
        repo: r.name,
        lens,
        scope: `The whole ${r.name} repo for now; narrow this to the folders one hunter can read in depth.`,
        focus: LENS_FOCUS[lens] || `What the ${lens} lens file asks for.`,
        maps: [`${r.name}-map.md`],
      });
    }
  });
  return groups;
}

// One starting modules rule per repo, by role, so recommend has modules to
// plan for: a backend (or other) repo groups files by the first folder under
// src/, a front-end repo by the folder under src/pages, src/features or
// src/components; an infra repo gets none. Module ids are <repo>.<folder>.
const MODULE_RULES = {
  backend: '^src/([^/]+)/',
  other: '^src/([^/]+)/',
  frontend: '^src/(?:pages|features|components)/([^/]+)/',
};

function defaultModules(repos) {
  return repos.filter((r) => !r.context_only && MODULE_RULES[r.role]).map((r) => ({
    repo: r.name,
    pattern: MODULE_RULES[r.role],
    id: `${r.name}.$1`,
    label: '$1',
  }));
}

function today() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function buildConfig(opts, ws) {
  const preset = readJson(path.join(KIT_ROOT, 'config', 'presets', `${opts.preset}.json`));
  const repos = repoEntries(opts, ws);
  const lenses = preset.lenses.slice();
  const rel = path.relative(ws, SCHEMA_FILE);
  const sameRoot = process.platform !== 'win32' || path.parse(SCHEMA_FILE).root.toLowerCase() === path.parse(ws).root.toLowerCase();
  const defaults = [];
  // unit_short: the counted thing comes first in a unit ("notes in one
  // workspace", "rows per file"), so init writes the first word.
  const scale = { unit: opts.unit ? opts.unit.trim() : DEFAULT_UNIT };
  scale.unit_short = opts.unit ? scale.unit.split(/\s+/)[0] : DEFAULT_UNIT_SHORT;
  scale.target = opts.target || DEFAULT_TARGET;
  const placeholders = [];
  if (!opts.question) placeholders.push('audit.question');
  if (!opts.unit) placeholders.push('scale.unit');
  if (!opts.target) placeholders.push('scale.target');
  if (!opts.name) defaults.push('audit.name');
  const cfg = {
    $schema: sameRoot ? posix(rel) : posix(SCHEMA_FILE),
    preset: opts.preset,
    size: opts.size,
    audit: {
      name: opts.name || `${opts.preset[0].toUpperCase()}${opts.preset.slice(1)} audit of ${repos.map((r) => r.name).join(', ')}`,
      question: opts.question || DEFAULT_QUESTION[opts.preset],
      type: opts.preset,
      date: today(),
      ...(placeholders.length ? { placeholders } : {}),
    },
    kit: { root: KIT_ROOT },
    repos,
    scale,
    lenses,
    out_of_scope: ['security'],
    groups: startingGroups(repos, lenses),
    modules: defaultModules(repos),
  };
  if (!opts.rules) cfg.rules = { enabled: false };
  return { cfg, defaults: placeholders.concat(defaults) };
}

// ---------- rendering ----------

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function context(cfg, ws) {
  const sizes = readJson(path.join(KIT_ROOT, 'config', 'sizes.json'));
  const size = sizes[cfg.size];
  const range = (r) => (r.min === r.max ? `${r.min}` : `${r.min}-${r.max}`);
  const kit = posix(KIT_ROOT);
  const repoAbs = cfg.repos.map((r) => posix(path.resolve(ws, r.path)));
  const lead = cfg.models.lead;
  const launch = launchLine(cfg, repoAbs);
  const list = (items, none) => (items.length ? items.map((x) => `  - ${x}`).join('\n') : `  - ${none}`);
  const ns = cfg.agents.namespace;
  return {
    config: cfg,
    date: cfg.audit.date,
    workspace: posix(ws),
    kit_root: kit,
    kit_cmd: `node "${kit}/kit.js"`,
    launch_line: launch,
    target: fmt(cfg.scale.target),
    platform_target: cfg.scale.platform_target ? fmt(cfg.scale.platform_target) : 'not set',
    tiers: cfg.scale.tiers.map(fmt).join(', '),
    lenses: cfg.lenses.join(', '),
    out_of_scope: cfg.out_of_scope.length ? cfg.out_of_scope.join('; ') : 'nothing listed',
    known_limits: list(cfg.known_limits, 'none listed yet (add them to known_limits in audit.config.json)'),
    library_assumptions: list(cfg.library_assumptions, 'none listed yet (add them to library_assumptions in audit.config.json)'),
    rules_state: cfg.rules.enabled
      ? `on: ${cfg.rules.engine}, rule sets ${cfg.rules.sets.join(', ')}, copied into rules/`
      : 'off (rules.enabled is false)',
    size_name: cfg.size,
    size_description: size.description,
    size_guidance: `${range(size.repos)} repos, ${range(size.hunt_groups)} hunt groups, ${range(size.verify_runs)} verify run(s)`,
    repo_names: cfg.repos.map((r) => `\`${r.name}\``).join(', '),
    repos_table: ['| Repo | Role | Folder (from the workspace) | Reads | Context only |', '|---|---|---|---|---|']
      .concat(cfg.repos.map((r) => `| \`${r.name}\` | ${ROLE_LABEL[r.role] || r.role} | \`${cell(r.path)}\` | ${r.include.length ? cell(r.include.join(', ')) : 'whole repo'} | ${r.context_only ? 'yes' : 'no'} |`))
      .join('\n'),
    groups_table: ['| Group | Repo | Lens | Scope |', '|---|---|---|---|']
      .concat(cfg.groups.map((g) => `| \`${g.key}\` | \`${g.repo}\` | ${g.lens} | ${cell(g.scope)} |`))
      .join('\n'),
    models_table: ['| Role | Agent type | Model | Effort |', '|---|---|---|---|', `| Lead (this session) | - | ${lead.model} | ${lead.effort} |`]
      .concat(Object.keys(cfg.agents.types).map((role) => {
        const m = cfg.models[role];
        return `| ${role.replace('_', ' ')} | \`${ns}${cfg.agents.types[role]}\` | ${m.model} | ${m.effort} |`;
      }))
      .join('\n'),
    agent_prefix: ns || '(none: agents installed with kit install-agents)',
  };
}

function lookup(ctx, key) {
  let v = ctx;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, part)) return undefined;
    v = v[part];
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(', ');
  return undefined;
}

// Replaces every {{ key }}; unknown keys are collected, never left in place.
function render(text, ctx, label, missing) {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, key) => {
    const v = lookup(ctx, key);
    if (v === undefined) { missing.push(`${label}: {{${key}}}`); return m; }
    return v;
  });
}

// ---------- writing ----------

// Claude Code permission rules: "Bash(git push *)" matches the prefix
// followed by arguments ("Bash(git push:*)" is the older spelling of the
// same rule), so the bare command gets its own rule. Every git entry also
// gets a "git * <sub>" form, which catches "git -C <dir> push" and other
// options placed before the subcommand. A read-only search that has one of
// these words as a separate argument (git log -S push) is blocked too;
// quote the word ('push') to search for it.
function denyRules(prefixes) {
  const out = [];
  for (const raw of prefixes) {
    const p = raw.trim().replace(/\s+/g, ' ');
    if (!p) continue;
    // "node --eval=": the value is glued to the option, so no space before *.
    if (p.endsWith('=')) { out.push(`Bash(${p}*)`); continue; }
    out.push(`Bash(${p})`, `Bash(${p} *)`);
    const m = /^git (\S.*)$/.exec(p);
    if (m) out.push(`Bash(git * ${m[1]})`, `Bash(git * ${m[1]} *)`);
  }
  return [...new Set(out)];
}

// "//" anchors a rule at the file-system root. Windows paths are written in
// the POSIX form Claude Code matches against (C:\work\x -> //c/work/x).
function fileDenyRules(repoDirs) {
  const out = [];
  for (const dir of repoDirs) {
    let p = path.resolve(dir).split(path.sep).join('/');
    const drive = /^([A-Za-z]):\/(.*)$/.exec(p);
    if (drive) p = `/${drive[1].toLowerCase()}/${drive[2]}`;
    p = p.replace(/\/+$/, '');
    out.push(`Edit(/${p}/**)`, `Write(/${p}/**)`);
  }
  return out;
}

// The line that starts the lead session: lead model and effort from the
// config ("inherit" sends no --model), and read access to every repo.
function launchLine(cfg, repoDirs) {
  const lead = cfg.models.lead;
  return ['claude']
    .concat(lead.model === 'inherit' ? [] : [`--model ${lead.model}`], [`--effort ${lead.effort}`])
    .concat(repoDirs.map((p) => `--add-dir "${posix(p)}"`)).join(' ');
}

// Warnings for values init filled with a neutral default that still hold it.
// The config lists them in audit.placeholders; a listed field whose value
// has since been changed no longer warns.
function placeholderWarnings(cfg) {
  const listed = cfg && cfg.audit && Array.isArray(cfg.audit.placeholders) ? cfg.audit.placeholders : [];
  const still = {
    'audit.question': () => Object.values(DEFAULT_QUESTION).includes(cfg.audit.question),
    'scale.unit': () => Boolean(cfg.scale) && cfg.scale.unit === DEFAULT_UNIT,
    'scale.target': () => Boolean(cfg.scale) && cfg.scale.target === DEFAULT_TARGET,
  };
  return listed.filter((k) => still[k] && still[k]())
    .map((k) => `${k} still holds the default written by kit init; set the real value in audit.config.json, remove "${k}" from audit.placeholders, then run: kit init <workspace> --refresh-prompts`);
}

function plan(cfg, ctx) {
  const T = (...p) => path.join(TEMPLATES, ...p);
  const work = cfg.outputs.work_dir;
  return {
    rendered: [
      [T('workspace', 'README.md'), 'README.md'],
      [T('workspace', 'HANDOFF.md'), 'HANDOFF.md'],
      [T('reports', '01-executive-summary.md'), cfg.outputs.summary],
      [path.join(PROMPTS, 'master.md'), 'MASTER-PROMPT.md'],
      [path.join(PROMPTS, 'launcher.md'), 'LAUNCHER-PROMPT.md'],
    ],
    copied: [
      // Stored without the dot: a .gitignore holding "*" inside the kit would hide its own folder from git.
      [T('workspace', 'gitignore'), '.gitignore'],
      [T('workspace', 'work', 'run-log.json'), `${work}/run-log.json`],
      [T('workspace', 'work', 'claims.json'), `${work}/claims.json`],
      [T('workspace', 'work', 'phase3', 'master-overrides.json'), `${work}/phase3/master-overrides.json`],
    ],
    dirs: [
      cfg.outputs.docs_dir, 'rules', 'rules/results', '.claude',
      ...['args', 'phase1', 'phase2', 'phase3', 'phase3/batches', 'phase3/receipts', 'phase4', 'phase5',
        'phase6', 'phase6/recs', 'phase6/diagrams'].map((d) => `${work}/${d}`),
    ],
    ctx,
  };
}

function hasBraces(file) {
  return fs.statSync(file).size < 2 * 1024 * 1024 && fs.readFileSync(file, 'utf8').includes('{{');
}

function refuseInKit(ws) {
  if (insideReal(ws, KIT_ROOT)) {
    throw new CliError(`refused: ${ws} is inside the kit folder. Create the workspace outside the kit (for example in an "audits" folder in your home folder), so audit results can never be committed with the kit`);
  }
}

// Renders the files of a plan list; throws on an unknown placeholder.
function renderAll(list, ctx) {
  const missing = [];
  const texts = list.map(([from, to]) => [to, render(fs.readFileSync(from, 'utf8'), ctx, path.relative(KIT_ROOT, from).split(path.sep).join('/'), missing)]);
  if (missing.length) throw new CliError(`unknown placeholders in the kit templates (nothing written):\n  ${missing.join('\n  ')}`);
  return texts;
}

function run(opts, io) {
  const ws = path.resolve(opts.workspace);
  refuseInKit(ws);
  if (fs.existsSync(ws)) {
    if (!fs.statSync(ws).isDirectory()) throw new CliError(`${ws} exists and is not a folder`);
    if (fs.existsSync(path.join(ws, 'audit.config.json'))) {
      throw new CliError(`refused: ${ws} already holds an audit (audit.config.json). init is for new workspaces only and never changes an audit's state; to render MASTER-PROMPT.md and LAUNCHER-PROMPT.md again from the current config, run: kit init "${posix(ws)}" --refresh-prompts`);
    }
    if (fs.readdirSync(ws).length && !opts.force) {
      throw new CliError(`refused: ${ws} is not empty. Pick a new folder, or add --force to add the workspace files that are missing (no existing file is overwritten)`);
    }
  }

  const { cfg: raw, defaults } = buildConfig(opts, ws);
  const merged = withDefaults(raw);
  const errs = validateConfig(merged);
  if (errs.length) throw new CliError(`the config init would write is invalid:\n  ${errs.join('\n  ')}`);
  if (merged.rules.enabled) {
    for (const set of merged.rules.sets) {
      if (!fs.existsSync(path.join(KIT_ROOT, 'rules', 'semgrep', set))) throw new CliError(`rule set "${set}" is not bundled with this kit (rules/semgrep/${set})`);
    }
  }
  const ctx = context(merged, ws);
  const p = plan(merged, ctx);

  // Render everything first, so a template problem writes nothing.
  const texts = renderAll(p.rendered, ctx);
  const settings = readJson(path.join(TEMPLATES, 'workspace', 'claude-settings.json'));
  settings.permissions = settings.permissions || {};
  const repoDirs = merged.repos.map((r) => path.resolve(ws, r.path));
  settings.permissions.deny = [...new Set((settings.permissions.deny || [])
    .concat(denyRules(merged.read_only.deny_bash), fileDenyRules(repoDirs)))];

  // Only files that do not exist yet are written (this matters with --force).
  const written = [];
  const kept = [];
  fs.mkdirSync(ws, { recursive: true });
  for (const d of p.dirs) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const write = (rel, data) => {
    const f = path.join(ws, rel);
    if (fs.existsSync(f)) { kept.push(rel); return; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data, { flag: 'wx' });
    written.push(f);
  };
  write('audit.config.json', JSON.stringify(raw, null, 2) + '\n');
  for (const [to, text] of texts) write(to, text);
  for (const [from, to] of p.copied) write(to, fs.readFileSync(from, 'utf8'));
  write(path.join('.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  if (merged.rules.enabled) {
    const copyMissing = (from, to) => {
      if (fs.statSync(from).isDirectory()) {
        for (const e of fs.readdirSync(from)) copyMissing(path.join(from, e), path.join(to, e));
      } else write(path.relative(ws, to), fs.readFileSync(from));
    };
    for (const set of merged.rules.sets) copyMissing(path.join(KIT_ROOT, 'rules', 'semgrep', set), path.join(ws, 'rules', set));
    copyMissing(path.join(KIT_ROOT, 'rules', 'semgrep', 'run-tests.sh'), path.join(ws, 'rules', 'run-tests.sh'));
  }

  // Checks on what init wrote (copied rule files are kit files, not checked).
  const ruleDir = path.join(ws, 'rules') + path.sep;
  const left = written.filter((f) => !f.startsWith(ruleDir) && hasBraces(f));
  try {
    loadConfig(ws);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.out(`FAIL written config: ${e.errors.join('; ')}`);
    return 1;
  }
  if (left.length) {
    io.out(`FAIL placeholders left in: ${left.map((f) => posix(path.relative(ws, f))).join(', ')}`);
    return 1;
  }

  const size = ctx.size_guidance;
  const kitCmd = ctx.kit_cmd;
  io.out(`Workspace created: ${posix(ws)}`);
  io.out(`  preset ${merged.preset}, size ${merged.size} (${size}); lenses ${ctx.lenses}; rules ${merged.rules.enabled ? 'on' : 'off'}`);
  io.out(`  repos: ${merged.repos.map((r) => `${r.name} -> ${r.path}`).join(', ')}`);
  io.out(`  ${merged.groups.length} starting hunt groups (one per repo and lens)`);
  io.out('  config is valid; .gitignore keeps everything in the workspace out of git');
  if (kept.length) io.out(`  kept ${kept.length} existing file(s) unchanged (--force never overwrites): ${kept.map(posix).join(', ')}`);
  io.out('');
  io.out('Check in audit.config.json before you go on:');
  io.out('  - each repo\'s role: every repo was set to "backend" (use frontend, infra or other where that fits; infra repos are often context_only)');
  io.out('  - the hunt groups: each covers a whole repo; narrow scope and focus, or split them');
  io.out(`  - the module rules (modules, one per repo; the recommendations file each finding under the module its path matches): ${merged.modules.length ? merged.modules.map((m) => `${m.repo}: ${m.pattern} -> ${m.id}`).join('; ') : 'none'} (fit each pattern to the repo layout; for a front-end repo use ^src/(?:pages|features|components)/([^/]+)/)`);
  if (defaults.length) io.out(`  - these defaults: ${defaults.join(', ')} (validate and doctor warn while question, unit or target keep them)`);
  io.out('  - out_of_scope, known_limits, library_assumptions and publish.tracker');
  io.out(`  After editing, render the prompts again: ${kitCmd} init "${posix(ws)}" --refresh-prompts`);
  io.out('');
  io.out('Next steps:');
  io.out(`  1. ${kitCmd} validate "${posix(ws)}"`);
  io.out(`  2. ${kitCmd} doctor "${posix(ws)}"      (the pins check fails until step 3)`);
  io.out(`  3. ${kitCmd} pin "${posix(ws)}"         (Phase 0; then run doctor again: all required lines ok)`);
  io.out(`  4. cd "${posix(ws)}" && ${ctx.launch_line}`);
  io.out('     then run /hooks, and paste the start prompt from LAUNCHER-PROMPT.md');
  return 0;
}

// --refresh-prompts: render the two prompt files of an existing workspace
// again from its current config. Touches nothing else.
function refresh(opts, io) {
  const ws = path.resolve(opts.workspace);
  refuseInKit(ws);
  if (!fs.existsSync(path.join(ws, 'audit.config.json'))) {
    throw new CliError(`${ws} holds no audit.config.json; --refresh-prompts works on an existing workspace (create one with kit init)`);
  }
  const { config, paths } = loadConfig(ws);
  const ctx = context(config, paths.workspace);
  const list = plan(config, ctx).rendered.filter(([, to]) => to === 'MASTER-PROMPT.md' || to === 'LAUNCHER-PROMPT.md');
  const texts = renderAll(list, ctx);
  for (const [to, text] of texts) fs.writeFileSync(path.join(ws, to), text);
  io.out(`Rendered again from audit.config.json: ${texts.map(([to]) => to).join(', ')}`);
  const moved = kitRootMoved(config, paths);
  if (moved) {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf8').replace(/^\uFEFF/, ''));
    raw.kit = { ...(raw.kit || {}), root: KIT_ROOT };
    fs.writeFileSync(paths.configFile, JSON.stringify(raw, null, 2) + '\n');
    io.out(`kit.root updated in audit.config.json: ${posix(moved)} -> ${posix(KIT_ROOT)} (the running kit)`);
  }
  for (const w of placeholderWarnings(config)) io.out(`WARNING ${w}`);
  return 0;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.out('usage: node tooling/init-workspace.js <workspace> --preset <scalability|reliability|performance> --size <lite|standard|full>');
      io.out('       --repo <folder> [--repo <folder> ...] [--name <text>] [--question <text>] [--unit <text>] [--target <N>] [--no-rules] [--force]');
      io.out('   or: node tooling/init-workspace.js <workspace> --refresh-prompts');
      return 0;
    }
    return opts.refresh ? refresh(opts, io) : run(opts, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`init: ${e.errors && e.errors.length > 1 ? e.errors.join('; ') : e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { main, render, denyRules, fileDenyRules, startingGroups, defaultModules, launchLine, placeholderWarnings };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
