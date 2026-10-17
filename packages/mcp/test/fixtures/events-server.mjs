// An MCP server with events for Nova's tests and the J7 journey (FR-201, docs/18 J7 step 5).
// Plain Node and the MCP server SDK only. It advertises the experimental capability
// `nova/events` with two events (ticket.created, build.failed), answers nova/events/subscribe,
// refresh and unsubscribe, and POSTs signed deliveries to the subscribers' webhooks:
// x-nova-event-id, x-nova-event-timestamp (Unix seconds) and x-nova-event-signature
// (`sha256=` HMAC-SHA256 of `<id>.<timestamp>.<body>` with the subscription's secret).
//
// Tools (the test drives deliveries through them):
//   emit_event {event, data?, deliveryId?, unsigned?, badSignature?, padBytes?, staleSeconds?}
//       deliver to every subscriber of `event`; returns their HTTP statuses
//   subscriptions {}   the current subscriptions (ids, events, expiry, refresh count)
//
// Run it over stdio with `node packages/mcp/test/fixtures/events-server.mjs [--ttl <seconds>]`;
// tests also build it in process (createEventsServer).
import { createHmac, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { argv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

export const EVENTS = [
  { name: 'ticket.created', description: 'A support ticket was opened' },
  { name: 'build.failed', description: 'A build failed' },
];

const anyParams = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value ?? {} }) },
};
const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function signDelivery(secret, id, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Build the server. `options.ttlSeconds` caps subscription lifetimes; `options.fetch` replaces the
 * HTTP client deliveries use; `options.now` the clock.
 */
export function createEventsServer(options = {}) {
  const now = options.now ?? (() => Date.now());
  const post = options.fetch ?? ((url, init) => fetch(url, init));
  const maxTtl = options.ttlSeconds ?? 3600;
  /** id → {event, url, secret, filter, expiresAt, refreshes} */
  const subs = new Map();
  const server = new McpServer(
    { name: 'nova-events-server', version: '1.0.0' },
    { capabilities: { experimental: { 'nova/events': { events: EVENTS } } } },
  );
  const expiry = (ttl) =>
    new Date(now() + Math.min(Math.max(Number(ttl) || maxTtl, 1), maxTtl) * 1000).toISOString();

  server.server.setRequestHandler('nova/events/subscribe', { params: anyParams }, (p) => {
    if (!EVENTS.some((e) => e.name === p.event)) throw new Error(`unknown event ${p.event}`);
    if (!p.webhook?.url || !p.webhook?.secret)
      throw new Error('a webhook url and secret are required');
    const id = `sub_${randomUUID()}`;
    const expiresAt = expiry(p.ttlSeconds);
    subs.set(id, {
      event: p.event,
      url: p.webhook.url,
      secret: p.webhook.secret,
      filter: p.filter ?? null,
      expiresAt,
      refreshes: 0,
    });
    return { subscriptionId: id, expiresAt };
  });
  server.server.setRequestHandler('nova/events/refresh', { params: anyParams }, (p) => {
    const s = subs.get(p.subscriptionId);
    if (!s) throw new Error('unknown subscription');
    s.expiresAt = expiry(p.ttlSeconds);
    s.refreshes += 1;
    return { expiresAt: s.expiresAt };
  });
  server.server.setRequestHandler('nova/events/unsubscribe', { params: anyParams }, (p) => {
    subs.delete(p.subscriptionId);
    return {};
  });

  server.registerTool(
    'emit_event',
    {
      title: 'Emit an event',
      description: 'Deliver an event to its subscribers (test control)',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          event: { type: 'string' },
          data: {},
          deliveryId: { type: 'string' },
          unsigned: { type: 'boolean' },
          badSignature: { type: 'boolean' },
          padBytes: { type: 'number' },
          staleSeconds: { type: 'number' },
        },
        required: ['event'],
        additionalProperties: false,
      }),
    },
    async (a) => {
      const results = [];
      for (const [id, s] of subs) {
        if (s.event !== a.event) continue;
        const deliveryId = a.deliveryId ?? `dlv_${randomUUID()}`;
        const body = JSON.stringify({
          subscriptionId: id,
          event: a.event,
          data: a.data ?? null,
          occurredAt: new Date(now()).toISOString(),
          ...(a.padBytes ? { pad: 'x'.repeat(a.padBytes) } : {}),
        });
        const ts = String(Math.floor(now() / 1000) - (a.staleSeconds ?? 0));
        const headers = { 'content-type': 'application/json' };
        if (!a.unsigned) {
          headers['x-nova-event-id'] = deliveryId;
          headers['x-nova-event-timestamp'] = ts;
          headers['x-nova-event-signature'] = signDelivery(
            a.badSignature ? 'wrong-secret' : s.secret,
            deliveryId,
            ts,
            body,
          );
        }
        try {
          const res = await post(s.url, { method: 'POST', headers, body });
          results.push({ subscriptionId: id, deliveryId, status: res.status });
        } catch (err) {
          results.push({ subscriptionId: id, deliveryId, error: String(err) });
        }
      }
      return text(JSON.stringify(results));
    },
  );
  server.registerTool(
    'subscriptions',
    {
      title: 'Subscriptions',
      description: 'The current subscriptions (test control)',
      inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    },
    () =>
      text(
        JSON.stringify(
          [...subs].map(([id, s]) => ({
            id,
            event: s.event,
            url: s.url,
            expiresAt: s.expiresAt,
            refreshes: s.refreshes,
          })),
        ),
      ),
  );
  return { server, subscriptions: subs };
}

function isMain() {
  try {
    return realpathSync(argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const i = argv.indexOf('--ttl');
  const ttlSeconds = i >= 0 ? Number(argv[i + 1]) : undefined;
  const { server } = createEventsServer(ttlSeconds ? { ttlSeconds } : {});
  await server.connect(new StdioServerTransport());
  stderr.write('nova-events-server ready\n');
}
