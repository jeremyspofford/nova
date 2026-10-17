// The Relay connection (FR-137, docs/22 §3.1): route token as a subprotocol, ping every 25 s with
// the pong answered by the Relay, close after 3 missed pongs and reconnect with backoff, and no
// reconnect after `revoked` or an unauthorized token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_CODES,
  RELAY_SUBPROTOCOL,
  RelayConnection,
  isSecureRelayUrl,
  relayConnectUrl,
  relayHttpUrl,
  type ConnectionState,
  type RelayConnectionOptions,
  type RelayEnvelope,
} from '../src/index.ts';
import { FakeRelay, type FakeSocket } from './fake-relay.ts';

const ROUTE = 'CLIENTROUTE00000';
const HUB = 'HUBROUTE00000000';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function connect(relay: FakeRelay, over: Partial<RelayConnectionOptions> = {}) {
  const states: [ConnectionState, string | null][] = [];
  const got: RelayEnvelope[] = [];
  const invalid: string[] = [];
  const conn = new RelayConnection({
    url: 'https://relay.example/base/',
    token: 'tok',
    routeId: ROUTE,
    webSocket: relay.factory,
    backoff: { initialMs: 1_000, maxMs: 8_000, factor: 2, jitter: 0 },
    onEnvelope: (e) => got.push(e),
    onState: (s, d) => states.push([s, d]),
    onInvalid: (e) => invalid.push(e),
    ...over,
  });
  return { conn, states, got, invalid };
}

const last = (relay: FakeRelay): FakeSocket => relay.sockets.at(-1)!;

describe('URLs', () => {
  it('maps a Relay URL to its endpoints', () => {
    expect(relayConnectUrl('https://relay.example/base/')).toBe(
      'wss://relay.example/base/v1/relay/connect',
    );
    expect(relayConnectUrl('http://127.0.0.1:9/')).toBe('ws://127.0.0.1:9/v1/relay/connect');
    expect(relayHttpUrl('wss://relay.example', '/v1/relay/hubs')).toBe(
      'https://relay.example/v1/relay/hubs',
    );
    expect(relayHttpUrl('ws://relay.example?x=1#y', '/v1/relay/health')).toBe(
      'http://relay.example/v1/relay/health',
    );
    expect(() => relayHttpUrl('ftp://relay.example', '/x')).toThrow('unsupported');
  });

  it('calls https, wss and loopback secure, plain http elsewhere not', () => {
    for (const u of [
      'https://relay.example',
      'wss://relay.example/x',
      'http://127.0.0.1:7430',
      'ws://localhost',
      'http://[::1]:9',
    ])
      expect(isSecureRelayUrl(u), u).toBe(true);
    for (const u of [
      'http://relay.example',
      'ws://192.168.1.5',
      'ftp://relay.example',
      'not a url',
      'http://127.example',
    ])
      expect(isSecureRelayUrl(u), u).toBe(false);
  });
});

