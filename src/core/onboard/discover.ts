// Discovery during setup (Amendment 2026-10-31-B Part 2; docs/plans/smart-home.md §6 and §10;
// docs/plans/M10f.md §3). It runs only when the person asks, and finds: it connects to nothing,
// signs in to nothing, and keeps nothing but the list of what was found (tier 1: done and reported).
//
//   on this computer   the services Nova already has adapters for, at their loopback addresses:
//                      a model runtime (Ollama), Screenpipe, Home Assistant. One GET each.
//   on the network     one DNS-SD query by multicast DNS for a home hub (Home Assistant) and for
//                      computers that advertise themselves. No port scan, no login, no default
//                      password, nothing that changes a device.
//
// The transport is injected. The real one sends to 224.0.0.251:5353 from an ephemeral port; the
// tests' one sends the same bytes by unicast to a fake responder on 127.0.0.1 and binds 127.0.0.1,
// so no test sends multicast or touches the real network (smart-home ADR §10).
import { createSocket } from 'node:dgram';
import { decodeMessage, encodeQuery, instances, type Instance, type Message } from './mdns.ts';

export type FoundKind = 'model-runtime' | 'screenpipe' | 'home-assistant' | 'computer';
export interface Found { kind: FoundKind; name: string; where: 'this computer' | 'your network'; address: string; detail: string; connected: false }
export interface Discovery { scope: 'device' | 'network'; found: Found[]; looked: string[]; transport: string; bound: string | null; at: string }

export interface DiscoveryTransport {
  readonly name: string;
  // A GET at a loopback address; null when nothing answers in time.
  get(url: string, timeoutMs: number): Promise<{ status: number; body: string } | null>;
  // The query sent once; every reply that arrives within the wait. `bound` is the local address
  // the socket was bound to.
  query(packet: Buffer, timeoutMs: number): Promise<{ bound: string; replies: Buffer[] }>;
  // Where each local service is looked for (its usual port, unless a stand-in says otherwise).
  port(kind: Exclude<FoundKind, 'computer'>): number;
}

export const LOCAL_PORTS: Readonly<Record<Exclude<FoundKind, 'computer'>, number>> = Object.freeze({ 'model-runtime': 11434, screenpipe: 3030, 'home-assistant': 8123 });
export const SERVICES = Object.freeze({ homeAssistant: '_home-assistant._tcp.local', computer: '_workstation._tcp.local' });

async function get(url: string, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const body = (await r.text()).slice(0, 64 * 1024);
    return { status: r.status, body };
  } catch { return null; }
}

function udpQuery(o: { to: string; port: number; bind: string; multicast: boolean }) {
  return (packet: Buffer, timeoutMs: number) => new Promise<{ bound: string; replies: Buffer[] }>((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const replies: Buffer[] = [];
    let bound = '';
    const done = () => { try { socket.close(); } catch { /* closed */ } resolve({ bound, replies }); };
    socket.on('message', (m) => { if (replies.length < 64) replies.push(m); });
    socket.on('error', done);
    socket.bind(0, o.bind, () => {
      bound = socket.address().address;
      if (o.multicast) { try { socket.setMulticastTTL(255); } catch { /* not supported here */ } }
      socket.send(packet, o.port, o.to, (err) => { if (err) done(); });
      setTimeout(done, timeoutMs).unref?.();
    });
  });
}

// What Nova uses on a real machine: loopback GETs, and one multicast query on the network.
export function realTransport(): DiscoveryTransport {
  return { name: 'this computer and the local network', get, query: udpQuery({ to: '224.0.0.251', port: 5353, bind: '0.0.0.0', multicast: true }), port: (k) => LOCAL_PORTS[k] };
}

// Stand-ins on loopback only (tests): local services at the given ports, and the mDNS query sent by
// unicast to a fake responder at 127.0.0.1:<port>, from a socket bound to 127.0.0.1.
export function loopbackTransport(o: { ports?: Partial<Record<Exclude<FoundKind, 'computer'>, number>>; mdns?: number | null }): DiscoveryTransport {
  const ports = { ...LOCAL_PORTS, ...(o.ports ?? {}) };
  const query = o.mdns ? udpQuery({ to: '127.0.0.1', port: o.mdns, bind: '127.0.0.1', multicast: false }) : async () => ({ bound: '127.0.0.1', replies: [] });
  return { name: 'loopback stand-ins', get, query, port: (k) => ports[k] };
}

