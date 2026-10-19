// What the Hub may reach on behalf of someone who is not its owner (decision 5 of ADR-095): only
// public addresses. A member must not point the Hub at its own loopback services or the owner's
// local network through an MCP server, a provider's base URL, a mailbox or an OAuth discovery.
// Like signed webhooks (`scheduler/delivery.ts`), a host is resolved, every address it resolves
// to must be public, and the connection goes to the address that was checked (pinned), so a DNS
// answer that changes in between cannot redirect it.
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { NovaError } from '@nova/shared';
import { pinnedLookup, publicAddress } from '../scheduler/delivery.ts';

export type ResolveHost = (host: string) => Promise<string[]>;

const systemResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

function localName(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    !h.includes('.')
  );
}

/**
 * Why a URL is refused for someone who is not the owner, or null: http(s) only, no credentials
 * in it, and the host resolves to public addresses only.
 */
export async function publicUrlProblem(
  raw: string,
  resolveHost: ResolveHost = systemResolve,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'only http and https URLs';
  if (url.username || url.password) return 'URLs cannot carry credentials';
  return publicHostProblem(url.hostname, resolveHost);
}

/** Why a host is refused (a private, loopback or local address), or null. */
export async function publicHostProblem(
  hostname: string,
  resolveHost: ResolveHost = systemResolve,
): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host) && localName(host)) return `${host} is a local name`;
  try {
    await publicAddress(host, resolveHost);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : `${host} could not be resolved`;
  }
}

/** The refusal for a non-owner's private target (400 `validation`, reason `private_address`). */
export function privateAddressError(what: string, problem: string): NovaError {
  return new NovaError('validation', `${what} must be a public address: ${problem}`, {
    details: { reason: 'private_address' },
  });
}

/** The checked public address to connect to for a host; throws for a private or local one. */
export async function pinnedPublicAddress(
  hostname: string,
  resolveHost: ResolveHost = systemResolve,
): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host) && localName(host)) throw privateAddressError(host, `${host} is a local name`);
  try {
    return await publicAddress(host, resolveHost);
  } catch (err) {
    throw privateAddressError(host, err instanceof Error ? err.message : 'not resolved');
  }
}

function webHeaders(res: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else if (v !== undefined) h.set(k, v);
  }
  return h;
}

/**
 * A `fetch` that reaches public addresses only: each request resolves its host, refuses private
 * and local ones, and connects to the address it checked (TLS still verifies the host name).
 * Redirects are returned as they are, never followed to another host.
 */
export function publicFetch(
  resolveHost: ResolveHost = systemResolve,
  /** Tests only: let private addresses through, still pinned to what `resolveHost` answered. */
  testing: { allowPrivate?: boolean } = {},
): typeof fetch {
  const run = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new TypeError(`only http and https URLs (${url.protocol})`);
    const address = testing.allowPrivate
      ? await publicAddress(url.hostname, resolveHost, true)
      : await pinnedPublicAddress(url.hostname, resolveHost);
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const r = send(
        url,
        {
          method: req.method,
          headers,
          lookup: pinnedLookup(address),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const empty = status === 204 || status === 304 || req.method === 'HEAD';
          try {
            resolve(
              new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
                status,
                statusText: res.statusMessage ?? '',
                headers: webHeaders(res),
              }),
            );
          } catch (err) {
            res.destroy();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
      r.once('error', reject);
      r.end(body ?? undefined);
    });
  };
  return run;
}
