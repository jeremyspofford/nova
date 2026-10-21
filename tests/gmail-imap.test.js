// Gmail with an app password, over IMAP, against a stand-in Gmail: connecting,
// reading, drafting, organizing, and the ways it goes wrong. Plus the MIME and
// IMAP parsing underneath.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gmail, googleEndpoints } from '../src/connectors/gmail.js';
import { decodeMailbox, encodeMailbox, fetchItems, parse } from '../src/connectors/imap.js';
import { decodeWords, messageFiles, messageText, parseMessage } from '../src/mime.js';
import { sampleMail, startFakeGoogle, startFakeImap } from '../scripts/fake-google.js';

let imap;
let google;
before(async () => {
  const mail = sampleMail();
  google = await startFakeGoogle({ mail });
  imap = await startFakeImap({ mail, labels: google.state.labels });
});
after(async () => { await imap.close(); await google.close(); });

const PASSWORD = { email: 'you@example.com', password: 'abcd efgh ijkl mnop' };
const fresh = () => new Gmail(mkdtempSync(join(tmpdir(), 'nova-gi-')), { imapUrl: imap.url, endpoints: googleEndpoints(google.base), timezone: 'America/Los_Angeles' });
const connected = async () => { const g = fresh(); await g.connectPassword(PASSWORD); return g; };

