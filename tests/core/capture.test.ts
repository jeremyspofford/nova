// Capture (M6 plan §1) in one process, against the stand-in Screenpipe: consent off by default and
// per source, the indicator's status, pause, each exclusion kind, private contexts never stored,
// classification and unclassified, the Screenpipe adapter's cursor, outage and reconnect, retention,
// promotion with provenance and its forget, proposals that only propose, event triggers, the
// stream, device agents through the inbox exactly once, and local-only refusing a remote Screenpipe.
// Neutral placeholders only; nothing is captured from this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { call, enroll, hub } from './mesh-support.ts';

type Hub = Awaited<ReturnType<typeof hub>>;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const min = (h: Hub, n: number) => new Date(h.clock.t + n * 60_000).toISOString();

// Every file under a folder that holds these bytes: the database, its write-ahead log, backups.
function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) out.push(p);
  }
  return out;
}

async function withScreenpipe(fn: (h: Hub, sp: Awaited<ReturnType<typeof startFakeScreenpipe>>, id: string) => Promise<void>) {
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

const pull = async (h: Hub, id: string) => (await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/pull`)).body;
const events = async (h: Hub, q = '') => (await h.c('GET', `/capture/events${q}`)).body as any[];

test('consent is off by default and per source: nothing is pulled, nothing stored, no indicator, until it is turned on', async () => {
  await withScreenpipe(async (h, sp, id) => {
    const overview = (await h.c('GET', '/capture')).body;
    assert.equal(overview.sources.length, 1);
    assert.deepEqual([overview.sources[0].enabled, overview.sources[0].active, overview.sources[0].consent], [false, false, null], 'added, but off');
    assert.equal(overview.status.active, false, 'no indicator');
    assert.deepEqual(overview.posture.map((p: { platform: string }) => p.platform), ['desktop', 'android', 'ios']);
    assert.match(overview.posture[2].can, /No passive capture of other apps/);
    sp.add({ at: min(h, -1), app: 'Editor', window: 'notes.txt', text: 'Before consent' });
    assert.deepEqual(await pull(h, id), { kept: 0, dropped: {} });
    assert.equal(sp.requests.length, 0, 'Screenpipe was not even asked');
    assert.equal((await events(h)).length, 0);

    const on = await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    assert.equal(on.status, 200);
    assert.equal(on.body.active, true);
    assert.equal(on.body.consent.by, 'person');
    const status = (await h.c('GET', '/capture/status')).body;
    assert.equal(status.active, true, 'the indicator shows');
    assert.deepEqual(status.capturing.map((c: { name: string }) => c.name), ['Screenpipe']);
    // What Screenpipe kept before consent is not taken in; what comes after is.
    h.tick(5 * 60_000);
    sp.add({ at: min(h, 1), app: 'Editor', window: 'notes.txt', text: 'After consent' });
    const r = await pull(h, id);
    assert.equal(r.kept, 1, JSON.stringify(r));
    const [e] = await events(h);
    assert.equal(e.text, 'After consent');
    assert.equal(e.kind, 'screen');
    assert.equal(e.consent.state, 'granted');
    assert.deepEqual(Object.keys(e.provenance).sort(), ['adapter', 'device_id', 'external_id', 'received_at', 'source_id', 'via']);
    assert.equal(e.provenance.adapter, 'screenpipe');
    assert.equal(e.provenance.via, 'pull');
    assert.equal(e.device.id, h.core.mesh.identity.id, 'captured on the hub');

    // Withdrawn: nothing more, and no indicator.
    assert.equal((await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/disable`)).body.active, false);
    sp.add({ at: min(h, 2), app: 'Editor', text: 'After withdrawal' });
    assert.equal((await pull(h, id)).kept, 0);
    assert.equal((await h.c('GET', '/capture/status')).body.active, false);
  });
});