// `NOVA_DISCOVERY_PORTS=model-runtime=4567,home-assistant=4568` and `NOVA_DISCOVERY_MDNS=127.0.0.1:5399`
// point discovery at stand-ins on loopback (tests and demos). Anything but loopback is refused.
export function transportFromEnv(env: NodeJS.ProcessEnv): DiscoveryTransport | null {
  if (!env.NOVA_DISCOVERY_PORTS && !env.NOVA_DISCOVERY_MDNS) return null;
  const ports: Partial<Record<Exclude<FoundKind, 'computer'>, number>> = {};
  for (const pair of (env.NOVA_DISCOVERY_PORTS ?? '').split(',').filter(Boolean)) {
    const [k, v] = pair.split('=');
    if (k && k in LOCAL_PORTS && Number(v) > 0) ports[k as Exclude<FoundKind, 'computer'>] = Number(v);
  }
  const m = /^127\.0\.0\.1:(\d+)$/.exec(env.NOVA_DISCOVERY_MDNS ?? '');
  return loopbackTransport({ ports, mdns: m ? Number(m[1]) : null });
}

const parse = (s: string): Record<string, unknown> | null => { try { const j = JSON.parse(s); return j && typeof j === 'object' ? j as Record<string, unknown> : null; } catch { return null; } };
const clip = (s: unknown, n = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

async function local(t: DiscoveryTransport, timeoutMs: number): Promise<Found[]> {
  const at = (k: Exclude<FoundKind, 'computer'>) => `127.0.0.1:${t.port(k)}`;
  const [ollama, screenpipe, ha] = await Promise.all([
    t.get(`http://${at('model-runtime')}/api/version`, timeoutMs),
    t.get(`http://${at('screenpipe')}/health`, timeoutMs),
    t.get(`http://${at('home-assistant')}/manifest.json`, timeoutMs),
  ]);
  const found: Found[] = [];
  const o = ollama?.status === 200 ? parse(ollama.body) : null;
  if (o && typeof o.version === 'string') found.push({ kind: 'model-runtime', name: `Ollama ${clip(o.version, 20)}`, where: 'this computer', address: at('model-runtime'), detail: 'A local model runtime. Settings › Models can use it.', connected: false });
  if (screenpipe && screenpipe.status === 200) found.push({ kind: 'screenpipe', name: 'Screenpipe', where: 'this computer', address: at('screenpipe'), detail: 'Screen and audio capture. It stays off until you turn it on in Settings › Capture.', connected: false });
  const h = ha?.status === 200 ? parse(ha.body) : null;
  if (h && /home assistant/i.test(String(h.name ?? ''))) found.push({ kind: 'home-assistant', name: 'Home Assistant', where: 'this computer', address: at('home-assistant'), detail: 'A home hub. Connecting it asks for a token first, in Settings › Connections.', connected: false });
  return found;
}

function fromNetwork(list: Instance[]): Found[] {
  return list.map((i): Found => {
    const address = `${i.addresses[0] ?? i.host ?? 'unknown address'}${i.port ? `:${i.port}` : ''}`;
    if (i.service === SERVICES.homeAssistant) {
      const name = clip(i.txt.location_name || i.name);
      return { kind: 'home-assistant', name: `Home Assistant “${name}”${i.txt.version ? ` ${clip(i.txt.version, 20)}` : ''}`, where: 'your network', address, detail: 'A home hub. Connecting it asks for a token first, in Settings › Connections.', connected: false };
    }
    return { kind: 'computer', name: clip(i.name.replace(/\s*\[[0-9a-f:]+\]$/i, '')), where: 'your network', address, detail: 'A computer. It could join Nova as a device: Settings › Devices › Add a device.', connected: false };
  });
}

export async function discover(o: { scope: 'device' | 'network'; transport: DiscoveryTransport; timeoutMs?: number; now?: () => Date }): Promise<Discovery> {
  const timeoutMs = o.timeoutMs ?? 1500;
  const looked = ['a model runtime, Screenpipe and Home Assistant on this computer'];
  const found = await local(o.transport, timeoutMs);
  let bound: string | null = null;
  if (o.scope === 'network') {
    looked.push('a home hub and other computers on your network, with one query');
    const r = await o.transport.query(encodeQuery([SERVICES.homeAssistant, SERVICES.computer]), timeoutMs);
    bound = r.bound;
    const messages: Message[] = [];
    for (const b of r.replies) { try { messages.push(decodeMessage(b)); } catch { /* a reply that can't be read is ignored */ } }
    const seen = new Set(found.map((f) => f.address));
    for (const f of fromNetwork(instances(messages, [SERVICES.homeAssistant, SERVICES.computer]))) if (!seen.has(f.address)) { seen.add(f.address); found.push(f); }
  }
  return { scope: o.scope, found: found.slice(0, 20), looked, transport: o.transport.name, bound, at: (o.now?.() ?? new Date()).toISOString() };
}
