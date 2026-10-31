// Fetching a page for the agent without letting a page steer it at Nova itself or the person's own
// network (Amendment 2026-10-30-C Part 3, the SSRF guard). Nova's console answers any request from
// this machine as the person, so a page that talks the agent into fetching
// http://localhost:<port>/api/v1/memory would have read everything Nova knows, without asking.
//
// The address is checked where the connection is really made: the name is resolved here, every
// address it resolves to must be public, and the socket connects to exactly the address that was
// checked, so a name that answers differently a moment later (DNS rebinding) can't slip through.
// Every redirect is a new request, checked the same way.
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(net, bits, 'ipv4');
// IPv6. Besides loopback, link-local, unique-local, documentation, discard and multicast: ranges
// that carry an IPv4 address or tunnel to one, since the IPv4 address inside could be this machine
// or the LAN, refused whole: IPv4-compatible (::/96), the local-use NAT64 prefix (64:ff9b:1::/48),
// Teredo (2001::/32), 6to4 (2002::/16). And the other IETF special ranges under 2001::/23 that are
// not one host on the public web (benchmarking, ORCHID).
for (const [net, bits] of [
  ['::', 96], ['::1', 128], ['100::', 64], ['64:ff9b:1::', 48], ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) PRIVATE.addSubnet(net, bits, 'ipv6');

// Names that only ever mean something on the person's own network.
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|arpa|ts\.net)\.?$/i;

// Whether a host name is one of those (Nova Computer's egress proxy applies the same rule).
export function privateName(host) {
  return PRIVATE_NAME.test(String(host));
}

// Whether an address is one a page may send the agent to: public, unicast.
export function publicAddress(address) {
  const kind = isIP(address);
  if (kind === 4) return !PRIVATE.check(address, 'ipv4');
  if (kind !== 6) return false;
  const a = address.toLowerCase();
  // An IPv4 address carried in IPv6 (mapped, or NAT64) is judged as the IPv4 address it is.
  const v4 = a.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? fromHexV4(a);
  if (v4) return publicAddress(v4);
  return !PRIVATE.check(a, 'ipv6');
}

function fromHexV4(a) {
  const m = a.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export class Refused extends Error {}

const refuse = (host) => new Refused(`Nova doesn’t fetch ${host}: it’s on this computer or a private network, not the public web.`);

// A lookup that answers only with addresses `allow` accepts; one private answer refuses the name.
function guardedLookup(allow) {
  return (hostname, options, cb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      if (!addresses.length || addresses.some((a) => !allow(a.address))) return cb(refuse(hostname));
      if (options?.all) return cb(null, addresses);
      cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

const MAX_BODY = 5_000_000;
const MAX_REDIRECTS = 5;

// GET a URL; the answer is { status, statusText, type, text, url }. `allow` decides which
// addresses may be reached (public ones, unless a test says otherwise).
export async function safeFetch(url, { signal, headers = {}, allow = publicAddress, timeoutMs = 20_000 } = {}) {
  const deadline = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  let at = new URL(url);
  for (let hop = 0; ; hop++) {
    if (at.protocol !== 'http:' && at.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched');
    const host = at.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) ? !allow(host) : allow === publicAddress && PRIVATE_NAME.test(host)) throw refuse(host);
    const res = await request(at, { signal: deadline, headers, lookup: guardedLookup(allow) });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new Error('The page redirected too many times.');
      at = new URL(res.headers.location, at);
      continue;
    }
    const type = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, statusText: res.statusMessage ?? '', type, url: at.href, text: await body(res, type, deadline) };
  }
}

function request(url, { signal, headers, lookup }) {
  return new Promise((ok, fail) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, lookup,
      headers: { 'accept-encoding': 'gzip, deflate, br', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', ...headers },
    }, ok);
    req.on('error', fail);
    req.end();
  });
}

async function body(res, type, signal) {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    if (signal.aborted) throw signal.reason;
    size += c.length;
    if (size > MAX_BODY) { res.destroy(); break; }
    chunks.push(c);
  }
  const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(Buffer.concat(chunks));
}