test('connecting with an app password: plain words when it is wrong', async () => {
  const g = fresh();
  await assert.rejects(g.connectPassword({ email: 'you', password: 'x' }), /Enter your Gmail address/);
  await assert.rejects(g.connectPassword({ email: 'you@example.com', password: ' ' }), /Paste the app password/);
  await assert.rejects(g.connectPassword({ email: 'you@example.com', password: 'my-google-password' }), /That's your Google password. Nova needs an app password/);
  await assert.rejects(g.connectPassword({ email: 'you@example.com', password: 'wrongwrongwrongw' }), /didn't accept that address and app password/);
  assert.equal(g.status().connected, false);

  const s = await g.connectPassword({ email: ' You@Example.com ', password: 'abcd efgh ijkl mnop' });
  assert.deepEqual([s.connected, s.method, s.account, s.notice.text], [true, 'password', 'you@example.com', 'Gmail is connected as you@example.com.']);
  assert.equal(statSync(join(g.dir, 'password.json')).mode & 0o777, 0o600);
});

test('search and read over IMAP say the same as over the API', async () => {
  const g = await connected();
  const { output, summary } = await g.search({ query: 'in:inbox newer_than:1d -category:promotions', max: 20 });
  assert.equal(summary, '5 messages');
  assert.match(output, /^5 messages in 5 conversations, newest first\./);
  assert.match(output, /\[1\] id=19a0c1d2e3f4a501 conversation=19a0c1d2e3f4a501 \(unread, important\)\nFrom: Dana Whitfield/);
  assert.match(output, /\(read\)\nFrom: City Water/);
  assert.match(output, /Date: \w{3}, \w{3} \d+, \d+:\d{2} [AP]M\nHi, The contract for the spring project is attached\./);
  assert.doesNotMatch(output, /Morning Brief/);
  assert.match((await g.search({ query: 'in:inbox', max: 2 })).output, /^2 messages.*More messages match/);
  assert.equal((await g.search({ query: 'from:nobody' })).output, 'Nothing matched from:nobody.');

  const a = await g.readMessage({ id: '19a0c1d2e3f4a501' });
  assert.equal(a.summary, 'Contract for the spring project: signature by Thursday');
  assert.match(a.output, /Attachments \(not opened\): spring-project-contract\.pdf \(180 KB\)/);
  assert.match(a.output, /Could you sign it and send it back by Thursday\?/);
  const b = await g.readMessage({ id: '19a0c1d2e3f4a503' });
  assert.match(b.output, /cleaning on Friday at 9:30 AM with Dr\. Patel/);
  await assert.rejects(g.readMessage({ id: '19a0c1d2e3f4ffff' }), /isn't there any more/);
  // Reading never marks anything read.
  assert.ok(imap.mail[0].labelIds.includes('UNREAD'));
  assert.deepEqual(imap.state.commands.filter((c) => /FETCH/.test(c) && /BODY\[/.test(c)), []);
  assert.ok(imap.state.commands.some((c) => /FETCH .*BODY\.PEEK\[\]/.test(c)));
});

test('a draft reply goes to Drafts, threaded, and is never sent', async () => {
  const g = await connected();
  const plan = await g.planDraft({ reply_to: '19a0c1d2e3f4a502', body: 'Yes! Café at 8?' });
  assert.deepEqual([plan.to, plan.subject, plan.threadId], ['Sam Ortiz <sam.ortiz@example.com>', 'Re: Saturday hike?', '19a0c1d2e3f4a502']);
  const before = imap.state.drafts.length;
  const r = await g.draft({ reply_to: '19a0c1d2e3f4a502', body: 'Yes! Café at 8?' });
  assert.equal(r.summary, 'Re: Saturday hike?');
  assert.match(r.link, /^https:\/\/mail\.google\.com\/mail\/\?authuser=you%40example\.com#drafts$/);
  const raw = imap.state.drafts.at(-1);
  assert.equal(imap.state.drafts.length, before + 1);
  assert.match(raw, /^From: you@example\.com\r\n/);
  assert.match(raw, /\r\nIn-Reply-To: <19a0c1d2e3f4a502@mail\.example>\r\nReferences: <19a0c1d2e3f4a502@mail\.example>\r\n/);
  assert.equal(messageText(parseMessage(Buffer.from(raw).toString('latin1'))), 'Yes! Café at 8?');
  assert.ok(imap.state.commands.some((c) => c.startsWith('APPEND "[Gmail]/Drafts" (\\Draft \\Seen)')));

  await assert.rejects(g.draft({ body: 'x' }), /needs someone to go to/);
  await assert.rejects(g.draft({ to: 'sam', body: 'x' }), /isn't an email address/);
  await g.draft({ to: 'sam@example.com', subject: 'x\r\nBcc: evil@example.com', body: 'x' });
  assert.doesNotMatch(imap.state.drafts.at(-1), /\r\nBcc:/);
});

test('organizing: archive, read state and labels, with a new label made on the way', async () => {
  const g = await connected();
  const ids = ['19a0c1d2e3f4a504', '19a0c1d2e3f4a506'];
  const plan = await g.planChange({ ids, archive: true, read: true, add_labels: ['bills', 'Paid'] });
  assert.equal(plan.verb, 'Archive 2 emails, mark them read and label them “Bills” and “Paid”');
  assert.deepEqual(plan.create, ['Paid']);
  assert.deepEqual(plan.messages.map((m) => m.from), ['City Water', 'The Morning Brief']);
  const r = await g.change({ ids, archive: true, read: true, add_labels: ['bills', 'Paid'] });
  assert.equal(r.summary, 'Archived 2 emails, marked them read and labelled them “Bills” and “Paid”');
  const water = imap.mail.find((m) => m.id === ids[0]);
  assert.ok(!water.labelIds.includes('INBOX'));
  assert.deepEqual(water.userLabels, ['Bills', 'Paid']);
  assert.ok(imap.state.labels.includes('Paid'));

  await g.change({ ids: [ids[0]], archive: false, read: false, remove_labels: ['Paid'] });
  assert.ok(water.labelIds.includes('INBOX') && water.labelIds.includes('UNREAD'));
  assert.deepEqual(water.userLabels, ['Bills']);

  await assert.rejects(g.planChange({ ids }), /Nothing to change/);
  await assert.rejects(g.planChange({ ids, remove_labels: ['Nope'] }), /no label called “Nope”/);
  await assert.rejects(g.planChange({ ids: ['19a0c1d2e3f4ffff'], archive: true }), /isn't there any more/);
  await assert.rejects(g.planChange({ ids: ['../x'], archive: true }), /isn't a message id/);
});

test('an app password removed at Google: "needs reconnecting", not a crash', async () => {
  const g = await connected();
  imap.state.password = 'qrstuvwxqrstuvwx';
  try {
    await assert.rejects(g.search({}), (e) => e.code === 'reconnect');
    assert.deepEqual([g.status().connected, g.status().broken], [false, true]);
    await assert.rejects(g.search({}), /needs reconnecting/);
  } finally { imap.state.password = 'abcdefghijklmnop'; }
  await g.connectPassword(PASSWORD);
  assert.equal(g.status().connected, true);
});

test('Gmail unreachable: says so', async () => {
  const g = new Gmail(mkdtempSync(join(tmpdir(), 'nova-gi-')), { imapUrl: 'imap://127.0.0.1:9' });
  await assert.rejects(g.connectPassword(PASSWORD), /Couldn't reach Gmail/);
});

test('one way in at a time; disconnecting forgets the password', async () => {
  const g = await connected();
  g.setClient(JSON.stringify({ installed: { client_id: '1-a.apps.googleusercontent.com', client_secret: 's' } }));
  g.writeSecret('token.json', { refresh_token: 'rt-fake', account: 'you@example.com' });
  assert.equal(g.status().method, 'password');
  const s = await g.disconnect();
  assert.deepEqual([s.connected, s.password, s.method], [true, true, 'google']); // the Google sign-in was already there
  assert.equal(existsSync(join(g.dir, 'password.json')), false);
  await g.connectPassword(PASSWORD); // connecting with a password signs the Google client out
  assert.equal(existsSync(join(g.dir, 'token.json')), false);
  assert.equal(g.status().method, 'password');
});

test('MIME: encoded words, quoted-printable, charsets, attachments, a message cut short', () => {
  assert.equal(decodeWords('=?UTF-8?B?Q2Fmw6k=?= =?ISO-8859-1?Q?cr=E8me_br=FBl=E9e?= ok'), 'Cafécrème brûlée ok');
  const raw = [
    'Subject: =?utf-8?q?R=C3=A9union?=', 'Content-Type: multipart/mixed; boundary="X"', '', 'preamble',
    '--X', 'Content-Type: multipart/alternative; boundary="Y"', '',
    '--Y', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=E9 at=\r\n 8.', '--Y',
    'Content-Type: text/html; charset=utf-8', '', '<p>Café</p>', '--Y--',
    '--X', 'Content-Type: application/pdf', "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf", 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--X--', 'epilogue', '',
  ].join('\r\n');
  const msg = parseMessage(Buffer.from(raw).toString('latin1'));
  assert.equal(msg.headers.get('subject')[0], 'Réunion');
  assert.equal(messageText(msg), 'Café at 8.');
  assert.deepEqual(messageFiles(msg), [{ name: 'résumé.pdf', size: 9 }]);
  const cut = parseMessage(Buffer.from(raw.slice(0, raw.indexOf('<p>'))).toString('latin1'));
  assert.equal(messageText(cut), 'Café at 8.');
});

test('IMAP responses: literals, bracketed sections, NIL, mailbox names', () => {
  const u = parse('5 FETCH (UID 9 X-GM-LABELS ("\\\\Inbox" Bills) FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT)] {11}\r\nFrom: a\r\n\r\n BODY[TEXT]<0> NIL)');
  const [items] = fetchItems([u]);
  assert.deepEqual(items['X-GM-LABELS'], ['\\Inbox', 'Bills']);
  assert.equal(items['BODY[HEADER.FIELDS (FROM SUBJECT)]'], 'From: a\r\n\r\n');
  assert.equal(items['BODY[TEXT]'], null);
  assert.equal(encodeMailbox('Café & Co'), 'Caf&AOk- &- Co');
  assert.equal(decodeMailbox('Caf&AOk- &- Co'), 'Café & Co');
});
