'use strict';
/*
 * make-fixture-repo.js - builds a tiny invented git repo for the tests: a
 * TypeScript "notes service" with a few planted scaling problems.
 *
 *   const { makeFixtureRepo } = require('./fixtures/make-fixture-repo');
 *   const { path, sha } = makeFixtureRepo(dir);   // dir: new or empty folder
 *
 * Planted problems:
 *   src/modules/notes/notes.repository.ts  find() on a workspace with no limit
 *   src/modules/imports/import.service.ts  awaited remote call inside a loop,
 *                                          and an offset-pagination loop
 *   src/clients/search.client.ts           axios client created without a
 *                                          timeout (axios.create, line 2)
 *   src/jobs/notify.queue.ts               queue job that keeps failed jobs
 * Each one is a shape a bundled Semgrep rule matches (tests/semgrep.test.js
 * checks that exactly those rules fire). The single commit uses a fixed author, committer and date, so the commit
 * id is the same on every machine and run.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AT = String.fromCharCode(64);
const WHEN = '2027-01-04T09:00:00+00:00';

const FILES = {
  'package.json': JSON.stringify({
    name: 'notes-service',
    version: '0.1.0',
    private: true,
    dependencies: { axios: '1.7.0', bull: '4.12.0', mongoose: '8.4.0' },
  }, null, 2) + '\n',
  'src/modules/notes/notes.repository.ts': [
    "import { NoteModel } from './note.model';",
    '',
    'export class NotesRepository {',
    '  // Every note of a workspace, in one query and one array.',
    '  async listForWorkspace(workspaceId: string) {',
    '    return NoteModel.find({ workspaceId }).lean();',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/modules/imports/import.service.ts': [
    "import { UsersClient } from '../../clients/users.client';",
    "import { NoteModel } from '../notes/note.model';",
    '',
    'export class ImportService {',
    '  constructor(private readonly usersClient: UsersClient) {}',
    '',
    '  async importRows(rows: { userId: string; body: string }[]) {',
    '    for (const row of rows) {',
    '      const owner = await this.usersClient.fetchProfile(row.userId);',
    '      await NoteModel.create({ ownerId: owner.id, body: row.body });',
    '    }',
    '  }',
    '',
    '  async reindexAll(workspaceId: string) {',
    '    let offset = 0;',
    '    for (;;) {',
    '      const batch = await NoteModel.find({ workspaceId }).skip(offset).limit(500);',
    '      if (batch.length === 0) break;',
    '      offset += 500;',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/clients/search.client.ts': [
    "import axios from 'axios';",
    "const search = axios.create({ baseURL: 'https://search.internal.example' });",
    'export async function searchNotes(query: string) {',
    "  const res = await search.get('/notes', { params: { q: query } });",
    '  return res.data;',
    '}',
    '',
  ].join('\n'),
  'src/jobs/notify.queue.ts': [
    "import Queue from 'bull';",
    '',
    "export const notifyQueue = new Queue('notifications');",
    '',
    'export function scheduleDigest(userId: string) {',
    '  return notifyQueue.add(',
    '    { userId },',
    '    { jobId: `digest-${userId}`, removeOnComplete: true, removeOnFail: false },',
    '  );',
    '}',
    '',
  ].join('\n'),
};

function git(dir, args) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: `fixture${AT}example.invalid`,
    GIT_AUTHOR_DATE: WHEN,
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: `fixture${AT}example.invalid`,
    GIT_COMMITTER_DATE: WHEN,
  };
  const res = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function makeFixtureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error(`fixture folder is not empty: ${dir}`);
  for (const [rel, text] of Object.entries(FILES)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'Notes service fixture']);
  return { path: dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

module.exports = { makeFixtureRepo, FILES };
