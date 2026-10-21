// The Gmail connector against a stand-in Google: sign-in, reading, and every
// way it can go wrong.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gmail, GmailError, bodyText, googleEndpoints } from '../src/connectors/gmail.js';
import { startFakeGoogle } from '../scripts/fake-google.js';

let google;
before(async () => { google = await startFakeGoogle(); });
after(() => google.close());

const CLIENT = JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh', redirect_uris: ['http://localhost'] } });
const fresh = () => new Gmail(mkdtempSync(join(tmpdir(), 'nova-g-')), { endpoints: googleEndpoints(google.base), timezone: 'America/Los_Angeles' });

async function connect(gmail) {
  gmail.setClient(CLIENT);
  const res = await fetch(gmail.authUrl('http://localhost:4317/oauth/gmail'), { redirect: 'manual' });
  const back = new URL(res.headers.get('location'));
  return gmail.finish(Object.fromEntries(back.searchParams));
}

test('the OAuth client must be a Desktop app client', () => {
  const g = fresh();
  assert.equal(g.status().client, false);
  assert.throws(() => g.setClient('not json'), /isn't the file/);
  assert.throws(() => g.setClient(JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com' } })), /Desktop app/);
  assert.throws(() => g.setClient(JSON.stringify({ installed: { client_id: 'nope' } })), /doesn't look like/);
  g.setClient(CLIENT);
  assert.equal(g.status().client, true);
  assert.throws(() => fresh().authUrl('http://localhost/oauth/gmail'), /OAuth client first/);
});

test('connecting: PKCE, read-only scope, token kept private', async () => {
  const g = fresh();
  g.setClient(CLIENT);
  const url = new URL(g.authUrl('http://localhost:4317/oauth/gmail'));
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');

  const notice = await connect(g);
  assert.deepEqual([notice.ok, notice.text], [true, 'Gmail is connected as you@example.com.']);
  const s = g.status();
  assert.deepEqual([s.connected, s.account, s.broken], [true, 'you@example.com', false]);
  const file = join(g.dir, 'token.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(g.dir, 'client.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /at-\d/); // access tokens stay in memory
});

test('a sign-in with a stolen or stale state is refused', async () => {
  const g = fresh();
  g.setClient(CLIENT);
  const n = await g.finish({ code: 'fake-code', state: 'made-up' });
  assert.equal(n.ok, false);
  assert.match(n.text, /took too long or came from somewhere else/);
  assert.equal(g.status().connected, false);
});

test('cancelling at Google says so plainly', async () => {
  const g = fresh();
  google.state.deny = true;
  try {
    const n = await connect(g);
    assert.equal(n.text, 'You cancelled at Google, so Gmail is still not connected.');
  } finally { google.state.deny = false; }
});

test('search: newest first, conversations counted, promotions left out', async () => {
  const g = fresh();
  await connect(g);
  const { output, summary } = await g.search({ query: 'in:inbox newer_than:1d -category:promotions', max: 20 });
  assert.equal(summary, '5 messages');
  assert.match(output, /^5 messages in 5 conversations, newest first\./);
  assert.match(output, /\[1\] id=19a0c1d2e3f4a501 conversation=19a0c1d2e3f4a501 \(unread, important\)\nFrom: Dana Whitfield/);
  assert.match(output, /Date: \w{3}, \w{3} \d+, \d+:\d{2} [AP]M/);
  assert.doesNotMatch(output, /Morning Brief/);

  const few = await g.search({ query: 'in:inbox', max: 2 });
  assert.match(few.output, /More messages match/);
  assert.match((await g.search({ query: 'from:nobody is:unread label:none', max: 0 })).output, /^\d+ message/);
});

test('read: headers, attachments listed, HTML turned to text', async () => {
  const g = fresh();
  await connect(g);
  const a = await g.readMessage({ id: '19a0c1d2e3f4a501' });
  assert.equal(a.summary, 'Contract for the spring project: signature by Thursday');
  assert.match(a.output, /Attachments \(not opened\): spring-project-contract\.pdf \(180 KB\)/);
  assert.match(a.output, /Could you sign it and send it back by Thursday\?/);
  const b = await g.readMessage({ id: '19a0c1d2e3f4a503' });
  assert.match(b.output, /cleaning on Friday at 9:30 AM/);
  assert.doesNotMatch(b.output, /<b>|&nbsp;/);
  await assert.rejects(g.readMessage({ id: '../profile' }), /isn't a message id/);
  await assert.rejects(g.readMessage({ id: '19a0c1d2e3f4ffff' }), /isn't there any more/);
});

test('an expired access token is renewed without the person noticing', async () => {
  const g = fresh();
  await connect(g);
  const before = google.state.refreshes;
  g.access.expires = 0;
  await g.search({ query: 'in:inbox', max: 1 });
  assert.equal(google.state.refreshes, before + 1);
  g.access.token = 'at-bogus'; // Google forgot it: one retry with a fresh one
  await g.search({ query: 'in:inbox', max: 1 });
  assert.equal(google.state.refreshes, before + 2);
});

test('access removed at Google: "needs reconnecting", not a crash', async () => {
  const g = fresh();
  await connect(g);
  google.state.revoked = true;
  g.access = null;
  await assert.rejects(g.search({}), (e) => e instanceof GmailError && e.code === 'reconnect');
  assert.deepEqual([g.status().connected, g.status().broken], [false, true]);
  await assert.rejects(g.search({}), /needs reconnecting/);
  google.state.revoked = false;
});

test('Google unreachable: says so', async () => {
  const g = new Gmail(mkdtempSync(join(tmpdir(), 'nova-g-')), { endpoints: googleEndpoints('http://127.0.0.1:9') });
  g.setClient(CLIENT);
  g.writeSecret('token.json', { refresh_token: 'rt-fake' });
  await assert.rejects(g.search({}), /Couldn't reach Google/);
});

test('not connected: the tool says where to connect', async () => {
  await assert.rejects(fresh().search({}), /isn't connected. The person can connect it at \/skills#gmail/);
});

test('disconnect revokes at Google and deletes the token; the client stays', async () => {
  const g = fresh();
  await connect(g);
  const s = await g.disconnect();
  assert.deepEqual([s.revoked, s.connected, s.client], [true, false, true]);
  assert.equal(google.state.revoked, true);
  assert.equal(existsSync(join(g.dir, 'token.json')), false);
  g.forgetClient();
  assert.equal(existsSync(join(g.dir, 'client.json')), false);
  google.state.revoked = false;
});

test('bodies: plain text preferred, charsets honoured', () => {
  const part = (mimeType, text, charset = 'utf-8') => ({ mimeType, headers: [{ name: 'Content-Type', value: `${mimeType}; charset=${charset}` }], body: { data: Buffer.from(text, charset === 'iso-8859-1' ? 'latin1' : 'utf8').toString('base64url') } });
  const alt = { mimeType: 'multipart/alternative', parts: [part('text/html', '<p>Hi <b>there</b></p>'), part('text/plain', 'Hi there')] };
  assert.equal(bodyText(alt), 'Hi there');
  assert.equal(bodyText({ mimeType: 'multipart/mixed', parts: [part('text/html', '<p>Only <i>HTML</i></p>')] }), 'Only HTML');
  assert.equal(bodyText(part('text/plain', 'Café crème', 'iso-8859-1')), 'Café crème');
});
