// The core's HTTP API (ADR-5): REST under /api/v1 and one server-sent event stream. Every UI
// capability is an API capability. One route table serves requests and generates the OpenAPI
// document, so the two cannot drift apart.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CoreError } from './errors.ts';

export interface Ctx { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> }
export type Handler = (ctx: Ctx) => unknown;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;                  // OpenAPI style: /tasks/{id}
  summary: string;
  body?: string;                 // what the JSON body carries, for the document
  status?: number;
  handle: Handler;
}

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
      ...(r.body ? { requestBody: { required: true, description: r.body, content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { [String(r.status ?? 200)]: { description: 'OK' }, default: { description: 'An error: {error, details?}' } },
    };
  }
  paths[`${PREFIX}/events`] = { get: { summary: 'Live updates as server-sent events: task, problem, setup, profile, extension.', responses: { 200: { description: 'text/event-stream' } } } };
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

export function createApi(o: { routes: Route[]; stream: Stream; version: string; trustedOrigin: (host: string) => boolean; onError: (e: unknown) => void }) {
  const table = o.routes.map((r) => ({ ...r, re: compile(r.path) }));
  const doc = openapi(o.routes, o.version);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Returns false when the path isn't the core's, so the caller can carry on routing.
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const path = url.pathname.slice(PREFIX.length) || '/';
    try {
      // Same rule as the rest of the server: changes come only from Nova's own page.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-nova'] !== '1') throw new CoreError('forbidden', 'Missing X-Nova header.');
        const origin = req.headers.origin;
        if (origin && !o.trustedOrigin(new URL(origin).host)) throw new CoreError('forbidden', 'Cross-origin request refused.');
      }
      if (path === '/openapi.json' && req.method === 'GET') { send(res, 200, doc); return true; }
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': nova core\n\n');
        const off = o.stream.on((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
        req.on('close', () => { clearInterval(beat); off(); });
        return true;
      }
      const matches = table.filter((r) => r.re.test(path));
      if (!matches.length) throw new CoreError('not_found', 'Not found.');
      const route = matches.find((r) => r.method === req.method);
      if (!route) { res.writeHead(405, { allow: matches.map((r) => r.method).join(', ') }); res.end(); return true; }
      const decode = (v: string) => { try { return decodeURIComponent(v); } catch { throw new CoreError('validation', 'The address has a malformed escape.'); } };
      const params = Object.fromEntries(Object.entries(route.re.exec(path)!.groups ?? {}).map(([k, v]) => [k, decode(v)]));
      const body = route.method === 'GET' || route.method === 'DELETE' ? {} : await readBody(req);
      const out = await route.handle({ params, query: url.searchParams, body });
      send(res, route.status ?? 200, out);
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
