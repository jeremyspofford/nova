// The M6 capture review's findings, each as the case that showed it: a private window whose marker
// is past where a title is cut or in another language, a Screenpipe backlog bigger than one pull,
// an item Screenpipe reports late with an older time, exclusions that missed what the person meant,
// who a promotion is recorded as, and the smaller ones (a Screenpipe answering too much, triage
// waiting for a provider, device times with no zone, a revoked device's sources, a source that
// isn't the hub's, a standby's page hearing about capture). Neutral placeholders only; nothing is
// captured from this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { Screenpipe, Unreachable } from '../../src/core/capture/screenpipe.ts';
import { call, enroll, hub } from './mesh-support.ts';

type Hub = Awaited<ReturnType<typeof hub>>;
type Sp = Awaited<ReturnType<typeof startFakeScreenpipe>>;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const min = (h: Hub, n: number) => new Date(h.clock.t + n * 60_000).toISOString();

function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) out.push(p);
  }
  return out;
}

async function withScreenpipe(fn: (h: Hub, sp: Sp, id: string) => Promise<void>) {
  const h = await hub();
  const sp = await startFakeScreenpipe();
  try {
    const added = await h.c('POST', '/capture/sources/screenpipe', { url: sp.base });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    await fn(h, sp, added.body.id);
  } finally {
    await sp.close();
    await h.stop();
  }
}

