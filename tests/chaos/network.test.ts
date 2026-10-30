// Chaos pass, the network (M7 plan §3): the standby partitioned from the hub, a slow link, a device
// offline with work queued on it, a device agent stuck in safe mode, and name lookups (DNS)
// failing. Everything is on loopback through a proxy the test controls, with an injected resolver:
// no real network and no real DNS query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../../src/device/queue.ts';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { bootCore } from '../core/connector-support.ts';
import { call, enroll, hub } from '../core/mesh-support.ts';
import { pair, proxy } from './mesh.ts';
import { problemWith, repairs, sleep, until } from './support.ts';

const caughtUp = (p: Awaited<ReturnType<typeof pair>>) => until(() => p.core.mesh.sync.cursor(), (c) => c >= p.h.core.mesh.sync.head(), 20_000, 'the standby to catch up');

test('the standby partitioned from the hub: behind is a problem on both sides, and both close once it copies again', { timeout: 90_000 }, async () => {
  const p = await pair();
  try {
    p.core.start();
    await caughtUp(p);
    p.link.cut();
    p.h.core.memory.remember({ kind: 'fact', content: 'Written while the standby was cut off.', recorded_by: 'person' });
    p.h.tick(5 * 60_000);
    p.h.core.mesh.role.checkLag();
    const onHub = await problemWith(p.h.core, 'standby-behind');
    assert.match(onHub.message, /fallen behind/);
    const r = await repairs(p.h.core, onHub.id);
    assert.equal(r[0]!.ok, false, 'while cut off, it is still behind');
    // The standby's own notice comes after a minute of wall time (replica.ts); recorded here in its
    // words, so its playbook's repair, copying again, can be tried while cut off and after.
    p.core.log.problem('sync', `The standby hasn’t reached the hub at ${p.link.url} for a minute: the hub can’t be reached.`);
    const onStandby = await problemWith(p.core, 'standby-behind');
    const still = await repairs(p.core, onStandby.id);
    assert.equal(still[0]!.ok, false, 'cut off, it can’t copy');
    p.link.heal();
    const fixed = await p.core.resilience.playbooks.attempt(onStandby.id, 'person');
    assert.equal(fixed.ok, true, fixed.said);
    await caughtUp(p);
    assert.ok(p.core.memory.list().some((m) => m.content === 'Written while the standby was cut off.'));
    const back = await p.h.core.resilience.playbooks.attempt(onHub.id, 'person');
    assert.equal(back.ok, true, back.said);
    assert.equal(p.h.core.log.problems({ open: true }).some((x) => x.id === onHub.id), false);
  } finally {
    await p.stop();
  }
});

test('a slow link: sync keeps up, slowly, with no false alarm and no failover', { timeout: 90_000 }, async () => {
  const p = await pair({ failoverAfterS: 1 });
  try {
    p.link.slow(250);
    p.core.start();
    for (let i = 0; i < 5; i++) p.h.core.memory.remember({ kind: 'fact', content: `Slow fact ${i}`, recorded_by: 'person' });
    await caughtUp(p);
    assert.equal(p.core.mesh.role.role(), 'standby', 'slow is not down: no failover');
    assert.equal(p.core.memory.list().filter((m) => m.content.startsWith('Slow fact')).length, 5);
    assert.deepEqual(p.core.log.problems({ open: true }).map((x) => x.message), []);
  } finally {
    await p.stop();
  }
});

test('a device offline: shown as offline, its queue kept, and on reconnect each item taken in exactly once', async () => {
  const h = await hub();
  const link = await proxy(() => Number(new URL(h.mesh).port));
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Example desk' });
    const q = new Queue(join(mkdtempSync(join(tmpdir(), 'nova-chaos-queue-')), 'queue'));
    for (const n of [1, 2, 3]) q.add('memory_note', { kind: 'fact', content: `Queued note ${n}` }, `note-key-000${n}`);
    const send = () => call(link.url, 'POST', '/api/v1/mesh/inbox', { items: q.pending().map((i) => ({ key: i.key, kind: i.kind, body: i.body, created_at: i.created_at })) }, { authorization: `Bearer ${token}` });
    link.cut();
    await assert.rejects(send(), 'unreachable while offline');
    assert.equal(q.counts().pending, 3, 'kept on the device');
    h.tick(10 * 60_000);
    const view = (await h.c('GET', '/mesh/devices')).body.find((d: { id: string }) => d.id === dev.deviceId);
    assert.equal(view.online, false, 'the hub shows it offline');
    link.heal();
    const first = await send();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // The reply is lost: the device sends the same items again. Nothing happens twice.
    const again = await send();
    assert.ok(again.body.results.every((r: { duplicate?: boolean }) => r.duplicate), JSON.stringify(again.body));
    q.settle(again.body.results);
    assert.deepEqual(q.counts(), { pending: 0, delivered: 3, refused: 0 });
    assert.equal(h.core.memory.list().filter((m) => m.content.startsWith('Queued note')).length, 3);
  } finally {
    link.close();
    await h.stop();
  }
});

