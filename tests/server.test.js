// End to end through the HTTP API, with the scripted stand-in model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
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
    NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none',
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

test('memory: kept before the reply is done, shown with its source, edited, forgotten and restored', async () => {
  const { id } = await (await post('/api/sessions', { text: 'I prefer tea in the afternoon' })).json();
  const s = await settle(id);
  const turn = s.session.turns[0];
  assert.equal(turn.items.at(-1).kind, 'memory');
  assert.equal(turn.items[0].text, "Got it. I'll remember that.", 'memory blocks never reach the reply');
  const log = readFileSync(join(nova.config.home, 'sessions', `${id}.jsonl`), 'utf8');
  assert.ok(log.indexOf('"type":"memory"') < log.indexOf('"type":"done"'));
  assert.doesNotMatch(log.split('"type":"memory"')[1], /tea/, 'the log keeps ids, not the words');

  let mem = await (await fetch(`${base}/api/memory`)).json();
  const entry = mem.sections.find((x) => x.title === 'Preferences').entries[0];
  assert.equal(entry.text, 'Prefers tea in the afternoon.');
  assert.equal(entry.from, `${id}/${turn.id}`);
  assert.equal(mem.titles[id], 'I prefer tea in the afternoon');

  assert.equal((await post(`/api/memory/${entry.id}`, { text: 'Prefers green tea after 2pm.' }, {})).status, 403, 'writes need the X-Nova header');
  const edited = await (await post(`/api/memory/${entry.id}`, { text: 'Prefers green tea after 2pm.' })).json();
  assert.equal(edited.entry.by, 'you');
  assert.equal((await post(`/api/memory/${entry.id}`, { text: '  ' })).status, 400);

  const { removed } = await (await post(`/api/memory/${entry.id}/forget`)).json();
  assert.equal(removed.length, 2, 'the matching day note goes too');
  assert.doesNotMatch(readFileSync(join(nova.config.home, 'MEMORY.md'), 'utf8'), /tea/);
  assert.equal((await post(`/api/memory/${entry.id}/forget`)).status, 404);
  await post('/api/memory/restore', { items: removed });
  mem = await (await fetch(`${base}/api/memory`)).json();
  assert.equal(mem.sections.find((x) => x.title === 'Preferences').entries[0].text, 'Prefers green tea after 2pm.');
  assert.equal((await post('/api/memory/restore', { items: [{ file: '../../etc/passwd', line: '- x' }] })).status, 200);
  assert.ok(!existsSync(join(nova.config.home, '..', '..', 'etc', 'passwd.md')));
  assert.equal((await post('/api/memory/zzz/forget')).status, 404);
});

test('memory: one store; MEMORY.md is its view, and hand edits are taken in on the Memory view and before Nova reads it', async () => {
  const file = join(nova.config.home, 'MEMORY.md');
  const v1 = async (kind) => (await fetch(`${base}/api/v1/memory?kind=${kind}`)).json();
  // Something remembered through the core's own API is in the Memory view and the file.
  const made = await (await post('/api/v1/memory', { kind: 'fact', content: 'Keeps a sample logbook.' })).json();
  let mem = await (await fetch(`${base}/api/memory`)).json();
  assert.ok(mem.sections.find((x) => x.title === 'Facts').entries.some((e) => e.id === made.id));
  assert.match(readFileSync(file, 'utf8'), new RegExp(`- Keeps a sample logbook\\. <!-- id=${made.id} `));

  // A bullet added by hand is the person's, once the Memory view loads.
  writeFileSync(file, readFileSync(file, 'utf8').replace('## Decisions\n', '## Decisions\n\n- Keeps the sample garden going this year.\n'));
  mem = await (await fetch(`${base}/api/memory`)).json();
  const entry = mem.sections.find((x) => x.title === 'Decisions').entries[0];
  assert.equal(entry.text, 'Keeps the sample garden going this year.');
  assert.equal(entry.by, 'hand');
  assert.equal((await v1('decision')).find((r) => r.id === entry.id).recorded_by, 'person');

  // A hand edit made just before a message is taken in before Nova reads the file.
  writeFileSync(file, readFileSync(file, 'utf8').replace('going this year.', 'going, with beans.'));
  const { id } = await (await post('/api/sessions', { text: 'What should I focus on today?' })).json();
  await settle(id);
  const fixed = (await v1('decision')).find((r) => r.content === 'Keeps the sample garden going, with beans.');
  assert.equal(fixed?.supersedes, entry.id);
  assert.equal(fixed.recorded_by, 'person');
  await post(`/api/memory/${fixed.id}/forget`);
  await post(`/api/memory/${made.id}/forget`);
});

test('memory: at start, an Era 2 MEMORY.md is imported into the core once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-s-import-'));
  writeFileSync(join(home, 'MEMORY.md'), '# MEMORY.md\n\n## Preferences\n\n- Likes sample tea. <!-- id=m00aa11bb from=s1/t1 at=2026-09-01T10:00:00.000Z -->\n- Written by hand.\n');
  const config = loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' });
  const first = createNova(config);
  const r = first.core.memory.get('m00aa11bb');
  assert.deepEqual([r.kind, r.content, r.source, r.observed_at, r.recorded_by], ['preference', 'Likes sample tea.', 's1/t1', '2026-09-01T10:00:00.000Z', 'nova']);
  assert.equal(first.core.memory.list().length, 2);
  await first.core.close();
  const again = createNova(config);
  assert.equal(again.core.memory.list().length, 2, 'starting again imports nothing twice');
  assert.match(readFileSync(join(home, 'MEMORY.md'), 'utf8'), /## Preferences\n\n- Likes sample tea\. <!-- id=m00aa11bb from=s1\/t1 at=2026-09-01T10:00:00\.000Z -->\n- Written by hand\. <!-- id=h[0-9a-f]{8} at=\S+ by=you -->\n/);
  await again.core.close();
});
