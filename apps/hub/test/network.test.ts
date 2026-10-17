// The network area (FR-135, FR-139; docs/22 §2, §6, §9): endpoints and their health checks, mDNS
// with a fake responder, PATCH with its audit and change record, rollback, the reachability test,
// diagnostics, Mesh and Relay sources, and a real loopback check against a running Hub.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NovaError, type EndpointCandidate } from '@nova/shared';
import { probeHello } from '@nova/core';
import { Logger, MemorySink } from '@nova/telemetry';
import { buildHub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { setupNetwork } from '../src/network.ts';
import { ACCOUNT, iface, networkDb, networkEnv, type NetworkEnv } from './network-env.ts';

let env: NetworkEnv | null = null;
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await env?.close();
  env = null;
  for (const c of cleanups.splice(0)) await c();
});

const LISTENER = { host: '0.0.0.0', port: 7419, protocol: 'http' as const };
const LAN = 'http://192.168.1.10:7419';
const MDNS = 'http://study-pc.local:7419';

function candidate(
  transport: 'mesh' | 'relay',
  url: string,
  health: EndpointCandidate['health'] = 'unknown',
): EndpointCandidate {
  return { transport, url, priority: 0, health, latencyMs: null, checkedAt: null, detail: null };
}

async function started(): Promise<NetworkEnv> {
  env = await networkEnv();
  env.area.useHubIdentity(() => ({ fingerprint: 'hub-fp_123' }));
  env.probe.set(LAN, true, 3);
  env.probe.set(MDNS, true, 4);
  await env.area.listening(LISTENER);
  return env;
}

