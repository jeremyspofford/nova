// Nova's MCP server core (FR-044) behind a plain HTTP host, driven by the SDK client: sessions per
// client, tool listing and calls, a session that another client cannot use, closing a client's
// sessions (revocation) and the per-client session cap.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { NovaMcpServer, type McpClientRef, type ServedTool } from '../src/index.ts';
import { waitFor } from './helpers.ts';

interface Host {
  url: string;
  server: NovaMcpServer;
  close(): Promise<void>;
}

const CLIENTS: Record<string, McpClientRef> = {
  a: { id: 'client-a', name: 'Editor' },
  b: { id: 'client-b', name: 'Other' },
};

let host: Host | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await host?.close();
  host = null;
});

async function startHost(tools: (c: McpClientRef) => ServedTool[], max?: number): Promise<Host> {
  const server = new NovaMcpServer({
    name: 'nova',
    version: '0.0.0-test',
    instructions: 'test server',
    tools: (c) => Promise.resolve(tools(c)),
    ...(max ? { maxSessionsPerClient: max } : {}),
  });
  const http: Server = createServer((req, res) => {
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
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const who = CLIENTS[headers.get('x-client') ?? ''];
    if (!who) return new Response('no client', { status: 401 });
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    return server.handle(
      new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method ?? 'GET', headers }),
      who,
      body,
    );
  }
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    server,
    close: async () => {
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

async function connect(
  as: 'a' | 'b',
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(host!.url), {
    requestInit: { headers: { 'x-client': as } },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

const echo = (name = 'echo'): ServedTool => ({
  name,
  description: 'Echo the text back',
  inputSchema: { properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true },
  call: (args, signal) =>
    Promise.resolve({
      text: `${String(args.text)}${signal.aborted ? ' (aborted)' : ''}`,
      isError: false,
    }),
});

describe("Nova's MCP server core", () => {
  it('lists and calls the tools of the authenticated client', async () => {
    host = await startHost((c) => [
      echo(),
      { ...echo('whoami'), call: () => Promise.resolve({ text: c.name, isError: false }) },
      { ...echo('bad name!'), call: () => Promise.reject(new Error('never listed')) },
      echo(),
    ]);
    const { client } = await connect('a');
    expect(client.getInstructions()).toBe('test server');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'whoami']);
    expect(tools[0]).toMatchObject({
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    });
    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r).toMatchObject({ content: [{ type: 'text', text: 'hi' }], isError: false });
    expect(await client.callTool({ name: 'whoami', arguments: {} })).toMatchObject({
      content: [{ text: 'Editor' }],
    });
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool/);
    expect(host.server.sessions('client-a')).toBe(1);
  });

  it('reports a failing tool as an error result without its internals', async () => {
    host = await startHost(() => [
      { ...echo('boom'), call: () => Promise.reject(new Error('secret internal detail')) },
    ]);
    const { client } = await connect('a');
    const r = await client.callTool({ name: 'boom', arguments: {} });
    expect(r).toMatchObject({ isError: true, content: [{ text: 'The call failed inside Nova.' }] });
    expect(JSON.stringify(r)).not.toContain('secret internal detail');
  });

  it("refuses another client's session id and requests without a session", async () => {
    host = await startHost(() => [echo()]);
    const { transport } = await connect('a');
    const sid = transport.sessionId!;
    const res = await fetch(host.url, {
      method: 'POST',
      headers: {
        'x-client': 'b',
        'mcp-session-id': sid,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const none = await fetch(host.url, {
      method: 'POST',
      headers: {
        'x-client': 'a',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(none.status).toBe(400);
    const get = await fetch(host.url, { headers: { 'x-client': 'a' } });
    expect(get.status).toBe(400);
  });

  it('closes every session of a client at once and cancels its calls', async () => {
    let started = false;
    let aborted = false;
    host = await startHost(() => [
      echo(),
      {
        ...echo('wait'),
        call: (_args, signal) =>
          new Promise((resolve) => {
            started = true;
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ text: 'aborted', isError: true });
            });
          }),
      },
    ]);
    const a = await connect('a');
    const b = await connect('b');
    const pending = a.client.callTool({ name: 'wait', arguments: {} });
    await waitFor(() => started, 5000, 'call started');
    expect(await host.server.closeClient('client-a')).toBe(1);
    await waitFor(() => aborted, 5000, 'call aborted');
    // The cancelled call still gets its answer before the session ends.
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'aborted' }] });
    expect(host.server.sessions('client-a')).toBe(0);
    // The closed session id is gone: the client has to start over (and pass auth again).
    const res = await fetch(host.url, {
      method: 'POST',
      headers: {
        'x-client': 'a',
        'mcp-session-id': a.transport.sessionId!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    expect(await b.client.callTool({ name: 'echo', arguments: { text: 'still' } })).toMatchObject({
      content: [{ text: 'still' }],
    });
  });

  it('caps sessions per client, closing the oldest', async () => {
    host = await startHost(() => [echo()], 2);
    await connect('a');
    await connect('a');
    await connect('a');
    expect(host.server.sessions('client-a')).toBe(2);
    expect(await host.server.closeAll()).toBe(2);
    expect(host.server.sessions()).toBe(0);
    await connect('a');
    expect(host.server.sessions('client-a')).toBe(1);
    await host.server.close();
    expect(host.server.sessions()).toBe(0);
    const late = await fetch(host.url, {
      method: 'POST',
      headers: {
        'x-client': 'a',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(late.status).toBe(503);
  });
});
