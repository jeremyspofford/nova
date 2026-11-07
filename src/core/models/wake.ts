// Wake-on-LAN (M6 plan §2; docs/plans/wol-inference-nodes-adr-2026-11-06.md, "Security"): the hub
// wakes a sleeping compute device with a magic packet, six 0xFF bytes and then the device's MAC
// sixteen times, sent as UDP to the broadcast address of a network the hub itself is on, from the
// hub's own card on that network. Nothing here decides whether a wake is wanted; the model manager
// does (opt-in, rate limits, the ledger). This module only says where a wake may go, and sends it.
// Tests hand in a stand-in sender, so no packet reaches a real network.
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { broadcastOf, privateAddress } from './hardware.ts';

const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

export function magicPacket(mac: string): Buffer {
  if (!MAC.test(mac)) throw new Error(`${mac} isn’t a MAC address.`);
  const bytes = Buffer.from(mac.split(/[:-]/).map((x) => parseInt(x, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

// "host:port", or a bare host on the usual port 9.
export function parseTarget(t: string): { host: string; port: number } {
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(t.trim());
  if (!m) throw new Error(`${t} isn’t a wake target (host:port).`);
  const port = m[2] ? Number(m[2]) : 9;
  if (port < 1 || port > 65535) throw new Error(`${t} has no usable port.`);
  return { host: m[1]!, port };
}

// ---- where a wake may go: the same-network test --------------------------------------------------

// A network card as the hub knows it: one of its own (read from the OS, never reported) or one a
// device reported in its heartbeat (already through checkHardware).
export interface Card { name?: string; address: string; netmask: string; mac?: string; wol?: 'magic' | 'off' | 'unknown' }

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIpv4 = (a: string) => IPV4.test(a) && a.split('.').every((x) => Number(x) <= 255);
const toInt = (a: string) => a.split('.').reduce((n, x) => ((n << 8) + Number(x)) >>> 0, 0);

// The prefix length of a contiguous netmask (ones, then zeros), or null for anything else.
export function prefixOf(mask: string): number | null {
  if (!isIpv4(mask)) return null;
  const n = toInt(mask);
  let p = 0;
  while (p < 32 && (n & (0x80000000 >>> p)) !== 0) p++;
  const expected = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return n === expected ? p : null;
}

// A wake network is a LAN between /16 and /30: a /10 is how Windows shows a mesh adapter, and a /8 or
// a 0.0.0.0 mask would make a broadcast that reaches far more than one home network.
export const WAKE_PREFIX = { min: 16, max: 30 } as const;

export type CardFault = 'not_private' | 'mesh' | 'netmask';

// Why a card can't be a wake network by itself, or null. `privateAddress` is the existing classifier,
// read unchanged; on top of it a wake network is never loopback or the limited broadcast, never one
// of the mesh's own addresses, never in the shared range mesh VPNs use (100.64.0.0/10), and its mask
// is contiguous with a prefix from /16 to /30.
export function cardFault(c: Card, mesh: (a: string) => boolean): CardFault | null {
  if (!isIpv4(c.address) || !privateAddress(c.address) || c.address.startsWith('127.') || c.address === '255.255.255.255') return 'not_private';
  if (mesh(c.address) || ((toInt(c.address) & 0xffc00000) >>> 0) === toInt('100.64.0.0')) return 'mesh';
  const p = prefixOf(c.netmask);
  return p === null || p < WAKE_PREFIX.min || p > WAKE_PREFIX.max ? 'netmask' : null;
}

export interface WakeRoute { sender: Card; card: Card; bind: string; target: string; port: number }
export type RouteRefusal = 'no_card' | CardFault | 'no_sender';

// The same-network test (the ADR's five rules): a hub card s and a device card d, both passing
// `cardFault`, with equal masks, on the same subnet. The target is s's own broadcast address on port
// 9, computed here from the hub's card; whatever broadcast the device reported is never used. The
// socket is bound to s, so the packet leaves on that card. `prefer` is the address the device's models
// answer at, tried first.
export function wakeRoute(hub: Card[], device: Card[], mesh: (a: string) => boolean, prefer?: string): { ok: true; route: WakeRoute } | { ok: false; reason: RouteRefusal } {
  if (!device.length) return { ok: false, reason: 'no_card' };
  const faults = device.map((d) => cardFault(d, mesh));
  const usable = device.filter((_, i) => faults[i] === null).sort((a, b) => Number(b.address === prefer) - Number(a.address === prefer));
  if (!usable.length) return { ok: false, reason: faults.includes('mesh') ? 'mesh' : faults.includes('netmask') ? 'netmask' : 'not_private' };
  for (const d of usable) {
    for (const s of hub) {
      if (cardFault(s, mesh) !== null || s.netmask !== d.netmask) continue;
      const mask = toInt(s.netmask);
      if (((toInt(s.address) & mask) >>> 0) !== ((toInt(d.address) & mask) >>> 0)) continue;
      const target = broadcastOf(s.address, s.netmask);
      if (target) return { ok: true, route: { sender: s, card: d, bind: s.address, target, port: 9 } };
    }
  }
  return { ok: false, reason: 'no_sender' };
}

// Whether the person's own target (PUT /models/wake) passes the same test for this route: a private
// IPv4 address on the sender's own subnet. Anything else is refused for this device.
export function targetOnRoute(host: string, r: WakeRoute): boolean {
  if (!isIpv4(host) || !privateAddress(host)) return false;
  const mask = toInt(r.sender.netmask);
  return ((toInt(host) & mask) >>> 0) === ((toInt(r.sender.address) & mask) >>> 0);
}

// The hub's own IPv4 cards, from the OS. Loopback and other internal cards never send a wake.
export function hubCards(): Card[] {
  const out: Card[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') out.push({ name, address: a.address, netmask: a.netmask });
  }
  return out;
}

// ---- sending ------------------------------------------------------------------------------------

export interface WakeSend { packet: Buffer; host: string; port: number; bind: string | null }
// Sends one datagram. The real one opens a UDP socket; tests hand in a recorder that opens nothing.
export type Sender = (s: WakeSend) => Promise<void>;

export const udpSender: Sender = ({ packet, host, port, bind }) => {
  const sock = createSocket('udp4');
  return new Promise((resolve, reject) => {
    sock.once('error', (e) => { sock.close(); reject(e); });
    sock.bind({ port: 0, ...(bind ? { address: bind } : {}) }, () => {
      try { sock.setBroadcast(true); } catch { /* a unicast target needs no broadcast */ }
      sock.send(packet, port, host, (e) => {
        sock.close();
        if (e) reject(e); else resolve();
      });
    });
  });
};

// `count` packets `gapMs` apart (UDP may drop one; the device ignores the extras), from `bind`.
export async function sendMagic(mac: string, target: string, o: { bind?: string; sender?: Sender; count?: number; gapMs?: number } = {}): Promise<void> {
  const { host, port } = parseTarget(target);
  const packet = magicPacket(mac);
  const send = o.sender ?? udpSender;
  for (let i = 0; i < (o.count ?? 1); i++) {
    if (i) await new Promise((r) => setTimeout(r, o.gapMs ?? 1000));
    await send({ packet, host, port, bind: o.bind ?? null });
  }
}