describe('the network panel', () => {
  it('shows nothing advertised until the Hub reports where it listens', async () => {
    env = await networkEnv();
    const r = await env.api('GET', '/api/v1/network');
    expect(r.status).toBe(200);
    expect(r.json.advertised).toEqual([]);
    expect(r.json.listener).toBeNull();
    expect(
      r.json.transports.map((t: { transport: string; status: string }) => [t.transport, t.status]),
    ).toEqual([
      ['lan', 'none'],
      ['mesh', 'none'],
      ['relay', 'none'],
      ['direct', 'off'],
    ]);
    expect(r.json.transports[0].detail).toMatch(/not reported/);
    expect((await env.api('POST', '/api/v1/network/test')).json.error.details.reason).toBe(
      'no_listener',
    );
    expect(env.area.endpoints()).toEqual([]);
    const d = await env.api('GET', '/api/v1/network/diagnostics');
    expect(d.json.problems[0]).toMatch(/has not reported where it listens/);
  });

  it('advertises the healthy LAN address and its mDNS name, and answers mDNS', async () => {
    const e = await started();
    expect(e.area.endpoints().map((c) => [c.transport, c.url, c.priority])).toEqual([
      ['lan', LAN, 10],
      ['lan', MDNS, 11],
    ]);
    const r = await e.api('GET', '/api/v1/network');
    expect(r.json).toMatchObject({
      primary: 'lan',
      listener: LISTENER,
      lan: { mdns: { enabled: true, running: true, name: 'study-pc' } },
      directPublic: { url: null },
      healthCheckSeconds: 60,
      egress: { mode: 'allowlist', href: '/api/v1/egress' },
      wakeHelpers: { configured: [], available: [] },
      lastChange: null,
    });
    // mDNS: one responder, answering with the healthy LAN address and the TXT of v=1 + fingerprint.
    expect(e.responders).toHaveLength(1);
    const last = e.responders[0]!.sent.at(-1)!;
    expect(last.answers.find((a) => a.type === 'A')?.data).toBe('192.168.1.10');
    expect(last.answers.find((a) => a.type === 'TXT')?.data).toEqual(['v=1', 'fp=hub-fp_123']);
    expect(last.answers.find((a) => a.type === 'SRV')?.data).toMatchObject({ port: 7419 });
    expect(await e.area.hostNames()).toEqual(['study-pc.local']);
    // The probes checked the Hub's own identity.
    expect(e.probe.calls.every((c) => c.opts.expectFingerprint === 'hub-fp_123')).toBe(true);
    expect(await e.diagnostics.collect()).toMatchObject({
      network: { primary: 'lan', advertised: 2, mdns: true },
    });
    // Endpoint events were persisted for clients.
    const names = (await e.events.since(null, 100)).map((ev) => ev.name);
    expect(names).toContain('network.endpoints.changed');
    expect(names).toContain('network.transport.changed');
  });

  it('runs no mDNS while the Hub listens on loopback only, and says why LAN is empty', async () => {
    env = await networkEnv();
    await env.area.listening({ host: '127.0.0.1', port: 7419, protocol: 'http' });
    expect(env.responders).toHaveLength(0);
    const r = await env.api('POST', '/api/v1/network/test');
    expect(r.json.transports[0]).toMatchObject({ transport: 'lan', status: 'none' });
    expect(r.json.transports[0].detail).toMatch(/listens on 127.0.0.1 only/);
    const d = await env.api('GET', '/api/v1/network/diagnostics');
    expect(d.json.problems.join('\n')).toMatch(/LAN: the Hub listens on 127.0.0.1 only/);
  });

  it('withdraws a dead endpoint on test, logs it, and re-adds it', async () => {
    const e = await started();
    e.probe.set(LAN, false);
    e.probe.set(MDNS, false);
    const dead = await e.api('POST', '/api/v1/network/test');
    expect(dead.status).toBe(200);
    expect(dead.json.advertised).toEqual([]);
    expect(dead.json.primary).toBeNull();
    expect(e.area.endpoints()).toEqual([]);
    // mDNS stops answering with an address that fails.
    expect(e.responders[0]!.sent.at(-1)!.answers.every((a) => a.ttl === 0)).toBe(true);
    const diag = await e.api('GET', '/api/v1/network/diagnostics');
    expect(diag.json.events.slice(0, 4).map((x: { kind: string }) => x.kind)).toEqual(
      expect.arrayContaining(['withdrawn', 'down', 'primary']),
    );
    expect(diag.json.problems).toContain(
      'No endpoint passes its reachability test, so none is advertised.',
    );
    expect(
      diag.json.problems.some((p: string) =>
        p.startsWith('LAN: http://192.168.1.10:7419 connection refused'),
      ),
    ).toBe(true);
    e.probe.set(LAN, true);
    e.probe.set(MDNS, true);
    const back = await e.api('POST', '/api/v1/network/test');
    expect(back.json.advertised.map((c: { url: string }) => c.url)).toEqual([LAN, MDNS]);
    const ep = (await e.api('GET', '/api/v1/network/diagnostics')).json.endpoints[0];
    expect(ep).toMatchObject({ url: LAN, uptime24h: { checks: 3, ok: 2 } });
  });

  it('takes Mesh and Relay from their sources, in order after the LAN', async () => {
    const e = await started();
    e.probe.set('http://100.100.1.2:7419', true, 30);
    e.area.useEndpointSource({
      transport: 'mesh',
      list: () => Promise.resolve([candidate('mesh', 'http://100.100.1.2:7419')]),
    });
    const off = e.area.useEndpointSource({
      transport: 'relay',
      list: () => Promise.resolve([candidate('relay', 'wss://relay.example/hub', 'ok')]),
    });
    const r = await e.area.test();
    expect(r.advertised.map((c) => c.transport)).toEqual(['lan', 'lan', 'mesh', 'relay']);
    // LAN goes away: Mesh is preferred, and the fallback is logged.
    e.probe.set(LAN, false);
    e.probe.set(MDNS, false);
    expect((await e.area.test()).primary).toBe('mesh');
    const events = (await e.api('GET', '/api/v1/network/diagnostics')).json.events;
    expect(events[0]).toMatchObject({ kind: 'primary', transport: 'mesh', fromTransport: 'lan' });
    off();
    expect(e.area.classify('100.100.1.2:7419')).toBe('mesh');
    expect(e.area.classify('192.168.1.10:7419')).toBe('lan');
    expect(e.area.classify('localhost:7419')).toBeNull();
    expect((await e.area.probe(LAN)).ok).toBe(false);
  });
});

