// Capture screening, job 1: the independent review of #271 (2063c4d8), one test per finding, each
// written before its fix (plan docs/plans/capture-screening-consumers.md, "The review"). Against
// stand-ins only: the Tev1 stand-in answers capture-sensitive from markers in the text.
// Synthetic placeholders only (canary keys, a published test card).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { HELD_NOTICE } from '../../src/core/capture/capture.ts';
import { sensitiveApp } from '../../src/core/decision-service/templates/capture-sensitive.ts';
import { captureCheck } from '../support/capture-check.ts';
import { call, enroll, hub } from './mesh-support.ts';

const AWS = 'AKIACANARY0000000000';
const GH = 'ghp_CANARY0123456789abcdefghijklmnopqrstu';

function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) out.push(p);
  }
  return out;
}

async function rig(o: { trusted?: boolean; contextBytes?: number; sources?: number } = {}) {
  const check = await captureCheck({ trusted: o.trusted ?? true, ...(o.contextBytes ? { contextBytes: o.contextBytes } : {}) });
  const h = await hub({ core: check.core });
  await h.core.decisionService.refresh();
  const sps: Awaited<ReturnType<typeof startFakeScreenpipe>>[] = [];
  const ids: string[] = [];
  // A second "source" is a device's inbox source: Screenpipe is one per hub.
  const sp = await startFakeScreenpipe();
  sps.push(sp);
  const id = (await h.c('POST', '/capture/sources/screenpipe', { url: sp.base })).body.id as string;
  ids.push(id);
  await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
  h.tick(60_000);
  const min = (n: number) => new Date(h.clock.t + n * 60_000).toISOString();
  const pull = async () => (await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/pull`)).body;
  const screen = async () => (await h.c('POST', '/capture/screen')).body;
  const events = async () => (await h.c('GET', '/capture/events?limit=200')).body as any[];
  const byTitle = async (t: string) => (await events()).find((e) => e.window_title === t || (e.window_title ?? '').startsWith(t));
  // An event stored by an older Nova: its words as they were, not yet checked.
  const old = async (title: string, text: string) => {
    sp.add({ at: min(1), app: 'Notes', window: title, text: 'placeholder' });
    await pull();
    const e = (await events()).find((x) => x.window_title === title);
    h.core.db.run(`UPDATE capture_event SET text = ?, sensitivity = 'unscreened', sensitivity_detail = NULL WHERE id = ?`, text, e.id);
    return e.id as string;
  };
  return { h, sp, id, check, min, pull, screen, events, byTitle, old, close: async () => { for (const s of sps) await s.close(); await h.stop(); await check.close(); } };
}

test('review 1: an older row at the 20,000-character cap with a key in it is redacted in place, trusted or not, and stays within the cap', async () => {
  for (const trusted of [true, false]) {
    const r = await rig({ trusted });
    try {
      const id = await r.old('old-full', `note ${AWS} `.padEnd(20_000, 'z'));
      await r.screen();
      await r.screen();
      const e = (await r.h.c('GET', `/capture/events/${id}`)).body;
      assert.equal(String(e.text).includes(AWS), false, `trusted ${trusted}: the key isn't kept in clear`);
      assert.ok(String(e.text).length <= 20_000, `trusted ${trusted}: within the cap`);
      assert.match(e.text, /\[redacted: cloud access key\]/);
      assert.deepEqual(holding(r.h.home, AWS), [], `trusted ${trusted}: nowhere under the home`);
      if (trusted) assert.equal(e.sensitivity.state, 'redact', 'and then checked');
    } finally { await r.close(); }
  }
});

test('review 2: the window title and address are judged too; an exclude clears them; a held item keeps them behind the tap', async () => {
  const r = await rig();
  try {
    r.sp.add(
      { at: r.min(1), app: 'Chat', window: 'router CANARY-GREY-PASSWORD maple', url: 'https://example.com/?note=CANARY-GREY-PASSWORD', text: 'ordinary words' },
      { at: r.min(2), app: 'Portal', window: 'Results CANARY-GREY-HEALTH for Alex', text: 'ordinary page text' },
    );
    await r.pull();
    await r.screen();
    const ev = await r.events();
    const pw = ev.find((e) => e.app === 'Chat');
    const health = ev.find((e) => e.app === 'Portal');
    assert.equal(pw.sensitivity.state, 'exclude', 'a password in the title excludes');
    assert.deepEqual([pw.text, pw.window_title, pw.url], [null, null, null], 'every text field is cleared');
    assert.equal(health.sensitivity.state, 'hold', 'health details in the title hold');
    assert.ok(r.check.seen().some((s) => s.includes('Results CANARY-GREY-HEALTH for Alex')), 'the model saw the title');
    assert.deepEqual(holding(r.h.home, 'CANARY-GREY-PASSWORD'), []);
  } finally { await r.close(); }
});

