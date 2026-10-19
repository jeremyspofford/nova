// M8 flagged carry-ins through the fully wired Hub: an MCP server hosted on a device offers its
// resources and prompts as well as its tools (FR-042, FR-210), reached through novad's
// pass-through under the same `mcp` grant, read as untrusted content and audited.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDevice } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let hubUrl: string;
let cookie: string;
let accountId: string;
const fakes: FakeDevice[] = [];

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nova-hub-flagged-m8-')));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: new MemorySecretStore(),
    events: new EventStore(db),
  });
  hubUrl = await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const code = await hub.auth.issueSetupCode();
  const res = await fetch(`${hubUrl}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  accountId = ((await res.json()) as { accountId: string }).accountId;
  cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
    .split(';')[0]!;
});

afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wire JSON read by the test
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

describe('resources and prompts of a device-hosted MCP server (M8)', () => {
  it('lists them through novad, under the grant', { timeout: 15_000 }, async () => {
    const seen: string[] = [];
    const fake = new FakeDevice({
      mcp: {
        notes: {
          tools: [{ name: 'find' }],
          call: () => ({ hits: 1 }),
          requests: {
            'resources/list': () => {
              seen.push('resources/list');
              return { resources: [{ uri: 'note://7', name: 'Note 7', mimeType: 'text/plain' }] };
            },
            'resources/read': (p) => {
              seen.push(`resources/read ${String(p.uri)}`);
              return { contents: [{ uri: p.uri, mimeType: 'text/plain', text: 'seven' }] };
            },
            'prompts/list': () => ({ prompts: [{ name: 'summarize' }] }),
          },
        },
      },
    });
    fakes.push(fake);
    const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
    expect(t.status).toBe(201);
    await fake.enroll(hubUrl, t.json.token as string);
    const deviceId = fake.deviceId!;
    // The owner grants the account's user the server on the device.
    expect(
      (
        await api('POST', `/api/v1/devices/${deviceId}/grants`, {
          kind: 'mcp',
          grantee: { kind: 'user', id: accountId },
          server: 'notes',
        })
      ).status,
    ).toBe(201);
    const created = await api('POST', '/api/v1/mcp/servers', {
      name: 'notes',
      transport: 'stdio',
      command: 'notes',
      deviceId,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.id as string;

    await vi.waitFor(
      async () => {
        const s = await api('GET', `/api/v1/mcp/servers/${id}`);
        expect(s.json).toMatchObject({
          status: 'connected',
          counts: { tools: 1, resources: 1, prompts: 1 },
        });
      },
      { timeout: 5_000 },
    );
    expect(seen).toContain('resources/list');
    // Listings are not audited (a resource or prompt read is, as `device.mcp.request`).
    expect(
      db.raw
        .prepare("SELECT count(*) AS n FROM audit_event WHERE action = 'device.mcp.request'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it(
    'offers tools alone when the device server has no resources or prompts',
    {
      timeout: 15_000,
    },
    async () => {
      const fake = new FakeDevice({
        mcp: { plain: { tools: [{ name: 'find' }], call: () => ({ hits: 1 }) } },
      });
      fakes.push(fake);
      const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
      await fake.enroll(hubUrl, t.json.token as string);
      await api('POST', `/api/v1/devices/${fake.deviceId!}/grants`, {
        kind: 'mcp',
        grantee: { kind: 'user', id: accountId },
        server: 'plain',
      });
      const created = await api('POST', '/api/v1/mcp/servers', {
        name: 'plain',
        transport: 'stdio',
        command: 'plain',
        deviceId: fake.deviceId!,
      });
      const id = created.json.id as string;
      await vi.waitFor(
        async () => {
          const s = await api('GET', `/api/v1/mcp/servers/${id}`);
          expect(s.json).toMatchObject({
            status: 'connected',
            counts: { tools: 1, resources: 0, prompts: 0 },
          });
        },
        { timeout: 5_000 },
      );
    },
  );
});
