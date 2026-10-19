// The browser's path to the Hub (FR-137 client, FR-135; docs/22 §2, §3.1): an unpaired browser
// passes straight through with its cookie; a browser paired through the Relay chooses between the
// page's origin and the Relay with selectEndpoint, sends its device session as a bearer token,
// falls back to the tunnel when the origin stops answering (re-sending only what is safe), follows
// the event stream over the chosen path, and forgets a pairing the Relay revoked. Also: the
// encrypted store, the endpoint classification and the fetch-based event stream reader.
/* eslint-disable @typescript-eslint/require-await */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndpointCandidate } from '@nova/shared';
import { createApi } from '../src/api.ts';
import {
  cleanEndpoints,
  guessTransport,
  originCandidate,
  relayCandidate,
} from '../src/relaytransport/endpoints.ts';
import {
  connectionMenuItem,
  pathDetail,
  pathText,
  useHubPath,
} from '../src/relaytransport/path.ts';
import { FetchEventSource, parseSse } from '../src/relaytransport/sse.ts';
import { SealedStore, indexedDbKv, memoryKv, relayStore } from '../src/relaytransport/store.ts';
import {
  HubTransport,
  headerRecord,
  hubTransport,
  isNetworkError,
  retrySafe,
  type TransportSnapshot,
} from '../src/relaytransport/transport.ts';
import type { EventSourceLike } from '../src/sse.ts';
import {
  FakeRelayLink,
  fakeConnect,
  fakeIndexedDb,
  json,
  relayPairing,
  type TunnelHandler,
} from './fakes-m7-push.ts';

const ORIGIN = 'https://192.168.1.10:7419';
const FAST = { budgetMs: 5, timeoutMs: 200 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.removeItem('nova.hub.endpoints');
});

const hello = (over: Record<string, unknown> = {}) =>
  json({ name: 'nova-hub', version: '1', hubFingerprint: null, ...over });

/** A Hub behind the tunnel: hello, and an echo of each request. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const tunnelHub: TunnelHandler = (path, init) => {
  if (path === '/api/v1/hello' && init.method === 'GET') return hello();
  if (path === '/api/v1/hello') return json({ endpoints: [] });
  return json({ via: 'relay', path, method: init.method, auth: init.headers.authorization });
};

async function pairedTransport(opts: {
  direct: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  tunnel?: TunnelHandler;
  pairing?: Parameters<typeof relayPairing>[0];
}) {
  const store = relayStore(memoryKv());
  await store.save(relayPairing(opts.pairing));
  const connect = fakeConnect(opts.tunnel ?? tunnelHub);
  const direct = vi.fn(opts.direct);
  const nativeEs = vi.fn<(url: string) => EventSourceLike>();
  const t = new HubTransport({
    fetch: direct as unknown as typeof fetch,
    origin: ORIGIN,
    store,
    connect,
    select: FAST,
    eventSource: nativeEs,
    events: null,
  });
  return { t, store, connect, direct, nativeEs };
}

const down = () => Promise.reject(new TypeError('Failed to fetch'));

/** A direct Hub at the origin: hello, and an echo. */
const originHub = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  if (url.endsWith('/api/v1/hello') && (init?.method ?? 'GET') === 'GET') return hello();
  if (url.endsWith('/api/v1/hello')) return json({ endpoints: [] });
  return json({
    via: 'origin',
    url,
    auth: new Headers(init?.headers).get('authorization'),
  });
};