test('pause: nothing is taken in while paused, nor afterwards from the paused stretch; the indicator says so', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'one' });
    assert.equal((await pull(h, id)).kept, 1);
    h.tick(10 * 60_000);
    const paused = await h.c('POST', '/capture/pause', { paused: true });
    assert.equal(paused.body[0].paused, true);
    const s = (await h.c('GET', '/capture/status')).body;
    assert.deepEqual([s.active, s.paused], [false, 1]);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'while paused' });
    assert.equal((await pull(h, id)).kept, 0);
    h.tick(10 * 60_000);
    await h.c('POST', '/capture/pause', { paused: false });
    sp.add({ at: min(h, 1), app: 'Editor', text: 'after resuming' });
    assert.equal((await pull(h, id)).kept, 1);
    assert.deepEqual((await events(h)).map((e) => e.text), ['after resuming', 'one'], 'the paused stretch never arrives');
  });
});

test('private windows are never stored; each exclusion kind keeps events out; drops are counted, never kept', async () => {
  await withScreenpipe(async (h, sp, id) => {
    const set = await h.c('PUT', '/capture/settings', {
      exclusions: [
        { kind: 'app', app: 'Password Keeper' },
        { kind: 'site', site: 'bank.example' },
        { kind: 'space', space: 'health' },
        { kind: 'time', window: { start: '12:00', end: '13:00' } },
      ],
      signals: [{ kind: 'app', app: 'Clinic Portal', space: 'health' }],
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((await h.c('PUT', '/capture/settings', { exclusions: [{ kind: 'folder' }] })).status, 400);
    assert.equal((await h.c('PUT', '/profile/capture/exclusions', { value: [] })).status, 400, 'only through the checked route');
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    const secret = 'PRIVATE-SENTINEL-4471';
    sp.add(
      { at: min(h, 1), app: 'Browser', window: 'New Incognito Tab - Browser', text: secret },
      { at: min(h, 2), app: 'Browser', window: 'Reading', text: secret, private: true },
      { at: min(h, 3), app: 'Password Keeper', window: 'Vault', text: 'EXCLUDED-APP' },
      { at: min(h, 4), app: 'Browser', window: 'Statement', url: 'https://www.bank.example/acct', text: 'EXCLUDED-SITE' },
      { at: min(h, 5), app: 'Clinic Portal', window: 'Results', text: 'EXCLUDED-SPACE' },
      { at: '2026-10-29T12:30:00.000Z', app: 'Editor', window: 'lunch', text: 'EXCLUDED-TIME' },
      { at: min(h, 6), app: 'Editor', window: 'notes.txt', text: 'kept' },
    );
    const r = await pull(h, id);
    assert.equal(r.kept, 1, JSON.stringify(r));
    assert.deepEqual(r.dropped, { private: 2, excluded: 4 });
    assert.deepEqual((await events(h)).map((e) => e.text), ['kept']);
    const counts = (await h.c('GET', `/capture`)).body.sources[0].counts;
    assert.deepEqual(counts, { kept: 1, private: 2, excluded: 4 });
    for (const word of [secret, 'EXCLUDED-APP', 'EXCLUDED-SITE', 'EXCLUDED-SPACE', 'EXCLUDED-TIME']) {
      assert.deepEqual(holding(h.home, word), [], `${word} is nowhere under the home`);
    }
  });
});

test('classification by the person’s signals; ambiguous and unsignalled stay unclassified until the person resolves them', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('PUT', '/capture/settings', { signals: [{ kind: 'app', app: 'Editor', space: 'work' }, { kind: 'app', app: 'Game', space: 'personal' }, { kind: 'calendar', window: { start: '09:00', end: '17:00' }, space: 'work' }] });
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    sp.add(
      { at: min(h, 1), app: 'Editor', window: 'plan', text: 'work by app and hours' },
      { at: min(h, 2), app: 'Game', window: 'level 3', text: 'personal app during working hours' },
      { at: '2026-10-29T20:00:00Z', app: 'Notes', window: 'evening', text: 'no signal at all' },
    );
    await pull(h, id);
    const all = await events(h);
    const by = (t: string) => all.find((e) => e.text === t);
    assert.deepEqual([by('work by app and hours').space, by('work by app and hours').space_by], ['work', 'signal:app+calendar']);
    assert.equal(by('personal app during working hours').space, null, 'two signals disagree: unclassified, never guessed');
    assert.equal(by('no signal at all').space, null);
    const open = await events(h, '?unclassified=1');
    assert.equal(open.length, 2);
    assert.equal((await h.c('GET', '/capture/status')).body.unclassified, 2);
    const fixed = await h.c('POST', `/capture/events/${by('no signal at all').id}/space`, { space: 'personal', remember: 'app' });
    assert.deepEqual([fixed.body.space, fixed.body.space_by], ['personal', 'person']);
    assert.ok((await h.c('GET', '/capture')).body.settings.signals.some((s: any) => s.kind === 'app' && s.app === 'Notes' && s.space === 'personal'), 'remembered as a signal');
    // The explicit switch wins.
    h.tick(11 * 3_600_000);
    await h.c('PUT', '/capture/settings', { switch: { space: 'study' } });
    sp.add({ at: min(h, 1), app: 'Game', window: 'x', text: 'during the switch' });
    await pull(h, id);
    const during = (await events(h)).find((e) => e.text === 'during the switch');
    assert.deepEqual([during.space, during.space_by], ['study', 'switch']);
  });
});

