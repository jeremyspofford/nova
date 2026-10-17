// MCP event subscriptions, client side (FR-201): the advertised `nova/events` capability, the
// subscribe, refresh and unsubscribe calls against the events fixture, and the signed deliveries
// the fixture sends to the webhook it was given.
import { createHmac } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  McpEventsClient,
  advertisedEvents,
  sdkClientTransport,
  type McpEventTransport,
} from '../src/index.ts';
import { createEventsServer, type FixtureSubscription } from './fixtures/events-server.mjs';

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let client: Client;
let subs: Map<string, FixtureSubscription>;
let posted: Posted[];
let events: McpEventsClient;
const signal = () => AbortSignal.timeout(5000);

beforeEach(async () => {
  posted = [];
  const fixture = createEventsServer({
    ttlSeconds: 600,
    fetch: (url, init) => {
      posted.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve({ status: 200 });
    },
  });
  subs = fixture.subscriptions;
  const [c, s] = InMemoryTransport.createLinkedPair();
  await fixture.server.connect(s);
  client = new Client({ name: 'nova-test', version: '0.0.0' });
  await client.connect(c);
  events = new McpEventsClient(sdkClientTransport((id) => (id === 'srv' ? client : null)));
});

afterEach(async () => {
  await client.close();
});

describe('advertised events', () => {
  it('reads the nova/events capability', () => {
    expect(events.events('srv')).toEqual([
      { name: 'ticket.created', description: 'A support ticket was opened' },
      { name: 'build.failed', description: 'A build failed' },
    ]);
    expect(events.events('other')).toBeNull();
  });

  it('a server without the capability offers none, and malformed entries are skipped', () => {
    expect(advertisedEvents({ tools: {} })).toEqual([]);
    expect(advertisedEvents(null)).toBeNull();
    expect(
      advertisedEvents({
        experimental: { 'nova/events': { events: [{ name: 'ok' }, { nope: 1 }, 'x'] } },
      }),
    ).toEqual([{ name: 'ok', description: null }]);
  });
});

describe('subscription calls', () => {
  it('subscribes with the webhook and secret, refreshes and unsubscribes', async () => {
    const sub = await events.subscribe(
      'srv',
      {
        event: 'ticket.created',
        webhookUrl: 'https://hub.example/api/v1/mcp/events/s1',
        // secret-scan: fake
        secret: 'secret-1',
        filter: { queue: 'support' },
        ttlSeconds: 3600,
      },
      signal(),
    );
    expect(sub.remoteId).toMatch(/^sub_/);
    expect(sub.expiresAt).not.toBeNull();
    const stored = subs.get(sub.remoteId)!;
    expect(stored).toMatchObject({
      event: 'ticket.created',
      url: 'https://hub.example/api/v1/mcp/events/s1',
      // secret-scan: fake
      secret: 'secret-1',
      filter: { queue: 'support' },
    });

    const refreshed = await events.refresh('srv', sub.remoteId, 3600, signal());
    expect(refreshed.expiresAt).not.toBeNull();
    expect(stored.refreshes).toBe(1);

    await events.unsubscribe('srv', sub.remoteId, signal());
    expect(subs.size).toBe(0);
  });

  it('deliveries carry an id, a timestamp and the HMAC over id.timestamp.body', async () => {
    const sub = await events.subscribe(
      'srv',
      {
        event: 'build.failed',
        webhookUrl: 'https://hub.example/hook',
        secret: 's3cret',
        filter: null,
        ttlSeconds: 60,
      },
      signal(),
    );
    await client.callTool({
      name: 'emit_event',
      arguments: { event: 'build.failed', data: { n: 1 } },
    });
    expect(posted).toHaveLength(1);
    const p = posted[0]!;
    const id = p.headers['x-nova-event-id']!;
    const ts = p.headers['x-nova-event-timestamp']!;
    const expected = `sha256=${createHmac('sha256', 's3cret').update(`${id}.${ts}.${p.body}`).digest('hex')}`;
    expect(p.headers['x-nova-event-signature']).toBe(expected);
    expect(JSON.parse(p.body)).toMatchObject({
      subscriptionId: sub.remoteId,
      event: 'build.failed',
      data: { n: 1 },
    });
  });

  it('refuses an event the server does not advertise, and a server that is not connected', async () => {
    await expect(
      events.subscribe(
        'srv',
        {
          event: 'nope',
          webhookUrl: 'https://x.example/',
          secret: 's',
          filter: null,
          ttlSeconds: 1,
        },
        signal(),
      ),
    ).rejects.toThrow(/does not advertise/);
    await expect(
      events.subscribe(
        'gone',
        {
          event: 'ticket.created',
          webhookUrl: 'https://x.example/',
          secret: 's',
          filter: null,
          ttlSeconds: 1,
        },
        signal(),
      ),
    ).rejects.toThrow(/not connected/);
    await expect(events.unsubscribe('gone', 'x', signal())).rejects.toThrow(/not connected/);
  });

  it('rejects a subscribe answer without an id; tolerates a refresh without an expiry', async () => {
    const fake: McpEventTransport = {
      capabilities: () => ({ experimental: { 'nova/events': { events: [{ name: 'e' }] } } }),
      request: (_s, method) =>
        Promise.resolve(
          method === 'nova/events/subscribe' ? { expiresAt: 'soon' } : { expiresAt: 42 },
        ),
    };
    const c = new McpEventsClient(fake);
    await expect(
      c.subscribe(
        'x',
        { event: 'e', webhookUrl: 'u', secret: 's', filter: null, ttlSeconds: 1 },
        signal(),
      ),
    ).rejects.toThrow(/subscription id/);
    expect(await c.refresh('x', 'r', 1, signal())).toEqual({ expiresAt: null });
  });
});
