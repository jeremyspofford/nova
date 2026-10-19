// The web app's Content-Security-Policy lets the browser reach the Relay only while the Relay is on
// (docs/22 §3): the join page claims a pairing there and the Relay transport connects there, and
// `connect-src 'self'` alone blocked both (J9).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayConnectOrigins } from '../src/relay.ts';
import { makeTeamHub, type TeamHub } from './team-env.ts';

let env: TeamHub | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const connectSrc = (csp: string | undefined) =>
  (csp ?? '')
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('connect-src')) ?? '';

describe('relayConnectOrigins', () => {
  it('gives the HTTP and WebSocket origins of a Relay URL', () => {
    expect(relayConnectOrigins('https://relay.example:8443/base?x=1')).toEqual([
      'https://relay.example:8443',
      'wss://relay.example:8443',
    ]);
    expect(relayConnectOrigins('http://127.0.0.1:7420')).toEqual([
      'http://127.0.0.1:7420',
      'ws://127.0.0.1:7420',
    ]);
    // The settings suggest the WebSocket form: the HTTP origin is still needed for pairing.
    expect(relayConnectOrigins('wss://relay.example')).toEqual([
      'https://relay.example',
      'wss://relay.example',
    ]);
    expect(relayConnectOrigins('ws://127.0.0.1:7420/v1/relay/connect')).toEqual([
      'http://127.0.0.1:7420',
      'ws://127.0.0.1:7420',
    ]);
  });

  it('gives nothing for other schemes or a URL that does not parse', () => {
    expect(relayConnectOrigins('')).toEqual([]);
    expect(relayConnectOrigins('not a url')).toEqual([]);
    expect(relayConnectOrigins('javascript:alert(1)')).toEqual([]);
    expect(relayConnectOrigins('ftp://relay.example')).toEqual([]);
  });
});

describe('the Hub CSP and the Relay', () => {
  it('adds the Relay to connect-src only while it is on', async () => {
    env = await makeTeamHub();
    const { hub, owner } = env;
    const csp = async () =>
      connectSrc(
        (await hub.app.inject({ method: 'GET', url: '/api/v1/hello', headers: owner.headers }))
          .headers['content-security-policy'],
      );
    expect(await csp()).toBe("connect-src 'self'");

    const on = await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/relay',
      headers: owner.headers,
      // A closed loopback port: the connector's registration attempt never leaves this machine.
      payload: { url: 'https://127.0.0.1:9', enabled: true },
    });
    expect(on.statusCode).toBe(200);
    await vi.waitFor(async () =>
      expect(await csp()).toBe("connect-src 'self' https://127.0.0.1:9 wss://127.0.0.1:9"),
    );

    await hub.app.inject({
      method: 'PATCH',
      url: '/api/v1/relay',
      headers: owner.headers,
      payload: { enabled: false },
    });
    await vi.waitFor(async () => expect(await csp()).toBe("connect-src 'self'"));
  });
});