test('review 3: the window title and address are scrubbed before they are cut, so a secret across the cut leaves no part behind', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: r.min(1), app: 'Terminal', window: `${'x'.repeat(280)} ${GH}`, text: 'nothing here' });
    r.sp.add({ at: r.min(2), app: 'Browser', window: 'w2', url: `https://example.com/${'a'.repeat(1970)}?token=${GH}`, text: 'nothing' });
    await r.pull();
    assert.deepEqual(holding(r.h.home, GH.slice(0, 12)), [], 'no part of the token is stored');
    const ev = await r.events();
    assert.ok(ev.every((e) => e.sensitivity.detail.rules.redacted.length > 0), JSON.stringify(ev.map((e) => e.sensitivity.detail.rules)));
  } finally { await r.close(); }
});

test('review 4: the sensitive-app list: web vaults, major banks by domain, missed apps and bundle ids, the window title; no food banks or league tables', () => {
  for (const [app, url, title] of [
    ['Google Chrome', 'https://vault.bitwarden.com/#/vault', ''], ['Google Chrome', 'https://my.1password.com/vaults', ''], ['Firefox', 'https://lastpass.com/vault/', ''],
    ['Google Chrome', 'https://www.bankofamerica.com/', ''], ['Google Chrome', 'https://secure.chase.com/web/auth', ''], ['Safari', 'https://www.wellsfargo.com/', ''],
    ['Safari', 'https://online.citi.com/', ''], ['Safari', 'https://www.hsbc.co.uk/', ''], ['Safari', 'https://monzo.com/', ''], ['Safari', 'https://www.paypal.com/myaccount', ''],
    ['Safari', 'https://netbank.commbank.com.au/', ''], ['Firefox', 'https://online.examplebank.com/accounts', ''],
    ['Chase', '', ''], ['Revolut', '', ''], ['Monzo', '', ''], ['PayPal', '', ''], ['Wells Fargo', '', ''], ['KeePass2Android', '', ''],
    ['com.agilebits.onepassword7', '', ''], ['com.bitwarden.desktop', '', ''], ['OnePassword', '', ''], ['1Password.exe', '', ''], ['Bit​warden', '', ''],
    ['Google Chrome', '', 'Vaults | 1Password'], ['Firefox', '', 'Bitwarden Web Vault — Mozilla Firefox'],
  ] as [string, string, string][]) assert.ok(sensitiveApp(app, url, title), `${app} ${url} ${title}`);
  for (const [app, url, title] of [
    ['Safari', 'https://www.databank.org/', ''], ['Keeper Standings', '', ''], ['Riverbank Notes', '', ''], ['Safari', 'https://news.example.com/banking-rates', ''],
    ['Google Chrome', '', 'Is 1Password worth it? A review - Example Blog'], ['Notes', '', 'Chase the deadline'],
  ] as [string, string, string][]) assert.equal(sensitiveApp(app, url, title), null, `${app} ${url} ${title}`);
});

test('review 4: a wrongly dropped app can be let back in, per source, through the checked settings route', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: r.min(1), app: 'Keeper', window: 'League table', text: 'The under-12s are second in the league.' });
    assert.deepEqual((await r.pull()).dropped, { sensitive_app: 1 }, 'dropped as a password manager');
    const bad = await r.h.c('PUT', '/capture/settings', { allow: [{ source: r.id }] });
    assert.equal(bad.status, 400, 'an allow-back names an app or a site');
    const set = await r.h.c('PUT', '/capture/settings', { allow: [{ source: r.id, app: 'Keeper' }] });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    r.sp.add({ at: r.min(2), app: 'Keeper', window: 'League table', text: 'The under-12s won on Saturday.' });
    assert.equal((await r.pull()).kept, 1);
    await r.screen();
    const [e] = await r.events();
    assert.equal(e.sensitivity.state, 'index', 'the template doesn’t exclude it again');
  } finally { await r.close(); }
});

