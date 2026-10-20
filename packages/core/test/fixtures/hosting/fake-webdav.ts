// A WebDAV server in memory for the hosting-target tests (FR-037, M8): GET, PUT, MKCOL, PROPFIND
// (Depth 0), MOVE (with Overwrite) and DELETE under one root collection `/dav/`, an optional
// required `Authorization` value, a log of requests, and switches to fail a request, redirect or
// never answer. Bound to 127.0.0.1 on a free port; nothing here reaches another machine.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeDav {
  /** The root collection, ending in `/`. */
  url: string;
  port: number;
  /** Files by path under the root (decoded, no leading slash). */
  files: Map<string, Buffer>;
  /** Collections by path under the root, without a trailing slash; '' is the root. */
  dirs: Set<string>;
  log: { method: string; path: string; auth: string | null; type: string | null }[];
  /** The `Authorization` value every request must carry; null: none needed. */
  auth: string | null;
  /** Answer this status to the first request that matches, once (or always with `sticky`). */
  fail: { method?: string; path?: RegExp; status: number; sticky?: boolean } | null;
  /** Answer 302 to everything. */
  redirect: boolean;
  /** Never answer (for timeouts). */
  hang: boolean;
  close(): Promise<void>;
}

const ROOT = '/dav/';

function rel(rawPath: string): string | null {
  const path = rawPath.split('?')[0] ?? '';
  if (!path.startsWith(ROOT) && path !== ROOT.slice(0, -1)) return null;
  const rest = path.slice(ROOT.length).replace(/\/+$/, '');
  try {
    return rest
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    return null;
  }
}

function parent(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function fakeWebDav(): Promise<FakeDav> {
  const dav: FakeDav = {
    url: '',
    port: 0,
    files: new Map(),
    dirs: new Set(['']),
    log: [],
    auth: null,
    fail: null,
    redirect: false,
    hang: false,
    close: () => Promise.resolve(),
  };
  const exists = (p: string) => dav.files.has(p) || dav.dirs.has(p);
  const under = (p: string, base: string) => p === base || p.startsWith(`${base}/`);
  const drop = (base: string) => {
    for (const k of [...dav.files.keys()]) if (under(k, base)) dav.files.delete(k);
    for (const k of [...dav.dirs]) if (k !== '' && under(k, base)) dav.dirs.delete(k);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const auth = req.headers.authorization ?? null;
    const data = await body(req);
    dav.log.push({
      method,
      path: req.url ?? '',
      auth,
      type: req.headers['content-type'] ?? null,
    });
    if (dav.hang) return;
    const end = (status: number, text = '') => {
      res.statusCode = status;
      res.end(text);
    };
    if (dav.redirect) {
      res.setHeader('Location', 'http://127.0.0.1:1/elsewhere/');
      return end(302);
    }
    if (dav.auth !== null && auth !== dav.auth) return end(401);
    const f = dav.fail;
    if (f && (!f.method || f.method === method) && (!f.path || f.path.test(req.url ?? ''))) {
      if (!f.sticky) dav.fail = null;
      return end(f.status);
    }
    const p = rel(req.url ?? '');
    if (p === null) return end(404);
    switch (method) {
      case 'GET': {
        const file = dav.files.get(p);
        if (file) return end(200, file.toString('utf8'));
        return end(dav.dirs.has(p) ? 200 : 404);
      }
      case 'PUT': {
        if (!dav.dirs.has(parent(p))) return end(409);
        if (dav.dirs.has(p)) return end(405);
        const had = dav.files.has(p);
        dav.files.set(p, data);
        return end(had ? 204 : 201);
      }
      case 'MKCOL': {
        if (exists(p)) return end(405);
        if (!dav.dirs.has(parent(p))) return end(409);
        dav.dirs.add(p);
        return end(201);
      }
      case 'PROPFIND': {
        if (!exists(p)) return end(404);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        return end(207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      }
      case 'DELETE': {
        if (!exists(p)) return end(404);
        drop(p);
        return end(204);
      }
      case 'MOVE': {
        const dest = rel(new URL(req.headers.destination ?? '', 'http://x').pathname);
        if (dest === null || !exists(p)) return end(404);
        if (!dav.dirs.has(parent(dest))) return end(409);
        const replaced = exists(dest);
        if (replaced && req.headers.overwrite === 'F') return end(412);
        if (replaced) drop(dest);
        for (const [k, v] of [...dav.files])
          if (under(k, p)) {
            dav.files.delete(k);
            dav.files.set(dest + k.slice(p.length), v);
          }
        for (const k of [...dav.dirs])
          if (k !== '' && under(k, p)) {
            dav.dirs.delete(k);
            dav.dirs.add(dest + k.slice(p.length));
          }
        return end(replaced ? 204 : 201);
      }
      default:
        return end(405);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  dav.port = port;
  dav.url = `http://127.0.0.1:${port}${ROOT}`;
  dav.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return dav;
}

/** The files of one folder on the fake server, by path inside it. */
export function folderFiles(dav: FakeDav, folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of dav.files)
    if (k.startsWith(`${folder}/`)) out[k.slice(folder.length + 1)] = v.toString('utf8');
  return out;
}
