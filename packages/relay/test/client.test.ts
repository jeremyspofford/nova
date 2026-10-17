// The client library and the API tunnel (FR-137, docs/22 §3.1): pairing against a fake Relay, Hub
// API requests through the sealed session with streamed responses, cancellation, timeouts,
// revocation, the paired notice, stale-stream retry and backpressure on the Hub side.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelayClient,
  RelayConnection,
  RelayError,
  RelaySession,
  StreamGuard,
  StreamIds,
  TunnelServer,
  createOffer,
  decodeTunnel,
  encodeTunnel,
  generateEd25519,
  generateX25519,
  deriveSessionKeys,
  openClaim,
  pairWithRelay,
  pairingSecrets,
  streamCounter,
  toBase64Url,
  utf8,
  type PairedClient,
  type TunnelHandler,
  type TunnelMessage,
} from '../src/index.ts';
import { FakeRelay } from './fake-relay.ts';
import { CLIENT, CLIENT_ID, HUB, keyPair } from './helpers.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(
  handler: TunnelHandler,
  opts: {
    highWaterBytes?: number;
    maxPendingBytes?: number;
    hubFloor?: number;
    /** Replace the Hub's tunnel: answer messages by hand. */
    rawHub?: (stream: string, data: Uint8Array, session: RelaySession) => void;
  } = {},
) {
  const { hubFloor, rawHub, ...tunnelOpts } = opts;
  const errors: unknown[] = [];
  const relay = new FakeRelay();
  relay.tokens.set('hub-token', HUB);
  relay.tokens.set('client-token', CLIENT);
  const keys = await keyPair();
  const guard = new StreamGuard('c', { floor: hubFloor ?? 0 });
  const hubIds = new StreamIds('h');
  const drops: string[] = [];
  let tunnel: TunnelServer | null = null;
  // eslint-disable-next-line prefer-const
  let hubConn: RelayConnection;
  const hubSession = new RelaySession({
    clientId: CLIENT_ID,
    localRoute: HUB,
    remoteRoute: CLIENT,
    keys: keys.hub,
    transmit: (e) => hubConn.send(e),
    onMessage: (s, d) => (rawHub ? rawHub(s, d, hubSession) : tunnel!.onMessage(s, d)),
    acceptStream: (s) => guard.accept(s),
    onDrain: (s) => tunnel!.onDrain(s),
    onStreamFailed: (s) => tunnel!.onStreamFailed(s),
    onDrop: (reason, info) => {
      drops.push(reason);
      if (reason === 'stale_stream' && info.stream) {
        const h = hubIds.next();
        hubSession.send(h, encodeTunnel({ t: 'stale', stream: info.stream, floor: guard.hwm }));
        hubSession.closeStream(h);
      }
    },
  });
  tunnel = new TunnelServer({
    sink: hubSession,
    handler,
    onError: (_s, err) => errors.push(err),
    ...tunnelOpts,
  });
  hubConn = new RelayConnection({
    url: 'https://relay.example',
    token: 'hub-token',
    routeId: HUB,
    webSocket: relay.factory,
    backoff: { initialMs: 100, jitter: 0 },
    onEnvelope: (e) => hubSession.receive(e),
    onState: (s) => hubSession.setConnected(s === 'open'),
  });
  hubConn.start();
  const paired: PairedClient = {
    v: 1,
    relayUrl: 'https://relay.example',
    hubRoute: HUB,
    clientRoute: CLIENT,
    clientId: CLIENT_ID,
    routeToken: 'client-token',
    sendKey: toBase64Url(keys.client.send),
    recvKey: toBase64Url(keys.client.recv),
  };
  const client = new RelayClient({
    paired,
    webSocket: relay.factory,
    backoff: { initialMs: 100, jitter: 0 },
    requestTimeoutMs: 30_000,
  });
  client.start();
  await vi.advanceTimersByTimeAsync(0);
  return { relay, client, hubSession, hubConn, hubIds, guard, drops, tunnel, errors };
}

