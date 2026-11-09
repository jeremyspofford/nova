import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedWords } from '../../src/runner.js';

test('the outside-content guard fails closed when the approvals registry throws', () => {
  const broken = { guardWords() { throw new Error('registry unreadable'); } };
  assert.equal(guardedWords('some_extension_tool', broken), 'take this step');
  // A step named in GUARDED keeps its own words; a registry that answers null leaves others alone.
  assert.equal(guardedWords('home_call', broken), 'change your home');
  assert.equal(guardedWords('some_read_tool', { guardWords: () => null }), null);
});
