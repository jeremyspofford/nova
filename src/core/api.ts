// The core's HTTP API (ADR-5): REST under /api/v1 and one server-sent event stream. Every UI
// capability is an API capability. One route table serves requests and generates the OpenAPI
// document, so the two cannot drift apart.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { CoreError } from './errors.ts';
import { APPROVER_ONLY, REFUSAL, allows, type Listener, type Principal, type Scope } from './mesh/access.ts';

// Who is asking and how they got here (mesh/access.ts), for the scope check and for handlers that
// need it (enrollment is only over the mesh listener; "this device" in the registry).
export interface Who { principal: Principal; listener: Listener; address: string }
export interface Ctx { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown>; headers: IncomingHttpHeaders; who: Who }
export type Handler = (ctx: Ctx) => unknown;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                  // OpenAPI style: /tasks/{id}
  summary: string;
  body?: string;                 // what the JSON body carries, for the document
  status?: number;
  // Set only on the webhook route: automations call it with their own token
  // (x-nova-hook-token), which the handler checks, instead of the X-Nova header.
  auth?: 'hook-token';
  // Who may call it (mesh/access.ts). Everything a person uses is `person`, the default.
  access?: Scope;
  handle: Handler;
}

// A handler returns Raw to answer with something other than JSON (the design-system CSS).
export class Raw {
  readonly type: string;
  readonly body: string | Buffer;
  constructor(type: string, body: string | Buffer) {
    this.type = type;
    this.body = body;
  }
}

// A handler returns Reply to set headers (a session cookie) along with its JSON, or a status of its
// own (422 with the problems a choice has).
export class Reply {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly status: number | null;
  constructor(body: unknown, headers: Record<string, string>, status: number | null = null) {
    this.body = body;
    this.headers = headers;
    this.status = status;
  }
}

// A handler returns Sse for a stream of its own (a browser task's live frames): `open` gets a way
// to send events and to hear when the client has gone. Never cached.
export class Sse {
  readonly open: (send: (event: string, data: unknown) => boolean, closed: (fn: () => void) => void, end: () => void) => void;
  constructor(open: Sse['open']) {
    this.open = open;
  }
}

// The one route allowed to skip the X-Nova guard. Any other route claiming it is refused at startup.
export const HOOK_ROUTE = { method: 'POST', path: '/hooks/{name}' } as const;

export interface Stream { on(listener: (event: string, data: unknown) => void): () => void }

const PREFIX = '/api/v1';

function compile(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
}

