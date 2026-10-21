// End to end through the HTTP API, with the scripted stand-in model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const root = new URL('..', import.meta.url).pathname;
let nova;
let base;

before(async () => {
  const config = loadConfig({
    NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-s-')),
    NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`,
  });
  nova = createNova(config);
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${nova.server.address().port}`;
});
after(() => nova.server.close());

const post = (path, body = {}, headers = { 'x-nova': '1' }) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const snap = async (id) => (await fetch(`${base}/api/sessions/${id}`)).json();
async function settle(id, until = (s) => s.live === null) {
  for (let i = 0; i < 200; i++) {
    const s = await snap(id);
    if (until(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

test('a message gets a streamed reply, logged as JSONL', async () => {
  const res = await post('/api/sessions', { text: 'What should I focus on today?' });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const s = await settle(id);
  const turn = s.session.turns[0];
  assert.equal(turn.state, 'done');
  assert.match(turn.items[0].text, /Three things, in order/);
  const lines = readFileSync(join(nova.config.home, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.type), ['session', 'user', 'assistant', 'done']);
  const list = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(list[0].title, 'What should I focus on today?');
});

test('exec waits for approval, then runs', async () => {
  const { id } = await (await post('/api/sessions', { text: 'run git status' })).json();
  const waiting = await settle(id, (s) => s.live?.phase === 'approval');
  const tool = waiting.session.turns[0].items.find((i) => i.kind === 'tool');
  assert.equal(tool.name, 'exec');
  assert.equal(tool.result, null);
  assert.equal((await post(`/api/sessions/${id}/approvals/${tool.id}`, { decision: 'allow' })).status, 200);
  const s = await settle(id);
  const t = s.session.turns[0];
  const ran = t.items.find((i) => i.kind === 'tool');
  assert.equal(ran.approval.decision, 'allow');
  assert.match(ran.result.output, /\[exit \d+\]/);
  assert.match(t.items.at(-1).text, /clean and up to date/);
});

test('a declined command never runs, and Nova carries on', async () => {
  const { id } = await (await post('/api/sessions', { text: 'run git status' })).json();
  const waiting = await settle(id, (s) => s.live?.phase === 'approval');
  const tool = waiting.session.turns[0].items.find((i) => i.kind === 'tool');
  await post(`/api/sessions/${id}/approvals/${tool.id}`, { decision: 'deny' });
  const t = (await settle(id)).session.turns[0];
  assert.equal(t.items.find((i) => i.kind === 'tool').result, null);
  assert.match(t.items.at(-1).text, /won't run it/);
});

test('read_file runs without approval', async () => {
  const { id } = await (await post('/api/sessions', { text: 'read my profile' })).json();
  const t = (await settle(id)).session.turns[0];
  const tool = t.items.find((i) => i.kind === 'tool');
  assert.equal(tool.needsApproval, false);
  assert.match(tool.result.output, /# USER\.md/);
});

test('stop keeps what was written and marks the turn stopped', async () => {
  const { id } = await (await post('/api/sessions', { text: 'go slow please' })).json();
  await settle(id, (s) => s.live?.phase === 'streaming');
  await post(`/api/sessions/${id}/stop`);
  const t = (await settle(id)).session.turns[0];
  assert.equal(t.state, 'stopped');
  assert.match(t.items[0]?.text ?? '', /^Thinking/);
});

test('a failing model becomes a readable error; regenerate tries again', async () => {
  const { id } = await (await post('/api/sessions', { text: 'please fail' })).json();
  const t = (await settle(id)).session.turns[0];
  assert.equal(t.state, 'error');
  assert.match(t.items[0].message, /exited before replying/);
  assert.match(t.items[0].detail, /simulated failure/);
  assert.equal((await post(`/api/sessions/${id}/regenerate`)).status, 202);
  const again = (await settle(id, (s) => s.live === null && s.session.turns[0].attempt === 1)).session.turns[0];
  assert.equal(again.attempt, 1);
});

test('a second message while replying is refused politely', async () => {
  const { id } = await (await post('/api/sessions', { text: 'slow again' })).json();
  const res = await post(`/api/sessions/${id}/messages`, { text: 'hello?' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /still replying/);
  await post(`/api/sessions/${id}/stop`);
  await settle(id);
});

test('cross-site requests are refused', async () => {
  assert.equal((await post('/api/sessions', { text: 'x' }, {})).status, 403);
  assert.equal((await post('/api/sessions', { text: 'x' }, { 'x-nova': '1', origin: 'https://evil.example' })).status, 403);
  const status = await new Promise((ok) => {
    request(`${base}/api/sessions`, { headers: { host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode); }).end();
  });
  assert.equal(status, 421); // DNS rebinding
});

test('static files cannot escape ui/', async () => {
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(res.status, 404);
  assert.equal((await fetch(`${base}/c/2026-10-21-abcdef`)).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/../../etc`)).status, 404);
});

test('first run seeds the standing files without overwriting', () => {
  const home = nova.config.home;
  for (const f of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md']) assert.ok(existsSync(join(home, f)), f);
  assert.ok(readdirSync(join(home, 'memory')).includes('README.md'));
  assert.ok(existsSync(join(home, 'workspace')));
});