test('the Screenpipe adapter: its cursor takes each item once; an outage is a problem, not a crash; reconnecting loses nothing', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    // Many items at once, some sharing a timestamp, across Screenpipe's pages.
    for (let i = 0; i < 230; i++) sp.add({ at: min(h, 1 + Math.floor(i / 3)), app: 'Editor', window: 'w', text: `item ${i}` });
    sp.add({ type: 'audio', at: min(h, 2), text: 'a spoken line' });
    assert.equal((await pull(h, id)).kept, 231);
    assert.equal((await pull(h, id)).kept, 0, 'nothing twice');
    sp.add({ at: min(h, 77), app: 'Editor', text: 'same second as the last' });
    assert.equal((await pull(h, id)).kept, 1);

    await sp.down();
    const r = await pull(h, id);
    assert.match(r.error, /isn’t answering/);
    let src = (await h.c('GET', '/capture')).body.sources[0];
    assert.equal(src.status, 'unreachable');
    const problems = () => h.c('GET', '/problems?open=1').then((x) => x.body.filter((p: any) => p.source === 'capture'));
    assert.equal((await problems()).length, 1);
    await pull(h, id);
    assert.equal((await problems()).length, 1, 'one problem for the outage, not one per try');
    assert.equal((await h.c('GET', '/health')).body.checks.capture.ok, false);
    assert.match((await h.c('GET', '/capture/status')).body.problem, /isn’t answering/);

    // Screenpipe kept recording meanwhile: all of it arrives once it's back.
    sp.add({ at: min(h, 80), app: 'Editor', text: 'during the outage' });
    await sp.up();
    assert.equal((await pull(h, id)).kept, 1);
    src = (await h.c('GET', '/capture')).body.sources[0];
    assert.equal(src.status, 'on');
    assert.equal((await problems()).length, 0, 'the problem is resolved');
    assert.equal((await events(h, '?limit=500')).length, 233);
    assert.equal((await events(h, '?kind=audio')).length, 1);
  });
});

test('retention sweeps old capture for real; a promoted memory stays, its provenance keeps when and where', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('PUT', '/capture/settings', { retention_days: 2 });
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'OLD-SENTINEL-1 the gate code is 2468' }, { at: min(h, 2), app: 'Editor', text: 'old and unremarkable' });
    await pull(h, id);
    const [, first] = await events(h);
    const kept = await h.c('POST', '/capture/promote', { event_ids: [first.id], content: 'The gate code is 2468.' });
    assert.equal(kept.status, 201);
    h.tick(3 * 86_400_000);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'new' });
    await pull(h, id);
    const swept = (await h.c('POST', '/capture/sweep')).body;
    assert.equal(swept.swept, 2);
    assert.deepEqual((await events(h)).map((e) => e.text), ['new']);
    assert.deepEqual(holding(h.home, 'OLD-SENTINEL-1'), []);
    const prov = (await h.c('GET', `/capture/memory/${kept.body.memory.id}`)).body;
    assert.deepEqual(prov.map((p: any) => [p.event_id, p.present, p.event_kind]), [[first.id, false, 'screen']]);
    assert.equal((await h.c('GET', '/memory')).body[0].content, 'The gate code is 2468.');
  });
});