describe('an unpaired browser', () => {
  it('passes every call straight through with its cookie and names its path', async () => {
    const direct = vi.fn(async () => json({ ok: true }));
    const t = new HubTransport({
      fetch: direct as unknown as typeof fetch,
      origin: ORIGIN,
      store: relayStore(memoryKv()),
      events: null,
    });
    const init = { method: 'POST', credentials: 'same-origin' as const, body: '{}' };
    const res = await t.fetch('/api/v1/threads', init);
    expect(await res.json()).toEqual({ ok: true });
    // Exactly the caller's request: no added header, no probe.
    expect(direct.mock.calls).toEqual([['/api/v1/threads', init]]);
    const snap = t.getSnapshot();
    expect(snap.paired).toBe(false);
    expect(snap.path).toMatchObject({ via: 'origin', transport: 'lan', url: ORIGIN });
    expect(pathText(snap)).toBe('Connected over LAN');
    expect(t.inUse).toBe(true);
  });

  it('opens the browser EventSource for streams', async () => {
    const close = vi.fn();
    const native: EventSourceLike = {
      readyState: 0,
      onopen: null,
      onerror: null,
      addEventListener: () => undefined,
      close,
    };
    const nativeEs = vi.fn(() => native);
    const t = new HubTransport({
      origin: ORIGIN,
      store: relayStore(memoryKv()),
      eventSource: nativeEs,
      events: null,
    });
    const es = t.eventSource('/api/v1/events/stream');
    await vi.waitFor(() => expect(nativeEs).toHaveBeenCalledWith('/api/v1/events/stream'));
    es.close();
    expect(close).toHaveBeenCalled();
  });

  it('learns the advertised endpoints once and names the origin by them', async () => {
    const adv: EndpointCandidate[] = [
      {
        transport: 'mesh',
        url: 'https://nova.tail1.ts.net:7419',
        priority: 20,
        health: 'ok',
        latencyMs: 4,
        checkedAt: null,
        detail: 'tailscale',
      },
    ];
    const direct = vi.fn(async () => json({ endpoints: adv }));
    const t = new HubTransport({
      fetch: direct as unknown as typeof fetch,
      origin: 'https://nova.tail1.ts.net:7419',
      store: relayStore(memoryKv()),
      events: null,
    });
    t.refreshEndpointsOnce();
    t.refreshEndpointsOnce();
    await vi.waitFor(() => expect(t.getSnapshot().advertised).toHaveLength(1));
    expect(direct).toHaveBeenCalledTimes(1);
    expect(direct.mock.calls[0]).toMatchObject(['/api/v1/hello', { method: 'POST' }]);
    expect(t.getSnapshot().path?.transport).toBe('mesh');
    expect(JSON.parse(window.localStorage.getItem('nova.hub.endpoints') ?? '[]')).toHaveLength(1);
  });

  it('is what createApi uses by default', async () => {
    const fetchMock = vi.fn(async () => json({ name: 'nova-hub', version: '1' }));
    vi.stubGlobal('fetch', fetchMock);
    await hubTransport.reload();
    const api = createApi();
    await expect(api.hello()).resolves.toMatchObject({ name: 'nova-hub' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/hello',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('a browser paired through the Relay', () => {
  it('uses the origin when it answers, with the device session as a bearer token', async () => {
    const { t, connect } = await pairedTransport({ direct: originHub });
    const res = await t.fetch('/api/v1/threads');
    expect(await res.json()).toMatchObject({ via: 'origin', auth: 'Bearer nvs_device_session' });
    expect(t.getSnapshot().path).toMatchObject({ via: 'origin', transport: 'lan' });
    expect(pathText(t.getSnapshot())).toBe('Connected over LAN');
    // The relay probe was cancelled and its link stopped.
    await vi.waitFor(() => expect(connect.links.every((l) => l.stopped > 0)).toBe(true));
  });

  it('goes through the Relay when the origin does not answer', async () => {
    const { t, connect, direct } = await pairedTransport({ direct: down });
    const res = await t.fetch('/api/v1/threads?limit=5', {
      method: 'GET',
      headers: { accept: 'application/json', cookie: 'x=1' },
    });
    expect(await res.json()).toEqual({
      via: 'relay',
      path: '/api/v1/threads?limit=5',
      method: 'GET',
      auth: 'Bearer nvs_device_session',
    });
    const link = connect.links[0]!;
    // The cookie never goes into the tunnel; the bearer token does.
    const call = link.calls.find((c) => c.path === '/api/v1/threads?limit=5')!;
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers.accept).toBe('application/json');
    const snap = t.getSnapshot();
    expect(snap.path).toMatchObject({ via: 'relay', transport: 'relay' });
    expect(snap.attempts.map((a) => [a.transport, a.outcome])).toEqual([
      ['lan', 'failed'],
      ['relay', 'ok'],
    ]);
    expect(pathText(snap)).toBe('Connected through the Relay');
    expect(pathDetail(snap)).toMatch(/through the Relay/);
    expect(direct).toHaveBeenCalledWith(`${ORIGIN}/api/v1/hello`, expect.anything());
  });

  it('sends bodies and absolute same-origin URLs through the tunnel', async () => {
    const { t, connect } = await pairedTransport({ direct: down });
    await t.select();
    await t.fetch(`${ORIGIN}/api/v1/threads`, { method: 'POST', body: '{"title":"x"}' });
    await t.fetch(new URL(`${ORIGIN}/api/v1/files?x=1`), {
      method: 'PUT',
      body: new TextEncoder().encode('bytes'),
    });
    const link = connect.links.at(-1)!;
    expect(link.calls.map((c) => [c.method, c.path, c.body])).toEqual(
      expect.arrayContaining([
        ['POST', '/api/v1/threads', '{"title":"x"}'],
        ['PUT', '/api/v1/files?x=1', 'bytes'],
      ]),
    );
    await expect(t.fetch('https://elsewhere.example/api/v1/x')).rejects.toThrow(
      /only Hub API calls/,
    );
  });

  it('re-sends a read through the Relay when the origin stops answering, and a write only with an Idempotency-Key', async () => {
    let up = true;
    const { t } = await pairedTransport({
      direct: (input, init) => (up ? originHub(input, init) : down()),
    });
    await t.fetch('/api/v1/threads');
    expect(t.getSnapshot().path?.via).toBe('origin');
    up = false;
    const read = await t.fetch('/api/v1/threads');
    expect(await read.json()).toMatchObject({ via: 'relay' });
    expect(t.getSnapshot().path?.via).toBe('relay');

    // Back on the origin, then it fails again under a write.
    up = true;
    await t.select();
    expect(t.getSnapshot().path?.via).toBe('origin');
    up = false;
    await expect(t.fetch('/api/v1/threads', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      TypeError,
    );
    up = true;
    await t.select();
    up = false;
    const write = await t.fetch('/api/v1/threads', {
      method: 'POST',
      body: '{}',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(await write.json()).toMatchObject({ via: 'relay', method: 'POST' });
  });

  it('turns tunnel failures into lost-connection errors', async () => {
    const { t } = await pairedTransport({
      direct: down,
      tunnel: (path) => {
        if (path === '/api/v1/hello') return hello();
        throw new Error('the Hub did not answer in time');
      },
    });
    await expect(t.fetch('/api/v1/threads')).rejects.toThrow(
      /Failed to fetch through the Relay: the Hub did not answer in time/,
    );
  });

  it('says so when neither path answers', async () => {
    const { t } = await pairedTransport({
      direct: down,
      tunnel: () => json({ error: { code: 'server_error' } }, 502),
    });
    expect(await t.select()).toBeNull();
    const snap = t.getSnapshot();
    expect(snap.unreachable).toBe(true);
    expect(pathText(snap)).toBe('Cannot reach the Hub');
    expect(snap.attempts.every((a) => a.outcome === 'failed')).toBe(true);
  });

  it('refuses a Hub at the origin with another fingerprint', async () => {
    const { t } = await pairedTransport({
      direct: async () => hello({ hubFingerprint: 'other' }),
      tunnel: (path) => (path === '/api/v1/hello' ? hello({ hubFingerprint: 'mine' }) : json({})),
      pairing: { hubFingerprint: 'mine' },
    });
    const path = await t.select();
    expect(path?.via).toBe('relay');
    expect(t.getSnapshot().attempts[0]).toMatchObject({
      outcome: 'failed',
      detail: 'a different Hub',
    });
  });

  it('keeps the Hub stream floor and forgets a pairing the Relay revoked', async () => {
    const { t, store, connect } = await pairedTransport({ direct: down });
    await t.select();
    const link = connect.links[0]!;
    link.notifyPaired({ requestId: null, deviceId: null });
    await vi.waitFor(async () => expect((await store.load())?.hubFloor).toBe(1234));
    link.setState('revoked');
    await vi.waitFor(() => expect(t.getSnapshot().revoked).toBe(true));
    expect(t.getSnapshot().paired).toBe(false);
    expect(await store.load()).toBeNull();
    expect(pathText(t.getSnapshot())).toBe('Removed from the Relay');
    expect(pathDetail(t.getSnapshot())).toMatch(/removed this device/);
  });

  it('tries the origin again while on the Relay', async () => {
    let up = false;
    const store = relayStore(memoryKv());
    await store.save(relayPairing());
    const t = new HubTransport({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        up ? originHub(input, init) : down(),
      origin: ORIGIN,
      store,
      connect: fakeConnect(tunnelHub),
      select: FAST,
      recheckMs: 30,
      events: null,
    });
    await t.select();
    expect(t.getSnapshot().path?.via).toBe('relay');
    up = true;
    await vi.waitFor(() => expect(t.getSnapshot().path?.via).toBe('origin'), { timeout: 2000 });
  });

  it('streams events through the tunnel and moves the stream when the path changes', async () => {
    let up = false;
    const sse = 'event: run.created\nid: e1\ndata: {"name":"run.created","id":"e1"}\n\n';
    const { t, nativeEs } = await pairedTransport({
      direct: (input, init) => (up ? originHub(input, init) : down()),
      tunnel: (path) =>
        path === '/api/v1/hello'
          ? hello()
          : new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    });
    await t.select();
    const es = t.eventSource('/api/v1/events/stream');
    const got: string[] = [];
    es.addEventListener('run.created', (ev) => got.push(ev.data));
    const errors: number[] = [];
    es.onerror = () => errors.push(es.readyState);
    await vi.waitFor(() => expect(got).toEqual(['{"name":"run.created","id":"e1"}']));
    // The tunnel's body ended: closed for good, so src/sse.ts reopens it with ?after=.
    await vi.waitFor(() => expect(errors).toContain(2));
    expect(nativeEs).not.toHaveBeenCalled();

    // A second stream on the Relay is closed when the origin comes back.
    const es2 = t.eventSource('/api/v1/events/stream?after=e1');
    const closed = vi.fn();
    es2.onerror = closed;
    await vi.waitFor(() => expect(es2.readyState).not.toBe(0));
    up = true;
    await t.select();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    expect(es2.readyState).toBe(2);
  });

  it('streams with the bearer token on the origin path', async () => {
    const seen: (string | null)[] = [];
    const { t } = await pairedTransport({
      direct: async (input, init) => {
        if (urlOf(input).endsWith('/api/v1/hello')) return originHub(input, init);
        seen.push(new Headers(init?.headers).get('authorization'));
        return new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    await t.select();
    const es = t.eventSource('/api/v1/threads/t1/stream');
    const got: string[] = [];
    es.addEventListener('message', (ev) => got.push(ev.data));
    await vi.waitFor(() => expect(got).toEqual(['hi']));
    expect(seen).toEqual(['Bearer nvs_device_session']);
    es.close();
  });

  it('forgets the pairing on request', async () => {
    const { t, store } = await pairedTransport({ direct: originHub });
    await t.select();
    await t.forget();
    expect(await store.load()).toBeNull();
    expect(t.getSnapshot()).toMatchObject({ paired: false, revoked: false });
  });
});

describe('useHubPath', () => {
  it('follows the transport and asks for the endpoints once it is in use', async () => {
    const { t, direct } = await pairedTransport({ direct: originHub });
    const { result } = renderHook(() => useHubPath(t));
    expect(result.current.path).toBeNull();
    await act(async () => {
      await t.fetch('/api/v1/threads');
    });
    expect(pathText(result.current)).toBe('Connected over LAN');
    renderHook(() => useHubPath(t));
    await vi.waitFor(() =>
      expect(direct.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1),
    );
  });
});

describe('the account menu item', () => {
  const snap = (over: Partial<TransportSnapshot>): TransportSnapshot => ({
    path: null,
    paired: false,
    relayState: null,
    checking: false,
    unreachable: false,
    revoked: false,
    attempts: [],
    advertised: [],
    ...over,
  });

  it('says what is happening in words', () => {
    expect(pathText(snap({ checking: true }))).toBe('Checking the connection…');
    expect(pathText(snap({}))).toBe('Cannot reach the Hub');
    const mesh = snap({
      path: { via: 'origin', transport: 'mesh', url: 'https://m', latencyMs: 12.4, since: 0 },
    });
    expect(pathText(mesh)).toBe('Connected over Mesh');
    expect(pathDetail(mesh)).toBe('This page talks to the Hub at https://m (12 ms).');
    expect(pathDetail(snap({}))).toMatch(/Neither/);
    const onSelect = vi.fn();
    const item = connectionMenuItem(mesh, onSelect);
    expect(item).toMatchObject({ id: 'connection', label: 'Connected over Mesh' });
    item.onSelect();
    expect(onSelect).toHaveBeenCalled();
  });
});

describe('endpoints', () => {
  it('guesses the transport of an address', () => {
    expect(guessTransport('https://192.168.0.2')).toBe('lan');
    expect(guessTransport('https://10.1.2.3:7419')).toBe('lan');
    expect(guessTransport('https://172.20.0.1')).toBe('lan');
    expect(guessTransport('http://localhost:5173')).toBe('lan');
    expect(guessTransport('https://hub.local')).toBe('lan');
    expect(guessTransport('https://[fd00::1]')).toBe('lan');
    expect(guessTransport('https://100.101.1.2')).toBe('mesh');
    expect(guessTransport('https://hub.tail9.ts.net')).toBe('mesh');
    expect(guessTransport('https://[fd7a:115c:a1e0::1]')).toBe('mesh');
    expect(guessTransport('https://nova.example.com')).toBe('direct');
    expect(guessTransport('https://8.8.8.8')).toBe('direct');
    expect(guessTransport('not a url')).toBe('direct');
  });

  it('takes the advertised transport for the origin and the Relay priority', () => {
    const adv = cleanEndpoints([
      { transport: 'mesh', url: 'https://nova.example.com:7419/', priority: 21, health: 'ok' },
      { transport: 'relay', url: 'wss://relay.example', priority: 33, health: 'ok' },
      { transport: 'bogus', url: 'x', priority: 1 },
      'junk',
    ]);
    expect(adv).toHaveLength(2);
    expect(originCandidate('https://nova.example.com:7419', adv)).toMatchObject({
      transport: 'mesh',
      priority: 21,
      url: 'https://nova.example.com:7419',
    });
    expect(originCandidate('https://other.example', adv)).toMatchObject({
      transport: 'direct',
      priority: 40,
      detail: 'this page',
    });
    expect(relayCandidate('wss://r', adv).priority).toBe(33);
    expect(relayCandidate('wss://r', []).priority).toBe(30);
    expect(cleanEndpoints('nope')).toEqual([]);
  });
});

describe('helpers', () => {
  it('tells lost connections and safe retries apart', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('x'))).toBe(false);
    const ctl = new AbortController();
    ctl.abort();
    expect(isNetworkError(new TypeError('x'), ctl.signal)).toBe(false);
    expect(retrySafe('get', {})).toBe(true);
    expect(retrySafe('POST', {})).toBe(false);
    expect(retrySafe('POST', { 'idempotency-key': 'k' })).toBe(true);
    expect(headerRecord([['A', '1']])).toEqual({ a: '1' });
    expect(headerRecord(undefined)).toEqual({});
  });
});

describe('the encrypted store', () => {
  it('keeps the pairing sealed under a key that cannot be exported', async () => {
    const kv = memoryKv();
    const store = relayStore(kv);
    const pairing = relayPairing({ token: 'nvs_secret_token' });
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    await store.save(pairing, keys);
    expect(await store.load()).toEqual(pairing);
    const wrap = kv.entries.get('wrap-key') as CryptoKey;
    expect(wrap).toBeInstanceOf(CryptoKey);
    expect(wrap.extractable).toBe(false);
    // Nothing secret is stored in the clear.
    const sealed = kv.entries.get('pairing') as { data: Uint8Array };
    const raw = new TextDecoder().decode(sealed.data);
    expect(raw).not.toContain('nvs_secret_token');
    expect(raw).not.toContain('route-token-secret');
    expect((kv.entries.get('pairing-keys') as CryptoKeyPair).privateKey.extractable).toBe(false);

    // A wiped key leaves nothing readable.
    kv.entries.delete('wrap-key');
    expect(await relayStore(kv).load()).toBeNull();
    await store.clear();
    expect(kv.entries.has('pairing')).toBe(false);
  });

  it('keeps a pending join with its device key, and refuses malformed records', async () => {
    const kv = memoryKv();
    const store = relayStore(kv);
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const join = {
      v: 1 as const,
      paired: relayPairing().paired,
      addPairingId: 'p1',
      confirmation: '123456',
      hubFingerprint: null,
      name: 'Phone',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    await store.savePending(join, keys);
    expect((await store.loadPending())?.join).toEqual(join);
    await store.clearPending();
    expect(await store.loadPending()).toBeNull();

    const box = new SealedStore(kv);
    await box.put('pairing', { v: 1, paired: { v: 1 }, token: 'x' });
    expect(await store.load()).toBeNull();
    await box.put('pending', { v: 1, paired: relayPairing().paired });
    expect(await store.loadPending()).toBeNull();
    expect(await box.getKeys('nothing')).toBeNull();
  });

  it('uses IndexedDB, and memory when IndexedDB fails', async () => {
    const idb = fakeIndexedDb();
    const store = relayStore(indexedDbKv(idb));
    await store.save(relayPairing());
    expect(idb.stores.get('kv')?.has('pairing')).toBe(true);
    expect((await relayStore(indexedDbKv(idb)).load())?.token).toBe('nvs_device_session');

    const broken = relayStore(indexedDbKv(fakeIndexedDb({ failOpen: true })));
    await broken.save(relayPairing());
    expect((await broken.load())?.deviceId).toBe('dev1');
    expect(await relayStore(indexedDbKv(undefined)).load()).toBeNull();
  });
});

describe('the fetch event stream', () => {
  it('parses the SSE format', () => {
    const { blocks, rest } = parseSse(
      ': comment\r\nevent: a\r\nid: 1\r\ndata: x\r\ndata: y\r\n\r\ndata\n\nevent: b\ndata: partial',
    );
    expect(blocks).toEqual([
      { event: 'a', data: 'x\ny', id: '1' },
      { event: 'message', data: '', id: null },
    ]);
    expect(rest).toBe('event: b\ndata: partial');
  });

  it('reads chunks as they come and reports an HTTP error as closed', async () => {
    const enc = new TextEncoder();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
      },
    });
    const es = new FetchEventSource(async () => new Response(body), '/s', { authorization: 'B' });
    const got: { data: string; id: string }[] = [];
    es.addEventListener('x', (ev) => got.push({ data: ev.data, id: ev.lastEventId }));
    const opened = vi.fn();
    es.onopen = opened;
    await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    ctl.enqueue(enc.encode('event: x\nid: 7\nda'));
    ctl.enqueue(enc.encode('ta: one\n\n'));
    await vi.waitFor(() => expect(got).toEqual([{ data: 'one', id: '7' }]));
    es.close();
    expect(es.readyState).toBe(2);

    const failed = new FetchEventSource(async () => new Response('no', { status: 401 }), '/s');
    const err = vi.fn();
    failed.onerror = err;
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(failed.readyState).toBe(2);

    const thrown = new FetchEventSource(() => Promise.reject(new TypeError('down')), '/s');
    const err2 = vi.fn();
    thrown.onerror = err2;
    await vi.waitFor(() => expect(err2).toHaveBeenCalled());
  });

  it('the fake link refuses calls once revoked', async () => {
    const link = new FakeRelayLink({}, () => json({}));
    link.setState('revoked');
    await expect(link.fetch('/api/v1/x')).rejects.toThrow(/removed/);
  });
});
