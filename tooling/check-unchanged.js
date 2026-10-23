'use strict';
/*
 * check-unchanged.js - done criterion: every repo is still at its pinned
 * commit and its working tree is untouched.
 *
 * Usage:
 *   node tooling/check-unchanged.js [<workspace>]
 *
 * For every repo in the config that has a path: HEAD must equal the commit
 * in <work>/pins.json and `git status --porcelain` must be empty. A repo
 * pinned with --allow-dirty must show exactly the uncommitted changes it had
 * when pinned. Before git runs, each repo's .git folder gets the check of
 * kit pin (lib/git-env.js gitDirCheck); a refused folder is a failure,
 * unless pins.json records trust_git_dir for that repo; then the folder
 * fails when its digest differs from git_dir_digest, or none was recorded.
 *
 * Exit codes: 0 all unchanged, 1 a repo moved or changed, 2 usage, config or
 * missing pins.
 *
 * Export: compareToPins(config, paths, pins) -> [{ repo, ok, problem }]
 */

const { loadConfig, ConfigError } = require('./lib/config');
const { repoState, readPins } = require('./pin');
const { gitDirCheck, gitDirDrift } = require('./lib/git-env');

class CliError extends Error {}

function compareToPins(config, paths, pins) {
  const out = [];
  for (const r of config.repos) {
    if (typeof r.path !== 'string') continue;
    const pin = pins.repos[r.name];
    if (!pin) {
      out.push({ repo: r.name, ok: false, problem: 'not in pins.json (run `kit pin` again)' });
      continue;
    }
    // The .git check of kit pin, again, before git runs (a repo pinned
    // with --trust-git-dir fails when its .git folder changed since).
    const chk = gitDirCheck(paths.repos[r.name]);
    if (chk.notRepo) {
      out.push({ repo: r.name, ok: false, problem: `not a git repository: ${paths.repos[r.name]}` });
      continue;
    }
    if (pin.trust_git_dir) {
      const drift = gitDirDrift(pin, chk);
      if (drift) {
        out.push({ repo: r.name, ok: false, problem: drift });
        continue;
      }
    } else if (chk.problems.length) {
      out.push({ repo: r.name, ok: false, problem: `.git folder refused (git not run): ${chk.problems.join('; ')}` });
      continue;
    }
    let st;
    try {
      st = repoState(paths.repos[r.name]);
    } catch (e) {
      out.push({ repo: r.name, ok: false, problem: e.message });
      continue;
    }
    const problems = [];
    if (st.sha !== pin.sha) problems.push(`HEAD is ${st.short}, pinned ${pin.short}`);
    if (pin.porcelain > 0) {
      if (st.changes_sha256 !== pin.changes_sha256) problems.push('uncommitted changes differ from the ones recorded at pin time');
    } else if (st.porcelain > 0) {
      problems.push(`${st.porcelain} uncommitted change${st.porcelain === 1 ? '' : 's'}`);
    }
    out.push({ repo: r.name, ok: problems.length === 0, problem: problems.join('; '), short: pin.short });
  }
  return out;
}

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  try {
    const pos = [];
    for (const a of argv) {
      if (a === '--help' || a === '-h') {
        io.out('usage: node tooling/check-unchanged.js [<workspace>]');
        return 0;
      }
      if (a.startsWith('-')) throw new CliError(`unknown option ${a}`);
      pos.push(a);
    }
    if (pos.length > 1) throw new CliError('only one workspace may be given');
    const { config, paths } = loadConfig(pos[0] || '.');
    const results = compareToPins(config, paths, readPins(paths));
    for (const r of results) io.out(r.ok ? `ok   ${r.repo} at ${r.short}, clean` : `FAIL ${r.repo}: ${r.problem}`);
    const bad = results.filter((r) => !r.ok).length;
    io.out(bad ? `${bad} of ${results.length} repos changed since the pin` : `all ${results.length} repos unchanged since the pin`);
    return bad ? 1 : 0;
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError) {
      io.err(`check-unchanged: ${e.message}`);
      if (e instanceof ConfigError && e.errors.length > 1) e.errors.forEach((m) => io.err(`  - ${m}`));
      return 2;
    }
    throw e;
  }
}

module.exports = { main, compareToPins };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
