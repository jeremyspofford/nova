// Capture against the real server (M6 plan §1), with the egress tripwire preloaded and the
// stand-in Screenpipe: the hub pulls on its own, a private window is never stored, an outage is a
// problem and reconnecting loses nothing, a remote Screenpipe is refused under local-only, and
// nothing captured reaches the home's git history. Then two real processes (M4's helpers): capture
// replicates to the standby, and forgetting (an event, and a memory promoted from capture) holds on
// both nodes, in their databases, write-ahead logs and backups; after a failover the new hub doesn't
// pull the old hub's own Screenpipe. Neutral placeholders only; nothing real is captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCheckServer } from '../support/capture-check.ts';
import { DatabaseSync } from 'node:sqlite';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { blank, stop, until, type Running } from './support.ts';
import { agent, kill, setup } from './m4c-support.ts';

function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) out.push(p);
  }
  return out;
}

// A backup of a running node's database, as an upgrade leaves one.
function backup(home: string, name: string) {
  mkdirSync(join(home, 'backups'), { recursive: true });
  const db = new DatabaseSync(join(home, 'nova.db'));
  try { db.exec(`VACUUM INTO '${join(home, 'backups', name)}'`); } finally { db.close(); }
}

const enc = encodeURIComponent;
const at = (base: number, minutes: number) => new Date(base + minutes * 60_000).toISOString();

