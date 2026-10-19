// `nova mcp stdio` and the server's resources and prompts (FR-044): a stdio-only client (the SDK
// client over stdio) reaches Nova's MCP server through the launcher, which adds the client's
// bearer token and relays JSON-RPC both ways; tools, resources, templates and prompts work end to
// end; a wrong token surfaces as an error; the launcher's configuration refuses a missing token,
// a plain-HTTP remote endpoint and bad arguments.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NovaMcpServer,
  launcherConfig,
  runStdioLauncher,
  type McpClientRef,
} from '../src/index.ts';

const LAUNCHER = fileURLToPath(new URL('../src/launcher-main.ts', import.meta.url));
const TOKEN = 'nvm_test_token_value';

interface Host {
  url: string;
  seenAuth: string[];
  close(): Promise<void>;
}

let host: Host | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await host?.close();
  host = null;
});

async function startHost(): Promise<Host> {
  const who: McpClientRef = { id: 'client-a', name: 'Editor' };
  const server = new NovaMcpServer({
    name: 'nova',
    version: '0.0.0-test',
    tools: () =>
      Promise.resolve([
        {
          name: 'echo',
          description: 'echo',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          call: (args) => Promise.resolve({ text: `echo ${String(args.text)}`, isError: false }),
        },
      ]),
    resources: {
      list: () =>
        Promise.resolve([
          { uri: 'nova://threads/t1', name: 'Chat one', mimeType: 'text/markdown' },
        ]),
      templates: () =>
        Promise.resolve([
          { uriTemplate: 'nova://projects/{projectId}/files/{+path}', name: 'Project files' },
        ]),
      read: (_c, uri) =>
        Promise.resolve(
          uri === 'nova://threads/t1'
            ? { uri, mimeType: 'text/markdown', text: '# Chat one\n\nhello' }
            : null,
        ),
    },
    prompts: {
      list: () =>
        Promise.resolve([
          {
            name: 'review',
            description: 'Review a diff',
            arguments: [{ name: 'focus', required: false }],
          },
        ]),
      get: (_c, name, args) =>
        Promise.resolve(
          name === 'review'
            ? { description: 'Review', text: `Review it. Focus: ${args.focus ?? 'all'}` }
            : null,
        ),
    },
  });
  const seenAuth: string[] = [];
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
    seenAuth.push(headers.get('authorization') ?? '');
    if (headers.get('authorization') !== `Bearer ${TOKEN}`)
      return new Response('{"error":{"code":"token_required"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
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
    seenAuth,
    close: async () => {
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

async function stdioClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [LAUNCHER, 'mcp', 'stdio'],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-only-agent', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe('nova mcp stdio', () => {
  it('relays a stdio client to Nova’s MCP server: tools, resources and prompts', async () => {
    host = await startHost();
    const client = await stdioClient({ NOVA_MCP_URL: host.url, NOVA_MCP_TOKEN: TOKEN });
    expect(client.getServerVersion()).toMatchObject({ name: 'nova' });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const call = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(call.content).toEqual([{ type: 'text', text: 'echo hi' }]);
    expect((await client.listResources()).resources).toEqual([
      { uri: 'nova://threads/t1', name: 'Chat one', mimeType: 'text/markdown' },
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates[0]).toMatchObject({
      name: 'Project files',
    });
    const read = await client.readResource({ uri: 'nova://threads/t1' });
    expect(read.contents[0]).toMatchObject({ text: '# Chat one\n\nhello' });
    await expect(client.readResource({ uri: 'nova://threads/other' })).rejects.toThrow();
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['review']);
    const prompt = await client.getPrompt({ name: 'review', arguments: { focus: 'tests' } });
    expect(prompt.messages[0]!.content).toEqual({ type: 'text', text: 'Review it. Focus: tests' });
    await expect(client.getPrompt({ name: 'missing' })).rejects.toThrow(/Unknown prompt/);
    // Every request carried the client's token, and only it.
    expect(new Set(host.seenAuth)).toEqual(new Set([`Bearer ${TOKEN}`]));
  });

  it('relays requests, notifications and the session in-process, then ends the session', async () => {
    host = await startHost();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buffered = '';
    stdout.on('data', (b: Buffer) => {
      buffered += b.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
    });
    const done = runStdioLauncher({ url: host.url, token: TOKEN, stdin, stdout });
    const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x' } },
    });
    send({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'nova://threads/t1' } });
    stdin.write('\n');
    await new Promise((r) => setTimeout(r, 300));
    stdin.end();
    await done;
    const byId = (id: number) => out.find((m) => m.id === id);
    expect(byId(1)).toMatchObject({ result: { serverInfo: { name: 'nova' } } });
    expect(byId(2)).toMatchObject({ result: { tools: [{ name: 'echo' }] } });
    expect(byId(3)).toMatchObject({ result: { content: [{ type: 'text', text: 'echo x' }] } });
    expect(byId(4)).toMatchObject({ result: { contents: [{ text: '# Chat one\n\nhello' }] } });
    // Only the client's token reached the Hub, on every request (the session's end included).
    expect(host.seenAuth.length).toBeGreaterThanOrEqual(5);
    expect(new Set(host.seenAuth)).toEqual(new Set([`Bearer ${TOKEN}`]));
  });

  it('reads the token from a file', async () => {
    host = await startHost();
    const cfg = launcherConfig(['--url', host.url, '--token-file', '/x/token'], {}, (p) =>
      p === '/x/token' ? `${TOKEN}\n` : '',
    );
    expect(cfg).toEqual({ url: host.url, token: TOKEN });
  });

  it('answers requests with an error when the Hub refuses the token or cannot be reached', async () => {
    host = await startHost();
    const run = async (url: string) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const lines: string[] = [];
      stdout.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
      const logs: string[] = [];
      const done = runStdioLauncher({
        url,
        token: 'nvm_wrong',
        stdin,
        stdout,
        log: (l) => logs.push(l),
      });
      stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })}\n`,
      );
      stdin.write('not json\n');
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      stdin.end();
      await done;
      return { lines: lines.map((l) => JSON.parse(l) as Record<string, unknown>), logs };
    };
    const refused = await run(host.url);
    expect(refused.lines).toEqual(
      expect.arrayContaining([
        {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32001, message: 'Nova refused the token for this client' },
        },
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      ]),
    );
    expect(refused.logs.join('\n')).not.toContain('nvm_wrong');
    const gone = await run('http://127.0.0.1:9/mcp');
    expect(gone.lines.find((l) => l.id === 1)).toMatchObject({ error: { code: -32000 } });
  });

  it('refuses a missing token, a remote plain-HTTP endpoint and no endpoint', () => {
    expect(() => launcherConfig([], { NOVA_MCP_TOKEN: TOKEN })).toThrow(/endpoint/);
    expect(() => launcherConfig([], { NOVA_MCP_URL: 'http://127.0.0.1:1/mcp' })).toThrow(/token/);
    expect(() =>
      launcherConfig([], { NOVA_MCP_URL: 'http://hub.example/mcp', NOVA_MCP_TOKEN: TOKEN }),
    ).toThrow(/https/);
    expect(
      launcherConfig([], { NOVA_MCP_URL: 'https://hub.example/mcp', NOVA_MCP_TOKEN: ` ${TOKEN} ` }),
    ).toEqual({ url: 'https://hub.example/mcp', token: TOKEN });
  });
});
