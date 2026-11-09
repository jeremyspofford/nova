// Stand-ins for discovery (M10f): an mDNS responder and a model runtime, both on 127.0.0.1 only.
// No test sends multicast or touches the real network (docs/plans/smart-home.md §10): discovery is
// pointed at these by its loopback transport (NOVA_DISCOVERY_MDNS, NOVA_DISCOVERY_PORTS).
// Placeholder names only.
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { decodeMdns, encodeMdnsResponse, type MdnsAnswer } from '../../src/core/index.ts';

// What the responder says: a placeholder Home Assistant and a computer advertising itself.
export const HOME_ANSWERS: MdnsAnswer[] = [
  { type: 12, name: '_home-assistant._tcp.local', ttl: 120, target: 'Example Home._home-assistant._tcp.local' },
  { type: 33, name: 'Example Home._home-assistant._tcp.local', ttl: 120, target: 'homehub.local', port: 8123, priority: 0, weight: 0 },
  { type: 16, name: 'Example Home._home-assistant._tcp.local', ttl: 120, txt: { location_name: 'Example Home', version: '2026.10.0', base_url: 'http://192.0.2.10:8123' } },
  { type: 1, name: 'homehub.local', ttl: 120, address: '192.0.2.10' },
  { type: 12, name: '_workstation._tcp.local', ttl: 120, target: 'desk-box [00:00:5e:00:53:01]._workstation._tcp.local' },
  { type: 33, name: 'desk-box [00:00:5e:00:53:01]._workstation._tcp.local', ttl: 120, target: 'desk-box.local', port: 9, priority: 0, weight: 0 },
  { type: 1, name: 'desk-box.local', ttl: 120, address: '192.0.2.20' },
];

export interface FakeMdns { port: number; queries: { from: string; names: string[] }[]; close(): Promise<void> }

export async function fakeMdns(answers: MdnsAnswer[] = HOME_ANSWERS): Promise<FakeMdns> {
  const socket: Socket = createSocket('udp4');
  const queries: FakeMdns['queries'] = [];
  socket.on('message', (msg, rinfo) => {
    try {
      const q = decodeMdns(msg);
      queries.push({ from: rinfo.address, names: q.questions.map((x) => x.name) });
      socket.send(encodeMdnsResponse(answers, q.id), rinfo.port, rinfo.address);
    } catch { /* not a query */ }
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return { port: socket.address().port, queries, close: () => new Promise<void>((r) => socket.close(() => r())) };
}

export interface FakeRuntime { port: number; hits: string[]; close(): Promise<void> }

// A model runtime that answers /api/version, as Ollama does, and records every request.
export async function fakeRuntime(): Promise<FakeRuntime> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/api/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '0.35.1' })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export interface AbsentService { port: number; attempts: number; close(): Promise<void> }

// A service the test wants absent, at a port the test holds for as long as it needs it. Every
// connection is reset as it arrives, before a byte is read or written, so discovery finds nothing
// there, and the port can't be taken by anything else. (A port bound and then released, as this
// once was, is free for the next listener in any parallel test file; WSL2 offers listeners about a
// thousand port numbers, so one often was taken, and a Nova server there answers GET /health 200,
// which discovery rightly reads as Screenpipe.) `attempts` counts the connections refused.
export async function absentService(): Promise<AbsentService> {
  let attempts = 0;
  const server: NetServer = createNetServer({ pauseOnConnect: true }, (socket) => { attempts++; socket.resetAndDestroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    get attempts() { return attempts; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface DiscoveryStandIns { runtime: FakeRuntime; mdns: FakeMdns; screenpipe: AbsentService; homeAssistant: AbsentService; env: { NOVA_DISCOVERY_PORTS: string; NOVA_DISCOVERY_MDNS: string } }

// Every stand-in discovery looks at: a model runtime, the mDNS responder, and Screenpipe and Home
// Assistant held absent. Each is handed to `cleanup` (a test's `t.after`) the moment it exists, so
// a test that fails at any point still closes all of them, and its process can end.
export async function discoveryStandIns(cleanup: (close: () => Promise<void>) => void): Promise<DiscoveryStandIns> {
  const own = async <T extends { close(): Promise<void> }>(make: Promise<T>): Promise<T> => { const x = await make; cleanup(() => x.close()); return x; };
  const runtime = await own(fakeRuntime());
  const mdns = await own(fakeMdns());
  const screenpipe = await own(absentService());
  const homeAssistant = await own(absentService());
  return {
    runtime, mdns, screenpipe, homeAssistant,
    env: {
      NOVA_DISCOVERY_PORTS: `model-runtime=${runtime.port},screenpipe=${screenpipe.port},home-assistant=${homeAssistant.port}`,
      NOVA_DISCOVERY_MDNS: `127.0.0.1:${mdns.port}`,
    },
  };
}