test('M6a: the real server pulls Screenpipe on its own, never stores a private window, rides out an outage, refuses a remote Screenpipe, keeps capture out of git', { timeout: 120_000 }, async () => {
  const sp = await startFakeScreenpipe();
  const m = blank('nova-m6a-');
  let nova: Running | null = null;
  try {
    nova = await m.start({ ...agent, NOVA_CAPTURE_POLL_MS: '150' });
    const src = (await m.send('POST', '/api/v1/capture/sources/screenpipe', { url: sp.base })).body;
    assert.equal(src.enabled, false, 'off until consent');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sp.requests.length, 0, 'not even asked before consent');
    assert.equal((await m.send('POST', `/api/v1/capture/sources/${enc(src.id)}/enable`)).status, 200);
    const t0 = Date.now();
    sp.add(
      { at: at(t0, 1), app: 'Editor', window: 'plan.md', text: 'GIT-SENTINEL-3307 draft the plan' },
      { at: at(t0, 1), app: 'Browser', window: 'New Incognito Tab - Browser', text: 'INCOGNITO-SENTINEL-1190' },
    );
    const evs = await until(() => m.get('/api/v1/capture/events'), (l: any[]) => l.length >= 1, 200);
    assert.deepEqual(evs.map((e: any) => e.text), ['GIT-SENTINEL-3307 draft the plan']);
    assert.equal((await m.get('/api/v1/capture/status')).active, true);

    // An outage: one problem, no crash; what Screenpipe kept meanwhile arrives once it's back.
    await sp.down();
    await until(() => m.get('/api/v1/capture'), (c: any) => c.sources[0].status === 'unreachable', 200);
    const problems = (await m.get('/api/v1/problems?open=1')).filter((p: any) => p.source === 'capture');
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /isn’t answering.*nothing Screenpipe keeps meanwhile is lost/);
    sp.add({ at: at(t0, 2), app: 'Editor', window: 'plan.md', text: 'while it was down' });
    await sp.up();
    await until(() => m.get('/api/v1/capture/events'), (l: any[]) => l.length >= 2, 200);
    assert.equal((await m.get('/api/v1/capture')).sources[0].status, 'on');
    assert.equal((await m.get('/api/v1/problems?open=1')).filter((p: any) => p.source === 'capture').length, 0);

    // A Screenpipe outside the person's devices: refused under local-only, and nothing is sent.
    const remote = await m.send('PATCH', `/api/v1/capture/sources/${enc(src.id)}`, { url: 'http://203.0.113.10:3030' });
    assert.equal(remote.status, 403);
    assert.match(remote.body.error, /outside your devices.*local-only/);

    // Nothing captured is in the home's git history, even after a commit of everything there.
    execFileSync('git', ['-C', m.home, 'add', '-A']);
    execFileSync('git', ['-C', m.home, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-q', '--allow-empty', '-m', 'test: everything']);
    const history = execFileSync('git', ['-C', m.home, 'log', '--all', '-p', '--format=%H'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    assert.equal(history.includes('GIT-SENTINEL-3307'), false, 'not in git history');
    assert.equal(execFileSync('git', ['-C', m.home, 'ls-files']).toString().includes('nova.db'), false);
    assert.deepEqual(holding(m.home, 'INCOGNITO-SENTINEL-1190'), [], 'the private window is nowhere');

    // Forgotten for real.
    await m.send('DELETE', `/api/v1/capture/events/${evs[0].id}`);
    assert.deepEqual(holding(m.home, 'GIT-SENTINEL-3307'), []);
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'the egress tripwire saw nothing');
  } finally {
    if (nova) await stop(nova);
    await sp.close();
  }
});

test('M6a: capture replicates to the standby; forgetting holds on both nodes, backups included; a new hub leaves the old hub’s Screenpipe alone', { timeout: 180_000 }, async () => {
  const sp = await startFakeScreenpipe();
  // A trusted capture-sensitive check on the hub (the Tev1 stand-in), so captured text can be
  // remembered (screening, job 1).
  const check = await captureCheckServer(mkdtempSync(join(tmpdir(), 'nova-m6a-check-')));
  const s = await setup('nova-m6a', () => {}, check.env);
  const { hub, standby } = s;
  let hubProc: Running | null = s.hubProc;
  let standbyProc: Running | null = null;
  try {
    standbyProc = await standby.start(s.env(s.standbyMesh));
    const src = (await hub.send('POST', '/api/v1/capture/sources/screenpipe', { url: sp.base })).body;
    await hub.send('POST', `/api/v1/capture/sources/${enc(src.id)}/enable`);
    const t0 = Date.now();
    sp.add(
      { at: at(t0, 1), app: 'Editor', window: 'a', text: 'EVENT-SENTINEL-6620 only evidence' },
      { at: at(t0, 2), app: 'Editor', window: 'b', text: 'MEMORY-SENTINEL-7731 the boiler is serviced in March' },
      { at: at(t0, 3), app: 'Editor', window: 'c', text: 'stays' },
    );
    assert.equal((await hub.send('POST', `/api/v1/capture/sources/${enc(src.id)}/pull`)).body.kept, 3);
    await until(() => hub.send('POST', '/api/v1/capture/screen').then(() => hub.get('/api/v1/capture/events')), (l: any[]) => l.every((e) => e.sensitivity.state === 'index'), 200);
    const evs = await hub.get('/api/v1/capture/events');
    const byText = (t: string) => evs.find((e: any) => e.text.startsWith(t));
    const promoted = (await hub.send('POST', '/api/v1/capture/promote', { event_ids: [byText('MEMORY-SENTINEL').id] })).body.memory;

    // The standby has the source (with its consent), the events and the memory.
    const there = await until(() => standby.get('/api/v1/capture/events'), (l: any[]) => l.length === 3, 400);
    assert.equal(there.length, 3);
    const standbySource = (await standby.get('/api/v1/capture')).sources[0];
    assert.deepEqual([standbySource.id, standbySource.enabled, !!standbySource.consent], [src.id, true, true]);
    await until(() => standby.get('/api/v1/memory'), (l: any[]) => l.some((x: any) => x.id === promoted.id), 400);
    // Backups on both nodes that hold all of it, as upgrades would leave them.
    for (const n of [hub, standby]) backup(n.home, 'nova-test-v8.db');
    for (const n of [hub, standby]) for (const w of ['EVENT-SENTINEL-6620', 'MEMORY-SENTINEL-7731']) assert.ok(holding(join(n.home, 'backups'), w).length > 0);

    // Forget one event, and the promoted memory (which takes its capture with it).
    assert.equal((await hub.send('DELETE', `/api/v1/capture/events/${byText('EVENT-SENTINEL').id}`)).status, 200);
    assert.equal((await hub.send('DELETE', `/api/v1/memory/${promoted.id}`)).status, 200);
    await until(() => standby.get('/api/v1/capture/events'), (l: any[]) => l.length === 1, 400);
    await until(() => standby.get('/api/v1/memory'), (l: any[]) => !l.some((x: any) => x.id === promoted.id), 400);
    for (const w of ['EVENT-SENTINEL-6620', 'MEMORY-SENTINEL-7731']) {
      const left = await until(async () => [...holding(hub.home, w), ...holding(standby.home, w)], (l) => l.length === 0, 400);
      assert.deepEqual(left, [], `${w}: gone from both nodes' databases, write-ahead logs and backups`);
    }
    assert.deepEqual((await standby.get('/api/v1/capture/events')).map((e: any) => e.text), ['stays']);

    // Failover: the standby becomes hub and keeps the consent, but doesn't pull the old hub's own
    // Screenpipe (on the old hub's loopback) in its name.
    await kill(hubProc);
    hubProc = null;
    assert.equal((await standby.send('POST', '/api/v1/mesh/promote', { confirm: true })).status, 200);
    const asked = sp.requests.length;
    const r = await standby.send('POST', `/api/v1/capture/sources/${enc(src.id)}/pull`);
    assert.match(r.body.error, /isn’t the hub now/);
    assert.equal(sp.requests.length, asked, 'nothing was pulled');
    for (const n of [hub, standby]) assert.equal(readFileSync(n.egress, 'utf8'), '', 'the egress tripwire saw nothing');
  } finally {
    if (hubProc) await stop(hubProc);
    if (standbyProc) await stop(standbyProc);
    await sp.close();
    await check.close();
  }
});
