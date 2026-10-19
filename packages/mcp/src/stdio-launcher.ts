// `nova mcp stdio` (FR-044, docs/08 §2.2): a launcher for MCP clients that only speak stdio. It
// relays newline-delimited JSON-RPC from stdin to Nova's MCP endpoint (streamable HTTP on the Hub)
// and the answers back to stdout, with the client's own token as a bearer token. The token comes
// from an environment variable or a file the user configures; it is never printed or logged, and
// the launcher holds no scope of its own: the Hub authenticates, scopes, gates and audits every
// call exactly as it does for an HTTP client. Nova never writes this into another application's
// configuration; the user pastes the command.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { SseParser } from '@nova/providers';

export interface StdioLauncherOptions {
  /** Nova's MCP endpoint, e.g. `https://hub.local:8443/mcp`. */
  url: string;
  token: string;
  stdin: Readable;
  stdout: Writable;
  /** Diagnostics (stderr); never receives the token. */
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

/** JSON-RPC error codes the launcher answers with when the Hub cannot. */
const UNREACHABLE = -32000;
const REJECTED = -32001;

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
}

/** Where the token and endpoint come from: flags, then environment variables. */
export function launcherConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): { url: string; token: string } {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = flag('--url') ?? env.NOVA_MCP_URL;
  if (!url) throw new Error('set the endpoint with --url or NOVA_MCP_URL');
  const parsed = new URL(url);
  // The token travels in a header: only https, or http to this machine.
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
    throw new Error('the endpoint must use https (http only for this machine)');
  const file = flag('--token-file') ?? env.NOVA_MCP_TOKEN_FILE;
  const token = (file ? read(file) : (env.NOVA_MCP_TOKEN ?? '')).trim();
  if (!token) throw new Error('set the token with NOVA_MCP_TOKEN or a file (--token-file)');
  return { url: parsed.toString(), token };
}

/** Relay until stdin ends; resolves once the session is closed. */
export async function runStdioLauncher(o: StdioLauncherOptions): Promise<void> {
  const doFetch = o.fetch ?? ((...a) => fetch(...a));
  const log = o.log ?? (() => undefined);
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let ready: Promise<void> = Promise.resolve();
  const stream = { open: false, stop: new AbortController() };
  const inflight = new Set<Promise<void>>();

  const write = (m: unknown) => {
    o.stdout.write(`${JSON.stringify(m)}\n`);
  };
  const fail = (id: Message['id'], code: number, message: string) => {
    // Notifications get no answer; requests always do.
    if (id === undefined || id === null) return;
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const headers = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = {
      authorization: `Bearer ${o.token}`,
      accept: 'application/json, text/event-stream',
    };
    if (json) h['content-type'] = 'application/json';
    if (sessionId) h['mcp-session-id'] = sessionId;
    if (protocolVersion) h['mcp-protocol-version'] = protocolVersion;
    return h;
  };
  /** Relay a response body: one JSON message, a batch, or an event stream of them. */
  const relay = async (res: Response, onMessage?: (m: Message) => void) => {
    const type = res.headers.get('content-type') ?? '';
    const emit = (text: string) => {
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        return;
      }
      for (const m of Array.isArray(v) ? v : [v]) {
        if (!m || typeof m !== 'object') continue;
        onMessage?.(m as Message);
        write(m);
      }
    };
    if (type.includes('text/event-stream') && res.body) {
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const chunk = await reader.read();
        const datas = chunk.done
          ? parser.end()
          : parser.push(decoder.decode(chunk.value, { stream: true }));
        for (const d of datas) emit(d);
        if (chunk.done) return;
      }
    }
    const text = await res.text();
    if (text.trim()) emit(text);
  };
  /** The server's own stream (notifications, server requests); optional on the Hub's side. */
  const openStream = () => {
    if (!sessionId || stream.open) return;
    stream.open = true;
    const signal = stream.stop.signal;
    void doFetch(o.url, { method: 'GET', headers: headers(false), signal })
      .then(async (res) => {
        if (res.ok) await relay(res);
      })
      .catch(() => undefined);
  };

  const send = async (m: Message): Promise<void> => {
    const isInit = m.method === 'initialize';
    if (!isInit) await ready;
    let res: Response;
    try {
      res = await doFetch(o.url, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(m),
      });
    } catch {
      log('nova mcp stdio: the Hub could not be reached');
      fail(m.id, UNREACHABLE, 'Nova could not be reached');
      return;
    }
    if (res.status === 401 || res.status === 403) {
      log(`nova mcp stdio: the Hub refused the request (${res.status})`);
      fail(m.id, REJECTED, 'Nova refused the token for this client');
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (isInit) {
      sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    }
    if (res.status === 202) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (!res.ok && !(res.headers.get('content-type') ?? '').includes('json')) {
      fail(m.id, UNREACHABLE, `Nova answered ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    await relay(res, (reply) => {
      if (!isInit || reply.id !== m.id) return;
      const r = reply.result as { protocolVersion?: unknown } | undefined;
      if (r && typeof r.protocolVersion === 'string') protocolVersion = r.protocolVersion;
    });
  };

  const rl = createInterface({ input: o.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let m: Message;
    try {
      m = JSON.parse(text) as Message;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const p = send(m)
      .catch(() => fail(m.id, UNREACHABLE, 'the request failed'))
      .finally(() => inflight.delete(p));
    inflight.add(p);
    // Everything after initialize waits until it is answered (the session id comes with it).
    if (m.method === 'initialize') ready = p;
    if (m.method === 'notifications/initialized') void p.then(openStream);
  }
  await Promise.allSettled([...inflight]);
  stream.stop.abort();
  // End the session on the Hub when the client goes.
  if (sessionId)
    await doFetch(o.url, { method: 'DELETE', headers: headers(false) })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
}