export function openapi(routes: Route[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    (paths[`${PREFIX}${r.path}`] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      ...(params.length ? { parameters: params } : {}),
      ...(r.access && r.access !== 'person' ? { 'x-nova-access': r.access } : {}),
      ...(r.body ? { requestBody: { required: true, description: r.body, content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { [String(r.status ?? 200)]: { description: 'OK' }, default: { description: 'An error: {error, details?}' } },
    };
  }
  paths[`${PREFIX}/events`] = { get: { summary: 'Live updates as server-sent events: task, problem, setup, profile, extension, trigger, message, design-system, device, join_request.', responses: { 200: { description: 'text/event-stream' } } } };
  return { openapi: '3.1.0', info: { title: 'Nova core API', version }, paths };
}

const readBody = (req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> => new Promise((ok, fail) => {
  let size = 0;
  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { fail(new CoreError('validation', 'The request is too large.')); req.destroy(); } else parts.push(c); });
  req.on('end', () => {
    if (!parts.length) return ok({});
    try {
      const v = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(new CoreError('validation', 'The body must be a JSON object.'));
      ok(v);
    } catch {
      fail(new CoreError('validation', 'The body isn’t valid JSON.'));
    }
  });
  req.on('error', fail);
});

// The host an Origin header names, or null when it names none: `null` (sandboxed frames, some
// redirects) or anything that isn't a URL. Such a request is refused like a foreign one. Parsing
// it unguarded would throw, and anyone could fill the problem list through a public route.
export function originHost(origin: string): string | null {
  try { return new URL(origin).host || null; } catch { return null; }
}

// Before M4 every request was the console's; a caller that doesn't say otherwise still is. The core
// itself (index.ts) always says.
const CONSOLE: Who = { principal: { kind: 'console' }, listener: 'console', address: 'console' };

export function createApi(o: {
  routes: Route[]; stream: Stream; version: string; trustedOrigin: (host: string) => boolean; onError: (e: unknown) => void;
  // Which events a principal may see on the stream (by default, all of them).
  visible?: (event: string, p: Principal) => boolean;
}) {
  for (const r of o.routes) {
    if (r.auth && (r.method !== HOOK_ROUTE.method || r.path !== HOOK_ROUTE.path)) throw new Error(`${r.method} ${r.path} can't skip the X-Nova guard; only ${HOOK_ROUTE.method} ${HOOK_ROUTE.path} may.`);
  }
  const table = o.routes.map((r) => ({ ...r, re: compile(r.path) }));
  const doc = openapi(o.routes, o.version);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Returns false when the path isn't the core's, so the caller can carry on routing.
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, who: Who = CONSOLE): Promise<boolean> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const path = url.pathname.slice(PREFIX.length) || '/';
    try {
      const matches = table.filter((r) => r.re.test(path));
      const route = matches.find((r) => r.method === req.method);
      // Who may call it comes first: someone without a session learns nothing, not even whether a
      // path exists.
      const scope: Scope = route?.access ?? matches[0]?.access ?? 'person';
      const verdict = allows(scope, who.principal);
      if (verdict !== 'ok') throw new CoreError(verdict === 'unauthenticated' ? 'unauthorized' : 'forbidden', scope === 'approver' && verdict === 'forbidden' ? APPROVER_ONLY : REFUSAL[verdict]);
      // Same rule as the rest of the server: changes come only from Nova's own page. The webhook
      // route is the one exception; it checks its own token.
      if (req.method !== 'GET' && req.method !== 'HEAD' && route?.auth !== 'hook-token') {
        if (req.headers['x-nova'] !== '1') throw new CoreError('forbidden', 'Missing X-Nova header.');
        const origin = req.headers.origin;
        const host = origin ? originHost(origin) : null;
        if (origin && (!host || !o.trustedOrigin(host))) throw new CoreError('forbidden', 'Cross-origin request refused.');
      }
      if (path === '/openapi.json' && req.method === 'GET') { send(res, 200, doc); return true; }
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': nova core\n\n');
        const off = o.stream.on((event, data) => {
          if (!o.visible || o.visible(event, who.principal)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
        req.on('close', () => { clearInterval(beat); off(); });
        return true;
      }
      if (!matches.length) throw new CoreError('not_found', 'Not found.');
      if (!route) { res.writeHead(405, { allow: matches.map((r) => r.method).join(', ') }); res.end(); return true; }
      const decode = (v: string) => { try { return decodeURIComponent(v); } catch { throw new CoreError('validation', 'The address has a malformed escape.'); } };
      const params = Object.fromEntries(Object.entries(route.re.exec(path)!.groups ?? {}).map(([k, v]) => [k, decode(v)]));
      const body = route.method === 'GET' || route.method === 'DELETE' ? {} : await readBody(req);
      const out = await route.handle({ params, query: url.searchParams, body, headers: req.headers, who });
      if (out instanceof Sse) {
        res.writeHead(route.status ?? 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
        res.write(': nova\n\n');
        const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
        const closers: (() => void)[] = [];
        let done = false;
        const finish = () => { if (done) return; done = true; clearInterval(beat); for (const fn of closers) fn(); };
        req.on('close', finish);
        out.open(
          (event, data) => !done && !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          (fn) => { if (done) fn(); else closers.push(fn); },
          () => { finish(); res.end(); },
        );
      } else if (out instanceof Reply) {
        res.writeHead(out.status ?? route.status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...out.headers });
        res.end(JSON.stringify(out.body));
      } else if (out instanceof Raw) {
        res.writeHead(route.status ?? 200, { 'content-type': out.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(out.body);
      } else send(res, route.status ?? 200, out);
    } catch (e) {
      if (e instanceof CoreError) send(res, e.status, { error: e.message, ...(e.details.length ? { details: e.details } : {}) });
      else {
        o.onError(e);
        send(res, 500, { error: 'Something went wrong inside Nova. It has been recorded as a problem.' });
      }
    }
    return true;
  }

  return { handle, doc };
}