describe('changing the network and rolling back', () => {
  it('audits a change, records what it replaced, and rolls it back', async () => {
    const e = await started();
    e.probe.set('https://hub.example.com', true, 50);
    const r = await e.api('PATCH', '/api/v1/network', {
      transports: { directPublic: true },
      directPublic: { url: 'https://hub.example.com/' },
      lan: { mdns: false },
      healthCheckSeconds: 30,
    });
    expect(r.status).toBe(200);
    expect(r.json.change).toMatchObject({ kind: 'network.settings', status: 'applied' });
    expect(r.json.directPublic.url).toBe('https://hub.example.com');
    expect(r.json.lan.mdns).toMatchObject({ enabled: false, running: false });
    expect(r.json.advertised.map((c: { transport: string }) => c.transport)).toEqual([
      'lan',
      'direct',
    ]);
    expect(e.responders[0]!.destroyed).toBe(true);
    expect(await e.area.hostNames()).toEqual(['hub.example.com']);
    const a = e.audit.find((x) => x.action === 'network.change');
    expect(a).toMatchObject({ kind: 'network', resource: r.json.change.id, result: 'ok' });
    expect(a?.detail?.keys).toEqual([
      'network.transports',
      'network.directPublic.url',
      'network.lan.mdns',
      'network.healthCheckSeconds',
    ]);
    // The same values again change nothing.
    const again = await e.api('PATCH', '/api/v1/network', { lan: { mdns: false } });
    expect(again.json.change).toBeNull();
    expect(e.audit.filter((x) => x.action === 'network.change')).toHaveLength(1);
    // One click puts everything back.
    const back = await e.api('POST', '/api/v1/network/rollback', {});
    expect(back.status).toBe(200);
    expect(back.json.change).toMatchObject({ id: r.json.change.id, status: 'rolled_back' });
    expect(back.json.network).toMatchObject({
      directPublic: { url: null },
      healthCheckSeconds: 60,
      lan: { mdns: { enabled: true, running: true } },
    });
    expect(back.json.network.advertised.map((c: { url: string }) => c.url)).toEqual([LAN, MDNS]);
    expect(e.settings.get('network.transports')).toMatchObject({ directPublic: false });
    expect(e.audit.at(-1)).toMatchObject({ action: 'network.rollback', result: 'ok' });
    const names = (await e.events.since(null, 200)).map((ev) => ev.name);
    expect(names.filter((n) => n === 'network.changed')).toHaveLength(2);
    // Nothing left to roll back; an unknown id is not found.
    const none = await e.api('POST', '/api/v1/network/rollback', {});
    expect(none.status).toBe(409);
    expect(none.json.error.details.reason).toBe('nothing_to_roll_back');
    expect((await e.api('POST', '/api/v1/network/rollback', { changeId: 'nope' })).status).toBe(
      404,
    );
    const diag = (await e.api('GET', '/api/v1/network/diagnostics')).json;
    expect(diag.changes[0]).toMatchObject({ status: 'rolled_back' });
  });

  it('validates the change and never leaves nothing to advertise', async () => {
    const e = await started();
    const bad = async (body: unknown) => (await e.api('PATCH', '/api/v1/network', body)).json.error;
    expect(
      (await bad({ transports: { lan: false, mesh: false, relay: false, directPublic: false } }))
        .details.reason,
    ).toBe('no_transport');
    expect((await bad({ transports: { directPublic: true } })).details.reason).toBe('url_required');
    expect((await bad({ wakeHelpers: ['nope'] })).details).toMatchObject({
      reason: 'unknown_device',
      ids: ['nope'],
    });
    expect((await bad({ lan: { mdnsName: 'Bad Name' } })).code).toBe('validation');
    expect((await bad({ surprise: true })).code).toBe('validation');
    expect(e.audit).toEqual([]);
    // A new mDNS name is announced under that name.
    const r = await e.api('PATCH', '/api/v1/network', { lan: { mdnsName: 'den' } });
    expect(r.json.lan.mdns.name).toBe('den');
    expect(
      e.responders
        .at(-1)!
        .sent.at(-1)!
        .answers.some((x) => x.name === 'den.local'),
    ).toBe(true);
  });

  it('puts back what was written when a later write fails, and needs the writer', async () => {
    env = await networkEnv();
    const writes: [string, unknown][] = [];
    env.area.useSettingsWriter((_a, key, value) => {
      writes.push([key, value]);
      if (key === 'network.lan.includeLoopback')
        return Promise.reject(new NovaError('policy_denied', 'managed'));
      env!.settings.set(key, value);
      return Promise.resolve();
    });
    const r = await env.api('PATCH', '/api/v1/network', {
      lan: { includeLoopback: true, mdns: false },
    });
    expect(r.status).toBe(403);
    // All or nothing: the mDNS write is put back.
    expect(writes).toEqual([
      ['network.lan.mdns', false],
      ['network.lan.includeLoopback', true],
      ['network.lan.mdns', true],
    ]);
    expect(env.settings.get('network.lan.mdns')).toBe(true);
    expect(await env.area.changes.last()).toBeNull();
    const plain = await networkEnv({ writer: false });
    cleanups.push(() => plain.close());
    const missing = await plain.api('PATCH', '/api/v1/network', { lan: { mdns: false } });
    expect(missing.json.error.details.reason).toBe('settings_writer_missing');
  });
});

