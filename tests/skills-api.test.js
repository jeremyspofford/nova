// Skills and Gmail end to end: install, connect, use, and remove, through the
// HTTP API with the scripted model and a stand-in Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { startFakeGoogle } from '../scripts/fake-google.js';

const root = new URL('..', import.meta.url).pathname;
const CLIENT = JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh' } });
let nova;
let google;
let base;

before(async () => {
  google = await startFakeGoogle();
  nova = createNova(loadConfig({
    NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-sk-')),
    NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`,
    NOVA_GOOGLE_BASE: google.base,
    NOVA_SEARCH_URL: `${google.base}/search`,
  }));
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${nova.server.address().port}`;
});
after(async () => { nova.server.close(); await google.close(); });

const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
const get = async (path) => (await fetch(base + path)).json();
async function settle(id, until = (s) => s.live === null) {
  for (let i = 0; i < 200; i++) {
    const s = await get(`/api/sessions/${id}`);
    if (until(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}
const ask = async (text) => { const { id } = await (await post('/api/sessions', { text })).json(); return { id, s: await settle(id) }; };

test('nothing installed, nothing connected', async () => {
  const v = await get('/api/skills');
  assert.deepEqual(v.installed, []);
  assert.deepEqual(v.available.map((s) => s.id), ['email-summary', 'shopping']);
  assert.deepEqual([v.connectors.gmail.client, v.connectors.gmail.connected], [false, false]);
});

test('email before Gmail is connected: Nova says where to connect', async () => {
  assert.equal((await post('/api/skills/email-summary/install')).status, 200);
  assert.equal((await post('/api/skills/email-summary/install')).status, 409);
  const { s } = await ask("What's in my email?");
  const items = s.session.turns[0].items;
  assert.deepEqual(items.map((i) => i.kind), ['skill', 'text']);
  assert.deepEqual([items[0].id, items[0].how], ['email-summary', 'matched']);
  assert.match(items[1].text, /\[Connect Gmail\]\(\/skills#gmail\)/);
});

test('connecting Gmail through the browser flow', async () => {
  assert.equal((await post('/api/connectors/gmail/connect')).status, 400); // no client yet
  assert.equal((await post('/api/connectors/gmail/client', { json: '{"web":{}}' })).status, 400);
  assert.equal((await post('/api/connectors/gmail/client', { json: CLIENT })).status, 200);
  const { url } = await (await post('/api/connectors/gmail/connect')).json();
  const atGoogle = await fetch(url, { redirect: 'manual' });
  const back = atGoogle.headers.get('location');
  assert.ok(back.startsWith(`${base}/oauth/gmail?`), back);
  const landed = await fetch(back, { redirect: 'manual' });
  assert.equal(landed.status, 303);
  assert.equal(landed.headers.get('location'), '/skills#gmail');
  const g = (await get('/api/skills')).connectors.gmail;
  assert.deepEqual([g.connected, g.account, g.notice.ok], [true, 'you@example.com', true]);
});

test('the email summary: searches, reads, summarizes; then the web asks first', async () => {
  const { id, s } = await ask("What's in my email today?");
  const items = s.session.turns[0].items;
  assert.deepEqual(items.map((i) => i.kind === 'tool' ? i.name : i.kind), ['skill', 'gmail_search', 'gmail_read', 'text']);
  assert.equal(items[1].result.summary, '5 messages');
  assert.equal(items[2].result.summary, 'Contract for the spring project: signature by Thursday');
  assert.match(items[3].text, /Dana Whitfield/);
  assert.equal(s.session.turns[0].state, 'done');

  // Same conversation: mail is in context now, so opening a page waits for the person.
  await post(`/api/sessions/${id}/messages`, { text: 'open that link' });
  const waiting = await settle(id, (x) => x.live?.phase === 'approval');
  const fetchTool = waiting.session.turns[1].items.find((i) => i.kind === 'tool');
  assert.deepEqual([fetchTool.name, fetchTool.needsApproval], ['web_fetch', true]);
  await post(`/api/sessions/${id}/approvals/${fetchTool.id}`, { decision: 'deny' });
  const done = await settle(id);
  assert.match(done.session.turns[1].items.at(-1).text, /won't open it/);

  // A fresh conversation hasn't read mail: no approval needed to read a page.
  const other = await (await post('/api/sessions', { text: 'open that link' })).json();
  const o = await settle(other.id, (x) => x.live === null || x.live?.phase === 'approval');
  assert.notEqual(o.live?.phase, 'approval');
});

test('shopping uses the web search and the playbook', async () => {
  await post('/api/skills/shopping/install');
  const { s } = await ask('Which merino socks should I buy for hiking?');
  const items = s.session.turns[0].items;
  assert.deepEqual(items.map((i) => i.kind === 'tool' ? i.name : i.kind), ['skill', 'web_search', 'text']);
  assert.equal(items[0].id, 'shopping');
  assert.match(items[1].result.output, /^\[1\] Merino Hiker Crew Sock – Trailknit\nhttps:\/\/trailknit\.example\/merino-hiker-crew/);
  assert.doesNotMatch(items[1].result.output, /Sponsored/);
});

test('removing a skill leaves nothing behind, and undo brings it back', async () => {
  const home = nova.config.home;
  const { files } = await (await post('/api/skills/shopping/remove')).json();
  assert.ok(files['SKILL.md']);
  assert.equal(existsSync(join(home, 'skills', 'shopping')), false);
  assert.deepEqual((await get('/api/skills')).installed.map((s) => s.id), ['email-summary']);
  const { s } = await ask('Which merino socks should I buy?');
  assert.ok(!s.session.turns[0].items.some((i) => i.kind === 'skill'));
  assert.equal((await post('/api/skills/shopping/remove')).status, 404);
  assert.equal((await post('/api/skills/shopping/restore', { files })).status, 200);
  assert.deepEqual((await get('/api/skills')).installed.map((s) => s.id), ['email-summary', 'shopping']);
});

test('disconnecting takes the Gmail tools away', async () => {
  const g = await (await post('/api/connectors/gmail/disconnect')).json();
  assert.deepEqual([g.connected, g.revoked], [false, true]);
  const { s } = await ask("What's in my email?");
  assert.match(s.session.turns[0].items.at(-1).text, /isn't connected/);
});
