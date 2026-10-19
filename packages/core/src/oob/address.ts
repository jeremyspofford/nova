// BMC addresses (FR-147, ADR-096 D6): the owner enters a host name or IP literal, optionally with
// a port; a Redfish BMC may also be pasted as a bare https:// URL. Credentials never travel in an
// address (they go to the vault), and nothing but a host and a port is kept: the Hub builds every
// request path itself, so an address cannot smuggle a path, query or another scheme.
//
// A BMC is another machine on the network. Loopback, link-local, unspecified and multicast
// addresses, and the Hub's own addresses and name, are refused: out-of-band credentials must never
// be offered to a service on the Hub itself. Numeric host forms (`0x7f000001`, `2130706433`,
// `0177.0.0.1`) are refused rather than guessed (a URL's host is normalized first, then checked).
// Names are checked again when the Hub connects: every address a name resolves to must pass, and
// the connection goes to the address that was checked.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { NovaError, type OobKind } from '@nova/shared';
import { ipBytes } from '../trust/x509.ts';

export interface OobAddress {
  host: string;
  port: number | null;
}

/** What makes an IP address unfit for a BMC, or `ok`. */
export type OobIpClass = 'ok' | 'loopback' | 'link_local' | 'unspecified' | 'multicast';

export interface OobOwnAddresses {
  addresses: ReadonlySet<string>;
  names: ReadonlySet<string>;
}

export interface OobAddressPolicy {
  /** The Hub's own addresses and names (default: its interfaces and host name). */
  own?: () => OobOwnAddresses;
  /** Tests only: the fake BMCs listen on 127.0.0.1. Never set by the Hub. */
  allowLoopback?: boolean;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid(reason: string, message: string, extra: Record<string, unknown> = {}): NovaError {
  return new NovaError('validation', message, { details: { reason, ...extra } });
}

function normalizeIp(ip: string): string {
  return ip.toLowerCase().replace(/%.*$/, '');
}

function classifyV4(b: Buffer | number[]): OobIpClass {
  const [p = 0, q = 0] = b;
  if (p === 0) return 'unspecified';
  if (p === 127) return 'loopback';
  if (p === 169 && q === 254) return 'link_local';
  if (p >= 224) return 'multicast';
  return 'ok';
}

/** Classify an IPv4 or IPv6 literal (IPv4-mapped and NAT64 forms by their IPv4 address). */
export function classifyIp(raw: string): OobIpClass {
  const ip = normalizeIp(raw);
  const v = isIP(ip);
  if (v === 4) return classifyV4(ip.split('.').map(Number));
  if (v !== 6) return 'unspecified';
  const b = ipBytes(ip);
  const zeros = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  if (zeros(0, 16)) return 'unspecified';
  if (zeros(0, 15) && b[15] === 1) return 'loopback';
  if (b[0] === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) return 'link_local';
  if (b[0] === 0xff) return 'multicast';
  const mapped = zeros(0, 10) && b[10] === 0xff && b[11] === 0xff;
  const compat = zeros(0, 12);
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12);
  if (mapped || compat || nat64) return classifyV4(b.subarray(12, 16));
  return 'ok';
}

/** The Hub's own interface addresses and host name. */
export function hubOwnAddresses(): OobOwnAddresses {
  const addresses = new Set<string>();
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) addresses.add(normalizeIp(a.address));
  const name = hostname().toLowerCase();
  const names = new Set([name, name.split('.')[0] ?? name].filter(Boolean));
  return { addresses, names };
}

function own(policy: OobAddressPolicy): OobOwnAddresses {
  return (policy.own ?? hubOwnAddresses)();
}

/** Why this IP may not be a BMC address, or null. */
export function bmcIpProblem(ip: string, policy: OobAddressPolicy = {}): string | null {
  const cls = classifyIp(ip);
  if (cls === 'loopback' && policy.allowLoopback) return null;
  if (cls !== 'ok') return cls;
  if (own(policy).addresses.has(normalizeIp(ip))) return 'hub';
  return null;
}

function refuseIp(ip: string, problem: string): NovaError {
  const what =
    problem === 'hub'
      ? "is one of the Hub's own addresses"
      : `is a ${problem.replace('_', '-')} address`;
  return invalid('address_not_allowed', `${ip} ${what}; a BMC is another machine on the network`, {
    kind: problem,
  });
}

