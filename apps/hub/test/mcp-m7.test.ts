// MCP server fields that arrive in M7 (FR-042, FR-047): `deviceId` (stdio only, one of the
// account's devices, reached through the device bridge and never spawned on the Hub), `auth` (an
// sse/http server's key, kept in the vault and sent as its Authorization header) and `oauth`
// (metadata document or dynamic registration, and scopes), with the checks between them.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuditRecord, DeviceService } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import {
  httpStatusFor,
  isNovaError,
  uuidv7,
  type McpServerM7View,
  type McpServerView,
} from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { deviceBridgeFrom, setupMcp, type DeviceMcpService, type HubMcpArea } from '../src/mcp.ts';

// The devices area's service is what app.ts hands to `deviceBridgeFrom` (checked when compiling).
const _devicesFit = (svc: DeviceService): DeviceMcpService => svc;
void _devicesFit;

/** A device service answering like novad's MCP pass-through (`services/novad/src/mcp.rs`). */
function fakeDevices(status: 'active' | 'pending' = 'active') {
  const calls: unknown[] = [];
  const svc: DeviceMcpService = {
    mcpList: (accountId, deviceId, grantee) => {
      calls.push(['list', accountId, deviceId, grantee]);
      if (status !== 'active')
        return Promise.reject(
          Object.assign(new Error('the device is not reachable'), { code: 'node_unavailable' }),
        );
      return Promise.resolve({
        servers: [
          {
            name: 'notes',
            tools: [{ name: 'find', description: 'Find notes', inputSchema: { type: 'object' } }],
          },
          { name: 'broken', tools: [], error: { code: 'node_unavailable', message: 'no bwrap' } },
        ],
      });
    },
    mcpCall: (accountId, deviceId, grantee, call) => {
      calls.push(['call', accountId, deviceId, grantee, call]);
      return Promise.resolve({
        content: [{ type: 'text', text: `found ${String(call.arguments.q)}` }],
        isError: false,
        untrusted: true,
      } as { content: unknown[]; isError: boolean });
    },
  };
  return { svc, calls };
}

type View = McpServerView & McpServerM7View;

const ACCOUNT = uuidv7();
const DEVICE = uuidv7();
let dir: string;
let db: NovaDatabase;
let area: HubMcpArea;
let app: FastifyInstance;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let remote: Server;
let remoteUrl: string;
let seenAuth: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-mcp-m7-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, created_at, updated_at) VALUES (?, ?, 'Laptop', 'client', ?, 'pk', '[]', 'active', ?, ?)",
    )
    .run(DEVICE, ACCOUNT, `fp-${DEVICE}`, now, now);
  secrets = new MemorySecretStore();
  audit = [];
  seenAuth = [];
  // A remote server that records the Authorization header of every request and refuses them.
  remote = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '');
    req.resume();
    res.writeHead(500).end('nope');
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as { port: number }).port}/mcp`;
  const ctx = {
    config: { version: '0.0.0-test', dataDir: join(dir, 'data') },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events: new EventStore(db),
    secrets,
    dataDir: join(dir, 'data'),
    accountOf: () => Promise.resolve(ACCOUNT),
    diagnostics: new DiagnosticsRegistry(),
    audit: { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) },
  } as unknown as Parameters<typeof setupMcp>[0];
  area = await setupMcp(ctx);
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await area.close();
  await app.close();
  remote.closeAllConnections();
  await new Promise<void>((r) => remote.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: payload as object });
const patch = (id: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/v1/mcp/servers/${id}`, payload: payload as object });