const json = (status: number, body: unknown) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: (async function* () {
    await Promise.resolve();
    yield utf8(JSON.stringify(body));
  })(),
});

describe('tunneled requests', () => {
  it('carries a request and its JSON answer', async () => {
    const seen: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body: string | null;
    }[] = [];
    const { client } = await setup((req) => {
      seen.push({
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body ? new TextDecoder().decode(req.body) : null,
      });
      return Promise.resolve(json(200, { ok: true, path: req.path }));
    });
    const res = await client.fetch('/api/v1/session', {
      headers: { Authorization: 'Bearer nvs_x' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true, path: '/api/v1/session' });
    const post = await client.fetch('/api/v1/threads', { method: 'post', body: '{"a":1}' });
    expect(await post.json()).toMatchObject({ ok: true });
    expect(seen).toEqual([
      {
        method: 'GET',
        path: '/api/v1/session',
        headers: { authorization: 'Bearer nvs_x' },
        body: null,
      },
      { method: 'POST', path: '/api/v1/threads', headers: {}, body: '{"a":1}' },
    ]);
    const bin = await client.fetch('/api/v1/x', { method: 'PUT', body: new Uint8Array([1, 2]) });
    expect(bin.status).toBe(200);
  });

  it('streams a long-lived response as it is produced', async () => {
    let push: ((s: string | null) => void) | null = null;
    const { client } = await setup(() =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: (async function* () {
          for (;;) {
            const next = await new Promise<string | null>((r) => (push = r));
            if (next === null) return;
            yield utf8(next);
          }
        })(),
      }),
    );
    const res = await client.fetch('/api/v1/events/stream');
    const reader = res.body!.getReader();
    await vi.advanceTimersByTimeAsync(0);
    push!(': connected\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n');
    push!('data: 1\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');
    push!(null);
    expect((await reader.read()).done).toBe(true);
  });

  it('turns a failing handler into a rejected request without its internal message', async () => {
    const { client, errors } = await setup(() => Promise.reject(new Error('inject failed')));
    expect(errors).toEqual([]);
    await expect(client.fetch('/api/v1/x')).rejects.toMatchObject({
      code: 'server_error',
      message: 'the Hub could not serve this request',
    });
    // The real cause stays on the Hub (its log).
    expect(errors).toEqual([new Error('inject failed')]);
  });

  it('refuses an answer whose request id is not the request’s', async () => {
    const { client } = await setup(() => Promise.reject(new Error('unused')), {
      rawHub: (stream, data, session) => {
        const req = decodeTunnel(data);
        if (req?.t !== 'req') return;
        // A Relay replaying an old answer onto a reused stream would carry another id.
        session.send(
          stream,
          encodeTunnel({ t: 'head', id: 'someone-else', status: 200, headers: {} }),
        );
      },
    });
    await expect(client.fetch('/api/v1/x')).rejects.toMatchObject({ code: 'bad_response' });
    const { client: c2 } = await setup(() => Promise.reject(new Error('unused')), {
      rawHub: (stream, data, session) => {
        if (decodeTunnel(data)?.t !== 'req') return;
        session.send(
          stream,
          encodeTunnel({ t: 'error', id: 'someone-else', code: 'x', message: 'y' }),
        );
      },
    });
    await expect(c2.fetch('/api/v1/x')).rejects.toMatchObject({ code: 'bad_response' });
    const { client: c3 } = await setup(() => Promise.reject(new Error('unused')), {
      rawHub: (stream, data, session) => {
        const req = decodeTunnel(data);
        if (req?.t !== 'req') return;
        expect(req.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        session.send(stream, encodeTunnel({ t: 'head', id: req.id!, status: 204, headers: {} }));
      },
    });
    expect((await c3.fetch('/api/v1/x')).status).toBe(204);
  });

  it('errors the body when the Hub fails mid-stream', async () => {
    const { client } = await setup(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: (async function* () {
          yield utf8('part');
          await Promise.resolve();
          throw new Error('broke');
        })(),
      }),
    );
    const res = await client.fetch('/api/v1/x');
    await expect(res.text()).rejects.toMatchObject({ code: 'server_error' });
  });

  it('gives null-body statuses no body', async () => {
    const { client } = await setup(() => Promise.resolve({ status: 204, headers: {}, body: null }));
    const res = await client.fetch('/api/v1/x', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const head = await client.fetch('/api/v1/x', { method: 'HEAD' });
    expect(head.body).toBeNull();
  });

  it('cancels on abort, and the Hub sees it', async () => {
    let aborted = false;
    const { client } = await setup(
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const ctl = new AbortController();
    const p = client.fetch('/api/v1/slow', { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    await vi.advanceTimersByTimeAsync(10);
    expect(aborted).toBe(true);
    const ctl2 = new AbortController();
    ctl2.abort();
    await expect(client.fetch('/api/v1/x', { signal: ctl2.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('stops the Hub producing when the reader cancels', async () => {
    let aborted = false;
    const { client } = await setup((_req, signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return Promise.resolve({
        status: 200,
        headers: {},
        body: (async function* () {
          while (!signal.aborted) {
            yield utf8('tick');
            await new Promise((r) => setTimeout(r, 1_000));
          }
        })(),
      });
    });
    const res = await client.fetch('/api/v1/events/stream');
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(aborted).toBe(true);
  });

  it('fails a request with no answer in time', async () => {
    const { client, relay } = await setup(() => new Promise(() => undefined));
    relay.hold = true;
    const p = client.fetch('/api/v1/x');
    const done = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
  });

  it('fails pending and later requests once the route is revoked', async () => {
    const { client, relay } = await setup(() => new Promise(() => undefined));
    const p = client.fetch('/api/v1/x');
    const done = expect(p).rejects.toMatchObject({ code: 'revoked' });
    const sock = relay.byRoute.get(CLIENT)!;
    sock.deliver({ v: 1, kind: 'close', to: CLIENT, from: CLIENT, reason: 'revoked' });
    sock.drop(4003, 'revoked');
    await done;
    expect(client.state).toBe('revoked');
    await expect(client.fetch('/api/v1/x')).rejects.toBeInstanceOf(RelayError);
  });

  it('resumes after the Hub reconnects', async () => {
    const { client, relay, hubConn } = await setup((req) =>
      Promise.resolve(json(200, { path: req.path })),
    );
    // The Hub drops off; the Relay has nowhere to deliver the request.
    relay.byRoute.get(HUB)!.drop(1006);
    const p = client.fetch('/api/v1/x');
    await vi.advanceTimersByTimeAsync(100);
    expect(hubConn.state).toBe('open');
    // The client's retransmit (5 s) reaches the reconnected Hub.
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;
    expect(await res.json()).toEqual({ path: '/api/v1/x' });
  });

  it('stops cleanly', async () => {
    const { client } = await setup(() => new Promise(() => undefined));
    const p = client.fetch('/api/v1/x');
    client.stop();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('Hub notices', () => {
  it('tells the client the pairing was approved', async () => {
    const { client, hubSession, hubIds } = await setup(() => new Promise(() => undefined));
    const waiting = client.waitForPaired();
    const h = hubIds.next();
    hubSession.send(h, encodeTunnel({ t: 'paired', requestId: 'req-1', deviceId: 'dev-1' }));
    hubSession.closeStream(h);
    expect(await waiting).toEqual({ requestId: 'req-1', deviceId: 'dev-1' });
    expect(await client.waitForPaired()).toEqual({ requestId: 'req-1', deviceId: 'dev-1' });
  });

  it('retries once on a fresh stream when the Hub calls a stream stale', async () => {
    const paths: string[] = [];
    // The Hub saw counters far above this client's clock before it restarted.
    const far = Date.now() * 1024 + 10_000_000;
    const { client, drops } = await setup(
      (req) => {
        paths.push(req.path);
        return Promise.resolve(json(200, {}));
      },
      { hubFloor: far },
    );
    const res = await client.fetch('/api/v1/y');
    expect(res.status).toBe(200);
    expect(paths).toEqual(['/api/v1/y']);
    expect(drops).toContain('stale_stream');
  });
});

describe('stale streams and writes', () => {
  it('does not send a write again after the Hub called its stream stale', async () => {
    const paths: string[] = [];
    const far = Date.now() * 1024 + 10_000_000;
    const { client, drops } = await setup(
      (req) => {
        paths.push(req.path);
        return Promise.resolve(json(200, {}));
      },
      { hubFloor: far },
    );
    await expect(
      client.fetch('/api/v1/threads', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({
      code: 'stale_stream',
    });
    expect(paths).toEqual([]);
    expect(drops).toContain('stale_stream');
    // A read after it goes through: the client's counter moved past the floor.
    expect((await client.fetch('/api/v1/y')).status).toBe(200);
  });
});

describe('Hub-side backpressure', () => {
  it('pauses a body while the client is not acking, and resumes on drain', async () => {
    let produced = 0;
    const { client, relay } = await setup(
      () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: (async function* () {
            for (let i = 0; i < 6; i++) {
              produced++;
              await Promise.resolve();
              yield new Uint8Array(1024);
            }
          })(),
        }),
      { highWaterBytes: 1500 },
    );
    const res = await client.fetch('/api/v1/big');
    const reader = res.body!.getReader();
    relay.hold = true;
    await vi.advanceTimersByTimeAsync(50);
    const pausedAt = produced;
    expect(pausedAt).toBeLessThan(6);
    relay.hold = false;
    relay.release();
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(total).toBe(6 * 1024);
    expect(produced).toBe(6);
  });

  it('gives up on a reader that never acks', async () => {
    let aborted = false;
    const { client, relay } = await setup(
      (_req, signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return Promise.resolve({
          status: 200,
          headers: {},
          body: (async function* () {
            for (let i = 0; i < 100; i++) {
              await Promise.resolve();
              yield new Uint8Array(1024);
            }
          })(),
        });
      },
      { highWaterBytes: 10_000_000, maxPendingBytes: 4096 },
    );
    const res = await client.fetch('/api/v1/big');
    expect(res.status).toBe(200);
    relay.hold = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(aborted).toBe(true);
  });
});

describe('tunnel messages', () => {
  it('validates every message kind', () => {
    const ok: TunnelMessage[] = [
      { t: 'req', method: 'GET', path: '/api/v1/x', headers: { a: 'b' } },
      { t: 'req', id: 'r1', method: 'GET', path: '/x', headers: {} },
      { t: 'head', id: 'r1', status: 204, headers: {} },
      { t: 'error', id: 'r1', code: 'x', message: 'y' },
      { t: 'req', method: 'POST', path: '/x', headers: {}, body: 'AA==' },
      { t: 'cancel' },
      { t: 'head', status: 200, headers: {} },
      { t: 'body', data: 'AA==' },
      { t: 'end' },
      { t: 'error', code: 'x', message: 'y' },
      { t: 'paired', requestId: null, deviceId: 'd' },
      { t: 'stale', stream: 'c1', floor: 3 },
    ];
    for (const m of ok) expect(decodeTunnel(encodeTunnel(m))).toEqual(m);
    const bad = [
      '{',
      '[]',
      '{"t":"zzz"}',
      '{"t":"req","method":"TRACE","path":"/x","headers":{}}',
      '{"t":"req","method":"GET","path":"x","headers":{}}',
      '{"t":"req","method":"GET","path":"/x","headers":{"a":1}}',
      '{"t":"req","method":"GET","path":"/x","headers":{},"body":3}',
      '{"t":"head","status":99,"headers":{}}',
      '{"t":"head","status":200,"headers":[]}',
      '{"t":"body","data":3}',
      '{"t":"error","code":1,"message":"x"}',
      '{"t":"paired","requestId":3,"deviceId":null}',
      '{"t":"stale","stream":"c1","floor":"3"}',
      '{"t":"req","id":"has space","method":"GET","path":"/x","headers":{}}',
      '{"t":"head","id":7,"status":200,"headers":{}}',
      '{"t":"error","id":"","code":"x","message":"y"}',
    ];
    for (const b of bad) expect(decodeTunnel(utf8(b)), b).toBeNull();
    const many: Record<string, string> = {};
    for (let i = 0; i < 101; i++) many[`h${i}`] = 'v';
    expect(
      decodeTunnel(utf8(JSON.stringify({ t: 'head', status: 200, headers: many }))),
    ).toBeNull();
  });

  it('answers a stream that does not start with a request, or with a bad body', async () => {
    const sent: { stream: string; msg: TunnelMessage | null }[] = [];
    const closed: string[] = [];
    const server = new TunnelServer({
      sink: {
        send: (stream, data) => sent.push({ stream, msg: decodeTunnel(data) }),
        closeStream: (s) => closed.push(s),
        abortStream: (s) => closed.push(s),
        pending: () => 0,
      },
      handler: () => Promise.resolve({ status: 200, headers: {}, body: null }),
    });
    server.onMessage('c1', encodeTunnel({ t: 'end' }));
    server.onMessage('c2', utf8('{"t":"req","method":"GET","path":"/x","headers":{},"body":"!!"}'));
    expect(sent.map((s) => s.msg)).toEqual([
      { t: 'error', code: 'validation', message: 'expected a request' },
      { t: 'error', code: 'validation', message: 'the body is not base64' },
    ]);
    expect(closed).toEqual(['c1', 'c2']);
    server.onMessage('c3', encodeTunnel({ t: 'req', method: 'GET', path: '/x', headers: {} }));
    expect(server.active).toBe(1);
    server.onMessage('c3', encodeTunnel({ t: 'req', method: 'GET', path: '/x', headers: {} }));
    server.close();
    server.onMessage('c4', encodeTunnel({ t: 'req', method: 'GET', path: '/x', headers: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.active).toBe(0);
    server.onStreamFailed('nope');
  });
});

describe('streams', () => {
  it('issues growing ids and accepts each peer stream once', () => {
    let now = 1000;
    const ids = new StreamIds('c', { now: () => now });
    const a = ids.next();
    const b = ids.next();
    expect(streamCounter(b)!.counter).toBe(streamCounter(a)!.counter + 1);
    now = 500;
    expect(streamCounter(ids.next())!.counter).toBeGreaterThan(streamCounter(b)!.counter);
    ids.skipPast(10_000_000);
    expect(streamCounter(ids.next())!.counter).toBe(10_000_001);
    expect(streamCounter('x1')).toBeNull();
    expect(streamCounter('c0')).toBeNull();
    expect(streamCounter('c')).toBeNull();

    const saved: number[] = [];
    const guard = new StreamGuard('c', { floor: 5, persist: (n) => saved.push(n), recent: 2 });
    expect(guard.accept('c5')).toBe(false);
    expect(guard.accept('h9')).toBe(false);
    expect(guard.accept('c9')).toBe(true);
    expect(guard.accept('c9')).toBe(false);
    expect(guard.accept('c7')).toBe(true);
    expect(saved).toEqual([9]);
    for (const n of [10, 11, 12]) expect(guard.accept(`c${n.toString(36)}`)).toBe(true);
    // Pruned counters stay refused: the floor rose past them.
    expect(guard.accept('c8')).toBe(false);
    expect(guard.hwm).toBe(12);
  });
});

describe('pairing with a Relay', () => {
  it('claims with the code, opens the offer and derives working session keys', async () => {
    const iterations = 1_000;
    const relayPairingId = 'pairing-0000000001';
    const secrets = await pairingSecrets('ABCD-EFGH', relayPairingId, iterations);
    const hubX = await generateX25519();
    const identity = await generateEd25519();
    const offer = await createOffer({
      offerKey: secrets.offerKey,
      relayPairingId,
      hubRoute: HUB,
      x25519: hubX.publicKey,
      addPairingId: 'add-1',
      identity,
    });
    let claimBlob = '';
    const fetch = vi.fn((url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { codeHash: string; blob: string };
      expect(url).toBe(`https://relay.example/v1/relay/pairings/${relayPairingId}/claim`);
      if (body.codeHash !== secrets.codeHash)
        return Promise.resolve(
          Response.json(
            { error: { code: 'auth_missing', message: 'wrong code' } },
            { status: 401 },
          ),
        );
      claimBlob = body.blob;
      return Promise.resolve(
        Response.json(
          {
            clientId: CLIENT_ID,
            routeId: CLIENT,
            routeToken: 'nvr_t',
            hubRouteId: HUB,
            offer,
            expiresAt: 'x',
          },
          { status: 201 },
        ),
      );
    });
    const device = await generateEd25519();
    const out = await pairWithRelay({
      relayUrl: 'https://relay.example',
      relayPairingId,
      code: 'abcd-efgh',
      device,
      name: 'Phone',
      platform: 'ios',
      pin: null,
      kdfIterations: iterations,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(out.addPairingId).toBe('add-1');
    expect(out.confirmation).toMatch(/^\d{6}$/);
    expect(out.paired).toMatchObject({
      hubRoute: HUB,
      clientRoute: CLIENT,
      clientId: CLIENT_ID,
      routeToken: 'nvr_t',
    });
    // The Hub opens the claim and derives the matching keys.
    const claim = await openClaim(secrets.claimKey, relayPairingId, claimBlob);
    expect(claim).toMatchObject({
      publicKey: device.publicKey,
      kind: 'browser',
      name: 'Phone',
      code: 'ABCDEFGH',
    });
    const hubKeys = await deriveSessionKeys('hub', hubX.privateKey, {
      hubRoute: HUB,
      clientRoute: CLIENT,
      clientId: CLIENT_ID,
      hubX25519: hubX.publicKey,
      clientX25519: claim!.x25519,
    });
    expect(toBase64Url(hubKeys.recv)).toBe(out.paired.sendKey);

    await expect(
      pairWithRelay({
        relayUrl: 'https://relay.example',
        relayPairingId,
        code: 'ABCD-EFGJ',
        device,
        name: 'Phone',
        platform: 'ios',
        kdfIterations: iterations,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: 'auth_missing', status: 401 });
  });

  it('refuses an answer without the fields it needs', async () => {
    const device = await generateEd25519();
    const fetch = () => Promise.resolve(Response.json({ clientId: 'x' }, { status: 201 }));
    await expect(
      pairWithRelay({
        relayUrl: 'https://relay.example',
        relayPairingId: 'p',
        code: 'ABCD-EFGH',
        device,
        name: 'n',
        platform: 'p',
        kdfIterations: 10,
        fetch,
      }),
    ).rejects.toThrow('hubRouteId');
    const broken = () => Promise.resolve(new Response('nope', { status: 500 }));
    await expect(
      pairWithRelay({
        relayUrl: 'https://relay.example',
        relayPairingId: 'p',
        code: 'ABCD-EFGH',
        device,
        name: 'n',
        platform: 'p',
        kdfIterations: 10,
        fetch: broken,
      }),
    ).rejects.toMatchObject({ code: 'pairing_failed', status: 500 });
  });
});
