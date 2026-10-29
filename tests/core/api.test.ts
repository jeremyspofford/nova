import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createApi, HOOK_ROUTE } from '../../src/core/api.ts';
import { sampleManifest } from './fixtures.ts';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-api-'));
  const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0 };
  const nova = createNova(config);
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-nova': '1' }) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const stop = async () => { nova.server.close(); await nova.core.close(); };
  return { nova, home, base, call, stop };
}

test('the OpenAPI document lists every route the core serves', async () => {
  const { nova, call, stop } = await boot();
  const { status, body } = await call('GET', '/openapi.json');
  assert.equal(status, 200);
  assert.equal(body.openapi, '3.1.0');
  for (const r of nova.core.routes) assert.ok(body.paths[`/api/v1${r.path}`]?.[r.method.toLowerCase()], `${r.method} ${r.path}`);
  assert.ok(body.paths['/api/v1/events']);
  await stop();
});

test('changes need Nova’s own header; unknown paths and methods are refused plainly', async () => {
  const { call, stop } = await boot();
  assert.equal((await call('POST', '/setup/messages', { text: 'Sam' }, {})).status, 403);
  assert.equal((await call('POST', '/setup/messages', { text: 'Sam' }, { 'x-nova': '1', origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('DELETE', '/health')).status, 405);
  const bad = await call('POST', '/tasks', { title: 'x', owner: 'workspace', goal: 'g', evidence_required: [] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /evidence/);
  await stop();
});

test('health reports each part in plain words', async () => {
  const { call, stop } = await boot();
  const { body } = await call('GET', '/health');
  assert.equal(body.ok, true);
  assert.equal(body.setup.done, false);
  assert.equal(body.checks.database.ok, true);
  assert.match(body.checks.database.detail, /Schema version \d+/);
  assert.equal(body.checks.workers.workers[0].id, 'workspace');
  assert.equal(body.checks.workers.workers[0].egress, 'none');
  await stop();
});

test('a task delegated over the API is done, with its evidence and its event trail, and the stream saw it', async () => {
  const { base, call, stop } = await boot();
  const seen: string[] = [];
  const ac = new AbortController();
  const sse = fetch(`${base}/events`, { signal: ac.signal }).then(async (res) => {
    const reader = res.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const m of new TextDecoder().decode(value).matchAll(/"state":"(\w+)"/g)) seen.push(m[1]!);
    }
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const created = await call('POST', '/tasks', {
    title: 'Save a shopping list', owner: 'workspace', goal: 'The list is saved in the workspace.',
    evidence_required: [{ kind: 'read_back', target: 'workspace:lists/shopping.md' }],
    inputs: { action: 'write', path: 'lists/shopping.md', content: '- bread\n' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.origin, { kind: 'user' });
  let task = created.body;
  for (let i = 0; i < 50 && !['done', 'failed'].includes(task.state); i++) {
    await new Promise((r) => setTimeout(r, 20));
    task = (await call('GET', `/tasks/${task.id}`)).body;
  }
  assert.equal(task.state, 'done', task.reason);
  assert.equal(task.verification.ok, true);
  const events = (await call('GET', `/tasks/${task.id}/events`)).body;
  assert.deepEqual(events.map((e: { kind: string }) => e.kind), ['created', 'dispatched', 'reported', 'verifying', 'verified']);
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await sse;
  assert.ok(seen.includes('done'), `stream saw: ${seen.join(',')}`);
  await stop();
});

test('settings and setup write the same profile records', async () => {
  const { call, stop } = await boot();
  await call('GET', '/setup');
  await call('POST', '/setup/messages', { text: 'Sam' });
  const put = await call('PUT', '/profile/tuning/directness', { value: 'gentle' });
  assert.deepEqual(put.body, { directness: 'gentle' });
  const profile = (await call('GET', '/profile')).body;
  assert.equal(profile.user.name, 'Sam');
  assert.equal(profile.tuning.directness, 'gentle');
  assert.equal((await call('PUT', '/profile/setup/state', { value: {} })).status, 400, 'setup’s working state is not a setting');
  const identity = (await call('GET', '/identity')).body;
  assert.match(identity.rendered, /working for Sam/);
  assert.match(identity.rendered, /Say hard things kindly/);
  await stop();
});

test('extensions install disabled, enable with an OK, and remove without residue', async () => {
  const { call, stop, nova } = await boot();
  const installed = await call('POST', '/extensions', { manifest: sampleManifest() });
  assert.equal(installed.status, 201);
  assert.equal(installed.body.extension.state, 'installed');
  assert.equal((await call('POST', '/extensions/example.weather/enable', {})).status, 403);
  assert.equal((await call('POST', '/extensions/example.weather/enable', { approved: true })).body.state, 'enabled');
  const removed = await call('DELETE', '/extensions/example.weather');
  assert.equal(removed.status, 200);
  assert.deepEqual((await call('GET', '/extensions')).body, []);
  assert.deepEqual(readdirSync(nova.core.extensions.root), []);
  await stop();
});

test('an unexpected error answers 500 and is recorded as a problem, not only logged', async () => {
  const problems: unknown[] = [];
  const api = createApi({
    routes: [{ method: 'GET', path: '/boom', summary: 'x', handle: () => { throw new Error('kaboom'); } }],
    stream: { on: () => () => {} }, version: '0', trustedOrigin: () => true, onError: (e) => problems.push(e),
  });
  const server: Server = createServer((req, res) => void api.handle(req, res, new URL(req.url!, 'http://x')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/boom`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /recorded as a problem/);
  assert.equal(problems.length, 1);
  server.close();
});

const noteAction = (path: string) => ({
  kind: 'task',
  task: { title: 'Note the event', owner: 'workspace', goal: 'The event is noted.', evidence_required: [{ kind: 'read_back', target: `workspace:${path}` }], inputs: { action: 'write', path, content: 'event\n' } },
});

test('webhooks are the one route outside the X-Nova guard, and they check their own token', async () => {
  const { call, stop } = await boot();
  const created = await call('POST', '/triggers/rules', { name: 'Example events', class: 'event', hook: 'example', action: noteAction('notes/hook.md') });
  assert.equal(created.status, 201);
  const token: string = created.body.token;
  assert.ok(token);
  assert.equal(created.body.rule.hook_path, '/api/v1/hooks/example');

  assert.equal((await call('POST', '/hooks/example', { n: 1 }, {})).status, 403, 'no token');
  assert.equal((await call('POST', '/hooks/example', { n: 1 }, { 'x-nova-hook-token': 'wrong' })).status, 403, 'wrong token');
  assert.equal((await call('POST', '/hooks/example', { n: 1 }, { 'x-nova': '1' })).status, 403, 'X-Nova is not a hook token');
  assert.equal((await call('POST', '/hooks/nothing', { n: 1 }, { 'x-nova-hook-token': token })).status, 404, 'unknown hook');

  const fired = await call('POST', '/hooks/example', { n: 1 }, { 'x-nova-hook-token': token, origin: 'http://automation.example' });
  assert.equal(fired.status, 202);
  assert.equal(fired.body.decision, 'act');
  const record = (await call('GET', `/triggers/${fired.body.trigger_id}`)).body;
  assert.ok(record.ledger_task_id);
  assert.deepEqual((await call('GET', `/tasks/${record.ledger_task_id}`)).body.origin, { kind: 'trigger', ref: record.trigger_id });

  const again = await call('POST', '/hooks/example', { n: 1 }, { 'x-nova-hook-token': token });
  assert.equal(again.body.decision, 'drop', 'the same event twice is deduped');

  await call('POST', `/triggers/rules/${created.body.rule.id}/pause`);
  const paused = await call('POST', '/hooks/example', { n: 2 }, { 'x-nova-hook-token': token });
  assert.equal(paused.status, 202);
  assert.equal(paused.body.decision, 'drop');
  const listed = (await call('GET', `/triggers?rule=${created.body.rule.id}`)).body;
  assert.equal(listed.length, 3);
  assert.match(listed[0].triage.reason, /paused/);

  // Other changes still need X-Nova.
  assert.equal((await call('POST', `/triggers/rules/${created.body.rule.id}/resume`, {}, { 'x-nova-hook-token': token })).status, 403);
  await stop();
});

test('the guard exemption is explicit: only the webhook route has it, and no other route can claim it', async () => {
  const { nova, stop } = await boot();
  const exempt = nova.core.routes.filter((r) => r.auth);
  assert.deepEqual(exempt.map((r) => `${r.method} ${r.path}`), [`${HOOK_ROUTE.method} ${HOOK_ROUTE.path}`]);
  assert.throws(() => createApi({
    routes: [{ method: 'POST', path: '/tasks', summary: 'x', auth: 'hook-token', handle: () => null }],
    stream: { on: () => () => {} }, version: '0', trustedOrigin: () => true, onError: () => {},
  }), /can't skip the X-Nova guard/);
  await stop();
});

test('the trigger registry over the API: add, edit, pause, remove; tokens never listed; tasks you delegate are reactive triggers', async () => {
  const { call, stop } = await boot();
  const beat = await call('POST', '/triggers/rules', { name: 'Mornings', class: 'heartbeat', cron: '0 7 * * 1-5', action: noteAction('notes/morning.md') });
  assert.equal(beat.status, 201);
  assert.equal(beat.body.token, undefined);
  assert.equal(beat.body.rule.schedule, 'Weekdays at 7:00 AM');
  const hook = (await call('POST', '/triggers/rules', { name: 'Example events', class: 'event', hook: 'example', action: noteAction('notes/hook.md') })).body;
  assert.equal((await call('POST', '/triggers/rules', { name: 'Bad', class: 'heartbeat', cron: 'whenever', action: noteAction('x.md') })).status, 400);

  const rules = (await call('GET', '/triggers/rules')).body;
  assert.equal(rules.length, 2);
  assert.equal(JSON.stringify(rules).includes(hook.token), false);
  assert.equal(JSON.stringify(rules).includes('hash'), false);

  assert.equal((await call('PUT', `/triggers/rules/${beat.body.rule.id}`, { cron: '30 8 * * *' })).body.schedule, 'Every day at 8:30 AM');
  assert.equal((await call('POST', `/triggers/rules/${beat.body.rule.id}/pause`)).body.paused, true);
  assert.equal((await call('POST', `/triggers/rules/${beat.body.rule.id}/resume`)).body.paused, false);
  assert.equal((await call('DELETE', `/triggers/rules/${beat.body.rule.id}`)).status, 200);
  assert.equal((await call('GET', `/triggers/rules/${beat.body.rule.id}`)).status, 404);

  const msg = (await call('POST', '/triggers/rules', { name: 'Check-in', class: 'proactive', action: { kind: 'message', text: 'A reminder you asked for.' } })).body.rule;
  const fired = await call('POST', `/triggers/rules/${msg.id}/fire`, {});
  assert.equal(fired.body.triage.decision, 'act');
  const [message] = (await call('GET', '/messages')).body;
  assert.equal(message.text, 'A reminder you asked for.');
  const origin = (await call('GET', `/triggers/${message.trigger_id}`)).body;
  assert.equal(origin.message_id, message.id);
  assert.equal(origin.class, 'proactive');
  assert.ok((await call('POST', `/messages/${message.id}/read`)).body.read_at);

  const task = (await call('POST', '/tasks', { title: 'Save a list', owner: 'workspace', goal: 'g', evidence_required: [{ kind: 'read_back', target: 'workspace:l.md' }], inputs: { action: 'write', path: 'l.md', content: 'x' } })).body;
  const reactive = (await call('GET', '/triggers')).body.find((t: { class: string }) => t.class === 'reactive');
  assert.equal(reactive.ledger_task_id, task.id);

  const health = (await call('GET', '/health')).body;
  assert.equal(health.checks.triggers.counts.rules, 2);
  assert.ok(health.checks.triggers.counts.triggers >= 2);
  await stop();
});

test('the test clock route exists only when NOVA_TEST_CLOCK=1', async () => {
  const plain = await boot();
  assert.equal(plain.nova.core.routes.some((r) => r.path === '/triggers/tick'), false);
  assert.notEqual((await plain.call('POST', '/triggers/tick', { now: '2026-03-02T12:00:00Z' })).status, 200);
  await plain.stop();

  process.env.NOVA_TEST_CLOCK = '1';
  const clocked = await boot();
  delete process.env.NOVA_TEST_CLOCK;
  try {
    const rule = (await clocked.call('POST', '/triggers/rules', { name: 'Every minute', class: 'heartbeat', cron: '* * * * *', action: noteAction('notes/beat.md') })).body.rule;
    const due = new Date(Date.parse(rule.created_at) + 61_000).toISOString();
    const first = await clocked.call('POST', '/triggers/tick', { now: due });
    assert.equal(first.status, 200);
    assert.equal(first.body.length, 1);
    assert.equal((await clocked.call('POST', '/triggers/tick', { now: due })).body.length, 0, 'the same due time runs once');
    assert.equal((await clocked.call('POST', '/triggers/tick', { now: 'not a time' })).status, 400);
  } finally {
    await clocked.stop();
  }
});

test('module boundary: outside src/core, only src/core/index.ts is imported', () => {
  const root = join(import.meta.dirname, '..', '..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!['core', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (!/\.(js|ts)$/.test(e.name)) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(/from '([^']*core\/[^']+)'/g)) {
        if (!m[1]!.endsWith('core/index.ts')) offenders.push(`${relative(root, p)} → ${m[1]}`);
      }
    }
  };
  walk(join(root, 'src'));
  assert.deepEqual(offenders, []);
});
