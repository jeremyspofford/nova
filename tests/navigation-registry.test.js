import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredViews, registeredViewRoots, missingViews } from './support/navigation-registry.js';
import { DESTINATIONS, reachable, routeOf } from '../ui/js/nav.js';
import { readFileSync } from 'node:fs';

test('navigation model accounts for every app view, including Settings children', () => {
  const actual = registeredViews();
  assert.deepEqual(DESTINATIONS.map(d => d.id).sort(), actual);
  for (const layout of ['phone', 'tablet', 'desktop']) assert.deepEqual(reachable(layout).sort(), actual);
  for (const d of DESTINATIONS) assert.equal(routeOf(d.path).dest, d.id);
});

test('adding an app registration extends the missing-view oracle', () => {
  const source = readFileSync(new URL('../ui/js/app.js', import.meta.url), 'utf8');
  const extended = source.replace(/const VIEWS = \{/, "const VIEWS = { orphaned: 'orphaned',");
  assert.notEqual(extended, source);
  assert.deepEqual(missingViews(registeredViews(extended), registeredViews()), ['orphaned']);
});

// Root IDs must follow the same registration/el resolution the real setView uses.
test('rendered-root oracle derives DOM IDs from actual registration and element mapping', () => {
  const source = "const el = { primary: $('actual-panel'), conversation: $('chat-panel'),\n};\nconst VIEWS = { first: 'primary', chat: 'conversation' };";
  assert.deepEqual(registeredViewRoots(source), { first: 'actual-panel', chat: 'chat-panel' });
  const actual = registeredViewRoots();
  assert.equal(actual.tasks, 'tasks-view');
  assert.equal(actual.chat, 'thread');
  assert.equal(actual.settings, 'settings-view');
  assert.deepEqual(Object.keys(actual).sort(), registeredViews());
});

test('rendered-root oracle fails closed on unresolved, duplicate and uninventoried mappings', () => {
  for (const source of [
    "const el = { home: $('home'),\n};\nconst VIEWS = { home: 'missing' };",
    "const el = { home: $('home'), home: $('second'),\n};\nconst VIEWS = { home: 'home' };",
    "const el = { home: $('shared'), other: $('shared'),\n};\nconst VIEWS = { home: 'home', other: 'other' };",
    "const el = { home: findPanel('home'),\n};\nconst VIEWS = { home: 'home' };",
    "const el = { home: $('home'),\n};\nconst VIEWS = { home: 'home', home: 'home' };",
    "const el = { home: $('home'),\n};\nconst VIEWS = dynamicViews();",
  ]) assert.throws(() => registeredViewRoots(source), /inventoried|registration|mapping/);
});
