// Nova's own MCP server (FR-044; docs/08 §2.2): streamable HTTP sessions for external clients,
// built on the SDK's web-standard transport. This module knows nothing about tokens or scopes:
// the Hub authenticates each request, names the client, and supplies that client's tools. A
// session belongs to the client that opened it, and closing a client (revocation) ends all of its
// sessions and cancels their calls at once.
import { randomUUID } from 'node:crypto';
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/server';
import { Logger } from '@nova/telemetry';

/** The client a request was authenticated as (an app authorization). */
export interface McpClientRef {
  id: string;
  name: string;
}

export interface ServedToolResult {
  text: string;
  isError: boolean;
}

/** One tool offered to a client; `name` is already a valid MCP tool name. */
export interface ServedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<ServedToolResult>;
}

export interface NovaMcpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  /** The tools this client may use now (asked on every list and call). */
  tools: (client: McpClientRef) => Promise<ServedTool[]>;
  /** Open sessions per client; the oldest closes when a new one would exceed it (default 16). */
  maxSessionsPerClient?: number;
  log?: Logger;
}

/** MCP tool names: 1-128 of letters, digits, `_`, `-` and `.`. */
export const MCP_SERVED_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

interface Session {
  id: string | null;
  client: McpClientRef;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  abort: AbortController;
  /** Calls being answered; a closing session lets them answer (cancelled) before it ends. */
  inflight: Set<Promise<unknown>>;
  closed: boolean;
}

/** How long a closing session waits for its cancelled calls to answer. */
const DRAIN_MS = 1000;

function rpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function toMcpTool(t: ServedTool): Tool {
  const tool: Tool = {
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', ...t.inputSchema },
  };
  if (t.title) tool.title = t.title;
  if (t.annotations) tool.annotations = { ...t.annotations };
  return tool;
}

export class NovaMcpServer {
  readonly #opts: NovaMcpServerOptions;
  readonly #log: Logger;
  readonly #sessions = new Map<string, Session>();
  /** Sessions whose initialize is still being answered (not in #sessions yet). */
  readonly #pending = new Set<Session>();
  #closed = false;

  constructor(opts: NovaMcpServerOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? new Logger({ module: 'mcp.server', sinks: [] });
  }

  /** Open sessions, optionally of one client. */
  sessions(clientId?: string): number {
    let n = 0;
    for (const s of this.#sessions.values()) if (!clientId || s.client.id === clientId) n++;
    return n;
  }

  /**
   * Answer one HTTP request (POST JSON-RPC, GET server stream, DELETE session) for an
   * authenticated client. `parsedBody` is the JSON body when the caller already read it.
   */
  async handle(req: Request, client: McpClientRef, parsedBody?: unknown): Promise<Response> {
    if (this.#closed) return rpcError(503, -32000, 'the server is shutting down');
    const opts = parsedBody === undefined ? {} : { parsedBody };
    const sid = req.headers.get('mcp-session-id');
    if (sid) {
      const s = this.#sessions.get(sid);
      // A session id of another client is as unknown as a made-up one.
      if (!s || s.closed || s.client.id !== client.id)
        return rpcError(404, -32001, 'Session not found');
      return s.transport.handleRequest(req, opts);
    }
    if (req.method !== 'POST' || !isInitializeRequest(parsedBody))
      return rpcError(400, -32000, 'Bad Request: start a session with an initialize request');
    this.#trim(client.id);
    const s = this.#open(client);
    this.#pending.add(s);
    try {
      await s.server.connect(s.transport);
      const res = await s.transport.handleRequest(req, opts);
      if (!s.id) await this.#end(s);
      return res;
    } catch (err) {
      await this.#end(s);
      throw err;
    } finally {
      this.#pending.delete(s);
    }
  }

  /** Close every session of a client now (revocation); returns how many were open. */
  async closeClient(clientId: string): Promise<number> {
    const mine = [...this.#all()].filter((s) => s.client.id === clientId && !s.closed);
    await Promise.all(mine.map((s) => this.#end(s)));
    return mine.length;
  }

  /** End every open session (the server was turned off); new sessions may start later. */
  async closeAll(): Promise<number> {
    const open = [...this.#all()].filter((s) => !s.closed);
    await Promise.all(open.map((s) => this.#end(s)));
    return open.length;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#all()].map((s) => this.#end(s)));
  }

  #all(): Set<Session> {
    return new Set([...this.#sessions.values(), ...this.#pending]);
  }

  #trim(clientId: string): void {
    const max = this.#opts.maxSessionsPerClient ?? 16;
    const mine = [...this.#sessions.values()].filter((s) => s.client.id === clientId);
    // Map order is insertion order: the oldest sessions go first.
    for (const s of mine.slice(0, Math.max(0, mine.length - max + 1))) void this.#end(s);
  }

  async #end(s: Session): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    if (s.id) this.#sessions.delete(s.id);
    // Cancel running calls and give them a moment to send their (cancelled) answers, so the
    // client gets a response instead of a stream that just stops.
    s.abort.abort();
    if (s.inflight.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...s.inflight]),
        new Promise<void>((r) => {
          timer = setTimeout(r, DRAIN_MS);
        }),
      ]);
      clearTimeout(timer);
      await new Promise<void>((r) => setImmediate(r));
    }
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  }

  #open(client: McpClientRef): Session {
    const abort = new AbortController();
    const server = new McpServer(
      { name: this.#opts.name, version: this.#opts.version },
      {
        capabilities: { tools: {} },
        ...(this.#opts.instructions ? { instructions: this.#opts.instructions } : {}),
      },
    );
    const session: Session = {
      id: null,
      client,
      server,
      abort,
      inflight: new Set(),
      closed: false,
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          session.id = id;
          if (session.closed) return;
          this.#sessions.set(id, session);
          this.#log.info('mcp client session opened', { clientId: client.id, sessionId: id });
        },
        onsessionclosed: (id) => {
          this.#log.info('mcp client session ended', { clientId: client.id, sessionId: id });
          void this.#end(session);
        },
      }),
    };
    session.transport.onclose = () => void this.#end(session);
    const list = async (): Promise<ServedTool[]> => {
      const seen = new Set<string>();
      const out: ServedTool[] = [];
      for (const t of await this.#opts.tools(client)) {
        if (!MCP_SERVED_TOOL_NAME.test(t.name) || seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
      return out;
    };
    server.server.setRequestHandler('tools/list', async () => ({
      tools: (await list()).map(toMcpTool),
    }));
    server.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const tool = (await list()).find((t) => t.name === name);
      if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args)))
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'arguments must be an object');
      if (session.closed)
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'the session has ended');
      const signal = AbortSignal.any([abort.signal, ctx.mcpReq.signal]);
      const run = tool.call(args ?? {}, signal);
      session.inflight.add(run);
      try {
        const r = await run;
        return { content: [{ type: 'text', text: r.text }], isError: r.isError };
      } catch (err) {
        this.#log.warn('mcp client tool call failed', { clientId: client.id, tool: name, err });
        return { content: [{ type: 'text', text: 'The call failed inside Nova.' }], isError: true };
      } finally {
        session.inflight.delete(run);
      }
    });
    return session;
  }
}
