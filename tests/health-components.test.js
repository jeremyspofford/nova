import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as components from '../ui/js/components.js';
import { DEFAULT_LIMITS } from '../src/core/caps/index.ts';

const zero = { tokens_in: 0, tokens_out: 0, estimated_tokens: 0, unpriced_tokens: 0, usd: 0, iterations: 0 };
const view = { limits: DEFAULT_LIMITS, month: { month: '2026-11', providers: [], total: zero } };

test('work costs renders Caps totals without treating unpriced or estimated tokens as extra usage', () => {
  assert.equal(typeof components.workCosts, 'function');
  const html = components.workCosts({ view: { ...view, month: { ...view.month, total: { ...zero, tokens_in: 12000, tokens_out: 3000, estimated_tokens: 4000, unpriced_tokens: 6000, usd: 0.12 } } } });
  assert.match(html, /15,000 tokens/);
  assert.match(html, /4,000 estimated/);
  assert.match(html, /6,000 unpriced/);
  assert.match(html, /\$0\.12/);
  assert.match(html, /priced USD/);
});

test('work costs escapes provider, model, period, error and input strings without mutation', () => {
  assert.equal(typeof components.workCosts, 'function');
  const attack = '<img src=x onerror="alert(1)">';
  const input = { view: { limits: { ...DEFAULT_LIMITS, task: { ...DEFAULT_LIMITS.task, usd: attack } }, month: { month: attack, total: zero, providers: [{ ...zero, provider: attack, model: attack }] } }, state: 'save-error', error: attack };
  const before = JSON.stringify(input);
  const html = components.workCosts(input);
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
  assert.equal(JSON.stringify(input), before);
});

test('unloaded and unavailable costs cannot save; null is explicitly unlimited', () => {
  assert.equal(typeof components.workCosts, 'function');
  for (const state of ['loading', 'unavailable', 'saving']) {
    const html = components.workCosts({ view: state === 'saving' ? view : null, state });
    assert.match(html, /<button[^>]*data-save-work-limits[^>]*disabled/);
  }
  const html = components.workCosts({ view: { ...view, limits: { ...DEFAULT_LIMITS, task: { ...DEFAULT_LIMITS.task, usd: null } } } });
  assert.match(html, /name="task\.usd\.unlimited"[^>]*checked/);
  assert.match(html, /name="task\.usd"[^>]*disabled/);
  assert.match(html, /Unlimited/);
});

test('diagnostics supplies a native attachment link and no live action when unavailable', () => {
  assert.equal(typeof components.diagnosticsDownload, 'function');
  const html = components.diagnosticsDownload();
  assert.match(html, /<a[^>]*href="\/api\/v1\/diagnostics"[^>]*download/);
  assert.match(html, /Review the file before sharing/);
  const unavailable = components.diagnosticsDownload({ available: false });
  assert.ok(!unavailable.includes('href='));
  assert.match(unavailable, /disabled/);
});
