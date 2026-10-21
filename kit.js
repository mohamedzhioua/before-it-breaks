#!/usr/bin/env node
'use strict';
// kit.js - one entry point for every kit tool: `node kit.js <command> [args]`.
// Each command runs one file in tooling/ with the remaining arguments; the
// workspace folder is the first positional argument of each tool (default:
// the current folder). `node kit.js help` lists the commands.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const T = (f) => path.join(__dirname, 'tooling', f);
const COMMANDS = {
  init: [T('init-workspace.js'), 'create a workspace from a preset'],
  doctor: [T('doctor.js'), 'check tools, config, repos and pins'],
  pin: [T('pin.js'), 'Phase 0: record the commit of every repo'],
  args: [T('workflow-args.js'), 'print the args of one workflow run (args <phase> [--run N])'],
  batches: [T('split-batches.js'), 'split candidates into verify batches and runs'],
  evidence: [T('run-evidence.js'), 're-run evidence commands into receipts (an allowlist, NOT a sandbox)'],
  synthesize: [T('synthesize-verdicts.js'), 'votes + verifier + receipts -> verdicts'],
  validate: [T('validate-config.js'), 'check audit.config.json'],
  'install-agents': [T('install-agents.js'), 'copy the agent files into a workspace (no plugin)'],
  save: [T('save-result.js'), 'check a workflow result and save it (save <phase> <result-file>)'],
  log: [T('record-run.js'), 'add an entry to work/run-log.json (log <phase> --agents N ...)'],
};
const GROUPS = {
  build: {
    log: T('build-verification-log.js'), report: T('build-report.js'), measurements: T('build-measurements.js'),
    recommendations: T('build-recommendations.js'), issues: T('build-issues.js'), explorer: T('build-explorer-data.js'),
  },
  check: {
    links: T('check-links.js'), mermaid: T('check-mermaid.mjs'), unchanged: T('check-unchanged.js'),
    secrets: T('scan-secrets.js'), workflows: T('check-workflows.js'), clean: T('check-clean.js'),
  },
};
const GROUP_HELP = { build: 'build an output document', check: 'run a check' };

function help(write) {
  write('usage: node kit.js <command> [arguments]\n\ncommands:');
  for (const [name, [, text]] of Object.entries(COMMANDS)) write(`  ${name.padEnd(16)}${text}`);
  for (const [name, subs] of Object.entries(GROUPS)) {
    write(`  ${`${name} <${Object.keys(subs).join('|')}>`}`);
    write(`  ${''.padEnd(16)}${GROUP_HELP[name]}`);
  }
  write(`  ${'help'.padEnd(16)}show this list`);
}

function main(argv) {
  const out = (s) => process.stdout.write(s + '\n');
  const err = (s) => process.stderr.write(s + '\n');
  const [cmd, ...rest] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { help(out); return 0; }
  if (!cmd) { help(err); return 2; }
  let file;
  let args = rest;
  if (Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    file = COMMANDS[cmd][0];
  } else if (Object.prototype.hasOwnProperty.call(GROUPS, cmd)) {
    const sub = rest[0];
    if (!sub || !Object.prototype.hasOwnProperty.call(GROUPS[cmd], sub)) {
      err(`kit: ${cmd} needs one of: ${Object.keys(GROUPS[cmd]).join(', ')}`);
      return 2;
    }
    file = GROUPS[cmd][sub];
    args = rest.slice(1);
  } else {
    err(`kit: unknown command "${cmd}" (see: node kit.js help)`);
    return 2;
  }
  if (!fs.existsSync(file)) {
    err(`kit: "${[cmd, args === rest ? '' : rest[0]].join(' ').trim()}" is not available in this version`);
    return 2;
  }
  const res = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (res.error) { err(`kit: could not start ${path.basename(file)} (${res.error.message})`); return 2; }
  return res.status === null ? 1 : res.status;
}
module.exports = { main, COMMANDS, GROUPS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