async function waitFor(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('MCP server deviceId (FR-042)', () => {
  it('runs a device server through the bridge, never on the Hub', async () => {
    const res = await post({
      name: 'notes',
      transport: 'stdio',
      command: 'notes',
      deviceId: DEVICE,
    });
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json<View>();
    expect(v).toMatchObject({ deviceId: DEVICE, hasAuth: false, oauthSettings: null });
    await waitFor(() => area.manager.state(v.id)?.status === 'error');
    expect(area.manager.state(v.id)!.lastError).toMatch(/device the Hub cannot reach/);
    const calls: unknown[] = [];
    area.useDeviceBridge({
      list: (target) => {
        calls.push(target);
        return Promise.resolve([{ name: 'find', inputSchema: { type: 'object' } }]);
      },
      call: () => Promise.resolve({ content: [], isError: false }),
    });
    await waitFor(() => area.manager.state(v.id)?.status === 'connected');
    expect(calls).toEqual([{ accountId: ACCOUNT, deviceId: DEVICE, server: 'notes' }]);
    expect(area.manager.tools(v.id).map((t) => t.descriptor.name)).toEqual(['mcp:notes.find']);
    expect(audit.find((a) => a.action === 'add')?.detail).toMatchObject({ deviceId: DEVICE });
  });

  it('refuses a device that is not the account’s, and a device for a remote server', async () => {
    expect(
      (await post({ name: 'a', transport: 'stdio', command: 'x', deviceId: uuidv7() })).statusCode,
    ).toBe(400);
    expect(
      (await post({ name: 'b', transport: 'http', url: remoteUrl, deviceId: DEVICE })).statusCode,
    ).toBe(400);
    const ok = (
      await post({ name: 'c', transport: 'stdio', command: 'x', deviceId: DEVICE })
    ).json<View>();
    // Moving it back to the Hub clears the device.
    const moved = await patch(ok.id, { deviceId: null, enabled: false });
    expect(moved.json<View>().deviceId).toBeNull();
  });
});

describe('MCP server auth and oauth (FR-042, FR-047)', () => {
  it('keeps the key in the vault and sends it as the Authorization header', async () => {
    const res = await post({
      name: 'remote',
      transport: 'http',
      url: remoteUrl,
      auth: 'key-123456789',
    });
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json<View>();
    expect(v.hasAuth).toBe(true);
    expect(v.auth).toMatchObject({ kind: 'api_key' });
    expect(res.body).not.toContain('key-123456789');
    const row = db.raw.prepare('SELECT config_json FROM mcp_server WHERE id = ?').get(v.id) as {
      config_json: string;
    };
    expect(row.config_json).not.toContain('key-123456789');
    expect(await secrets.get(`secret://mcp/${v.id}/auth/header`)).toBe('Bearer key-123456789');
    await waitFor(() => seenAuth.length > 0);
    expect(seenAuth[0]).toBe('Bearer key-123456789');
    // '' keeps it; a scheme is kept as given; null removes it.
    expect((await patch(v.id, { auth: '' })).json<View>().hasAuth).toBe(true);
    await patch(v.id, { auth: 'Basic dXNlcjpwYXNz' });
    expect(await secrets.get(`secret://mcp/${v.id}/auth/header`)).toBe('Basic dXNlcjpwYXNz');
    expect((await patch(v.id, { auth: null })).json<View>().hasAuth).toBe(false);
    expect(await secrets.get(`secret://mcp/${v.id}/auth/header`)).toBeNull();
    expect(JSON.stringify(audit)).not.toContain('key-123456789');
  });

  it('checks auth and oauth against the transport and each other', async () => {
    for (const bad of [
      { name: 'a', transport: 'stdio', command: 'x', auth: 'k' },
      { name: 'b', transport: 'stdio', command: 'x', oauth: { dynamicRegistration: true } },
      { name: 'c', transport: 'http', url: remoteUrl, auth: 'k', oauth: { scopes: ['read'] } },
      { name: 'd', transport: 'http', url: remoteUrl, auth: 'secret://provider/x/api_key' },
      {
        name: 'e',
        transport: 'http',
        url: remoteUrl,
        oauth: { clientMetadataUrl: 'https://hub.example/client.json', dynamicRegistration: true },
      },
      {
        name: 'f',
        transport: 'http',
        url: remoteUrl,
        oauth: { clientMetadataUrl: 'http://x/c.json' },
      },
      { name: 'g', transport: 'http', url: remoteUrl, oauth: { extra: 1 } },
    ]) {
      const r = await post(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const ok = await post({
      name: 'h',
      transport: 'sse',
      url: remoteUrl,
      oauth: { dynamicRegistration: true, scopes: ['read', 'write'] },
    });
    expect(ok.json<View>().oauthSettings).toEqual({
      dynamicRegistration: true,
      scopes: ['read', 'write'],
    });
    const cleared = await patch(ok.json<View>().id, { oauth: null });
    expect(cleared.json<View>().oauthSettings).toBeNull();
  });
});

describe('the device bridge (FR-042, FR-210)', () => {
  it('reaches a device server through the pass-through as the account’s user', async () => {
    const res = await post({
      name: 'notes',
      transport: 'stdio',
      command: 'notes',
      deviceId: DEVICE,
    });
    const v = res.json<View>();
    const { svc, calls } = fakeDevices();
    area.useDeviceBridge(deviceBridgeFrom(svc));
    await waitFor(() => area.manager.state(v.id)?.status === 'connected');
    expect(area.manager.tools(v.id).map((t) => t.descriptor.name)).toEqual(['mcp:notes.find']);
    const r = await area.manager.callTool(v.id, 'find', { q: 'milk' });
    expect(r).toMatchObject({ ok: true });
    expect(calls).toEqual([
      ['list', ACCOUNT, DEVICE, { kind: 'user', id: ACCOUNT }],
      [
        'call',
        ACCOUNT,
        DEVICE,
        { kind: 'user', id: ACCOUNT },
        { server: 'notes', tool: 'find', arguments: { q: 'milk' } },
      ],
    ]);
  });

  it('fails a server the device lists with an error, does not list, or a device that is not active', async () => {
    const bridge = deviceBridgeFrom(fakeDevices().svc);
    const target = { accountId: ACCOUNT, deviceId: DEVICE };
    const signal = new AbortController().signal;
    await expect(bridge.list({ ...target, server: 'broken' }, signal)).rejects.toThrow(/no bwrap/);
    await expect(bridge.list({ ...target, server: 'absent' }, signal)).rejects.toThrow(
      /lists no MCP server named absent/,
    );
    await expect(
      deviceBridgeFrom(fakeDevices('pending').svc).list({ ...target, server: 'notes' }, signal),
    ).rejects.toThrow(/not reachable/);
  });

  it('refuses a device that is still waiting for approval', async () => {
    const pending = uuidv7();
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, created_at, updated_at) VALUES (?, ?, 'New', 'client', ?, 'pk', '[]', 'pending', ?, ?)",
      )
      .run(pending, ACCOUNT, `fp-${pending}`, now, now);
    const r = await post({ name: 'p', transport: 'stdio', command: 'x', deviceId: pending });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/not approved/);
  });
});
