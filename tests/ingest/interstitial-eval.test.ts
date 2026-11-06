// The Interstitial Research templates' eval set, in CI: the manifest matches the generator; every
// outcome of both templates is covered; expected outcomes follow each template's own rule;
// placeholders only; and every case's input fits its template's declared fields. No model is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildState } from '../../src/core/decision-service/state.ts';
import { OUTBOUND_CHECK_V1, VERIFY_TRANSFER_V1 } from '../../src/core/decision-service/templates/interstitial.ts';
import { MANIFEST_FILE, QUESTIONS, buildCases, manifest } from './interstitial-eval/cases.ts';

const cases = buildCases();
const T = { [VERIFY_TRANSFER_V1.template_id]: VERIFY_TRANSFER_V1, [OUTBOUND_CHECK_V1.template_id]: OUTBOUND_CHECK_V1 };

test('the committed manifest is exactly what the generator produces', () => {
  assert.deepEqual(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')), manifest(cases));
});

test('every outcome of both templates has cases; labels name every question', () => {
  const m = manifest(cases);
  for (const o of ['use_established', 'use_hypothesis', 'quarantine', 'discard']) assert.ok(o === 'quarantine' || (m.expected[`interstitial.verify-transfer:${o}`] ?? 0) >= 1, o);
  for (const o of ['send', 'withhold']) assert.ok((m.expected[`interstitial.outbound-check:${o}`] ?? 0) >= 3, o);
  for (const c of cases) assert.deepEqual(Object.keys(c.labels), [...QUESTIONS[c.template]], c.id);
  // Quarantine is the band between: binary labels never produce it, so the eval scores it from the
  // probabilities a seat gives (0.4–0.7), not from a label.
  assert.ok(!cases.some((c) => c.expected === 'quarantine'));
});

test('placeholder people only, and every input fits its template', () => {
  const names = new Set(cases.flatMap((c) => [...JSON.stringify(c.input).matchAll(/\b[A-Z][a-z]+ Placeholder\b/g)].map((x) => x[0])));
  for (const n of names) assert.match(n, /^(Alex|Sam|Jordan|Taylor) Placeholder$/);
  assert.doesNotMatch(JSON.stringify(cases), /@|https?:\/\//);
  for (const c of cases) assert.doesNotThrow(() => buildState(T[c.template]!, c.input), c.id);
});
