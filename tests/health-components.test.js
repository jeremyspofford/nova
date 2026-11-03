import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as components from '../ui/js/components.js';
import { begin, over } from '../ui/js/wait.js';
import { DEFAULT_LIMITS } from '../src/core/caps/index.ts';

const zero = { tokens_in: 0, tokens_out: 0, estimated_tokens: 0, unpriced_tokens: 0, usd: 0, iterations: 0 };
const accounting = { scope: 'this-node-runner', provider_reports_included: false, words: 'Nova runner usage on this machine; provider-managed tasks are not included. Autonomous runner work is live capped; your own conversations are metered without caps. Provider-owned loops are not live capped. Spend on other nodes is not included. Estimated tokens and tokens without a price are labeled separately; this is not complete monthly billing.' };
const view = { accounting, limits: DEFAULT_LIMITS, month: { month: '2026-11', providers: [], total: zero } };

test('work costs renders Caps totals without treating unpriced or estimated tokens as extra usage', () => {
  assert.equal(typeof components.workCosts, 'function');
  const html = components.workCosts({ view: { ...view, month: { ...view.month, total: { ...zero, tokens_in: 12000, tokens_out: 3000, estimated_tokens: 4000, unpriced_tokens: 6000, usd: 0.12 } } } });
  assert.match(html, /15,000 tokens/);
  assert.match(html, /4,000 estimated/);
  assert.match(html, /6,000 unpriced/);
  assert.match(html, /\$0\.12/);
  assert.match(html, /priced USD/);
  const compact = html.split('<details')[0];
  const details = html.split('<details')[1];
  assert.match(compact, /Nova runner usage on this machine; provider-managed tasks are not included\./);
  assert.match(details, /Nova runner usage on this machine; provider-managed tasks are not included\./);
  assert.match(details, /Provider-owned loops are not live capped\./);
  assert.doesNotMatch(html, /Provider usage appears only when reported|reported usage is counted afterward/);
});

test('work costs escapes provider, model, period, error and input strings without mutation', () => {
  assert.equal(typeof components.workCosts, 'function');
  const attack = '<img src=x onerror="alert(1)">';
  const input = { view: { accounting: { ...accounting, words: attack }, limits: { ...DEFAULT_LIMITS, task: { ...DEFAULT_LIMITS.task, usd: attack } }, month: { month: attack, total: zero, providers: [{ ...zero, provider: attack, model: attack }] } }, state: 'save-error', error: attack };
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

// Waiting HTML intentionally reads the shared clock/history. Pin the clock rather than claiming
// byte-purity across wall time; both request keys retain the caller's actual start on redraw.
test('work costs loading and saving use the retained shared wait clock', (t) => {
  t.mock.method(Date, 'now', () => 10_000);
  begin('health-costs', 10_000);
  const first = components.workCosts({ state: 'loading' });
  assert.match(first, /data-waiting="health-costs" data-since="10000"/);
  assert.doesNotMatch(first, /waiting is-late/);
  t.mock.method(Date, 'now', () => 15_000);
  const redrawn = components.workCosts({ state: 'loading' });
  assert.match(redrawn, /class="waiting is-late"[^>]*data-waiting="health-costs" data-since="10000"/);
  begin('health-costs-save', 15_000);
  const saving = components.workCosts({ view, state: 'saving' });
  assert.match(saving, /data-waiting="health-costs-save" data-since="15000"/);
  assert.match(saving, /Saving limits/);
  over('health-costs'); over('health-costs-save');
});