const on = (h: Hub, id: string) => h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
const pull = async (h: Hub, id: string) => (await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/pull`)).body;
const texts = async (h: Hub) => ((await h.c('GET', '/capture/events?limit=500')).body as any[]).map((e) => e.text).sort();

// Nowhere: no file under the home (database, write-ahead log, backups), no sync-log row, no inbox
// row, no problem.
function nowhere(h: Hub, word: string) {
  assert.deepEqual(holding(h.home, word), [], `${word}: no file under the home`);
  const n = (sql: string) => h.core.db.get<{ n: number }>(sql, `%${word}%`)!.n;
  assert.equal(n('SELECT COUNT(*) AS n FROM sync_log WHERE row LIKE ?'), 0, `${word}: not in the sync log`);
  assert.equal(n(`SELECT COUNT(*) AS n FROM device_inbox WHERE IFNULL(body, '') || IFNULL(reason, '') LIKE ?`), 0, `${word}: not in an inbox row`);
  assert.equal(n(`SELECT COUNT(*) AS n FROM problem WHERE message || IFNULL(detail, '') LIKE ?`), 0, `${word}: not in a problem`);
}

test('BLOCKER 1: a private window is never stored, whatever the title’s length or language, from Screenpipe or a device', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await on(h, id);
    sp.add(
      { at: min(h, 1), app: 'Firefox', window: `${'Long page title '.repeat(19)} — Mozilla Firefox Private Browsing`, text: 'LEAK-LONGTITLE' },
      { at: min(h, 2), app: 'Firefox', window: 'Nouvel onglet — Navigation privée de Mozilla Firefox', text: 'LEAK-FR' },
      { at: min(h, 3), app: 'Google Chrome', window: 'Neuer Tab - Google Chrome (Inkognito)', text: 'LEAK-DE' },
      { at: min(h, 4), app: 'Firefox', window: 'Nuova scheda', url: 'about:privatebrowsing', text: 'LEAK-URL' },
      { at: min(h, 5), app: 'Editor', window: 'notes.txt', text: 'kept' },
    );
    const r = await pull(h, id);
    assert.deepEqual([r.kept, r.dropped], [1, { private: 4 }], JSON.stringify(r));
    assert.deepEqual(await texts(h), ['kept']);

    // The same through a paired computer's inbox.
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer', purposes: ['capture-source'] });
    await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue', 'capture.app-activity'] }, bearer(token));
    await on(h, `device:${dev.deviceId}:app-activity`);
    const send = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', {
      items: [
        { key: 'cap-10000001', kind: 'capture_event', body: { kind: 'app-activity', at: min(h, 6), app: 'Firefox', window_title: `${'Another long title '.repeat(17)} — Mozilla Firefox Private Browsing`, text: 'LEAK-DEVICE-LONG' } },
        { key: 'cap-10000002', kind: 'capture_event', body: { kind: 'app-activity', at: min(h, 7), app: 'Microsoft Edge', window_title: 'Nieuw tabblad - InPrivate', text: 'LEAK-DEVICE-NL' } },
      ],
    }, bearer(token));
    assert.deepEqual(send.body.results.map((x: any) => [x.status, x.ref]), [['accepted', undefined], ['accepted', undefined]]);
    for (const w of ['LEAK-LONGTITLE', 'LEAK-FR', 'LEAK-DE', 'LEAK-URL', 'LEAK-DEVICE-LONG', 'LEAK-DEVICE-NL', 'Long page title', 'Another long title', 'Navigation privée', 'Inkognito', 'Nieuw tabblad']) nowhere(h, w);
  });
});

test('SHOULD-FIX 2: a backlog bigger than one pull arrives whole, oldest first, over the next pulls', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await on(h, id);
    const n = 5200;
    for (let i = 0; i < n; i++) sp.add({ at: new Date(h.clock.t + 1000 + i * 1000).toISOString(), app: 'Editor', window: 'w', text: `item ${i}` });
    h.tick(n * 1000 + 60_000);
    let kept = 0;
    for (let i = 0; i < 4 && kept < n; i++) kept += (await pull(h, id)).kept;
    assert.equal(kept, n);
    assert.equal(h.core.db.get<{ n: number }>('SELECT COUNT(DISTINCT external_id) AS n FROM capture_event')!.n, n);
    assert.ok(h.core.db.get(`SELECT 1 FROM capture_event WHERE text = 'item 0'`), 'the oldest is there');
    assert.equal((await pull(h, id)).kept, 0, 'nothing twice');
  });
});

test('SHOULD-FIX 3: an item Screenpipe reports late, with an older time, still arrives once; how far back is configurable', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await on(h, id);
    sp.add({ at: min(h, 5), app: 'Editor', text: 'newer' });
    assert.equal((await pull(h, id)).kept, 1);
    sp.add({ at: min(h, 4), app: 'Editor', text: 'older but late' });
    assert.equal((await pull(h, id)).kept, 1);
    assert.deepEqual(await texts(h), ['newer', 'older but late']);
    assert.equal((await pull(h, id)).kept, 0, 'and once');
    // Further back than the default needs the source to say so.
    const set = await h.c('PATCH', `/capture/sources/${encodeURIComponent(id)}`, { lookback_minutes: 30 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.lookback_minutes, 30);
    assert.equal((await h.c('PATCH', `/capture/sources/${encodeURIComponent(id)}`, { lookback_minutes: 0 })).status, 400);
    sp.add({ at: min(h, 40), app: 'Editor', text: 'newest' });
    assert.equal((await pull(h, id)).kept, 1);
    sp.add({ at: min(h, 22), app: 'Editor', text: 'eighteen minutes late' });
    assert.equal((await pull(h, id)).kept, 1);
    assert.ok((await texts(h)).includes('eighteen minutes late'));
  });
});

test('SHOULD-FIX 4: a site in a browser with no address, a fully qualified host, app editions, audio over a time window', async () => {
  await withScreenpipe(async (h, sp, id) => {
    const s = await h.c('PUT', '/capture/settings', { exclusions: [{ kind: 'site', site: 'bank.example' }, { kind: 'app', app: 'Signal' }, { kind: 'time', window: { start: '12:00', end: '13:00' } }] });
    assert.equal(s.status, 200);
    await on(h, id);
    sp.add(
      { at: min(h, 1), app: 'Browser', window: 'Bank Example - Account summary', text: 'bank.example/accounts balance 1234 SITE-NO-URL' },
      { at: min(h, 2), app: 'Browser', window: 'Statement', url: 'https://bank.example./acct', text: 'SITE-TRAILING-DOT' },
      { at: min(h, 3), app: 'Signal.exe', window: 'chat', text: 'APP-EXE' },
      { at: min(h, 4), app: 'Signal Beta', window: 'chat', text: 'APP-BETA' },
      { at: min(h, 5), app: 'Editor', window: 'notes', text: 'kept' },
    );
    const r = await pull(h, id);
    assert.deepEqual([r.kept, r.dropped], [1, { excluded: 4 }], JSON.stringify(r));
    for (const w of ['SITE-NO-URL', 'SITE-TRAILING-DOT', 'APP-EXE', 'APP-BETA']) nowhere(h, w);

    // Audio has no app; a time window keeps it out over its whole stretch, not only its start.
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer', purposes: ['capture-source'] });
    await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue', 'capture.audio'] }, bearer(token));
    await on(h, `device:${dev.deviceId}:audio`);
    const send = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', {
      items: [{ key: 'cap-20000001', kind: 'capture_event', body: { kind: 'audio', at: '2026-10-29T11:50:00Z', ended_at: '2026-10-29T12:10:00Z', text: 'AUDIO-INTO-LUNCH' } }],
    }, bearer(token));
    assert.match(send.body.results[0].reason, /Excluded: 12:00–13:00/);
    nowhere(h, 'AUDIO-INTO-LUNCH');
  });
});

test('SHOULD-FIX 5: a promotion is recorded as whoever made it: the hub’s screen, or a paired device', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await on(h, id);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'first fact' }, { at: min(h, 2), app: 'Editor', text: 'second fact' }, { at: min(h, 3), app: 'Editor', text: 'third fact' });
    await pull(h, id);
    const evs = (await h.c('GET', '/capture/events')).body as any[];
    const by = (t: string) => evs.find((e) => e.text === t).id;
    const here = (await h.c('POST', '/capture/promote', { event_ids: [by('first fact')] })).body.memory;
    assert.deepEqual([here.recorded_by, here.user_state], ['console', 'confirmed']);
    assert.equal((await h.c('GET', `/capture/memory/${here.id}`)).body[0].by, 'console');

    const { dev, token } = await enroll(h, { kind: 'phone', name: 'Test phone' });
    const there = await call(h.mesh, 'POST', '/api/v1/capture/promote', { event_ids: [by('second fact')], scope: 'personal' }, bearer(token));
    assert.equal(there.status, 201, JSON.stringify(there.body));
    assert.equal(there.body.memory.recorded_by, `device:${dev.deviceId}`);
    assert.equal((await h.c('GET', `/capture/memory/${there.body.memory.id}`)).body[0].by, `device:${dev.deviceId}`);

    // Accepting a proposal, too.
    h.core.decisions.decide = async (t) => ({ template_id: t, version: 1, answers: { remember: 0.95 }, confidence: 0.9, provider: 'stand-in', escalate: false, why: '' });
    await h.c('POST', '/capture/propose');
    const [p] = (await h.c('GET', '/capture/proposals')).body;
    const ok = await call(h.mesh, 'POST', `/api/v1/capture/proposals/${p.id}/accept`, { scope: 'personal' }, bearer(token));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await h.c('GET', `/capture/memory/${ok.body.memory.id}`)).body[0].by, `device:${dev.deviceId}`);
  });
});

test('a Screenpipe that answers too much is refused, not read into memory', async () => {
  const big = 'x'.repeat(17 * 1024 * 1024);
  const sp = new Screenpipe({ url: 'http://127.0.0.1:9', fetch: (async () => new Response(`{"status":"${big}"}`, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
  await assert.rejects(sp.pull({}, '2026-10-29T10:00:00.000Z'), (e) => e instanceof Unreachable && /too much/.test((e as Error).message));
});

test('events triage skipped because no provider could answer are looked at once one can', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await on(h, id);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'The recycling is collected on Thursdays.' });
    await pull(h, id);
    const first = (await h.c('POST', '/capture/propose')).body;
    assert.equal(first.proposed.length, 0, 'nobody could answer');
    h.core.decisions.decide = async (t) => ({ template_id: t, version: 1, answers: { remember: 0.95 }, confidence: 0.9, provider: 'stand-in', escalate: false, why: '' });
    const second = (await h.c('POST', '/capture/propose')).body;
    assert.equal(second.proposed.length, 1, JSON.stringify(second));
    assert.equal((await h.c('GET', '/capture/proposals')).body[0].event.text, 'The recycling is collected on Thursdays.');
  });
});

test('a device’s time with no zone is refused, never read in the server’s zone; a revoked device’s sources go off', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer', purposes: ['capture-source'] });
    await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue', 'capture.app-activity'] }, bearer(token));
    const sid = `device:${dev.deviceId}:app-activity`;
    await on(h, sid);
    h.tick(60_000);
    const r = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', {
      items: [{ key: 'cap-30000001', kind: 'capture_event', body: { kind: 'app-activity', at: '2026-10-29 10:05:00', app: 'Editor', text: 'NO-ZONE' } }],
    }, bearer(token));
    assert.equal(r.body.results[0].ref, undefined, JSON.stringify(r.body));
    assert.match(r.body.results[0].reason, /when it happened/);
    nowhere(h, 'NO-ZONE');

    assert.equal((await h.c('POST', `/mesh/devices/${dev.deviceId}/revoke`, { confirm: true })).status, 200);
    const s = (await h.c('GET', '/capture')).body.sources.find((x: any) => x.id === sid);
    assert.deepEqual([s.enabled, s.active], [false, false]);
    assert.match(s.detail, /removed/);
  } finally {
    await h.stop();
  }
});

test('a Screenpipe that isn’t the hub’s now needs the person: the indicator says so', async () => {
  await withScreenpipe(async (h, _sp, id) => {
    await on(h, id);
    h.core.db.run(`UPDATE capture_source SET device_id = 'another-device' WHERE id = ?`, id);
    await pull(h, id);
    const status = (await h.c('GET', '/capture/status')).body;
    assert.match(status.problem ?? '', /isn’t the hub now/);
  });
});

test('a standby’s pages hear about capture when sync brings it', async () => {
  const h = await hub();
  try {
    // The page reloads capture on a capture change (ui/js/app.js); sync's rows arrive without one.
    const heard: unknown[] = [];
    h.core.capture.on('change', (c) => heard.push(c));
    h.core.mesh.role.emit('applied', { applied: 3, files: 0, cursor: 3 });
    assert.deepEqual(heard, [{ what: 'sync' }]);
  } finally {
    await h.stop();
  }
});
