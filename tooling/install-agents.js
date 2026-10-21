'use strict';
/*
 * install-agents.js - copy the kit's agent definitions into a workspace, for
 * people who use the kit without installing the Claude Code plugin.
 *
 * Usage:
 *   node tooling/install-agents.js [<workspace>] [--force]
 *
 * Copies every agents/*.md file of the kit into <workspace>/.claude/agents/
 * (created if needed). A file there that is identical to the kit's is left
 * as it is; one that differs (edited by hand, or from another kit version)
 * is only replaced with --force. Without it the tool copies nothing, lists
 * those files and exits 1. Nothing else is changed. Agents installed this way are project agents, so their types
 * have no plugin prefix: set "agents": { "namespace": "" } in
 * audit.config.json. The tool says so, and warns when the config in the
 * workspace still has another namespace.
 *
 * Exit codes: 0 copied, 1 a changed file would be replaced (no --force),
 * 2 usage, workspace not found or no agent files.
 *
 * Exports: main(argv, io), installAgents(workspace, { kitRoot, force })
 *   -> [file]   (throws ChangedError with .files when a changed file
 *   would be replaced without force)
 */

const fs = require('fs');
const path = require('path');

class CliError extends Error {}
class ChangedError extends Error {
  constructor(files) {
    super(`${files.length} agent file${files.length === 1 ? '' : 's'} in the workspace differ from the kit's; re-run with --force to replace them`);
    this.files = files;
  }
}

const KIT_ROOT = path.join(__dirname, '..');

function installAgents(workspace, opts) {
  const kitRoot = (opts && opts.kitRoot) || KIT_ROOT;
  const ws = path.resolve(workspace || '.');
  if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) throw new CliError(`workspace not found: ${ws}`);
  const src = path.join(kitRoot, 'agents');
  const names = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith('.md')).sort() : [];
  if (!names.length) throw new CliError(`no agent files found in ${src}`);
  const dest = path.join(ws, '.claude', 'agents');
  const changed = names.filter((n) => {
    const to = path.join(dest, n);
    return fs.existsSync(to) && !fs.readFileSync(to).equals(fs.readFileSync(path.join(src, n)));
  });
  if (changed.length && !(opts && opts.force)) throw new ChangedError(changed.map((n) => path.join(dest, n)));
  fs.mkdirSync(dest, { recursive: true });
  return names.map((n) => {
    const to = path.join(dest, n);
    fs.copyFileSync(path.join(src, n), to);
    return to;
  });
}

// The namespace the workspace config asks for, or undefined when unknown.
function configuredNamespace(ws) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'audit.config.json'), 'utf8').replace(/^﻿/, ''));
    if (cfg && cfg.agents && typeof cfg.agents.namespace === 'string') return cfg.agents.namespace;
    return cfg ? null : undefined; // null: config present, default namespace in use
  } catch (e) {
    return undefined;
  }
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const rest = [];
    let force = false;
    for (const a of argv) {
      if (a === '--help' || a === '-h') { io.out('usage: node tooling/install-agents.js [<workspace>] [--force]'); return 0; }
      if (a === '--force') { force = true; continue; }
      if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      rest.push(a);
    }
    if (rest.length > 1) throw new CliError(`unexpected argument ${rest[1]}`);
    const ws = path.resolve(rest[0] || '.');
    const files = installAgents(ws, { force });
    files.forEach((f) => io.out(`copied ${f}`));
    io.out(`${files.length} agent files installed in ${path.join(ws, '.claude', 'agents')}`);
    io.out('note: agents installed this way have no plugin prefix; set "agents": { "namespace": "" } in audit.config.json');
    const ns = configuredNamespace(ws);
    if (ns !== undefined && ns !== '') {
      io.out(`warning: audit.config.json still uses the namespace ${ns === null ? 'default ("before-it-breaks:")' : `"${ns}"`}; agent types will not resolve until it is ""`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ChangedError) {
      io.err(`install-agents: ${e.message}; nothing was copied`);
      e.files.forEach((f) => io.err(`  - ${f}`));
      return 1;
    }
    if (e instanceof CliError) {
      io.err(`install-agents: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { main, installAgents, ChangedError };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
