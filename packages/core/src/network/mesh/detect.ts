// Host network detection for the Network Setup assistant (docs/22 §6 step 1): interfaces and
// which ones belong to a VPN or mesh, LAN subnets, DNS from /etc/resolv.conf, and the package
// manager a client install would use. Everything the host is asked for is injectable.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { MeshProvider, NetworkInterfaceView } from '@nova/shared';

export interface NetworkProbe {
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** A file's text, or null when it cannot be read. */
  readFile: (path: string) => Promise<string | null>;
  exists: (path: string) => boolean;
  platform: NodeJS.Platform;
}

export function defaultNetworkProbe(over: Partial<NetworkProbe> = {}): NetworkProbe {
  return {
    interfaces: networkInterfaces,
    readFile: (p) => readFile(p, 'utf8').catch(() => null),
    exists: existsSync,
    platform: process.platform,
    ...over,
  };
}

// Interface names the common clients use: tailscale0 (Linux), wt0 (NetBird), wg*/wg-* (WireGuard),
// utun* (macOS tunnels, any VPN), tun/tap/ppp/ipsec and ZeroTier's zt*.
const NAMED: [RegExp, NetworkInterfaceView['kind'], MeshProvider | null][] = [
  [/^tailscale\d*$/, 'mesh', 'tailscale'],
  [/^wt\d+$/, 'mesh', 'netbird'],
  [/^wg[\w-]*$/, 'mesh', 'wireguard'],
  [/^(?:utun|tun|tap|ppp|ipsec|zt)\w*$/, 'vpn', null],
  [/^(?:docker|br-|veth|virbr|cni|flannel|vmnet|vboxnet)/, 'other', null],
];

export function classifyInterface(
  name: string,
  infos: readonly NetworkInterfaceInfo[],
): Pick<NetworkInterfaceView, 'kind' | 'provider'> {
  if (infos.length > 0 && infos.every((i) => i.internal))
    return { kind: 'loopback', provider: null };
  for (const [re, kind, provider] of NAMED) if (re.test(name)) return { kind, provider };
  // A tunnel with a Tailscale-range address (100.64.0.0/10) but another name, e.g. macOS utun.
  if (infos.some((i) => i.family === 'IPv4' && inCgnat(i.address)))
    return { kind: 'mesh', provider: null };
  return { kind: 'lan', provider: null };
}

export function detectInterfaces(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): NetworkInterfaceView[] {
  const out: NetworkInterfaceView[] = [];
  for (const [name, infos] of Object.entries(ifaces)) {
    if (!infos) continue;
    out.push({
      name,
      ...classifyInterface(name, infos),
      addresses: infos.map((i) => ({
        address: i.address,
        family: i.family,
        cidr: i.cidr ?? null,
      })),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** IPv4 subnets of the LAN interfaces (`192.168.1.0/24`), link-local skipped. */
export function lanSubnets(interfaces: readonly NetworkInterfaceView[]): string[] {
  const out = new Set<string>();
  for (const i of interfaces) {
    if (i.kind !== 'lan') continue;
    for (const a of i.addresses) {
      if (a.family !== 'IPv4' || !a.cidr || a.address.startsWith('169.254.')) continue;
      const net = ipv4Network(a.cidr);
      if (net) out.add(net);
    }
  }
  return [...out].sort();
}

/** `192.168.1.23/24` → `192.168.1.0/24`. */
export function ipv4Network(cidr: string): string | null {
  const [addr, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const n = addr ? ipv4ToInt(addr) : null;
  if (n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return `${intToIpv4((n & mask) >>> 0)}/${bits}`;
}

export function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 100.64.0.0/10: the shared address space Tailscale, Headscale and NetBird hand out. */
export function inCgnat(addr: string): boolean {
  const n = ipv4ToInt(addr);
  return n !== null && n >>> 22 === (100 * 256 + 64) >>> 6;
}

export interface ResolvConf {
  nameservers: string[];
  search: string[];
}

export function parseResolvConf(text: string): ResolvConf {
  const nameservers: string[] = [];
  const search: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'nameserver' && rest[0]) nameservers.push(rest[0]);
    if ((key === 'search' || key === 'domain') && rest.length) search.push(...rest);
  }
  return { nameservers, search: [...new Set(search)] };
}

export type PackageManager = 'apt' | 'dnf' | 'brew' | 'winget';

export function detectPackageManager(probe: NetworkProbe): PackageManager | null {
  if (probe.platform === 'win32') return 'winget';
  if (probe.platform === 'darwin') {
    return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].some(probe.exists) ? 'brew' : null;
  }
  if (probe.exists('/usr/bin/apt-get')) return 'apt';
  if (probe.exists('/usr/bin/dnf')) return 'dnf';
  return null;
}