test('a device agent in safe mode: a problem with its playbook; Nova asks its boot agent once to restart the runtime; it closes when running again', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Example desk' });
    const beat = (safe: boolean) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { safe_mode: safe, runtime_version: 'r1' }, { authorization: `Bearer ${token}` });
    assert.equal((await beat(true)).status, 200);
    const p = await problemWith(h.core, 'device-safe-mode', { subject: dev.deviceId });
    const r = await repairs(h.core, p.id);
    assert.match(r[0]!.said, /Asked Example desk’s boot agent to start its runtime again/);
    // The ask goes out once, with the next heartbeat in safe mode.
    assert.equal((await beat(true)).body.restart_runtime, true);
    assert.equal((await beat(true)).body.restart_runtime, undefined);
    // The boot agent restarted it: running again closes the problem.
    await beat(false);
    const done = await h.core.resilience.playbooks.attempt(p.id, 'person');
    assert.equal(done.ok, true, done.said);
    assert.equal(h.core.log.problems({ open: true }).some((x) => x.id === p.id), false);
  } finally {
    await h.stop();
  }
});

test('DNS failing: a connection that can’t reconnect because its name won’t resolve says so, and closes once the name resolves again', { timeout: 60_000 }, async () => {
  const ha = await startFakeHomeAssistant();
  const port = new URL(ha.base).port;
  // The resolver, injected for this process: "ha-box" is this machine, until DNS fails.
  let dnsUp = true;
  const original = dns.lookup;
  const fail = (host: string) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host });
  (dns as { lookup: unknown }).lookup = (host: string, opts: unknown, cb?: unknown) => {
    const done = (typeof opts === 'function' ? opts : cb) as (e: Error | null, a?: unknown, f?: number) => void;
    const all = typeof opts === 'object' && (opts as { all?: boolean })?.all;
    if (host !== 'ha-box') return original(host, opts as never, done as never);
    if (!dnsUp) return process.nextTick(() => done(fail(host)));
    process.nextTick(() => (all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)));
  };
  const resolve = async (host: string) => { if (!dnsUp && host === 'ha-box') throw fail(host); return ['127.0.0.1']; };
  const via = (input: string | URL | Request, init?: RequestInit) => {
    if (!dnsUp) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: fail('ha-box') }));
    return fetch(String(input).replace(/^http:\/\/ha-box:\d+/, ha.base), init);
  };
  const nova = await bootCore({ homeAssistant: { fetch: via as typeof fetch, lookup: resolve, reconnectMs: { first: 30, max: 200 }, timeoutMs: 2000 }, resilience: { lookup: resolve } });
  try {
    const ok = await nova.call('POST', '/connectors/home-assistant/connect', { url: `http://ha-box:${port}`, token: ha.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await until(() => nova.core.connectors.view('home-assistant').live, (l) => l === 'listening', 10_000, 'the live connection');

    // DNS fails, and the connection drops: every reconnect fails at the name.
    dnsUp = false;
    await ha.close();
    await until(() => nova.core.connectors.view('home-assistant').live, (l) => l === 'reconnecting', 10_000, 'reconnecting');
    await nova.core.resilience.sweep();
    await nova.core.resilience.sweep();
    const p = await problemWith(nova.core, 'name-lookup', { subject: 'home-assistant' });
    assert.match(p.message, /can’t look up the name ha-box/);
    assert.match(p.message, /nothing is sent anywhere else instead/);

    // The name resolves again and Home Assistant is back: the next look closes the problem.
    const back = await startFakeHomeAssistant({ port: Number(port), token: ha.token });
    dnsUp = true;
    try {
      await until(() => nova.core.connectors.view('home-assistant').live, (l) => l === 'listening', 15_000, 'listening again');
      await nova.core.resilience.sweep();
      await until(() => nova.core.log.problems({ open: true }).some((x) => x.id === p.id), (open) => !open, 10_000, 'the problem to close');
    } finally {
      await back.close();
    }
  } finally {
    (dns as { lookup: unknown }).lookup = original;
    await nova.stop();
    await sleep(10);
  }
});