test('promotion is deliberate, with provenance back to capture; forgetting either side takes both, everywhere under the home', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    const word = 'PROMOTE-SENTINEL-8812';
    sp.add({ at: min(h, 1), app: 'Editor', window: 'a', text: `${word} the plumber comes Tuesday` }, { at: min(h, 2), app: 'Editor', window: 'b', text: 'FORGET-SENTINEL-5531 only evidence' });
    await pull(h, id);
    assert.equal((await h.c('GET', '/memory')).body.length, 0, 'capture is evidence, not memory');
    const [second, first] = await events(h);
    // A backup taken now holds both, as an upgrade would leave it.
    mkdirSync(join(h.home, 'backups'), { recursive: true });
    h.core.db.raw.exec(`VACUUM INTO '${join(h.home, 'backups', 'nova-test-v8.db')}'`);
    assert.ok(holding(join(h.home, 'backups'), word).length === 1);

    const made = await h.c('POST', '/capture/promote', { event_ids: [first.id] });
    assert.equal(made.status, 201);
    const m = made.body.memory;
    assert.equal(m.content, `${word} the plumber comes Tuesday`);
    assert.deepEqual([m.source, m.observed_at, m.recorded_by, m.user_state], [`capture:${first.id}`, first.at, 'person', 'confirmed']);
    assert.deepEqual((await h.c('GET', `/capture/events/${first.id}`)).body.promoted, [m.id]);
    assert.equal((await h.c('GET', `/capture/memory/${m.id}`)).body[0].present, true);

    // Forgetting the memory takes the capture it came from.
    assert.equal((await h.c('DELETE', `/memory/${m.id}`)).status, 200);
    assert.equal((await h.c('GET', `/capture/events/${first.id}`)).status, 404);
    assert.deepEqual(holding(h.home, word), [], 'gone from the database, its write-ahead log and the backup');

    // Forgetting a captured event: here and in the backup, and it can't be pulled back.
    const gone = await h.c('DELETE', `/capture/events/${second.id}`);
    assert.deepEqual(gone.body.forgotten, [second.id]);
    assert.deepEqual(holding(h.home, 'FORGET-SENTINEL-5531'), []);
    sp.items.find((i: any) => i.text.startsWith('FORGET'))!.at = min(h, 3);
    // Even read again (a cursor reset), a forgotten item stays forgotten.
    h.core.db.run(`UPDATE capture_source SET cursor = json_set(cursor, '$.read', json('{}'))`);
    const again = await pull(h, id);
    assert.equal(again.kept, 0, JSON.stringify(again));
    assert.equal(again.dropped.forgotten, 2, 'both forgotten items, read again, stay out');
    // Sync's log carries only content-free deletes.
    assert.equal(h.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_log WHERE instr(row, 'SENTINEL') > 0`)!.n, 0);
  });
});

test('a forgotten event takes the memory promoted from it unless the person keeps it', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'first fact' }, { at: min(h, 2), app: 'Editor', text: 'second fact' });
    await pull(h, id);
    const [b, a] = await events(h);
    const ma = (await h.c('POST', '/capture/promote', { event_ids: [a.id] })).body.memory;
    const mb = (await h.c('POST', '/capture/promote', { event_ids: [b.id], content: 'Second, in my words.' })).body.memory;
    const r1 = (await h.c('DELETE', `/capture/events/${a.id}`)).body;
    assert.deepEqual(r1.memories, [ma.id]);
    const r2 = (await h.c('DELETE', `/capture/events/${b.id}?keep_memory=1`)).body;
    assert.deepEqual(r2.memories, []);
    assert.deepEqual((await h.c('GET', '/memory')).body.map((x: any) => x.id), [mb.id]);
  });
});

test('a triage decision may only propose: nothing is memory until the person accepts; an unsure answer proposes nothing', async () => {
  await withScreenpipe(async (h, sp, id) => {
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    sp.add({ at: min(h, 1), app: 'Editor', text: 'The recycling is collected on Thursdays.' }, { at: min(h, 2), app: 'Editor', text: 'scrolling' });
    await pull(h, id);
    // With no provider that can answer (the built-in rules have none for this), nothing is proposed.
    let r = (await h.c('POST', '/capture/propose')).body;
    assert.deepEqual([r.looked, r.proposed.length], [2, 0]);
    assert.ok(h.core.templates.get('capture-promote'), 'the template is built in');

    // A decision provider that answers (here a stand-in for a local model).
    sp.add({ at: min(h, 3), app: 'Editor', text: 'The recycling moved to Wednesdays.' }, { at: min(h, 4), app: 'Editor', text: 'more scrolling' });
    await pull(h, id);
    const decide = h.core.decisions.decide.bind(h.core.decisions);
    h.core.decisions.decide = async (t, inputs) => (t === 'capture-promote'
      ? { template_id: t, version: 1, answers: { remember: /recycling/.test(String(inputs.text)) ? 0.95 : 0.55 }, confidence: 0.9, provider: 'stand-in', escalate: !/recycling/.test(String(inputs.text)), why: '' }
      : decide(t, inputs));
    r = (await h.c('POST', '/capture/propose')).body;
    assert.deepEqual([r.looked, r.proposed.length], [2, 1]);
    assert.equal((await h.c('GET', '/memory')).body.length, 0, 'a proposal is not a memory');
    const [p] = (await h.c('GET', '/capture/proposals')).body;
    assert.equal(p.event.text, 'The recycling moved to Wednesdays.');
    assert.deepEqual([p.provider, p.p], ['stand-in', 0.95]);
    assert.equal((await h.c('GET', '/capture/status')).body.proposals, 1);
    const ok = await h.c('POST', `/capture/proposals/${p.id}/accept`, {});
    assert.equal(ok.status, 201);
    assert.equal(ok.body.memory.recorded_by, 'person');
    const prov = (await h.c('GET', `/capture/memory/${ok.body.memory.id}`)).body;
    assert.equal(prov[0].proposal_id, p.id, 'the proposal is part of the audit trail');
    assert.equal((await h.c('GET', '/capture/proposals')).body.length, 0);
    assert.equal((await h.c('POST', `/capture/proposals/${p.id}/dismiss`)).status, 404);
  });
});

test('capture feeds event rules, and capture.stream(device, kind) hands readers normalized events', async () => {
  await withScreenpipe(async (h, sp, id) => {
    const rule = await h.c('POST', '/triggers/rules', { name: 'Something to sort', class: 'event', connector: 'capture', topic: 'unclassified', action: { kind: 'message', text: 'Something captured needs a space.' }, dedup_window_s: 0 });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    assert.equal((await h.c('POST', '/triggers/rules', { name: 'x', class: 'event', connector: 'capture', topic: 'folder:/tmp', action: { kind: 'message', text: 'x' } })).status, 400);
    await h.c('POST', `/capture/sources/${encodeURIComponent(id)}/enable`);
    const seen: any[] = [];
    const stream = h.core.capture.stream(h.core.mesh.identity.id, 'audio');
    const off = stream.subscribe((e) => seen.push(e));
    const it = h.core.capture.stream(null, null)[Symbol.asyncIterator]();
    sp.add({ at: min(h, 1), app: 'Editor', text: 'unsorted' }, { type: 'audio', at: min(h, 2), text: 'a call' });
    await pull(h, id);
    off();
    assert.deepEqual(seen.map((e) => e.kind), ['audio'], 'only the device and kind asked for');
    assert.equal(stream.recent().length, 1);
    assert.equal((await it.next()).value.text, 'unsorted');
    await it.return?.();
    const fired = await (async () => { for (let i = 0; i < 40; i++) { const l = (await h.c('GET', `/triggers?rule=${rule.body.rule.id}`)).body; if (l.length >= 2) return l; await new Promise((r) => setTimeout(r, 25)); } return []; })();
    assert.equal(fired.length, 2, 'both events are unclassified');
    assert.equal(fired[0].source, 'connector:capture/unclassified');
    assert.ok(fired.every((t: any) => /^[0-9a-f]{64}$/.test(t.payload_ref)), 'the trigger keeps a hash, never the words');
  });
});

test('a device agent’s capture events through the inbox: offered by its heartbeat, off until consent, exactly once, private never kept', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    const hb = await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue', 'capture.app-activity'] }, bearer(token));
    assert.equal(hb.status, 200);
    const sources = (await h.c('GET', '/capture')).body.sources;
    assert.deepEqual(sources.map((s: any) => [s.id, s.name, s.enabled, s.device.name]), [[`device:${dev.deviceId}:app-activity`, 'App activity', false, 'Test computer']]);
    const send = (items: unknown[]) => call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items }, bearer(token));
    const item = (key: string, body: Record<string, unknown>) => ({ key, kind: 'capture_event', body: { kind: 'app-activity', at: min(h, 1), ...body } });

    let r = await send([item('cap-00000001', { app: 'Editor', window_title: 'report', text: 'BEFORE-CONSENT-SENTINEL' })]);
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].status, 'accepted');
    assert.match(r.body.results[0].reason, /Not kept: App activity is off/);
    assert.equal(r.body.results[0].ref, undefined);
    assert.deepEqual(holding(h.home, 'BEFORE-CONSENT-SENTINEL'), []);

    await h.c('POST', `/capture/sources/${encodeURIComponent(`device:${dev.deviceId}:app-activity`)}/enable`);
    h.tick(60_000);
    r = await send([
      item('cap-00000002', { app: 'Editor', window_title: 'report', text: 'kept from the device' }),
      item('cap-00000003', { app: 'Browser', window_title: 'InPrivate - Browser', text: 'PRIVATE-DEVICE-SENTINEL' }),
      { key: 'cap-00000004', kind: 'capture_event', body: { kind: 'telepathy', at: min(h, 1) } },
    ]);
    assert.deepEqual(r.body.results.map((x: any) => x.status), ['accepted', 'accepted', 'refused']);
    const ref = r.body.results[0].ref;
    assert.ok(ref);
    assert.match(r.body.results[1].reason, /Private and incognito windows are never kept/);
    // Again, as after a lost reply: the same answer, and still one event.
    r = await send([item('cap-00000002', { app: 'Editor', window_title: 'report', text: 'kept from the device' })]);
    assert.deepEqual([r.body.results[0].duplicate, r.body.results[0].ref], [true, ref]);
    const evs = (await h.c('GET', '/capture/events')).body;
    assert.deepEqual(evs.map((e: any) => [e.id, e.kind, e.provenance.via, e.device.id]), [[ref, 'app-activity', 'inbox', dev.deviceId]]);
    assert.deepEqual(holding(h.home, 'PRIVATE-DEVICE-SENTINEL'), []);
    // The inbox keeps the key and the event's id, never the body.
    const row = h.core.db.get<{ body: string | null; ref: string }>('SELECT body, ref FROM device_inbox WHERE key = ?', 'cap-00000002')!;
    assert.deepEqual([row.body, row.ref], [null, ref]);
  } finally {
    await h.stop();
  }
});

test('local-only refuses a Screenpipe outside the person’s devices, and stops pulling one when privacy tightens', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-capture-remote-'));
  const asked: string[] = [];
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, capture: { fetch: (async (u: string) => { asked.push(String(u)); throw new Error('no network in this test'); }) as unknown as typeof fetch } });
  try {
    const s = core.capture.addScreenpipe({ url: 'http://203.0.113.10:3030' });
    assert.equal(s.egress, 'remote');
    assert.throws(() => core.capture.enable(s.id, { by: 'person' }), /outside your devices.*local-only/);
    assert.equal(core.capture.source(s.id).enabled, false);
    // Allowed when the person's setting allows it; refused again, without asking, once it tightens.
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    core.capture.enable(s.id, { by: 'person' });
    core.profile.set('privacy', 'default', 'local-only', 'settings');
    const r = await core.capture.pull(s.id);
    assert.match((r as { error: string }).error, /local-only/);
    assert.equal(core.capture.source(s.id).status, 'refused');
    assert.deepEqual(asked, [], 'nothing was sent anywhere');
    // A Screenpipe on another of the person's own devices is local.
    const local = core.capture.addScreenpipe({ url: 'http://192.168.1.20:3030' });
    assert.equal(local.egress, 'local');
  } finally {
    await core.close();
  }
});