test('review 5: a memory made from an event before the check is listed for the person when the event is later found to hold a secret', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: r.min(1), app: 'Notes', window: 'old', text: 'placeholder' });
    await r.pull();
    await r.screen();
    const [e] = await r.events();
    r.h.core.db.run(`UPDATE capture_event SET text = ? WHERE id = ?`, `old note with ${AWS} in it`, e.id);
    const made = await r.h.c('POST', '/capture/promote', { event_ids: [e.id] });
    assert.equal(made.status, 201);
    r.h.core.db.run(`UPDATE capture_event SET sensitivity = 'unscreened', sensitivity_detail = NULL WHERE id = ?`, e.id);
    await r.screen();
    const review = (await r.h.c('GET', '/capture/memory-review')).body as any[];
    assert.equal(review.length, 1);
    assert.equal(review[0].memory_id, made.body.memory.id);
    assert.match(review[0].why, /cloud access key/);
    assert.equal(JSON.stringify(review).includes(AWS), false, 'the list never shows the value');
    // Keeping it takes it off the list.
    assert.equal((await r.h.c('POST', `/capture/memory-review/${made.body.memory.id}/keep`)).status, 200);
    assert.deepEqual((await r.h.c('GET', '/capture/memory-review')).body, []);
  } finally { await r.close(); }
});

test('review 6: events the trusted model can’t answer back off and stop, newer ones aren’t starved, and the notice says why truly', async () => {
  const r = await rig({ contextBytes: 3000 });
  try {
    for (let i = 0; i < 20; i++) r.sp.add({ at: r.min(1 + i / 100), app: 'Editor', window: `long${i}`, text: 'word '.repeat(300) });
    r.sp.add({ at: r.min(2), app: 'Editor', window: 'short', text: 'Draft the plan' });
    await r.pull();
    await r.screen();
    await r.screen();
    assert.equal((await r.byTitle('short')).sensitivity.state, 'index', 'a newer event isn’t starved');
    const long = await r.byTitle('long0');
    assert.equal(long.sensitivity.state, 'held');
    assert.equal(long.sensitivity.why.includes('Add the Tev1 4B model'), false, 'Tev1 4B is installed and trusted: the notice says why truly');
    assert.match(long.sensitivity.why, /couldn’t check it/);
    const held = (await r.h.c('GET', '/capture/holding')).body;
    assert.equal(held.trusted, true);
    assert.equal(held.notice, null, 'the no-model notice isn’t shown when a model is trusted');
    // Backed off, with a limit: after the limit, a failing event isn't asked again.
    // Each ask is one decision record (the stand-in counts only the requests it accepts).
    const asks = () => r.h.core.db.all(`SELECT 1 FROM decision_record WHERE subsystem = 'capture'`).length;
    const before = asks();
    for (let k = 0; k < 8; k++) { r.h.tick(2 * 86_400_000); await r.screen(); }
    const after = asks();
    for (let k = 0; k < 3; k++) { r.h.tick(2 * 86_400_000); await r.screen(); }
    assert.equal(asks(), after, 'past the limit, nothing more is asked');
    assert.ok(after > before);
    assert.match((await r.byTitle('long0')).sensitivity.why, /stays held until capture retention deletes it/);
  } finally { await r.close(); }
});

test('review 7: overlapping ticks run one pass at a time; triage proposes an event once', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: r.min(1), app: 'Editor', window: 'a', text: 'Remember the dentist on Friday' });
    await r.pull();
    let calls = 0;
    r.h.core.decisions.decide = async (t: string) => { calls++; await new Promise((res) => setTimeout(res, 50)); return { template_id: t, version: 1, provider: 'test', answers: { remember: 0.9 }, confidence: 0.9, escalate: false } as never; };
    await Promise.all([r.h.core.capture.tick(), r.h.core.capture.tick(), r.h.core.capture.tick(), r.h.core.capture.tick()]);
    assert.equal(calls, 1);
    assert.equal(r.h.core.db.all('SELECT 1 FROM capture_proposal').length, 1);
    // The database itself refuses a second open proposal for one event.
    const [p] = r.h.core.db.all<{ event_id: string }>('SELECT event_id FROM capture_proposal');
    assert.throws(() => r.h.core.db.run(`INSERT INTO capture_proposal (id, event_id, template_id, version, provider, p, state, at) VALUES ('dup', ?, 'capture-promote', 1, 'x', 0.9, 'proposed', '2026-10-29T10:00:00Z')`, p!.event_id), /UNIQUE/);
  } finally { await r.close(); }
});

