// Nova's MCP server, M7 (FR-044): resources (chat transcripts in the client's thread scope, its
// projects' files read-only through their folders) and prompts (active skills, for clients whose
// tools include `skill.load`), each read passing the gate and audited as `client.call`, anything
// out of scope reading as missing; and the `nova mcp stdio` launcher reaching `/mcp` with a real
// client token, driven by the SDK client over stdio.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type SettingKey,
} from '@nova/shared';
import type { AuditRecord, GateRequest, ToolGate } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { hashToken } from '@nova/security';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupMcpServer, type McpServerArea } from '../src/mcp-server.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000d1';
const PROJECT = '01920000-0000-7000-8000-0000000000d2';
const OTHER_PROJECT = '01920000-0000-7000-8000-0000000000d3';
const THREAD = '01920000-0000-7000-8000-0000000000d4';
const HIDDEN = '01920000-0000-7000-8000-0000000000d5';
const LAUNCHER = fileURLToPath(
  new URL('../../../packages/mcp/src/launcher-main.ts', import.meta.url),
);

interface Threads {
  id: string;
  title: string;
  projectId: string | null;
  temporary: boolean;
}

let dir: string;
let db: NovaDatabase;
let area: McpServerArea;
let app: FastifyInstance;
let base: string;
let audit: AuditRecord[];
let gateCalls: GateRequest[];
let deny: Set<string>;
const clients: Client[] = [];

