// IP address helpers for the Hub's endpoints and Wake Helper routing (FR-135, FR-138). Subnet
// tests use node:net's BlockList, which understands IPv4, IPv6 and IPv4-mapped IPv6.
import { BlockList, isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';

/** An address without brackets or an IPv6 zone, IPv4-mapped IPv6 as plain IPv4; null if not an IP. */
export function normalizeIp(address: string): string | null {
  let a = address.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped?.[1]) a = mapped[1];
  return isIP(a) ? a.toLowerCase() : null;
}

export function ipFamily(address: string): 4 | 6 | null {
  const a = normalizeIp(address);
  if (!a) return null;
  return isIP(a) === 4 ? 4 : 6;
}

function list(entries: [string, number][], family: 4 | 6): BlockList {
  const b = new BlockList();
  for (const [net, prefix] of entries) b.addSubnet(net, prefix, family === 4 ? 'ipv4' : 'ipv6');
  return b;
}

const LOOPBACK4 = list([['127.0.0.0', 8]], 4);
const LINK_LOCAL4 = list([['169.254.0.0', 16]], 4);
const LINK_LOCAL6 = list([['fe80::', 10]], 6);
// Addresses of WireGuard meshes: the shared address space Tailscale, Headscale and NetBird hand
// out, and Tailscale's IPv6 range. They belong to the mesh transport, never to the LAN.
const MESH4 = list([['100.64.0.0', 10]], 4);
const MESH6 = list([['fd7a:115c:a1e0::', 48]], 6);

function check(b: BlockList, address: string): boolean {
  const a = normalizeIp(address);
  if (!a) return false;
  return b.check(a, isIP(a) === 4 ? 'ipv4' : 'ipv6');
}

export function isLoopbackIp(address: string): boolean {
  const a = normalizeIp(address);
  return a === '::1' || (a !== null && check(LOOPBACK4, a));
}

export function isLinkLocalIp(address: string): boolean {
  return check(LINK_LOCAL4, address) || check(LINK_LOCAL6, address);
}

export function isMeshIp(address: string): boolean {
  return check(MESH4, address) || check(MESH6, address);
}

// Interfaces whose addresses no LAN client reaches (container and VM bridges) or that are a mesh
// or VPN tunnel (the mesh transport lists those; a magic packet never crosses one).
const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|lxcbr|lxdbr|podman|tailscale|wt\d|wg\d|zt|utun|tun|tap|awdl|llw|nebula)/i;

/** A container or VM bridge, or a mesh or VPN tunnel, by interface name. */
export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_INTERFACE.test(name);
}

/** Whether `address` is inside `network/prefix` (same family only). */
export function inSubnet(address: string, network: string, prefix: number): boolean {
  const a = normalizeIp(address);
  const n = normalizeIp(network);
  if (!a || !n || isIP(a) !== isIP(n)) return false;
  const family = isIP(n) === 4 ? 4 : 6;
  const max = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return false;
  return list([[n, prefix]], family).check(a, family === 4 ? 'ipv4' : 'ipv6');
}

function v4ToInt(a: string): number {
  return a.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function intToV4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

/** The directed broadcast address of an IPv4 subnet (`192.168.1.255` for 192.168.1.7/24). */
export function directedBroadcast(address: string, prefix: number): string | null {
  const a = normalizeIp(address);
  if (!a || isIP(a) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 30) return null;
  const host = prefix === 0 ? 0xffffffff : (0xffffffff >>> prefix) >>> 0;
  return intToV4((v4ToInt(a) | host) >>> 0);
}

/** One address of one of the Hub's interfaces. */
export interface InterfaceAddress {
  name: string;
  address: string;
  family: 4 | 6;
  prefix: number;
  internal: boolean;
}

/** The Hub's interface addresses with their prefix lengths (from `os.networkInterfaces()`). */
export function interfaceAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): InterfaceAddress[] {
  const out: InterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const e of entries ?? []) {
      const address = normalizeIp(e.address);
      if (!address) continue;
      const family = isIP(address) === 4 ? 4 : 6;
      const fromCidr = e.cidr ? Number(e.cidr.split('/')[1]) : NaN;
      const prefix = Number.isInteger(fromCidr) ? fromCidr : family === 4 ? 24 : 64;
      out.push({ name, address, family, prefix, internal: e.internal });
    }
  }
  return out;
}

/** The host of a URL as an IP when it is one (brackets and zone removed), else null. */
export function urlIp(url: string): string | null {
  try {
    return normalizeIp(new URL(url).hostname);
  } catch {
    return null;
  }
}
