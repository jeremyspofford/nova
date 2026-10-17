// A mock calendar MCP server with events for the J7 journey (docs/18 J7 steps 1, 2 and 5, and the
// M6 demo: booking a meeting asks before the invite is sent). Plain Node and the MCP server SDK
// only; the Hub runs it over stdio as an MCP server the owner adds in Settings > Tools & MCP.
//
// Tools the agent sees:
//   list_events {}                       the calendar's events (reads)
//   create_event {title, start, attendees?}   adds an event (writes)
//   send_invite {eventId}                emails the event's attendees (sends)
// No tool carries MCP annotations, so nothing about them is taken on the server's word.
//
// Events (FR-201): the experimental capability `nova/events` advertises `invite.received`; the
// server answers nova/events/subscribe, refresh and unsubscribe and POSTs deliveries to each
// subscriber's webhook with x-nova-event-id, x-nova-event-timestamp (Unix seconds) and
// x-nova-event-signature (`sha256=` HMAC-SHA256 of `<id>.<timestamp>.<body>`), the contract in
// packages/mcp/src/events.ts.
//
// The journey controls it from outside, never through a tool: with `--control <file>` the server
// listens on a loopback port and writes `{"port": N}` to that file. Its routes:
//   GET  /state   {calls, events, subscriptions}   tool calls so far, the calendar, subscribers
//   POST /emit    {event, data?, deliveryId?, unsigned?, padBytes?}
//                 → [{subscriptionId, deliveryId, status}] one delivery per subscriber
import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { argv, stderr } from 'node:process';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const EVENTS = [{ name: 'invite.received', description: 'Someone invited you to a meeting' }];
const anyParams = {
  '~standard': { version: 1, vendor: 'e2e', validate: (value) => ({ value: value ?? {} }) },
};
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const object = (properties, required = Object.keys(properties)) =>
  fromJsonSchema({ type: 'object', properties, required, additionalProperties: false });

const calendar = [
  {
    id: 'evt_1',
    title: 'Quarterly planning',
    start: '2026-10-20T15:00:00Z',
    attendees: ['sam@example.com'],
  },
  {
    id: 'evt_2',
    title: 'Dentist',
    start: '2026-10-21T09:30:00Z',
    attendees: [],
  },
];
/** Tool calls in order: {tool, args}. */
const calls = [];
/** id → {event, url, secret, expiresAt} */
const subs = new Map();

const server = new McpServer(
  { name: 'e2e-calendar', version: '1.0.0' },
  { capabilities: { experimental: { 'nova/events': { events: EVENTS } } } },
);
const expiry = (ttl) =>
  new Date(Date.now() + Math.min(Math.max(Number(ttl) || 3600, 60), 3600) * 1000).toISOString();

server.server.setRequestHandler('nova/events/subscribe', { params: anyParams }, (p) => {
  if (!EVENTS.some((e) => e.name === p.event)) throw new Error(`unknown event ${p.event}`);
  if (!p.webhook?.url || !p.webhook?.secret)
    throw new Error('a webhook url and secret are required');
  const id = `sub_${randomUUID()}`;
  const expiresAt = expiry(p.ttlSeconds);
  subs.set(id, { event: p.event, url: p.webhook.url, secret: p.webhook.secret, expiresAt });
  return { subscriptionId: id, expiresAt };
});
server.server.setRequestHandler('nova/events/refresh', { params: anyParams }, (p) => {
  const s = subs.get(p.subscriptionId);
  if (!s) throw new Error('unknown subscription');
  s.expiresAt = expiry(p.ttlSeconds);
  return { expiresAt: s.expiresAt };
});
server.server.setRequestHandler('nova/events/unsubscribe', { params: anyParams }, (p) => {
  subs.delete(p.subscriptionId);
  return {};
});

server.registerTool(
  'list_events',
  {
    title: 'List events',
    description: 'List the events on the calendar',
    inputSchema: object({}),
  },
  (args) => {
    calls.push({ tool: 'list_events', args });
    return text(JSON.stringify(calendar));
  },
);
server.registerTool(
  'create_event',
  {
    title: 'Create an event',
    description: 'Add an event to the calendar',
    inputSchema: object(
      {
        title: { type: 'string' },
        start: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      ['title', 'start'],
    ),
  },
  (args) => {
    calls.push({ tool: 'create_event', args });
    const event = {
      id: `evt_${calendar.length + 1}`,
      title: args.title,
      start: args.start,
      attendees: args.attendees ?? [],
    };
    calendar.push(event);
    return text(`Created ${event.id}: ${event.title} at ${event.start}`);
  },
);
server.registerTool(
  'send_invite',
  {
    title: 'Send an invite',
    description: "Email an event's invitation to its attendees",
    inputSchema: object({ eventId: { type: 'string' } }),
  },
  (args) => {
    calls.push({ tool: 'send_invite', args });
    const event = calendar.find((e) => e.id === args.eventId);
    if (!event) return { ...text(`No event ${args.eventId}`), isError: true };
    return text(`Invite for ${event.title} sent to ${event.attendees.join(', ') || 'nobody'}`);
  },
);

function sign(secret, id, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('hex')}`;
}

async function emit(a) {
  const results = [];
  for (const [id, s] of subs) {
    if (s.event !== a.event) continue;
    const deliveryId = a.deliveryId ?? `dlv_${randomUUID()}`;
    const body = JSON.stringify({
      subscriptionId: id,
      event: a.event,
      data: a.data ?? null,
      occurredAt: new Date().toISOString(),
      ...(a.padBytes ? { pad: 'x'.repeat(a.padBytes) } : {}),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json' };
    if (!a.unsigned) {
      headers['x-nova-event-id'] = deliveryId;
      headers['x-nova-event-timestamp'] = ts;
      headers['x-nova-event-signature'] = sign(s.secret, deliveryId, ts, body);
    }
    try {
      const res = await fetch(s.url, { method: 'POST', headers, body });
      results.push({ subscriptionId: id, deliveryId, status: res.status, body: await res.text() });
    } catch (err) {
      results.push({ subscriptionId: id, deliveryId, error: String(err) });
    }
  }
  return results;
}

function startControl(file) {
  const control = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'GET' && req.url === '/state')
        return send(200, {
          calls,
          events: calendar,
          subscriptions: [...subs].map(([id, s]) => ({
            id,
            event: s.event,
            url: s.url,
            expiresAt: s.expiresAt,
          })),
        });
      if (req.method === 'POST' && req.url === '/emit') {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          return send(400, { error: 'not JSON' });
        }
        emit(body).then(
          (r) => send(200, r),
          (err) => send(500, { error: String(err) }),
        );
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  control.listen(0, '127.0.0.1', () => {
    writeFileSync(file, JSON.stringify({ port: control.address().port }));
  });
  control.unref();
}

const i = argv.indexOf('--control');
if (i >= 0 && argv[i + 1]) startControl(argv[i + 1]);
await server.connect(new StdioServerTransport());
stderr.write('e2e-calendar ready\n');
