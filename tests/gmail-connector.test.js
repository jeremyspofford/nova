// Gmail repackaged as a connector (M5 plan §2), against the stand-in Google: Era 2's plaintext
// secrets move into the vault and their files are deleted; Gmail shows in Settings › Connections
// with what it can do and what it never does; the same reads, drafts and organizing as before
// (tests/gmail*.test.js are unchanged in behaviour); new mail becomes an event trigger record
// while a rule listens for it; disconnecting revokes at Google and deletes every Gmail secret
// and rule. Neutral placeholders only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { TOOLS } from '../src/tools.js';
import { SCOPE } from '../src/connectors/gmail.js';
import { startFakeGoogle, startFakeImap, sampleMail } from '../scripts/fake-google.js';

let google;
let imap;
let mail;
before(async () => {
  mail = sampleMail();
  google = await startFakeGoogle({ mail });
  imap = await startFakeImap({ mail });
});
after(async () => { await imap.close(); await google.close(); });

const CLIENT = { installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'placeholder-client-secret' } };

async function boot(home = mkdtempSync(join(tmpdir(), 'nova-gc-'))) {
  const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_GOOGLE_BASE: google.base, NOVA_IMAP_URL: imap.url }), port: 0 };
  const nova = createNova(config);
  nova.core.start();
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${nova.server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const stop = async () => { nova.server.closeAllConnections(); nova.server.close(); await nova.core.close(); };
  return { nova, home, call, stop };
}

async function signIn(gmail) {
  gmail.setClient(JSON.stringify(CLIENT));
  const res = await fetch(gmail.authUrl('http://localhost:4317/oauth/gmail'), { redirect: 'manual' });
  return gmail.finish(Object.fromEntries(new URL(res.headers.get('location')).searchParams));
}

test('Era 2’s plaintext secrets move into the vault on start, and their files are deleted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-gc-'));
  const dir = join(home, 'connectors', 'gmail');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'client.json'), JSON.stringify(CLIENT), { mode: 0o600 });
  writeFileSync(join(dir, 'token.json'), JSON.stringify({ refresh_token: 'rt-fake', account: 'you@example.com', since: '2026-10-01T00:00:00.000Z' }), { mode: 0o600 });
  const { nova, call, stop } = await boot(home);
  try {
    assert.deepEqual(nova.runner.gmail.migrated.sort(), ['client.json', 'token.json']);
    assert.equal(existsSync(dir), false, 'the plaintext folder is gone');
    assert.equal(existsSync(join(home, 'connectors')), false);
    assert.deepEqual(nova.core.vault.list(), ['connector/gmail/GOOGLE_OAUTH_CLIENT', 'connector/gmail/GOOGLE_REFRESH_TOKEN']);
    assert.doesNotMatch(readFileSync(nova.core.vault.file, 'utf8'), /rt-fake|placeholder-client-secret/);
    // Still connected, as before the move.
    const s = (await call('GET', '/api/connectors/gmail')).body;
    assert.deepEqual([s.connected, s.account, s.method], [true, 'you@example.com', 'google']);
    const view = (await call('GET', '/api/v1/connectors/gmail')).body;
    assert.deepEqual([view.connected, view.account, view.egress], [true, 'you@example.com', 'remote']);
    assert.ok((await call('GET', '/api/v1/extensions')).body.some((x) => x.id === 'gmail' && x.state === 'enabled'), 'connected Gmail is in the extension host');
    // And it works: a search over the API with the moved sign-in.
    assert.match((await nova.runner.gmail.search({ query: 'in:inbox' })).output, /messages in/);
  } finally { await stop(); }
});

