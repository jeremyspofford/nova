// Skills and Gmail end to end: install, connect, use, and remove, through the
// HTTP API with the scripted model and a stand-in Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { sampleMail, startFakeGoogle, startFakeImap } from '../scripts/fake-google.js';

const root = new URL('..', import.meta.url).pathname;
const CLIENT = JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh' } });
let nova;
let google;
let imap;
let base;

before(async () => {
  const mail = sampleMail();
  google = await startFakeGoogle({ mail });
  imap = await startFakeImap({ mail, labels: google.state.labels });
  nova = createNova(loadConfig({
    NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-sk-')),
    NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`,
    NOVA_GOOGLE_BASE: google.base,
    NOVA_SEARCH_URL: `${google.base}/search`,
    NOVA_IMAP_URL: imap.url,
  }));
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${nova.server.address().port}`;
});
after(async () => { nova.server.close(); await google.close(); await imap.close(); });

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

test('an app password connects Gmail; drafts and changes wait for the person and show exactly what', async () => {
  const bad = await post('/api/connectors/gmail/password', { email: 'you@example.com', password: 'my-google-password' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Nova needs an app password/);
  const ok = await (await post('/api/connectors/gmail/password', { email: 'you@example.com', password: 'abcd efgh ijkl mnop' })).json();
  assert.deepEqual([ok.connected, ok.method], [true, 'password']);
  assert.ok(!JSON.stringify(await get('/api/skills')).includes('abcdefghijklmnop'));

  // A draft: the card shows the whole draft; Allow saves it, and nothing is sent.
  const { id } = await (await post('/api/sessions', { text: 'Draft a reply to Sam saying yes' })).json();
  let s = await settle(id, (x) => x.live?.phase === 'approval');
  let tool = s.session.turns[0].items.find((i) => i.kind === 'tool');
  assert.deepEqual([tool.name, tool.needsApproval, tool.preview.to, tool.preview.subject, tool.preview.reply], ['gmail_draft', true, 'Sam Ortiz <sam.ortiz@example.com>', 'Re: Saturday hike?', true]);
  assert.match(tool.preview.body, /^Hi Sam,\n\nYes, Saturday is still on\./);
  const drafts = imap.state.drafts.length;
  await post(`/api/sessions/${id}/approvals/${tool.id}`, { decision: 'allow' });
  s = await settle(id);
  tool = s.session.turns[0].items.find((i) => i.kind === 'tool');
  assert.deepEqual([tool.result.ok, tool.result.summary, tool.result.link], [true, 'Re: Saturday hike?', 'https://mail.google.com/mail/?authuser=you%40example.com#drafts']);
  assert.equal(imap.state.drafts.length, drafts + 1);

  // A change, declined: nothing moves. Then allowed.
  const water = imap.mail.find((m) => m.id === '19a0c1d2e3f4a504');
  const c = await (await post('/api/sessions', { text: 'Archive the water bill and the newsletter' })).json();
  s = await settle(c.id, (x) => x.live?.phase === 'approval');
  tool = s.session.turns[0].items.find((i) => i.kind === 'tool');
  assert.equal(tool.preview.verb, 'Archive 2 emails and mark them read');
  assert.deepEqual(tool.preview.messages.map((m) => m.from), ['City Water', 'The Morning Brief']);
  await post(`/api/sessions/${c.id}/approvals/${tool.id}`, { decision: 'deny' });
  s = await settle(c.id);
  assert.match(s.session.turns[0].items.at(-1).text, /left them where they are/);
  assert.ok(water.labelIds.includes('INBOX'));

  await post(`/api/sessions/${c.id}/messages`, { text: 'Archive them after all' });
  s = await settle(c.id, (x) => x.live?.phase === 'approval');
  tool = s.session.turns[1].items.find((i) => i.kind === 'tool');
  await post(`/api/sessions/${c.id}/approvals/${tool.id}`, { decision: 'allow' });
  s = await settle(c.id);
  assert.equal(s.session.turns[1].items.find((i) => i.kind === 'tool').result.summary, 'Archived 2 emails and marked them read');
  assert.ok(!water.labelIds.includes('INBOX'));

  const off = await (await post('/api/connectors/gmail/disconnect')).json();
  assert.deepEqual([off.connected, off.password], [false, true]);
});

test('adding your own skill, from a .zip or a folder, and removing it', async () => {
  const { makeZip } = await import('../scripts/make-zip.js');
  const skill = '---\nname: meeting-notes\ndescription: Turns meeting notes into decisions and action items.\n---\n\nList decisions, then action items.\n';
  const r = await post('/api/skills/add', { zip: makeZip({ 'meeting-notes/SKILL.md': skill }).toString('base64') });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).skill.name, 'Meeting notes');
  const mine = (await get('/api/skills')).installed.find((s) => s.id === 'meeting-notes');
  assert.equal(mine.own, true);
  assert.equal((await post('/api/skills/add', { zip: makeZip({ 'meeting-notes/SKILL.md': skill }).toString('base64') })).status, 409);
  assert.equal((await post('/api/skills/add', { zip: Buffer.from('nope').toString('base64') })).status, 400);
  assert.equal((await post('/api/skills/add', { files: { 'a/SKILL.md': skill.replace('meeting-notes', 'standup') } })).status, 200);
  const big = await post('/api/skills/add', { zip: 'A'.repeat(9_000_000) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  assert.equal((await post('/api/skills/meeting-notes/remove')).status, 200);
  assert.equal((await post('/api/skills/standup/remove')).status, 200);
});