describe('RelayConnection', () => {
  it('authenticates with the token as a subprotocol and forwards frames', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn, states, got } = connect(relay);
    expect(conn.send({ v: 1, kind: 'ping', to: ROUTE, from: ROUTE })).toBe(false);
    conn.start();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.sockets).toHaveLength(1);
    expect(last(relay).protocols).toEqual([RELAY_SUBPROTOCOL, 'bearer.tok']);
    expect(last(relay).url).toBe('wss://relay.example/base/v1/relay/connect');
    expect(states.map((s) => s[0])).toEqual(['connecting', 'open']);
    const data: RelayEnvelope = {
      v: 1,
      kind: 'ack',
      to: ROUTE,
      from: HUB,
      client: 'c',
      stream: 's',
      ack: 1,
    };
    last(relay).deliver(data);
    expect(got).toEqual([data]);
    expect(conn.send(data)).toBe(true);
  });

  it('pings every 25 s and measures the round trip', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn } = connect(relay);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_000);
    const pings = last(relay)
      .sentEnvelopes()
      .filter((e) => e.kind === 'ping');
    expect(pings).toEqual([{ v: 1, kind: 'ping', to: ROUTE, from: ROUTE }]);
    expect(conn.rttMs).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(conn.state).toBe('open');
  });

  it('answers a ping from the Relay', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn } = connect(relay);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    last(relay).deliver({ v: 1, kind: 'ping', to: ROUTE, from: HUB });
    expect(last(relay).sentEnvelopes().at(-1)).toEqual({
      v: 1,
      kind: 'pong',
      to: HUB,
      from: ROUTE,
    });
  });

  it('closes after 3 missed pongs and reconnects with backoff', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    relay.answerPings = false;
    const { conn, states } = connect(relay);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = last(relay);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(first.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(first.closedWith).toEqual({ code: CLOSE_CODES.keepalive, reason: 'keepalive' });
    expect(states.at(-1)).toEqual(['closed', 'no pong from the Relay']);
    expect(relay.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(relay.sockets).toHaveLength(2);
    expect(conn.state).toBe('open');
  });

  it('backs off exponentially up to the cap and resets once open', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn } = connect(relay);
    relay.down = true;
    const created: number[] = [];
    const factory = relay.factory;
    relay.factory = (url, protocols) => {
      created.push(Date.now());
      return factory(url, protocols);
    };
    const c2 = connect(relay);
    c2.conn.start();
    await vi.advanceTimersByTimeAsync(40_000);
    const gaps = created.slice(1).map((t, i) => t - created[i]!);
    expect(gaps.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    // Once a connection opens, the next failure starts from the initial delay again.
    relay.down = false;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(c2.conn.state).toBe('open');
    const n = created.length;
    last(relay).drop(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(created.length).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(created.length).toBe(n + 1);
    conn.stop();
  });

  it('stops reconnecting when revoked', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn, got, states } = connect(relay);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    last(relay).deliver({ v: 1, kind: 'close', to: ROUTE, from: ROUTE, reason: 'revoked' });
    last(relay).drop(CLOSE_CODES.revoked, 'revoked');
    expect(got.at(-1)).toMatchObject({ kind: 'close', reason: 'revoked' });
    expect(states.at(-1)?.[0]).toBe('revoked');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.sockets).toHaveLength(1);
    // The close code alone is enough.
    const second = connect(relay);
    second.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    last(relay).drop(CLOSE_CODES.revoked, '');
    expect(second.conn.state).toBe('revoked');
  });

  it('stops reconnecting when the token is refused', async () => {
    const relay = new FakeRelay();
    const { conn, states } = connect(relay);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual(['unauthorized', 'the Relay refused the route token']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.sockets).toHaveLength(1);
  });

  it('reports invalid frames and ignores them', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn, got, invalid } = connect(relay);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    last(relay).deliver('{nope');
    last(relay).onmessage?.({ data: new Uint8Array(3) });
    last(relay).deliver(JSON.stringify({ v: 1, kind: 'data', to: ROUTE, from: HUB }));
    expect(got).toEqual([]);
    expect(invalid).toEqual(['invalid JSON', 'binary frame', 'data needs client']);
  });

  it('retries when the token cannot be read, and stops cleanly', async () => {
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    let calls = 0;
    const { conn, states } = connect(relay, {
      token: () =>
        calls++ === 0 ? Promise.reject(new Error('vault locked')) : Promise.resolve('tok'),
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual(['closed', 'vault locked']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.state).toBe('open');
    conn.stop();
    expect(conn.state).toBe('stopped');
    expect(last(relay).closedWith?.code).toBe(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.sockets).toHaveLength(1);
  });

  it('retries when the socket cannot be created', async () => {
    let n = 0;
    const relay = new FakeRelay();
    relay.tokens.set('tok', ROUTE);
    const { conn, states } = connect(relay, {
      webSocket: (url, protocols) => {
        if (n++ === 0) throw new Error('bad url');
        return relay.factory(url, protocols);
      },
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual(['closed', 'bad url']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.state).toBe('open');
  });
});
