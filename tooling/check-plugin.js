'use strict';
/*
 * check-plugin.js - maintainer check of the Claude Code plugin files.
 *
 * Usage:
 *   node tooling/check-plugin.js [<kit folder>]     (default: this kit)
 *
 * Checks:
 *   agents/*.md          front matter with name (equal to the file name) and
 *                        description; tools only from Read, Grep, Glob, Bash,
 *                        Write, Edit; model (if set) one of opus, sonnet,
 *                        haiku, fable, inherit or a claude-* model id; effort
 *                        (if set) one of low, medium, high, xhigh, max; a
 *                        "## Safety rules" section in the body. Every agent of
 *                        the interface contract exists.
 *   skills/<dir>/SKILL.md front matter with name (equal to <dir>) and
 *                        description. Every skill of the contract exists.
 *                        Every `${CLAUDE_PLUGIN_ROOT}/kit.js <command>` in a
 *                        skill names a command of kit.js (its COMMANDS and
 *                        GROUPS tables, subcommands included) or help.
 *   .claude-plugin/plugin.json       name (kebab-case), version (x.y.z),
 *                        description, author.name, license.
 *   .claude-plugin/marketplace.json  name, owner.name, and a plugins list
 *                        whose entries have name and source; one entry names
 *                        the plugin of plugin.json.
 *
 * The front matter reader understands one "key: value" per line (values may
 * be quoted); that is all the kit's files use.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 usage error or the
 * folder is not a kit.
 *
 * Exports: main(argv, io), checkPlugin(root) -> string[] problems,
 *   parseFrontMatter(text) -> { data, body } | null
 */

const fs = require('fs');
const path = require('path');

class CliError extends Error {}

const AGENTS = ['audit-mapper', 'audit-hunter', 'audit-rule-writer', 'audit-skeptic', 'audit-verifier', 'audit-architect', 'audit-docs-writer'];
const SKILLS = ['start-audit', 'run-phase', 'audit-status'];
const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'];
const MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'inherit'];
const MODEL_ID = /^claude-[a-z0-9.-]+$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BUILT_IN = ['help']; // handled by kit.js itself, not by a tooling file
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const KIT_CALL = /\$\{CLAUDE_PLUGIN_ROOT\}\/kit\.js"?\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;

function parseFrontMatter(text) {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return null;
  const end = t.indexOf('\n---\n', 3);
  if (end < 0) return null;
  const data = {};
  for (const line of t.slice(4, end).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) { data['(bad line)'] = line; continue; }
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    data[m[1]] = v;
  }
  return { data, body: t.slice(end + 5) };
}

function readJson(file, problems, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    problems.push(`${label}: ${e.code === 'ENOENT' ? 'missing' : `not valid JSON (${e.message})`}`);
    return null;
  }
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function checkAgent(file, problems) {
  const label = `agents/${path.basename(file)}`;
  const fm = parseFrontMatter(fs.readFileSync(file, 'utf8'));
  if (!fm) { problems.push(`${label}: no front matter (--- block at the top)`); return; }
  const d = fm.data;
  if (d['(bad line)']) problems.push(`${label}: front matter line not understood: ${d['(bad line)']}`);
  if (!nonEmpty(d.name)) problems.push(`${label}: name is required`);
  else if (d.name !== path.basename(file, '.md')) problems.push(`${label}: name "${d.name}" must match the file name`);
  if (!nonEmpty(d.description)) problems.push(`${label}: description is required`);
  if (d.tools !== undefined) {
    const list = d.tools.split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) problems.push(`${label}: tools is empty`);
    for (const t of list) if (!TOOLS.includes(t)) problems.push(`${label}: tool "${t}" is not allowed (only ${TOOLS.join(', ')})`);
  }
  if (d.model !== undefined && !MODELS.includes(d.model) && !MODEL_ID.test(d.model)) {
    problems.push(`${label}: model "${d.model}" is not one of ${MODELS.join(', ')} or a claude-* id`);
  }
  if (d.effort !== undefined && !EFFORTS.includes(d.effort)) problems.push(`${label}: effort "${d.effort}" is not one of ${EFFORTS.join(', ')}`);
  if (!/^## Safety rules\b/m.test(fm.body)) problems.push(`${label}: the body has no "## Safety rules" section`);
}

function kitCommands(root, problems) {
  try {
    const kit = require(path.join(root, 'kit.js'));
    const top = Object.keys(kit.COMMANDS || {});
    const groups = kit.GROUPS || {};
    return { top: new Set(top.concat(BUILT_IN)), groups };
  } catch (e) {
    problems.push(`kit.js: cannot be loaded (${e.message.split('\n')[0]})`);
    return null;
  }
}

