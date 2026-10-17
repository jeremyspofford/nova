// The computers area routes (FR-080, FR-102, FR-193): computers with snapshots, restore and stop;
// the per-scope network policy of Settings > Network; proxy credentials whose values are
// write-only; and the network decision log read from the audit. Every route needs a session and
// is account-scoped; bad bodies are `validation`.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError } from '@nova/shared';
import {
  AuditLog,
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  classifyAddress,
  type AuditRecord,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupComputers, type ComputersArea } from '../src/computers.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000aa';
const OTHER = '01920000-0000-7000-8000-0000000000bb';
const AGENT = '01920000-0000-7000-8000-0000000000a1';
const THREAD = '01920000-0000-7000-8000-0000000000d1';
const AUTH = { 'x-test-account': ACCOUNT };
const AUTH_OTHER = { 'x-test-account': OTHER };

class FakeSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly requests: ExecRequest[] = [];
  available() {
    return Promise.resolve({ ok: true, detail: 'fake' });
  }
  exec(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    return Promise.resolve({ status: 'exited', exitCode: 0, output: 'ok' });
  }
  poll(sessionId: string): Promise<ExecResult> {
    return Promise.resolve({ status: 'running', sessionId, output: '' });
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
}

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let upstream: Server;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-computers-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  db.raw
    .prepare(
      `INSERT INTO agent (id, account_id, name, time_budget_s, token_budget, created_at, updated_at)
       VALUES (?, ?, 'Researcher', 3600, 100000, ?, ?)`,
    )
    .run(AGENT, ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO agent_thread (thread_id, agent_id, account_id, kind, created_at) VALUES (?, ?, ?, 'main', ?)",
    )
    .run(THREAD, AGENT, ACCOUNT, now);
  upstream = createServer((req, res) => res.end(`auth=${String(req.headers.authorization)}`));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const a = upstream.address();
  port = typeof a === 'object' && a ? a.port : 0;
});
afterEach(async () => {
  await new Promise((r) => upstream.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Env {
  app: FastifyInstance;
  area: ComputersArea;
  audit: AuditRecord[];
  events: EventStore;
  secrets: MemorySecretStore;
  sandbox: FakeSandbox;
  settings: Record<string, unknown>;
}

async function env(opts: { auditLog?: boolean } = {}): Promise<Env> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const registry = new ProviderRegistry({ db, secrets });
  const router = new DirectRouter(registry);
  const settings: Record<string, unknown> = {
    'network.egressMode': 'allowlist',
    'network.egressAllow': ['pypi.org'],
    'network.egressDeny': [],
    'computers.agentComputer': 'local_container',
    'computers.limits': { cpus: 2, memoryMb: 2048, wallClockSeconds: 300 },
    'computers.microVm': { enabled: false, runner: null },
  };
  const ctx = {
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    events,
    secrets,
    dataDir: config.dataDir,
    registry,
    router,
    nodes: new NodeService({ db, secrets, events }),
    threads: new ThreadService({ db, router, events }),
    setting: (key: string) => Promise.resolve(settings[key]),
    accountOf: (req: { headers: Record<string, unknown> }) => {
      const id = req.headers['x-test-account'];
      if (id !== ACCOUNT && id !== OTHER)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(id);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const audit: AuditRecord[] = [];
  const sandbox = new FakeSandbox();
  const area = await setupComputers({
    ...ctx,
    // The real audit log stores decisions for the decision log; the list records the rest.
    audit: opts.auditLog
      ? new AuditLog({ db, events })
      : { append: (r) => Promise.resolve(void audit.push(r)) },
    sandbox,
    proxy: {
      socketDir: join(dir, 's'),
      resolve: (h) => Promise.resolve(h === 'api.test' ? ['127.0.0.1'] : []),
      classify: (x) => (x === '127.0.0.1' ? 'public' : classifyAddress(x)),
    },
  });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return { app, area, audit, events, secrets, sandbox, settings };
}

let e: Env;
afterEach(async () => {
  await e.app.close();
  await e.area.close();
});

describe('computer routes', () => {
  it('lists, snapshots, restores and stops an agent computer', async () => {
    e = await env();
    expect((await e.app.inject({ method: 'GET', url: '/api/v1/computers' })).statusCode).toBe(401);
    const c = await e.area.service.forAgent(ACCOUNT, AGENT);
    await c.fs.write('notes.md', Buffer.from('v1'));
    const list = await e.app.inject({ method: 'GET', url: '/api/v1/computers', headers: AUTH });
    expect(list.json().items).toEqual([
      expect.objectContaining({
        id: c.id,
        kind: 'local_container',
        agentId: AGENT,
        state: 'running',
      }),
    ]);
    expect(
      (await e.app.inject({ method: 'GET', url: '/api/v1/computers', headers: AUTH_OTHER })).json()
        .items,
    ).toEqual([]);
    expect(
      (await e.app.inject({ method: 'GET', url: `/api/v1/computers/${c.id}`, headers: AUTH_OTHER }))
        .statusCode,
    ).toBe(404);
    const snap = await e.app.inject({
      method: 'POST',
      url: `/api/v1/computers/${c.id}/snapshots`,
      headers: AUTH,
      payload: { label: 'first' },
    });
    expect(snap.statusCode).toBe(201);
    expect(snap.json()).toMatchObject({ computerId: c.id, label: 'first' });
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: `/api/v1/computers/${c.id}/snapshots`,
          headers: AUTH,
          payload: { label: 'x', extra: 1 },
        })
      ).statusCode,
    ).toBe(400);
    await c.fs.write('notes.md', Buffer.from('v2'));
    const restored = await e.app.inject({
      method: 'POST',
      url: `/api/v1/computers/${c.id}/restore`,
      headers: AUTH,
      payload: { snapshotId: snap.json().id },
    });
    expect(restored.statusCode).toBe(200);
    expect(Buffer.from(await c.fs.read('notes.md')).toString()).toBe('v1');
    const snaps = await e.app.inject({
      method: 'GET',
      url: `/api/v1/computers/${c.id}/snapshots`,
      headers: AUTH,
    });
    expect(snaps.json().items).toHaveLength(1);
    const stop = await e.app.inject({
      method: 'POST',
      url: `/api/v1/computers/${c.id}/stop`,
      headers: AUTH,
    });
    expect(stop.json().state).toBe('stopped');
    const del = await e.app.inject({
      method: 'DELETE',
      url: `/api/v1/computers/${c.id}/snapshots/${snap.json().id}`,
      headers: AUTH,
    });
    expect(del.json()).toEqual({ ok: true });
    expect(
      (
        await e.app.inject({
          method: 'DELETE',
          url: `/api/v1/computers/${c.id}/snapshots/${snap.json().id}`,
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(404);
    expect(e.audit.filter((a) => a.kind === 'computer').map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'computer.create',
        'computer.snapshot',
        'computer.restore',
        'computer.stop',
        'computer.snapshot.delete',
      ]),
    );
    const names = (
      db.raw.prepare('SELECT name FROM event ORDER BY id').all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'computer.state.changed',
        'computer.snapshot.created',
        'computer.restored',
      ]),
    );
  });

  it("routes an agent thread's commands to its computer", async () => {
    e = await env();
    const routed = e.area.router(e.area.sandbox);
    await routed.exec({
      cmd: 'ls',
      cwd: '/x',
      roots: [],
      network: 'off',
      yieldMs: 10,
      signal: new AbortController().signal,
      owner: { accountId: ACCOUNT, threadId: THREAD, turnId: 't', callId: null },
    } as ExecRequest);
    const req = e.sandbox.requests.at(-1)!;
    expect(req.roots[0]?.label).toBe('computer');
    expect(req.env?.HOME).toBe(req.roots[0]?.path);
    expect((await e.area.threadPolicy.forThread(ACCOUNT, THREAD))?.roots).toHaveLength(1);
  });
});