const THREADS: Threads[] = [
  { id: THREAD, title: 'Tomatoes', projectId: PROJECT, temporary: false },
  { id: HIDDEN, title: 'Receipts', projectId: OTHER_PROJECT, temporary: false },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-mcp-m7-'));
  const folder = join(dir, 'garden');
  mkdirSync(join(folder, 'notes'), { recursive: true });
  writeFileSync(join(folder, 'notes', 'plan.md'), '# Plan\n\nPlant in May.');
  writeFileSync(join(folder, 'seed.bin'), Buffer.from([1, 0, 2]));
  writeFileSync(join(dir, 'outside.txt'), 'not in the project');
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  for (const [id, name] of [
    [PROJECT, 'Garden'],
    [OTHER_PROJECT, 'Taxes'],
  ] as const)
    db.raw
      .prepare(
        'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, ACCOUNT, name, now, now);
  db.raw
    .prepare(
      "INSERT INTO project_folder (id, project_id, path, access, created_at, updated_at) VALUES (?, ?, ?, 'read', ?, ?)",
    )
    .run(uuidv7(), PROJECT, folder, now, now);
  audit = [];
  gateCalls = [];
  deny = new Set();
  const settings: Partial<Record<SettingKey, unknown>> = { 'mcpServer.enabled': true };
  const gate: ToolGate = {
    check: (req) => {
      gateCalls.push(req);
      return Promise.resolve(
        deny.has(req.tool.name)
          ? { effect: 'deny', reason: 'test rule', tier: 'pre_approvable', stop: false }
          : { effect: 'allow', reason: 'ok', tier: 'pre_approvable' },
      );
    },
    preview: () => Promise.reject(new Error('unused')),
  };
  const events = new EventStore(db);
  const ctx = {
    config: { version: '0.0.0-test' },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
    dataDir: join(dir, 'data'),
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {
      list: (_a: string, q: { projectId?: string }) =>
        Promise.resolve({
          items: THREADS.filter((t) => !q.projectId || t.projectId === q.projectId).map((t) => ({
            ...t,
            mode: 'chat',
            updatedAt: now,
          })),
          nextCursor: null,
        }),
      detail: (_a: string, id: string) => {
        const t = THREADS.find((x) => x.id === id);
        if (!t) return Promise.reject(new NovaError('not_found', 'thread not found'));
        return Promise.resolve({
          thread: t,
          messages: [
            {
              id: 'm1',
              role: 'user',
              createdAt: now,
              parts: [{ type: 'text', text: 'When do I plant?' }],
            },
            {
              id: 'm2',
              role: 'assistant',
              createdAt: now,
              parts: [{ type: 'text', text: 'In May.' }],
            },
          ],
        });
      },
    },
    setting: (key: SettingKey) =>
      Promise.resolve((key in settings ? settings[key] : SETTINGS[key].default) as never),
    accountOf: () => Promise.resolve(ACCOUNT),
    diagnostics: new DiagnosticsRegistry(),
    audit: { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) },
    gate,
    tools: {
      runtime: {
        scopeFor: () =>
          Promise.resolve({ roots: [], profile: { id: 'workspace', hash: 'h' }, network: 'off' }),
        registry: { list: () => Promise.resolve([]), find: () => Promise.resolve(null) },
      },
    },
    skills: {
      list: () =>
        Promise.resolve([
          { name: 'review', description: 'Review a change', active: true },
          { name: 'old', description: 'Shadowed', active: false },
        ]),
      resolve: (_a: string, name: string) =>
        Promise.resolve(name === 'review' ? { name, body: 'Read the diff closely.' } : null),
    },
  } as unknown as Parameters<typeof setupMcpServer>[0];
  area = await setupMcpServer(ctx);
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await area.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function client(scopes: Record<string, unknown>): string {
  const token = `nvm_${uuidv7().replace(/-/g, '')}`;
  db.raw
    .prepare(
      "INSERT INTO app_authorization (id, account_id, kind, client_name, scopes, token_hash, status, created_at) VALUES (?, ?, 'mcp_client', 'Agent', ?, ?, 'active', ?)",
    )
    .run(
      uuidv7(),
      ACCOUNT,
      JSON.stringify({ tools: [], projects: [], threads: 'none', mode: 'read_only', ...scopes }),
      hashToken(token),
      new Date().toISOString(),
    );
  return token;
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'agent', version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(c);
  return c;
}

describe('resources', () => {
  it('lists chats in scope as transcripts and reads them through the gate', async () => {
    const c = await connect(client({ projects: [PROJECT], threads: 'read' }));
    const listed = (await c.listResources()).resources;
    expect(listed).toEqual([
      expect.objectContaining({
        uri: `nova://threads/${THREAD}`,
        name: 'Tomatoes',
        mimeType: 'text/markdown',
      }),
    ]);
    const read = await c.readResource({ uri: `nova://threads/${THREAD}` });
    expect((read.contents[0] as { text: string }).text).toMatch(
      /^# Tomatoes\n\n## user \(.+\)\n\nWhen do I plant\?\n\n## assistant \(.+\)\n\nIn May\.\n$/,
    );
    expect(gateCalls.at(-1)).toMatchObject({
      origin: 'mcp_client',
      tool: { name: 'threads.read' },
      provenance: { taint: ['external_agent'] },
    });
    expect(audit.at(-1)).toMatchObject({
      action: 'client.call',
      result: 'ok',
      detail: { tool: 'threads.read' },
    });
    // Another project's chat reads as missing.
    await expect(c.readResource({ uri: `nova://threads/${HIDDEN}` })).rejects.toThrow();
    await expect(c.readResource({ uri: 'nova://elsewhere/x' })).rejects.toThrow();
  });

  it('offers nothing to a client without thread or project scope', async () => {
    const c = await connect(client({}));
    expect((await c.listResources()).resources).toEqual([]);
    expect((await c.listResourceTemplates()).resourceTemplates).toEqual([]);
    await expect(c.readResource({ uri: `nova://threads/${THREAD}` })).rejects.toThrow();
    await expect(
      c.readResource({ uri: `nova://projects/${PROJECT}/files/notes/plan.md` }),
    ).rejects.toThrow();
  });

  it('reads project files read-only through their folders, never outside or binary', async () => {
    const c = await connect(client({ projects: [PROJECT] }));
    expect((await c.listResourceTemplates()).resourceTemplates[0]).toMatchObject({
      uriTemplate: 'nova://projects/{projectId}/files/{+path}',
    });
    const read = await c.readResource({ uri: `nova://projects/${PROJECT}/files/notes/plan.md` });
    expect(read.contents[0]).toMatchObject({
      mimeType: 'text/markdown',
      text: '# Plan\n\nPlant in May.',
    });
    expect(gateCalls.at(-1)).toMatchObject({
      tool: { name: 'fs.read' },
      resource: { kind: 'path', value: join(dir, 'garden', 'notes', 'plan.md') },
    });
    for (const uri of [
      `nova://projects/${PROJECT}/files/../outside.txt`,
      `nova://projects/${PROJECT}/files/seed.bin`,
      `nova://projects/${PROJECT}/files/missing.md`,
      `nova://projects/${OTHER_PROJECT}/files/plan.md`,
    ])
      await expect(c.readResource({ uri }), uri).rejects.toThrow();
    // A rule that denies reading files makes the file read as missing too.
    deny.add('fs.read');
    await expect(
      c.readResource({ uri: `nova://projects/${PROJECT}/files/notes/plan.md` }),
    ).rejects.toThrow();
    expect(audit.at(-1)).toMatchObject({ action: 'client.call', result: 'denied' });
  });
});

describe('M7 review hardening', () => {
  it('passes listings through the gate: a denied listing is empty and audited', async () => {
    const c = await connect(client({ projects: '*', threads: 'read', tools: ['skill.load'] }));
    expect((await c.listResources()).resources).toHaveLength(2);
    deny.add('threads.list');
    deny.add('projects.list');
    deny.add('skills.list');
    expect((await c.listResources()).resources).toEqual([]);
    expect((await c.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await c.listPrompts()).prompts).toEqual([]);
    for (const tool of ['threads.list', 'projects.list', 'skills.list'])
      expect(
        audit.some((a) => a.detail?.tool === tool && a.result === 'denied'),
        tool,
      ).toBe(true);
  });

  it('never reads a project of another account, whatever the client scope', async () => {
    const other = uuidv7();
    const otherProject = uuidv7();
    const now = new Date().toISOString();
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(other, now, now);
    db.raw
      .prepare(
        'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(otherProject, other, 'Theirs', now, now);
    db.raw
      .prepare(
        "INSERT INTO project_folder (id, project_id, path, access, created_at, updated_at) VALUES (?, ?, ?, 'read', ?, ?)",
      )
      .run(uuidv7(), otherProject, join(dir, 'garden'), now, now);
    const c = await connect(client({ projects: '*' }));
    await expect(
      c.readResource({ uri: `nova://projects/${otherProject}/files/notes/plan.md` }),
    ).rejects.toThrow();
    // The same file through the account's own project reads.
    const own = await c.readResource({ uri: `nova://projects/${PROJECT}/files/notes/plan.md` });
    expect(own.contents[0]).toMatchObject({ text: '# Plan\n\nPlant in May.' });
  });
});

describe('prompts', () => {
  it('serves active skills to clients whose tools include skill.load', async () => {
    const c = await connect(client({ tools: ['skill.load'] }));
    expect((await c.listPrompts()).prompts).toEqual([
      expect.objectContaining({ name: 'review', description: 'Review a change' }),
    ]);
    const p = await c.getPrompt({ name: 'review', arguments: { input: 'the parser change' } });
    expect(p.messages[0]!.content).toEqual({
      type: 'text',
      text: 'Read the diff closely.\n\n---\n\nthe parser change',
    });
    expect(gateCalls.at(-1)).toMatchObject({ tool: { name: 'skill.load' } });
    await expect(c.getPrompt({ name: 'old' })).rejects.toThrow(/Unknown prompt/);
    deny.add('skill.load');
    await expect(c.getPrompt({ name: 'review' })).rejects.toThrow(/Unknown prompt/);
  });

  it('serves none to other clients', async () => {
    const c = await connect(client({ projects: '*', threads: 'read' }));
    expect((await c.listPrompts()).prompts).toEqual([]);
    await expect(c.getPrompt({ name: 'review' })).rejects.toThrow(/Unknown prompt/);
  });
});

describe('nova mcp stdio against the Hub', () => {
  it('relays a stdio-only client with its token to /mcp', async () => {
    const token = client({ projects: '*', threads: 'read', tools: ['skill.load'] });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER, 'mcp', 'stdio'],
      env: { PATH: process.env.PATH ?? '', NOVA_MCP_URL: `${base}/mcp`, NOVA_MCP_TOKEN: token },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'stdio-agent', version: '1' });
    await c.connect(transport);
    clients.push(c);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'projects.list',
      'threads.list',
      'threads.read',
    ]);
    expect((await c.listResources()).resources).toHaveLength(2);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual(['review']);
    expect(area.server.sessions()).toBe(1);
  });
});