function checkSkill(dir, commands, problems) {
  const name = path.basename(dir);
  const label = `skills/${name}/SKILL.md`;
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) { problems.push(`${label}: missing`); return; }
  const text = fs.readFileSync(file, 'utf8');
  const fm = parseFrontMatter(text);
  if (!fm) { problems.push(`${label}: no front matter (--- block at the top)`); return; }
  const d = fm.data;
  if (d['(bad line)']) problems.push(`${label}: front matter line not understood: ${d['(bad line)']}`);
  if (!nonEmpty(d.name)) problems.push(`${label}: name is required`);
  else if (d.name !== name) problems.push(`${label}: name "${d.name}" must match the folder name "${name}"`);
  if (!nonEmpty(d.description)) problems.push(`${label}: description is required`);
  if (!commands) return;
  for (const m of text.matchAll(KIT_CALL)) {
    const [, cmd, sub] = m;
    if (Object.prototype.hasOwnProperty.call(commands.groups, cmd)) {
      if (!sub || !Object.prototype.hasOwnProperty.call(commands.groups[cmd], sub)) {
        problems.push(`${label}: "kit.js ${[cmd, sub].filter(Boolean).join(' ')}" needs one of ${Object.keys(commands.groups[cmd]).join(', ')}`);
      }
    } else if (!commands.top.has(cmd)) {
      problems.push(`${label}: "kit.js ${cmd}" is not a kit.js command`);
    }
  }
}

function checkManifests(root, problems) {
  const plugin = readJson(path.join(root, '.claude-plugin', 'plugin.json'), problems, '.claude-plugin/plugin.json');
  if (plugin) {
    const l = '.claude-plugin/plugin.json';
    if (!nonEmpty(plugin.name) || !KEBAB.test(plugin.name)) problems.push(`${l}: name must be kebab-case`);
    if (!nonEmpty(plugin.version) || !SEMVER.test(plugin.version)) problems.push(`${l}: version must look like 1.2.3`);
    if (!nonEmpty(plugin.description)) problems.push(`${l}: description is required`);
    if (!plugin.author || !nonEmpty(plugin.author.name)) problems.push(`${l}: author.name is required`);
    if (!nonEmpty(plugin.license)) problems.push(`${l}: license is required`);
  }
  const market = readJson(path.join(root, '.claude-plugin', 'marketplace.json'), problems, '.claude-plugin/marketplace.json');
  if (market) {
    const l = '.claude-plugin/marketplace.json';
    if (!nonEmpty(market.name) || !KEBAB.test(market.name)) problems.push(`${l}: name must be kebab-case`);
    if (!market.owner || !nonEmpty(market.owner.name)) problems.push(`${l}: owner.name is required`);
    if (!Array.isArray(market.plugins) || !market.plugins.length) problems.push(`${l}: plugins must be a non-empty list`);
    else {
      market.plugins.forEach((p, i) => {
        if (!p || !nonEmpty(p.name)) problems.push(`${l}: plugins[${i}].name is required`);
        if (!p || (!nonEmpty(p.source) && (typeof p.source !== 'object' || p.source === null))) problems.push(`${l}: plugins[${i}].source is required`);
      });
      if (plugin && nonEmpty(plugin.name) && !market.plugins.some((p) => p && p.name === plugin.name)) {
        problems.push(`${l}: no plugins entry names "${plugin.name}" (the plugin of plugin.json)`);
      }
    }
  }
}

function checkPlugin(root) {
  const problems = [];
  const agentsDir = path.join(root, 'agents');
  const agentFiles = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const a of AGENTS) if (!agentFiles.includes(`${a}.md`)) problems.push(`agents/${a}.md: missing`);
  for (const f of agentFiles) checkAgent(path.join(agentsDir, f), problems);
  const commands = kitCommands(root, problems);
  const skillsDir = path.join(root, 'skills');
  const skillDirs = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  for (const s of SKILLS) if (!skillDirs.includes(s)) problems.push(`skills/${s}/SKILL.md: missing`);
  for (const s of skillDirs) checkSkill(path.join(skillsDir, s), commands, problems);
  checkManifests(root, problems);
  return problems;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const rest = [];
    for (const a of argv) {
      if (a === '--help' || a === '-h') { io.out('usage: node tooling/check-plugin.js [<kit folder>]'); return 0; }
      if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      rest.push(a);
    }
    if (rest.length > 1) throw new CliError(`unexpected argument ${rest[1]}`);
    const root = path.resolve(rest[0] || path.join(__dirname, '..'));
    if (!fs.existsSync(path.join(root, '.claude-plugin')) && !fs.existsSync(path.join(root, 'agents'))) {
      throw new CliError(`not a kit folder (no .claude-plugin/ or agents/): ${root}`);
    }
    const problems = checkPlugin(root);
    if (problems.length) {
      problems.forEach((p) => io.out(`FAIL ${p}`));
      io.out(`check-plugin: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
      return 1;
    }
    io.out(`check-plugin: ok (${AGENTS.length} agents, ${SKILLS.length} skills, 2 manifests)`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`check-plugin: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { main, checkPlugin, parseFrontMatter };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
