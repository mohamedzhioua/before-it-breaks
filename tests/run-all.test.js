'use strict';
// run-all.js: a failing step names its failing tests above the tail.

const test = require('node:test');
const assert = require('node:assert/strict');
const { failures } = require('./run-all');

test('failures() returns each not ok line with its YAML block, nested ones too', () => {
  const tap = [
    'ok 1 - passes',
    'not ok 2 - top-level failure',
    '  ---',
    '  error: boom',
    '  ...',
    'ok 3 - passes too',
    '    not ok 1 - nested failure',
    '      ---',
    '      error: inner',
    '      ...',
  ].join('\n');
  const found = failures(tap);
  assert.equal(found.length, 2);
  assert.match(found[0], /^not ok 2 - top-level failure\n  ---\n  error: boom\n  \.\.\.$/);
  assert.match(found[1], /not ok 1 - nested failure[\s\S]*error: inner/);
  assert.ok(!found.join('\n').includes('ok 3 - passes too'));
});

test('failures() caps a block that never closes', () => {
  const tap = ['not ok 1 - open block', ...Array.from({ length: 50 }, (_, i) => `  line ${i}`)].join('\n');
  const [block] = failures(tap);
  assert.equal(block.split('\n').length, 20);
});

test('failures() finds nothing in a passing run', () => {
  assert.deepEqual(failures('ok 1 - a\nok 2 - b\n# fail 0'), []);
});
