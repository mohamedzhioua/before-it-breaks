'use strict';
/*
 * validate-config.js - check an audit workspace's audit.config.json.
 *
 * Usage:
 *   node tooling/validate-config.js [<workspace-or-file>] [--example]
 *
 *   <workspace-or-file>  workspace folder holding audit.config.json, or the
 *                        config file itself (default: current directory).
 *   --example            example-plan mode: a repo may give url + ref
 *                        instead of path, and pin may be "TODO".
 *
 * The file is completed with the kit defaults and its preset first (see
 * tooling/lib/config.js), so only what you wrote, or what the layers could
 * not fill, is reported.
 *
 * Output: `OK`, or a header line followed by one numbered error per line.
 * Exit codes: 0 valid, 1 invalid, 2 usage error or unreadable file.
 */

const path = require('path');
const { loadConfig, ConfigError } = require('./lib/config');

class CliError extends Error {}

function parseArgs(argv) {
  const opts = { example: false, target: null, help: false };
  for (const a of argv) {
    if (a === '--example') opts.example = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
    else if (opts.target !== null) throw new CliError(`only one workspace or file may be given (got ${opts.target} and ${a})`);
    else opts.target = a;
  }
  return opts;
}

function display(p) {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

function main(argv, io) {
  io = io || {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
  };
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.out('usage: node tooling/validate-config.js [<workspace-or-file>] [--example]');
      return 0;
    }
    try {
      loadConfig(opts.target || '.', { example: opts.example });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      if (e.stage !== 'validate') throw new CliError(e.errors.join('; '));
      io.out(`${display(e.file)}: ${e.errors.length} error${e.errors.length === 1 ? '' : 's'}`);
      e.errors.forEach((msg, i) => io.out(`  ${i + 1}. ${msg}`));
      return 1;
    }
    io.out('OK');
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`validate-config: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
