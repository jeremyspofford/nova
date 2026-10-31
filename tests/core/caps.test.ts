// Hard caps on autonomy cost (Amendment 2026-10-31-B Part 5), the core: limits and their checks,
// the spend file, a meter's ceilings per task and per day, the loop detector's weights, prices
// (local free, priced where a price exists, unpriced said so), the month per provider, the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Caps, DEFAULT_LIMITS, LOOP, SPEND_DIR, capsRoutes, signature, weightOf } from '../../src/core/index.ts';

function profile() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(s: string, k: string) => m.get(`${s}.${k}`) as T | undefined,
    set: (s: string, k: string, v: unknown) => { m.set(`${s}.${k}`, v); },
  };
}
function caps(o: { at?: () => Date; tz?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-caps-'));
  const p = profile();
  return { home, p, c: new Caps({ home, profile: p, ...(o.at ? { now: o.at } : {}), timezone: () => o.tz ?? 'UTC' }) };
}

test('defaults are conservative and set; ceilings change in plain words, null is no ceiling', () => {
  const { c } = caps();
  assert.deepEqual(c.limits(), DEFAULT_LIMITS);
  assert.deepEqual(DEFAULT_LIMITS, { task: { iterations: 24, tokens: 150_000, usd: 0.5 }, day: { iterations: 300, tokens: 1_500_000, usd: 5 } });
  assert.deepEqual(c.setLimits({ task: { tokens: 50_000 }, day: { usd: null } }).task.tokens, 50_000);
  assert.equal(c.limits().day.usd, null);
  assert.equal(c.limits().task.iterations, 24, 'what isn’t named keeps its value');
  assert.throws(() => c.setLimits({ week: {} }), /task or day/);
  assert.throws(() => c.setLimits({ task: { steps: 3 } }), /iterations, tokens or usd/);
  assert.throws(() => c.setLimits({ task: { tokens: -1 } }), /above zero/);
  assert.throws(() => c.setLimits({ task: { iterations: 2.5 } }), /whole number/);
  assert.throws(() => c.setLimits('x'), /Send/);
});

test('the loop detector: near-identical calls (case, spacing, key order, numbers) count 1, 3, 5, 7, 9', () => {
  assert.equal(signature('web_fetch', { url: 'https://example.com/a?page=2' }), signature('web_fetch', { url: ' HTTPS://example.com/a?page=37 ' }));
  assert.equal(signature('x', { a: 1, b: 'q' }), signature('x', { b: 'Q', a: 2 }));
  assert.notEqual(signature('web_fetch', { url: 'https://example.com/a' }), signature('web_fetch', { url: 'https://example.com/b' }));
  assert.notEqual(signature('read_file', { path: 'a' }), signature('web_fetch', { path: 'a' }));
  const sig = signature('exec', { command: 'ls' });
  const seen: string[] = [];
  const weights = [];
  for (let i = 0; i < 7; i++) { weights.push(weightOf(sig, seen)); seen.push(sig); }
  assert.deepEqual(weights, [1, 3, 5, 7, 9, 9, 9]);
  // Only the last LOOP.window calls count.
  const old = [sig, ...Array.from({ length: LOOP.window }, (_, i) => signature('read_file', { path: `f${'x'.repeat(i)}` }))];
  assert.equal(weightOf(sig, old), 1);
});

test('a stuck loop is stopped before its 5th identical call; varied work isn’t', () => {
  const { c } = caps();
  const m = c.meter({ task_id: 't1', session_id: 's1', capped: true });
  const loop = { name: 'web_fetch', args: { url: 'https://example.com/status' } };
  const stops = [];
  for (let i = 0; i < 6; i++) { const s = m.step(loop); stops.push(s); if (s) break; }
  assert.equal(stops.length, 5, 'four ran (1+3+5+7 = 16), the fifth (9) would make 25');
  const stop = stops[4]!;
  assert.equal(stop.scope, 'task');
  assert.equal(stop.what, 'iterations');
  assert.equal(stop.loop, true);
  assert.equal(m.spent.iterations, 16);
  assert.match(stop.words, /^Stopped at this task’s ceiling: 24 steps\./);
  assert.match(stop.words, /kept repeating/);
  assert.match(stop.words, /This task spent 16 steps, 0 tokens, \$0\.00\./);
  assert.match(stop.words, /Resuming waits for your OK in Tasks; it gets a fresh allowance \(24 steps, 150,000 tokens, \$0\.50\)/);
  // Eight different steps cost eight.
  const v = c.meter({ task_id: 't2', session_id: 's2', capped: true });
  for (let i = 0; i < 8; i++) assert.equal(v.step({ name: 'read_file', args: { path: `notes-${'abcdefgh'[i]}.md` } }), null);
  assert.equal(v.spent.iterations, 8);
  // A person's own conversation is metered, never stopped.
  const chat = c.meter({ task_id: null, session_id: 's3', capped: false });
  for (let i = 0; i < 12; i++) assert.equal(chat.step(loop), null);
});

test('tokens: reported as given, otherwise estimated (4 characters a token) and said so; stopped once over the task’s ceiling', () => {
  const { c, home } = caps();
  c.setLimits({ task: { tokens: 1000 } });
  const m = c.meter({ task_id: 't1', session_id: 's1', capped: true });
  assert.equal(m.check({ model: 'example', where: 'local' }), null);
  m.model({ provider: 'openai-compatible', model: 'example-chat:8b', where: 'local', usage: { tokens_in: 300, tokens_out: 100 }, sent: 99_999, received: 99_999 });
  assert.equal(m.spent.tokens_in + m.spent.tokens_out, 400);
  assert.equal(m.spent.estimated_tokens, 0);
  m.model({ provider: 'custom-cli', model: 'example-command', where: 'local', usage: null, sent: 2000, received: 400 });
  assert.equal(m.spent.tokens_in + m.spent.tokens_out, 400 + 500 + 100);
  assert.equal(m.spent.estimated_tokens, 600);
  const s = m.check()!;
  assert.equal(s.what, 'tokens');
  assert.match(s.words, /1,000 tokens \(600 of them estimated\)/);
  const file = join(home, SPEND_DIR, `${new Date().toISOString().slice(0, 7)}.jsonl`);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('dollars: local is free, a priced model is priced from the model manager’s table, an unpriced one is said so and held by tokens', () => {
  const { c, p } = caps();
  p.set('models', 'prices', { 'example-cloud': { usd_per_mtok_in: 3, usd_per_mtok_out: 15 } });
  assert.equal(c.price('example-local', 'local', 1e6, 1e6), 0);
  assert.equal(c.price('example-cloud', 'remote', 100_000, 10_000), 0.45);
  assert.equal(c.price('example-unknown', 'remote', 100, 100), null);
  assert.equal(c.price('example-unknown', 'remote', 100, 100, 0.12), 0.12, 'a reported cost is taken');
  const m = c.meter({ task_id: 't1', session_id: 's1', capped: true });
  assert.equal(m.check({ model: 'example-unknown', where: 'remote' }), null, 'an unpriced model isn’t refused: tokens hold it');
  m.model({ provider: 'example-cloud-provider', model: 'example-cloud', where: 'remote', usage: { tokens_in: 100_000, tokens_out: 10_000 }, sent: 0, received: 0 });
  m.model({ provider: 'example-cloud-provider', model: 'example-cloud', where: 'remote', usage: { tokens_in: 20_000, tokens_out: 1_000 }, sent: 0, received: 0 });
  const s = m.check()!;
  assert.equal(s.what, 'usd');
  assert.match(s.words, /ceiling: \$0\.50\. This task spent 0 steps, 131,000 tokens, \$0\.53\./);
  const u = c.meter({ task_id: 't2', session_id: 's2', capped: true });
  u.model({ provider: 'example-other', model: 'example-unknown', where: 'remote', usage: { tokens_in: 10, tokens_out: 5 }, sent: 0, received: 0 });
  assert.equal(u.spent.unpriced_tokens, 15);
});

test('the day’s ceiling holds across tasks (in the person’s timezone), and a person’s conversation doesn’t count against it', () => {
  let now = new Date('2026-10-31T22:30:00.000Z');
  const { c } = caps({ at: () => now, tz: 'Europe/Lisbon' });
  c.setLimits({ day: { tokens: 1000 } });
  c.meter({ task_id: null, session_id: 'chat', capped: false }).model({ provider: 'p', model: 'm', where: 'local', usage: { tokens_in: 5000, tokens_out: 0 }, sent: 0, received: 0 });
  assert.equal(c.day().tokens_in, 0);
  const a = c.meter({ task_id: 'a', session_id: 'sa', capped: true });
  a.model({ provider: 'p', model: 'm', where: 'local', usage: { tokens_in: 600, tokens_out: 0 }, sent: 0, received: 0 });
  const b = c.meter({ task_id: 'b', session_id: 'sb', capped: true });
  assert.equal(b.check(), null);
  b.model({ provider: 'p', model: 'm', where: 'local', usage: { tokens_in: 500, tokens_out: 0 }, sent: 0, received: 0 });
  const stop = c.meter({ task_id: 'c', session_id: 'sc', capped: true }).check()!;
  assert.equal(stop.scope, 'day');
  assert.match(stop.words, /^Stopped at today’s ceiling for all tasks: 1,000 tokens\. Today’s tasks spent 0 steps, 1,100 tokens/);
  assert.match(stop.words, /starts again at midnight/);
  // Midnight in Lisbon (UTC+0 in winter): a new day.
  now = new Date('2026-11-01T00:30:00.000Z');
  assert.equal(c.meter({ task_id: 'd', session_id: 'sd', capped: true }).check(), null);
});

test('the month per provider and model, conversations and reported usage included; the view and the routes', async () => {
  const { c, p } = caps();
  p.set('models', 'prices', { 'example-cloud': { usd_per_mtok_in: 1, usd_per_mtok_out: 1 } });
  c.meter({ task_id: null, session_id: 'chat', capped: false }).model({ provider: 'openai-compatible', model: 'example-chat:8b', where: 'local', usage: null, sent: 400, received: 40 });
  c.meter({ task_id: 't', session_id: 's', capped: true }).model({ provider: 'openai-compatible', model: 'example-chat:8b', where: 'local', usage: { tokens_in: 1000, tokens_out: 100 }, sent: 0, received: 0 });
  c.report({ task_id: 'p1', provider: 'claude-code', model: 'example-cloud', where: 'remote', tokens_in: 500_000, tokens_out: 500_000 });
  const mo = c.month();
  assert.deepEqual(mo.providers.map((x) => [x.provider, x.model, x.calls, x.tokens_in + x.tokens_out, x.usd]), [['claude-code', 'example-cloud', 1, 1_000_000, 1], ['openai-compatible', 'example-chat:8b', 2, 100 + 10 + 1100, 0]]);
  assert.equal(mo.total.estimated_tokens, 110);
  assert.equal(mo.words, 'This month: 1,001,210 tokens (110 estimated), $1.00.');
  assert.equal(c.day().usd, 1, 'reported usage counts toward the day');
  const [get, put] = capsRoutes(c);
  assert.equal(`${get!.method} ${get!.path} ${put!.method} ${put!.path}`, 'GET /caps PUT /caps/limits');
  const v = await get!.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: {} as never }) as ReturnType<Caps['view']>;
  assert.deepEqual(v.defaults, DEFAULT_LIMITS);
  assert.equal(v.month.providers.length, 2);
  const r = await put!.handle({ params: {}, query: new URLSearchParams(), body: { day: { iterations: 100 } }, headers: {}, who: {} as never }) as { limits: { day: { iterations: number } } };
  assert.equal(r.limits.day.iterations, 100);
});
