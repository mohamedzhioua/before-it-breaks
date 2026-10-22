'use strict';
/*
 * fixture-votes.js - writes tests/fixtures/data/fixture-votes-B1.json into a
 * workspace as a votes file, with each verifier check's receipt id set to
 * the receipt that `kit evidence` wrote there (receipt ids depend on the
 * fixture repo's commit, so the data file cannot hold them).
 *
 *   const { writeFixtureVotes } = require('./fixtures/fixture-votes');
 *   writeFixtureVotes(ws);                       // work/phase3/votes-B1.json
 *   writeFixtureVotes(ws, 'votes-2.json', edit); // edit(votes) before writing
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'fixture-votes-B1.json');

function fixtureVotes(ws) {
  const votes = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ws, 'work', 'phase3', 'receipts', '_index.json'), 'utf8'));
  const byId = new Map(index.candidates.map((e) => [e.id, e.receipt]));
  for (const r of votes.results) {
    if (r.kind === 'verify') r.checks.forEach((c) => { if (byId.has(c.id)) c.receipt = byId.get(c.id); });
  }
  return votes;
}

function writeFixtureVotes(ws, name, edit) {
  const votes = fixtureVotes(ws);
  if (edit) edit(votes);
  const file = path.join(ws, 'work', 'phase3', name || 'votes-B1.json');
  fs.writeFileSync(file, JSON.stringify(votes, null, 2));
  return votes;
}

module.exports = { fixtureVotes, writeFixtureVotes };