describe('hardening (review notes)', () => {
  it('lists the direct public host as a Hub name only while Direct public is on', async () => {
    const e = await started();
    const r = await e.api('PATCH', '/api/v1/network', {
      directPublic: { url: 'https://hub.example.com' },
    });
    expect(r.json.directPublic.url).toBe('https://hub.example.com');
    expect(await e.area.hostNames()).toEqual(['study-pc.local']);
    e.probe.set('https://hub.example.com', true);
    await e.api('PATCH', '/api/v1/network', { transports: { directPublic: true } });
    expect(await e.area.hostNames()).toEqual(['study-pc.local', 'hub.example.com']);
  });

  it('shares one running check among concurrent tests instead of queueing more', async () => {
    const e = await started();
    const before = e.probe.calls.length;
    e.probe.delayMs = 200;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => e.api('POST', '/api/v1/network/test')),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    // One check probes the two LAN candidates once each.
    expect(e.probe.calls.length - before).toBe(2);
    expect(new Set(results.map((r) => r.json.checkedAt as string)).size).toBe(1);
  });

  it('answers 409 to a rollback while another one runs', async () => {
    const e = await started();
    let release: () => void = () => undefined;
    e.area.changes.registerUndo('slow', () => new Promise<void>((r) => (release = r)));
    await e.area.changes.record({ kind: 'slow', summary: 'one', undo: {} });
    await e.area.changes.record({ kind: 'slow', summary: 'two', undo: {} });
    const first = e.api('POST', '/api/v1/network/rollback', {});
    // Wait until the first rollback holds the lock.
    for (let i = 0; i < 100 && (await e.area.changes.last())?.summary !== 'two'; i++)
      await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    const second = await e.api('POST', '/api/v1/network/rollback', {});
    expect(second.status).toBe(409);
    expect(second.json.error.details.reason).toBe('rollback_in_progress');
    release();
    expect((await first).status).toBe(200);
  });
});