test('review 8: the same text from the same source isn’t asked again; another source’s is', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: r.min(1), app: 'Editor', window: 'a', text: 'The same ordinary note' }, { at: r.min(2), app: 'Editor', window: 'a', text: 'The  same ordinary   note' });
    await r.pull();
    await r.screen();
    assert.equal(r.check.seen().length, 1, 'asked once for the same normalised text from one source');
    const ev = await r.events();
    assert.ok(ev.every((e) => e.sensitivity.state === 'index'));
    assert.ok(ev.some((e) => e.sensitivity.detail.decision?.cached === true), 'the second says it reused the first decision');
    // Another source: a device's inbox.
    const { enroll, call } = await import('./mesh-support.ts');
    const { dev, token } = await enroll(r.h, { kind: 'computer', name: 'Desk', purposes: ['capture-source'] });
    const auth = { authorization: `Bearer ${token}` };
    await call(r.h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue', 'capture.screen'] }, auth);
    await r.h.c('POST', `/capture/sources/${encodeURIComponent(`device:${dev.deviceId}:screen`)}/enable`);
    r.h.tick(60_000);
    await call(r.h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [{ key: 'cap-cache-0001', kind: 'capture_event', body: { kind: 'screen', at: r.min(1), app: 'Editor', window_title: 'a', text: 'The same ordinary note' } }] }, auth);
    await r.screen();
    assert.equal(r.check.seen().length, 2, 'a cached answer never crosses sources');
  } finally { await r.close(); }
});

test('review 8: decision records go with their event (forget and retention), and a capture record’s state hash is keyed, not a plain hash', async () => {
  const r = await rig();
  try {
    r.sp.add({ at: r.min(1), app: 'Editor', window: 'a', text: 'Short note' }, { at: r.min(2), app: 'Editor', window: 'b', text: 'Another short note' });
    await r.pull();
    await r.screen();
    const [a, b] = await r.events();
    const rec = r.h.core.db.get<{ state_sha256: string; state_fields: string }>('SELECT state_sha256, state_fields FROM decision_record WHERE id = ?', a.sensitivity.decision)!;
    assert.match(rec.state_sha256, /^hmac:[0-9a-f]{64}$/, 'keyed per home');
    const plain = createHash('sha256').update(JSON.stringify({ source: 'text read from the screen in Editor', text: 'Short note' })).digest('hex');
    assert.equal(rec.state_sha256.includes(plain), false);
    await r.h.c('DELETE', `/capture/events/${a.id}`);
    assert.equal(r.h.core.db.get('SELECT 1 FROM decision_record WHERE id = ?', a.sensitivity.decision), undefined, 'gone with its forgotten event');
    await r.h.c('PUT', '/capture/settings', { retention_days: 1 });
    r.h.tick(3 * 86_400_000);
    await r.h.c('POST', '/capture/sweep');
    assert.equal(r.h.core.db.get('SELECT 1 FROM decision_record WHERE id = ?', b.sensitivity.decision), undefined, 'gone with its swept event');
    assert.equal(r.h.core.db.all(`SELECT 1 FROM decision_record WHERE subsystem = 'capture'`).length, 0, 'no capture record outlives retention');
  } finally { await r.close(); }
});

test('minor: stream readers and event rules get an event once it is checked, never before', async () => {
  const r = await rig();
  try {
    const got: string[] = [];
    const off = r.h.core.capture.stream(null, null).subscribe((e) => got.push(e.sensitivity.state));
    r.sp.add({ at: r.min(1), app: 'Chat', window: 'w', text: 'the wifi word is CANARY-GREY-PASSWORD maple' }, { at: r.min(2), app: 'Editor', window: 'e', text: 'ordinary' });
    await r.pull();
    assert.deepEqual(got, [], 'nothing before the check');
    await r.screen();
    off();
    assert.deepEqual(got.sort(), ['exclude', 'index']);
  } finally { await r.close(); }
});

test('minor: a held event’s decision record says hold, not index', async () => {
  const r = await rig({ trusted: false });
  try {
    r.sp.add({ at: r.min(1), app: 'Editor', window: 'a', text: 'Draft' });
    await r.pull();
    await r.screen();
    const [e] = await r.events();
    assert.equal(e.sensitivity.state, 'held');
    assert.ok(e.sensitivity.why.startsWith(HELD_NOTICE));
    assert.equal(r.h.core.db.get<{ outcome: string }>('SELECT outcome FROM decision_record WHERE id = ?', e.sensitivity.decision)?.outcome, 'hold');
  } finally { await r.close(); }
});

