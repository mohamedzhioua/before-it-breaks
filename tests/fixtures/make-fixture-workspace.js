'use strict';
/*
 * make-fixture-workspace.js - lays out an invented, already-verified audit
 * workspace for the builder tests: config, pins, candidates, verdicts,
 * receipts, report inputs, claims, run log, module plans, cross-cutting
 * decisions and one diagram. No git and no repos are needed: the pins are
 * invented and the builders only read the work folder.
 *
 *   const { makeFixtureWorkspace } = require('./fixtures/make-fixture-workspace');
 *   const ws = makeFixtureWorkspace(dir);   // dir: new or empty folder
 *
 * Data: tests/fixtures/data/builders/. Eighteen candidates: twelve reported
 * (PROVEN, PROVEN-STATIC, UNPROVEN) and one each of MERGED, REFUTED,
 * REMOVED, NEEDS-REVIEW, HELD and OUT-OF-SCOPE.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data', 'builders');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(DATA, from), to);
}

function makeFixtureWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error(`fixture folder is not empty: ${dir}`);
  const work = path.join(dir, 'work');
  copy('audit.config.json', path.join(dir, 'audit.config.json'));
  for (const f of ['pins.json', 'candidates.json', 'claims.json', 'run-log.json']) copy(f, path.join(work, f));
  copy('verdicts.json', path.join(work, 'phase3', 'verdicts.json'));
  copy('receipts-index.json', path.join(work, 'phase3', 'receipts', '_index.json'));
  copy('report-inputs.json', path.join(work, 'phase5', 'report-inputs.json'));
  copy('cross-cutting.json', path.join(work, 'phase6', 'cross-cutting.json'));
  for (const f of fs.readdirSync(path.join(DATA, 'recs')).sort()) copy(path.join('recs', f), path.join(work, 'phase6', 'recs', f));
  for (const f of fs.readdirSync(path.join(DATA, 'diagrams')).sort()) copy(path.join('diagrams', f), path.join(work, 'phase6', 'diagrams', f));
  // One receipt file per index entry, so the receipt links resolve.
  const index = JSON.parse(fs.readFileSync(path.join(DATA, 'receipts-index.json'), 'utf8'));
  for (const c of index.candidates) {
    fs.writeFileSync(path.join(work, 'phase3', 'receipts', `${c.id}.md`), `receipt ${c.receipt}\n\nInvented receipt for ${c.id}.\n`);
  }
  // The module doc that a modules rule links to.
  const doc = path.join(dir, 'system-docs', 'notes-api', 'architecture.md');
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, '# notes-api architecture\n\n## Modules\n\nInvented module overview for the tests.\n');
  return dir;
}

module.exports = { makeFixtureWorkspace, DATA };
