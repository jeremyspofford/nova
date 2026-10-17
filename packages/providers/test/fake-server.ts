// A local HTTP server for adapter tests: each request is answered by the next queued handler
// and recorded, so tests can assert on exactly what an adapter sent.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach } from 'vitest';
import type { StreamEvent } from '../src/index.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeServer {
  /** `http://127.0.0.1:<port>`, no path. */
  origin: string;
  handlers: Handler[];
  seen: Seen[];
}

/** Start a fresh server before each test and close it after. */
export function useFakeServer(): FakeServer {
  const state: FakeServer = { origin: '', handlers: [], seen: [] };
  let server: Server;
  beforeEach(async () => {
    state.handlers.length = 0;
    state.seen.length = 0;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        state.seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        const h = state.handlers.shift();
        if (!h) {
          res.writeHead(500).end('no handler');
          return;
        }
        h(req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    state.origin = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return state;
}

export const fixture = (dir: string, name: string) =>
  readFileSync(new URL(`../fixtures/${dir}/${name}.sse`, import.meta.url), 'utf8');

/** Replay an SSE body in small pieces so the parser sees events split across reads. */
export const sse =
  (text: string, opts: { pieces?: number; delayMs?: number; end?: boolean } = {}): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const size = Math.max(1, Math.ceil(text.length / (opts.pieces ?? 7)));
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const next = () => {
      const c = chunks.shift();
      if (c === undefined) {
        if (opts.end === false) res.socket?.destroy();
        else res.end();
        return;
      }
      res.write(c);
      setTimeout(next, opts.delayMs ?? 1);
    };
    next();
  };

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

export async function events(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** The SSE text up to (not including) the event that contains `marker`. */
export function cutBefore(text: string, marker: string): string {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  return text.slice(0, text.lastIndexOf('\n\n', at) + 2);
}