function hostOk(host: string, policy: OobAddressPolicy): string {
  const h = normalizeIp(host);
  if (isIP(h)) {
    const problem = bmcIpProblem(h, policy);
    if (problem) throw refuseIp(h, problem);
    return h;
  }
  const name = h.endsWith('.') ? h.slice(0, -1) : h;
  if (!name || name.length > 253 || !name.split('.').every((l) => LABEL.test(l)))
    throw invalid('bad_address', `${host} is not a host name or IP address`);
  // A name ending in a number is a numeric IPv4 form to some resolvers (decimal, octal, hex).
  const last = name.split('.').pop() ?? '';
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last))
    throw invalid(
      'bad_address',
      `${host} is a numeric host form; give the IPv4 address in dotted decimal`,
    );
  if (name === 'localhost' || name.endsWith('.localhost')) throw refuseIp(name, 'loopback');
  if (own(policy).names.has(name)) throw refuseIp(name, 'hub');
  return name;
}

function portOf(raw: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw invalid('bad_address', `bad port ${raw}`);
  const n = Number(raw);
  if (n < 1 || n > 65535) throw invalid('bad_address', `bad port ${raw}`);
  return n;
}

/**
 * Parse what the owner typed: `host`, `host:port`, an IPv4 or IPv6 literal (`[v6]:port` for a
 * port), or for Redfish `https://host[:port][/]` (also with `/redfish/v1`). Refused: credentials
 * (`user@host`, `https://user:pass@…`), other schemes, paths, queries, fragments, whitespace,
 * numeric host forms, and addresses that are not another machine (see the file comment).
 */
export function parseOobAddress(
  raw: string,
  kind: OobKind,
  policy: OobAddressPolicy = {},
): OobAddress {
  const s = raw.trim();
  if (!s || /\s/.test(s) || [...s].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f'))
    throw invalid('bad_address', 'the address cannot contain spaces or control characters');
  if (s.includes('://')) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw invalid('bad_address', 'not a host, IP address or URL');
    }
    if (url.username || url.password)
      throw invalid(
        'credentials_in_address',
        'credentials go in the credentials field, never in the address',
      );
    if (kind !== 'redfish' || url.protocol !== 'https:')
      throw invalid('bad_address', 'only a Redfish BMC may be given as a URL, and only https://');
    if (url.search || url.hash || !['', '/', '/redfish/v1', '/redfish/v1/'].includes(url.pathname))
      throw invalid('bad_address', 'give the BMC address without a path, query or fragment');
    // The URL parser has already normalized numeric hosts (`0x7f000001` -> `127.0.0.1`).
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return { host: hostOk(host, policy), port: url.port ? portOf(url.port) : null };
  }
  if (s.includes('@'))
    throw invalid(
      'credentials_in_address',
      'credentials go in the credentials field, never in the address',
    );
  if (s.includes('/') || s.includes('?') || s.includes('#'))
    throw invalid('bad_address', 'give a host name or IP address only');
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (bracketed) {
    if (isIP(bracketed[1] ?? '') !== 6) throw invalid('bad_address', `${s} is not an IPv6 address`);
    return {
      host: hostOk(bracketed[1] ?? '', policy),
      port: bracketed[2] !== undefined ? portOf(bracketed[2]) : null,
    };
  }
  const colons = s.split(':').length - 1;
  if (colons === 1) {
    const [host = '', port = ''] = s.split(':');
    return { host: hostOk(host, policy), port: portOf(port) };
  }
  if (colons > 1) {
    if (isIP(s) !== 6) throw invalid('bad_address', `${s} is not an IPv6 address`);
    return { host: hostOk(s, policy), port: null };
  }
  return { host: hostOk(s, policy), port: null };
}

export type ResolveHost = (host: string) => Promise<string[]>;

const systemResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The address to connect to for a stored BMC host, checked again now: a literal as it is, a name
 * resolved with every answer checked (one bad answer refuses it all). 403 `policy_denied`
 * `{reason: address_not_allowed}` otherwise; 409 `conflict` `{reason: bmc_unreachable}` when the
 * name does not resolve.
 */
export async function resolveBmcAddress(
  host: string,
  policy: OobAddressPolicy = {},
  resolve: ResolveHost = systemResolve,
): Promise<string> {
  const refuse = (ip: string, problem: string) =>
    new NovaError('policy_denied', refuseIp(ip, problem).message, {
      details: { reason: 'address_not_allowed', kind: problem },
    });
  if (isIP(host)) {
    const problem = bmcIpProblem(host, policy);
    if (problem) throw refuse(host, problem);
    return normalizeIp(host);
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    addresses = [];
  }
  if (!addresses.length)
    throw new NovaError('conflict', `${host} could not be resolved`, {
      details: { reason: 'bmc_unreachable' },
    });
  for (const a of addresses) {
    const problem = bmcIpProblem(a, policy);
    if (problem) throw refuse(`${host} (${a})`, problem);
  }
  return normalizeIp(addresses[0] ?? host);
}

/** `host:port` for display and the HTTP Host header (IPv6 in brackets). */
export function hostPort(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}
