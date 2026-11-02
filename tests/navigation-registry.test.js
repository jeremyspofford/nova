import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredViews, missingViews } from './support/navigation-registry.js';
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