describe('network policy routes', () => {
  it('shows the global policy and per-scope grants, and validates patterns', async () => {
    e = await env();
    const view = await e.app.inject({ method: 'GET', url: '/api/v1/egress', headers: AUTH });
    expect(view.json()).toMatchObject({
      global: { mode: 'allowlist', allow: ['pypi.org'], deny: [] },
      scopes: [],
      inspection: { https: true },
    });
    expect(view.json().inspection.caCertPem).toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(view.json())).not.toContain('PRIVATE KEY');
    const pem = await e.app.inject({ method: 'GET', url: '/api/v1/egress/ca.pem', headers: AUTH });
    expect(pem.headers['content-type']).toContain('application/x-pem-file');
    expect(pem.body).toContain('BEGIN CERTIFICATE');
    const put = await e.app.inject({
      method: 'PUT',
      url: `/api/v1/egress/scopes/agent/${AGENT}`,
      headers: AUTH,
      payload: {
        mode: 'limited',
        allow: ['API.Test.', '*.example.com'],
        deny: ['bad.example.com'],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      kind: 'agent',
      id: AGENT,
      mode: 'limited',
      allow: ['api.test', '*.example.com'],
    });
    for (const allow of [['*'], ['a.*.com'], ['*.com'], ['bad host']]) {
      const r = await e.app.inject({
        method: 'PUT',
        url: `/api/v1/egress/scopes/agent/${AGENT}`,
        headers: AUTH,
        payload: { allow },
      });
      expect(r.statusCode, allow[0]).toBe(400);
    }
    expect(
      (
        await e.app.inject({
          method: 'PUT',
          url: `/api/v1/egress/scopes/nope/${AGENT}`,
          headers: AUTH,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await e.app.inject({ method: 'GET', url: '/api/v1/egress', headers: AUTH })).json().scopes,
    ).toHaveLength(1);
    expect(
      (await e.app.inject({ method: 'GET', url: '/api/v1/egress', headers: AUTH_OTHER })).json()
        .scopes,
    ).toEqual([]);
    const del = await e.app.inject({
      method: 'DELETE',
      url: `/api/v1/egress/scopes/agent/${AGENT}`,
      headers: AUTH,
    });
    expect(del.json()).toEqual({ ok: true });
    expect(
      (
        await e.app.inject({
          method: 'DELETE',
          url: `/api/v1/egress/scopes/agent/${AGENT}`,
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(404);
    expect(e.audit.map((a) => [a.kind, a.action])).toEqual(
      expect.arrayContaining([
        ['settings', 'egress.scope.set'],
        ['settings', 'egress.scope.delete'],
      ]),
    );
  });

  it('keeps credential values write-only and in the vault', async () => {
    e = await env();
    const created = await e.app.inject({
      method: 'POST',
      url: '/api/v1/egress/credentials',
      headers: AUTH,
      payload: { name: 'Mock API', hosts: ['api.test'], scheme: 'bearer', value: 'tok-abcdef123' },
    });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(JSON.stringify(c)).not.toContain('tok-abcdef123');
    expect(await e.secrets.get(c.secretRef)).toBe('tok-abcdef123');
    const list = await e.app.inject({
      method: 'GET',
      url: '/api/v1/egress/credentials',
      headers: AUTH,
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.body).not.toContain('tok-abcdef123');
    for (const payload of [
      { name: 'x', hosts: ['api.test'], scheme: 'header', value: 'v' },
      { name: 'x', hosts: ['*'], scheme: 'bearer', value: 'v' },
      { name: 'x', hosts: ['api.test'], scheme: 'bearer' },
      { name: 'x', hosts: ['api.test'], scheme: 'header', header: 'Host', value: 'v' },
    ]) {
      const r = await e.app.inject({
        method: 'POST',
        url: '/api/v1/egress/credentials',
        headers: AUTH,
        payload,
      });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const patched = await e.app.inject({
      method: 'PATCH',
      url: `/api/v1/egress/credentials/${c.id}`,
      headers: AUTH,
      payload: { value: 'tok-rotated99', hosts: ['api.test', '*.api.test'] },
    });
    expect(patched.json().hosts).toEqual(['api.test', '*.api.test']);
    expect(await e.secrets.get(c.secretRef)).toBe('tok-rotated99');
    expect(
      (
        await e.app.inject({
          method: 'PATCH',
          url: `/api/v1/egress/credentials/${c.id}`,
          headers: AUTH,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await e.app.inject({
          method: 'PATCH',
          url: `/api/v1/egress/credentials/${c.id}`,
          headers: AUTH_OTHER,
          payload: { name: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    const del = await e.app.inject({
      method: 'DELETE',
      url: `/api/v1/egress/credentials/${c.id}`,
      headers: AUTH,
    });
    expect(del.json()).toEqual({ ok: true });
    expect(await e.secrets.has(c.secretRef)).toBe(false);
    expect(e.audit.filter((a) => a.kind === 'secret').map((a) => a.action)).toEqual([
      'egress.credential.create',
      'egress.credential.update',
      'egress.credential.delete',
    ]);
    expect(JSON.stringify(e.audit)).not.toContain('tok-');
  });

  it('serves the network decision log from the audit', async () => {
    e = await env({ auditLog: true });
    await e.area.store.createCredential(ACCOUNT, {
      name: 'Mock API',
      hosts: ['api.test'],
      scheme: 'bearer',
      value: 'tok-decisions1',
    });
    e.settings['network.egressAllow'] = ['api.test'];
    const session = await e.area.egress.open({
      accountId: ACCOUNT,
      threadId: THREAD,
      network: 'allowlist',
      scope: null,
    });
    const p = new URL(session!.proxyUrl);
    const get = (url: string) =>
      new Promise<string>((resolve, reject) => {
        const r = request(
          {
            host: p.hostname,
            port: Number(p.port),
            path: url,
            headers: {
              host: new URL(url).host,
              'proxy-authorization': `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`,
            },
          },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += String(c)));
            res.on('end', () => resolve(`${res.statusCode} ${body}`));
          },
        );
        r.on('error', reject);
        r.end();
      });
    // The upstream saw the credential; the response the sandbox gets has it masked.
    expect(await get(`http://api.test:${port}/private/path`)).toMatch(/^200 auth=Bearer \*+$/);
    expect(await get(`http://evil.test:${port}/`)).toMatch(/^403/);
    await session!.close();
    const all = await e.app.inject({
      method: 'GET',
      url: '/api/v1/egress/decisions',
      headers: AUTH,
    });
    const items = all.json().items;
    expect(items.map((i: { decision: string; host: string }) => [i.decision, i.host])).toEqual([
      ['deny', 'evil.test'],
      ['allow', 'api.test'],
    ]);
    expect(items[0]).toMatchObject({ cause: 'allowlist', scope: { kind: 'agent', id: AGENT } });
    expect(items[1]).toMatchObject({ status: 200, method: 'GET', port, mode: 'allowlist' });
    expect(all.body).not.toContain('/private/path');
    const denied = await e.app.inject({
      method: 'GET',
      url: '/api/v1/egress/decisions?decision=deny',
      headers: AUTH,
    });
    expect(denied.json().items).toHaveLength(1);
    const byHost = await e.app.inject({
      method: 'GET',
      url: '/api/v1/egress/decisions?host=api.test&limit=5',
      headers: AUTH,
    });
    expect(byHost.json().items).toHaveLength(1);
    expect(
      (
        await e.app.inject({ method: 'GET', url: '/api/v1/egress/decisions', headers: AUTH_OTHER })
      ).json().items,
    ).toEqual([]);
    expect(
      (
        await e.app.inject({
          method: 'GET',
          url: '/api/v1/egress/decisions?limit=0',
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(400);
  });
});