describe('diagnostics', () => {
  it('reports transports, trust, mesh, relay, devices, events and changes', async () => {
    const e = await started();
    e.area.useTrustSummary(() =>
      Promise.resolve({
        mode: 'local-ca',
        caFingerprint: 'AA:BB',
        leafNotAfter: '2027-01-01T00:00:00.000Z',
        leafSans: ['study-pc.local'],
        meshCert: null,
        problems: ['the leaf expires in 10 days'],
      }),
    );
    e.area.useMeshSummary(() => Promise.resolve({ provider: 'headscale', acl: '2 rules' }));
    e.area.useRelayStatus(() => Promise.reject(new Error('relay offline')));
    let ca = 0;
    e.area.useProbeCa(() => {
      ca += 1;
      return Promise.resolve('-----BEGIN CERTIFICATE-----');
    });
    const iso = new Date().toISOString();
    e.db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, last_seen_at, created_at, updated_at)
         VALUES ('dev1', ?, 'nas', 'compute', 'fp1', 'pk1', '["compute"]', 'active', ?, ?, ?)`,
      )
      .run(ACCOUNT, iso, iso, iso);
    e.db.raw
      .prepare(
        `INSERT INTO transport_endpoint (id, device_id, net, url, healthy, latency_ms, last_checked_at, created_at)
         VALUES ('te1', 'dev1', 'lan', 'http://192.168.1.40:7430', 1, 7, ?, ?)`,
      )
      .run(iso, iso);
    await e.area.test();
    expect(ca).toBeGreaterThan(0);
    expect(e.probe.calls.at(-1)?.opts.ca).toBe('-----BEGIN CERTIFICATE-----');
    const d = (await e.api('GET', '/api/v1/network/diagnostics')).json;
    expect(d).toMatchObject({
      primary: 'lan',
      trust: { mode: 'local-ca', caFingerprint: 'AA:BB' },
      mesh: { provider: 'headscale' },
      relay: { error: 'relay offline' },
      devices: [
        {
          deviceId: 'dev1',
          name: 'nas',
          kind: 'compute',
          roles: ['compute'],
          reachable: true,
          relayPaired: false,
          endpoints: [
            { transport: 'lan', url: 'http://192.168.1.40:7430', healthy: true, latencyMs: 7 },
          ],
        },
      ],
    });
    expect(d.checkedAt).not.toBeNull();
    expect(d.transports).toHaveLength(4);
    expect(d.endpoints[0]).toMatchObject({
      url: LAN,
      health: 'ok',
      uptime24h: { checks: 2, ok: 2 },
    });
    expect(d.problems).toContain('Trust: the leaf expires in 10 days');
    expect(d.events.length).toBeGreaterThan(0);
    const view = (await e.api('GET', '/api/v1/network')).json;
    expect(view.trust).toMatchObject({ mode: 'local-ca' });
    e.area.useTrustSummary(() => Promise.reject(new Error('no CA')));
    expect((await e.api('GET', '/api/v1/network')).json.trust).toBeNull();
  });

  it('runs the first check itself when asked before any', async () => {
    env = await networkEnv();
    env.probe.set(LAN, true);
    await env.area.listening(LISTENER);
    // A fresh area on the same database whose listener is set without a check yet.
    const second = await setupNetwork(env.ctx, {
      probe: env.probe.probe,
      interfaces: () => ({ eth0: [iface('192.168.1.10', 24)] }),
      mdns: () => {
        throw new Error('no mDNS here');
      },
      timers: { setInterval: () => 0, clearInterval: () => undefined },
    });
    cleanups.push(() => second.close());
    second.registry.setListener(LISTENER);
    expect(second.registry.checkedAt()).toBeNull();
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    second.register(app);
    cleanups.push(() => app.close());
    const res = await app.inject({ url: '/api/v1/network/diagnostics' });
    expect(res.json().checkedAt).not.toBeNull();
    // mDNS could not start: LAN still works by address.
    expect(res.json().endpoints.map((c: { url: string }) => c.url)).toEqual([LAN]);
  });
});

describe('a real Hub on loopback', () => {
  it('passes its own reachability check through the Hub’s hello route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-network-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
    const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
    const db = await networkDb();
    const hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    });
    cleanups.push(async () => {
      await hub.app.close();
    });
    const url = await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(url).port);
    // The area uses the real probe here, against the running Hub.
    env = await networkEnv({
      db,
      settings: { 'network.lan.includeLoopback': true },
      interfaces: () => ({ lo: [iface('127.0.0.1', 8, true)] }),
      deps: { probe: probeHello, probeTimeoutMs: 2_000 },
    });
    await env.area.listening({ host: '127.0.0.1', port, protocol: 'http' });
    expect(env.area.endpoints().map((c) => [c.url, c.health])).toEqual([[url, 'ok']]);
    expect(env.area.endpoints()[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    // A host name the Hub does not answer to fails, so it would never be advertised.
    const other = await probeHello(`http://elsewhere.example:${port}`, {
      timeoutMs: 2_000,
      connectAddress: '127.0.0.1',
    });
    expect(other).toMatchObject({ ok: false });
    expect(other.detail).toMatch(/refused this host name/);
    // With the Hub identity: its hello carries the fingerprint, and the trust area answers a
    // fresh nonce with a statement signed by the pinned key (review finding 14).
    const hello = (await (await fetch(`${url}/api/v1/hello`)).json()) as {
      hubFingerprint?: string;
    };
    expect(hello.hubFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await probeHello(url, { timeoutMs: 2_000, expectFingerprint: hello.hubFingerprint! }),
    ).toMatchObject({ ok: true, detail: null });
    expect(
      (await probeHello(url, { timeoutMs: 2_000, expectFingerprint: 'A'.repeat(43) })).detail,
    ).toBe('another Hub answered');
  });
});