test('the same Gmail: reads, drafts and organizes; it can neither send nor delete', async () => {
  const gmailTools = Object.keys(TOOLS).filter((n) => n.startsWith('gmail_')).sort();
  assert.deepEqual(gmailTools, ['gmail_draft', 'gmail_organize', 'gmail_read', 'gmail_search']);
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.modify');
  const { call, stop } = await boot();
  try {
    const view = (await call('GET', '/api/v1/connectors')).body.connectors.find((c) => c.id === 'gmail');
    assert.deepEqual(view.never, ['Send email.', 'Delete email.']);
    assert.deepEqual(view.setup, { kind: 'link', href: '/skills#gmail', label: 'Connect Gmail' });
    assert.equal(view.connected, false);
    // Local-only (the default): Gmail is off and says why; Nova doesn't recommend it.
    assert.equal(view.allowed, false);
    assert.match(view.blocked, /local-only/);
    assert.equal(view.recommended, false);
  } finally { await stop(); }
});

test('new mail becomes an event trigger record while a rule listens for it, once per message', async () => {
  const { nova, call, stop } = await boot();
  try {
    await call('PUT', '/api/v1/profile/privacy/default', { value: 'cloud-allowed' });
    await signIn(nova.runner.gmail);
    const conn = nova.core.connectors.get('gmail');
    assert.match((await call('POST', '/api/v1/triggers/rules', { name: 'Mail', class: 'event', connector: 'gmail', topic: 'outbox', action: { kind: 'message', text: 'x' } })).body.error, /topic is inbox/);
    const rule = (await call('POST', '/api/v1/triggers/rules', { name: 'New mail', class: 'event', connector: 'gmail', topic: 'inbox', action: { kind: 'message', text: 'New mail arrived.' }, dedup_window_s: 0 })).body.rule;
    assert.equal(rule.source, 'connector:gmail/inbox');
    await conn.poll(); // the first look learns what is already there
    assert.deepEqual((await call('GET', `/api/v1/triggers?rule=${rule.id}`)).body, []);
    mail.push({ id: '19a0c1d2e3f4a5ff', threadId: '19a0c1d2e3f4a5ff', labelIds: ['INBOX', 'UNREAD'], at: Date.now(), from: 'Example Sender <sender@example.com>', subject: 'A new placeholder message', snippet: 'Hello', text: 'Hello', userLabels: [] });
    try {
      await conn.poll();
      await conn.poll();
      const fired = (await call('GET', `/api/v1/triggers?rule=${rule.id}`)).body;
      assert.equal(fired.length, 1, 'once per message');
      assert.deepEqual([fired[0].class, fired[0].source, fired[0].triage.decision], ['event', 'connector:gmail/inbox', 'act']);
    } finally { mail.pop(); }
  } finally { await stop(); }
});

test('disconnecting in Settings › Connections revokes at Google and deletes every Gmail secret and rule', async () => {
  const { nova, call, stop } = await boot();
  try {
    await signIn(nova.runner.gmail);
    await call('POST', '/api/connectors/gmail/password', { email: 'you@example.com', password: 'abcd efgh ijkl mnop' });
    nova.runner.gmail.setClient(JSON.stringify(CLIENT));
    nova.runner.gmail.writeSecret('token.json', { refresh_token: 'rt-fake', account: 'you@example.com' });
    await call('POST', '/api/v1/triggers/rules', { name: 'New mail', class: 'event', connector: 'gmail', topic: 'inbox', action: { kind: 'message', text: 'New mail.' } });
    const r = (await call('POST', '/api/v1/connectors/gmail/disconnect')).body;
    assert.deepEqual([r.connected, r.revoked, r.rules_removed], [false, true, 1]);
    assert.match(r.note ?? '', /app password/);
    assert.equal(google.state.revoked, true);
    assert.deepEqual(nova.core.vault.list('connector/gmail/'), []);
    assert.equal((await call('GET', '/api/connectors/gmail')).body.client, false);
    assert.equal((await call('GET', '/api/v1/extensions')).body.some((x) => x.id === 'gmail'), false);
    google.state.revoked = false;
    // Era 2’s own disconnect on the Skills page still keeps the OAuth client, as before.
    await signIn(nova.runner.gmail);
    const era2 = (await call('POST', '/api/connectors/gmail/disconnect')).body;
    assert.deepEqual([era2.connected, era2.client], [false, true]);
    assert.equal((await call('GET', '/api/v1/connectors/gmail')).body.connected, false);
    google.state.revoked = false;
  } finally { await stop(); }
});
