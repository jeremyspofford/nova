import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedWords } from '../../src/runner.js';

test('the outside-content guard fails closed when the approvals registry throws', () => {
  const broken = { guardWords() { throw new Error('registry unreadable'); } };
  assert.equal(guardedWords('some_extension_tool', broken), 'take this step');
  // The one tool every connected service's actions go through is guarded through the registry: when
  // it throws, or there is none, it asks; so does home_call, the older name for Home Assistant's.
  assert.equal(guardedWords('service_call', broken), 'take this step');
  assert.equal(guardedWords('service_call', broken, 'home-assistant.service'), 'take this step');
  assert.equal(guardedWords('service_call', null), 'take this step');
  assert.equal(guardedWords('home_call', broken), 'take this step');
  assert.equal(guardedWords('home_call', null), 'take this step');
  // A step named in GUARDED keeps its own words; a registry that answers null leaves others alone.
  assert.equal(guardedWords('exec', broken), 'run a command');
  assert.equal(guardedWords('some_read_tool', { guardWords: () => null }), null);
});
