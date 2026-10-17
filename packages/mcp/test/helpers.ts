// Shared test helpers: a manager with fast backoff, a config builder, the fixture path and a
// streamable HTTP host for the fixture server.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Redactor } from '@nova/security';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  McpManager,
  type McpManagerOptions,
  type McpServerConfig,
  type McpServerState,
} from '../src/index.ts';
import { createTestServer, type TestServerOptions } from './fixtures/test-server.mjs';

export const FIXTURE = fileURLToPath(new URL('./fixtures/test-server.mjs', import.meta.url));

export function stdioConfig(
  over: Partial<McpServerConfig> = {},
  args: string[] = [],
): McpServerConfig {
  return {
    id: over.id ?? randomUUID(),
    accountId: 'acct-1',
    name: 'test',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE, ...args],
    url: null,
    env: {},
    headers: {},
    enabled: true,
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 10_000,
    enabledTools: null,
    disabledTools: [],
    ...over,
  };
}

export interface Harness {
  manager: McpManager;
  sink: MemorySink;
  statuses: McpServerState[];
  toolChanges: string[];
  secrets: Map<string, string>;
}

export function harness(opts: Partial<McpManagerOptions> = {}): Harness {
  const sink = new MemorySink();
  const statuses: McpServerState[] = [];
  const toolChanges: string[] = [];
  const secrets = new Map<string, string>();
  const manager = new McpManager({
    resolveSecret: (ref) => Promise.resolve(secrets.get(ref) ?? null),
    log: new Logger({ module: 'mcp', sinks: [sink], level: 'debug' }),
    redactor: new Redactor(),
    backoff: { baseMs: 20, maxMs: 100 },
    listChangedDebounceMs: 0,
    onStatus: (s) => statuses.push(s),
    onToolsChanged: (id) => toolChanges.push(id),
    ...opts,
  });
  return { manager, sink, statuses, toolChanges, secrets };
}

export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 8_000,
  what = 'condition',
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export interface HttpHost {
  url: string;
  /** Headers of every request received. */
  requests: Record<string, string>[];
  close(): Promise<void>;
}

/**
 * Serve the fixture over streamable HTTP (stateful sessions) from an in-process HTTP server.
 * With `requireHeader`, requests without that header value are refused with 401.
 */
export async function startHttpHost(
  opts: TestServerOptions & { requireHeader?: [string, string] } = {},
): Promise<HttpHost> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const requests: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    handle(req)
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const reader = response.body.getReader();
          res.on('close', () => void reader.cancel().catch(() => undefined));
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  async function handle(req: IncomingMessage): Promise<Response> {
    const headers = new Headers();
    const seen: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') {
        headers.set(k, v);
        seen[k] = v;
      }
    }
    requests.push(seen);
    if (opts.requireHeader && seen[opts.requireHeader[0]] !== opts.requireHeader[1]) {
      return new Response('unauthorized', { status: 401 });
    }
    let body: string | undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = Buffer.concat(chunks).toString('utf8');
    }
    const sid = seen['mcp-session-id'];
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid) return new Response('unknown session', { status: 404 });
      const t = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, t),
      });
      await createTestServer({ ...opts, log: () => undefined }).connect(t);
      transport = t;
    }
    const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    return transport.handleRequest(request);
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: async () => {
      for (const t of sessions.values()) await t.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
