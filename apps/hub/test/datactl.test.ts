// The data controls area on a real Hub (FR-105, FR-116, FR-115, FR-121; ADR-097 D5; J10 step 3):
// export -> delete-all -> import through the API, checked against the archive table by table and
// through the Hub's own routes, with and without a passphrase; refusals write nothing; owner-only;
// a spend cap stops the next chat turn's model call; crash reports and retention.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type SettingKey,
} from '@nova/shared';
import {
  AuditLog,
  DirectRouter,
  EXPORT_ROOTS,
  KEEP_ENTRIES,
  SpendCaps,
  WIPE_ROOTS,
  buildCrashReport,
  dataTables,
  listZip,
  readZipEntry,
  tableLines,
  withSpendCaps,
  writeCrashDump,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { setupDatactl, type DatactlArea } from '../src/datactl.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const HOST = { host: '127.0.0.1:7419' };
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

let dir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let hub: Hub;
let dataApp: FastifyInstance;
let auth: Record<string, string>;
let ownerId: string;
let restarts: number;
let clock: Date | null;
const open: Env[] = [];

interface Env {
  dir: string;
  db: NovaDatabase;
  secrets: MemorySecretStore;
  hub: Hub;
  area: DatactlArea;
  dataApp: FastifyInstance;
  auth: Record<string, string>;
  ownerId: string;
}

/** A Hub after setup, with the data controls area on its own app (the lead wires it in app.ts). */
async function makeEnv(): Promise<Env> {
  const envDir = mkdtempSync(join(tmpdir(), 'nova-hub-datactl-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(envDir, 'data'), NOVA_WEB_DIR: join(envDir, 'noweb') },
    [],
  );
  const envDb = openDatabase({ path: ':memory:' });
  await migrate(envDb);
  const envSecrets = new MemorySecretStore();
  const spend = new SpendCaps({ db: envDb });
  const envHub = await buildHub({
    config,
    db: envDb,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: envSecrets,
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    // The lead's wiring: the router enforces the caps before each model call.
    router: (registry) => withSpendCaps(new DirectRouter(registry), spend),
  });
  const code = await envHub.auth.issueSetupCode();
  const res = await envHub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  const setting = async <K extends SettingKey>(key: K) => {
    const rows = envDb.raw
      .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
      .all() as { key: string; value_json: string }[];
    const global: Record<string, unknown> = {};
    for (const r of rows) global[r.key] = JSON.parse(r.value_json) as unknown;
    return Promise.resolve(resolveSetting(key, { global }).value);
  };
  const ctx = {
    config,
    db: envDb,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    events: envHub.events,
    secrets: envSecrets,
    dataDir: config.dataDir,
    registry: envHub.registry,
    router: envHub.router,
    nodes: envHub.nodes,
    threads: envHub.threads,
    setting,
    accountOf: async (req: { principal?: { accountId: string | null } | null }) => {
      if (!req.principal?.accountId) throw new NovaError('token_required', 'sign in');
      return Promise.resolve(req.principal.accountId);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const envArea = await setupDatactl(ctx, {
    audit: new AuditLog({ db: envDb, events: envHub.events }),
    spend,
    scrypt: FAST,
    restart: () => {
      restarts++;
    },
    sweepCheckMs: 0,
    hubName: () => Promise.resolve('test-hub'),
    now: () => clock ?? new Date(),
  });
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    req.principal = h?.startsWith('Bearer ') ? await envHub.auth.verify(h.slice(7)) : null;
    // Plays a paired device's session (Add Device) for the Hub-only checks.
    if (req.principal && req.headers['x-test-device'])
      req.principal = { ...req.principal, deviceId: 'device-1', scopes: [] };
  });
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  envArea.register(app);
  await app.ready();
  const env: Env = {
    dir: envDir,
    db: envDb,
    secrets: envSecrets,
    hub: envHub,
    area: envArea,
    dataApp: app,
    auth: {
      ...HOST,
      authorization: `Bearer ${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
    },
    ownerId: res.json<Json>().accountId as string,
  };
  open.push(env);
  return env;
}

function use(e: Env): void {
  ({ dir, db, secrets, hub, dataApp, auth, ownerId } = e);
}

beforeEach(async () => {
  restarts = 0;
  clock = null;
  use(await makeEnv());
});

afterEach(async () => {
  for (const e of open.splice(0)) {
    await e.area.close();
    await e.dataApp.close();
    await e.hub.app.close();
    e.db.close();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = auth,
): Promise<{ status: number; json: Json; raw: Buffer }> {
  const app =
    url.startsWith('/api/v1/data') || url.startsWith('/api/v1/usage/') ? dataApp : hub.app;
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Json }),
  });
  const raw = res.rawPayload;
  let json: Json;
  try {
    json = res.json<Json>();
  } catch {
    json = {};
  }
  return { status: res.statusCode, json, raw };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A chat with one exchange and an attachment, a project, a setting and a keyed provider. */
async function makeData(): Promise<string> {
  expect((await api('POST', '/api/v1/projects', { name: 'Garden' })).status).toBe(201);
  expect(
    (await api('PATCH', '/api/v1/settings', { key: 'appearance.theme', value: 'dark' })).status,
  ).toBe(200);
  const p = await api('POST', '/api/v1/providers', {
    provider: 'openai',
    label: 'Work key',
    apiKey: 'sk-proj-abcdefghijklmnop1234',
  });
  expect(p.status).toBe(201);
  const t = await api('POST', '/api/v1/threads', { title: 'Plans' });
  const threadId = t.json.id as string;
  const sent = await api('POST', `/api/v1/threads/${threadId}/messages`, {
    text: 'remember the needle',
    attachments: [
      {
        name: 'note.txt',
        mime: 'text/plain',
        data: Buffer.from('attached words').toString('base64'),
      },
    ],
  });
  expect(sent.status).toBe(202);
  await until(
    () => api('GET', `/api/v1/threads/${threadId}`),
    (r) =>
      (r.json.messages as Json[]).some((m) => m.role === 'assistant' && m.status === 'complete'),
  );
  return threadId;
}

async function upload(bytes: Buffer): Promise<string> {
  const res = await dataApp.inject({
    method: 'POST',
    url: '/api/v1/data/import/upload',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(res.statusCode).toBe(201);
  return res.json<Json>().uploadId as string;
}

/**
 * Every table of the archive compared with the Hub now: equal, except that the logs may have grown
 * and `extra` tables may hold more rows (the importing session).
 */
/** The columns an import turns off or revokes (vet.ts). */
const RESTORED_OFF: Record<string, string[]> = {
  mcp_server: ['enabled'],
  plugin_install: ['enabled'],
  agent_adapter: ['enabled'],
  hook: ['trust_state', 'trusted_hash', 'trusted_by', 'trusted_at'],
  auth_token: ['revoked_at'],
};

function compareWithArchive(archive: Buffer, extra: string[] = []): void {
  const path = join(dir, 'compare.zip');
  writeFileSync(path, archive);
  const tables = new Map(dataTables(db.raw).map((t) => [t.name, t]));
  let compared = 0;
  for (const e of listZip(path, { maxEntries: 1e6, maxTotalBytes: 1e10 })) {
    const m = /^tables\/(.+)\.jsonl$/.exec(e.name);
    if (!m) continue;
    const parts: Buffer[] = [];
    readZipEntry(path, e, (c) => parts.push(Buffer.from(c)));
    let want: unknown[] = Buffer.concat(parts)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => `${l}\n`);
    let have: unknown[] = [...tableLines(db.raw, tables.get(m[1]!)!)];
    // What an import turns off or revokes (vet.ts) is compared without those columns.
    const off = RESTORED_OFF[m[1]!];
    if (off) {
      const drop = (l: unknown) => {
        const o = JSON.parse(l as string) as Record<string, unknown>;
        for (const c of off) delete o[c];
        return JSON.stringify(o);
      };
      have = have.map(drop);
      want = want.map(drop);
    }
    if (m[1] === 'event' || m[1] === 'audit_event')
      expect(have.slice(0, want.length), m[1]).toEqual(want);
    else if (extra.includes(m[1]!)) expect(have, m[1]).toEqual(expect.arrayContaining(want));
    else expect(have, m[1]).toEqual(want);
    compared++;
  }
  expect(compared).toBeGreaterThan(100);
}

describe('export -> delete-all -> import (J10 step 3)', () => {
  it('round-trips the Hub without a passphrase and lists the secrets to re-enter', async () => {
    const threadId = await makeData();
    const ex = await api('POST', '/api/v1/data/export', {});
    expect(ex.status).toBe(200);
    const archive = ex.raw;

    // An import into a Hub with data is refused.
    const early = await upload(archive);
    const busy = await api('POST', '/api/v1/data/import', { uploadId: early, confirm: true });
    expect(busy.status).toBe(409);
    expect(busy.json.error.details.reason).toBe('hub_not_empty');

    expect(
      (await api('POST', '/api/v1/data/delete-all', { confirm: 'wrong-name' })).json.error.details
        .reason,
    ).toBe('confirmation_mismatch');
    const del = await api('POST', '/api/v1/data/delete-all', { confirm: 'TEST-HUB' });
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ restartRequired: true });
    await until(
      () => Promise.resolve(restarts),
      (n) => n === 1,
    );
    const overview = await api('GET', '/api/v1/data');
    expect(overview.json).toMatchObject({ empty: true, blockingTables: [], hubName: 'test-hub' });
    expect((await api('GET', '/api/v1/threads')).json.items).toEqual([]);
    // The deletion's own entry starts the new audit log.
    expect(db.raw.prepare('SELECT seq, action FROM audit_event ORDER BY seq').all()).toEqual([
      { seq: 1, action: 'data.delete_all' },
    ]);

    // A damaged archive is refused and writes nothing.
    // One byte changed inside a table's data.
    const damaged = Buffer.from(archive);
    writeFileSync(join(dir, 'damaged.zip'), archive);
    const entry = listZip(join(dir, 'damaged.zip'), { maxEntries: 1e6, maxTotalBytes: 1e10 }).find(
      (e) => e.name === 'tables/thread.jsonl',
    )!;
    const at =
      entry.offset +
      30 +
      archive.readUInt16LE(entry.offset + 26) +
      archive.readUInt16LE(entry.offset + 28) +
      2;
    damaged[at] = damaged[at]! ^ 0xff;
    const bad = await api('POST', '/api/v1/data/import', {
      uploadId: await upload(damaged),
      confirm: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.reason).toBe('archive_damaged');
    expect((await api('GET', '/api/v1/data')).json.empty).toBe(true);

    const id = await upload(archive);
    const check = await api('POST', '/api/v1/data/import/check', { uploadId: id });
    expect(check.json).toMatchObject({ hubEmpty: true, encrypted: false, migratesFrom: null });
    expect(check.json.toReEnter).toHaveLength(1);
    const imp = await api('POST', '/api/v1/data/import', { uploadId: id, confirm: true });
    expect(imp.status).toBe(200);
    expect(imp.json).toMatchObject({ verified: true, restartRequired: true, secrets: 0 });
    expect(imp.json.keptTables).toContain('trust_identity');
    await until(
      () => Promise.resolve(restarts),
      (n) => n === 2,
    );

    compareWithArchive(archive);
    // The Hub's own routes see everything again; the provider key is to be entered again.
    const thread = await api('GET', `/api/v1/threads/${threadId}`);
    expect(thread.json.thread.title).toBe('Plans');
    expect((await api('GET', '/api/v1/projects')).json.items.map((p: Json) => p.name)).toEqual([
      'Garden',
    ]);
    // The row keeps its reference; the key itself is one to enter again.
    const providers = (await api('GET', '/api/v1/providers')).json.items as Json[];
    const work = providers.find((p) => p.label === 'Work key')!;
    expect(check.json.toReEnter).toEqual([`secret://provider/${work.id as string}/api_key`]);
    expect(await secrets.has(`secret://provider/${work.id as string}/api_key`)).toBe(false);
    const search = await api('GET', '/api/v1/search?q=needle');
    expect(JSON.stringify(search.json)).toContain(threadId);
    const actions = (
      db.raw.prepare('SELECT action FROM audit_event ORDER BY seq').all() as Json[]
    ).map((r) => r.action);
    expect(actions.at(-1)).toBe('data.import');
  });

  it('round-trips with a passphrase: the provider key comes back', async () => {
    await makeData();
    // A sealed export is confirmed with the Hub's name, and never from a paired device.
    const unconfirmed = await api('POST', '/api/v1/data/export/ticket', { passphrase: PASS });
    expect(unconfirmed.json.error.details.reason).toBe('confirmation_mismatch');
    const device = await api(
      'POST',
      '/api/v1/data/export',
      { passphrase: PASS, confirm: 'test-hub' },
      { ...auth, 'x-test-device': '1' },
    );
    expect(device.status).toBe(403);
    expect(device.json.error.details.reason).toBe('hub_only');
    const ticket = await api('POST', '/api/v1/data/export/ticket', {
      passphrase: PASS,
      confirm: 'test-hub',
    });
    const dl = await api(
      'GET',
      `/api/v1/data/export/download?ticket=${ticket.json.ticket as string}`,
    );
    expect(dl.status).toBe(200);
    // One use only.
    expect(
      (await api('GET', `/api/v1/data/export/download?ticket=${ticket.json.ticket as string}`))
        .status,
    ).toBe(404);
    const archive = dl.raw;
    expect(archive.subarray(0, 8).toString()).toBe('NOVAEXP1');
    expect(archive.includes(Buffer.from('sk-proj-abcdefghijklmnop1234'))).toBe(false);

    expect((await api('POST', '/api/v1/data/delete-all', { confirm: 'test-hub' })).status).toBe(
      200,
    );
    const id = await upload(archive);
    const wrong = await api('POST', '/api/v1/data/import', {
      uploadId: id,
      passphrase: 'not it at all',
      confirm: true,
    });
    expect(wrong.json.error.details.reason).toBe('wrong_passphrase');
    expect((await api('GET', '/api/v1/data')).json.empty).toBe(true);
    const imp = await api('POST', '/api/v1/data/import', {
      uploadId: id,
      passphrase: PASS,
      confirm: true,
    });
    expect(imp.status).toBe(200);
    expect(imp.json.keptTables).toEqual([]);
    const providers = (await api('GET', '/api/v1/providers')).json.items as Json[];
    const work = providers.find((p) => p.label === 'Work key')!;
    expect(await secrets.get(`secret://provider/${work.id as string}/api_key`)).toBe(
      'sk-proj-abcdefghijklmnop1234',
    );
  });
});

describe('import into a fresh Hub', () => {
  it('replaces the fresh setup; its owner stays signed in as the archive owner', async () => {
    const a = { ownerId };
    const threadId = await makeData();
    const archive = (await api('POST', '/api/v1/data/export', {})).raw;
    // Another Hub, just set up: only what setup and its own upkeep wrote, so it counts as empty.
    use(await makeEnv());
    expect(ownerId).not.toBe(a.ownerId);
    expect((await api('GET', '/api/v1/data')).json).toMatchObject({
      empty: true,
      blockingTables: [],
    });
    const id = await upload(archive);
    const imp = await api('POST', '/api/v1/data/import', { uploadId: id, confirm: true });
    expect(imp.status).toBe(200);
    compareWithArchive(archive, ['auth_token']);
    const session = await api('GET', '/api/v1/session');
    expect(session.json.accountId).toBe(a.ownerId);
    expect((await api('GET', `/api/v1/threads/${threadId}`)).json.thread.title).toBe('Plans');
    // Its own keys stayed (the archive had no passphrase).
    expect(imp.json.keptTables).toContain('trust_identity');
  });
});

describe('data folders', () => {
  /** Every name a source file joins onto the data folder. */
  function sourceNames(): Set<string> {
    const names = new Set<string>();
    const roots = ['../../../packages/core/src', '../src'].map((r) =>
      fileURLToPath(new URL(r, import.meta.url)),
    );
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.ts'))
          for (const m of readFileSync(p, 'utf8').matchAll(
            /join\(\s*[\w.#()]*[dD]ataDir\s*,\s*'([^']+)'/g,
          ))
            names.add(m[1]!);
      }
    };
    roots.forEach(walk);
    return names;
  }

  it('knows every folder the Hub writes: exported, deleted, or kept on purpose', async () => {
    const known = new Set([...EXPORT_ROOTS, ...WIPE_ROOTS, ...KEEP_ENTRIES]);
    const fromSource = [...sourceNames()];
    expect(fromSource.length).toBeGreaterThan(15);
    expect(fromSource.filter((n) => !known.has(n))).toEqual([]);
    await makeData();
    const onDisk = readdirSync(join(dir, 'data'));
    expect(onDisk.filter((n) => !known.has(n))).toEqual([]);
  });
});

describe('the wiring in app.ts', () => {
  it('quiesces the Hub before delete-all and restarts it after', async () => {
    const config = loadConfig(
      { NOVA_DATA_DIR: join(dir, 'wired'), NOVA_WEB_DIR: join(dir, 'noweb') },
      [],
    );
    const wdb = openDatabase({ path: ':memory:' });
    await migrate(wdb);
    let restarted = 0;
    const wired = await buildHub({
      config,
      db: wdb,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets: new MemorySecretStore(),
      restart: () => {
        restarted++;
      },
    });
    try {
      const code = await wired.auth.issueSetupCode();
      const res = await wired.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: HOST,
        payload: { code },
      });
      const owner = res.json<Json>().accountId as string;
      const h = {
        ...HOST,
        authorization: `Bearer ${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
      };
      const name = (
        await wired.app.inject({ method: 'GET', url: '/api/v1/data', headers: h })
      ).json<Json>().hubName as string;
      const del = await wired.app.inject({
        method: 'POST',
        url: '/api/v1/data/delete-all',
        headers: h,
        payload: { confirm: name },
      });
      expect(del.statusCode).toBe(200);
      await until(
        () => Promise.resolve(restarted),
        (n) => n === 1,
      );
      // Nothing wrote before the deletion's own entry, and no new turn starts until the restart.
      expect(
        wdb.raw.prepare('SELECT seq, action FROM audit_event ORDER BY seq LIMIT 1').get(),
      ).toEqual({
        seq: 1,
        action: 'data.delete_all',
      });
      await expect(
        wired.chat.startTurn({ accountId: owner, threadId: 'x', text: 'hi' } as never),
      ).rejects.toThrow(/shutting down/);
    } finally {
      await wired.app.close();
      wdb.close();
    }
  });
});

describe('access', () => {
  it('needs a session everywhere and the owner under /api/v1/data', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/v1/data'],
      ['POST', '/api/v1/data/export'],
      ['POST', '/api/v1/data/export/ticket'],
      ['GET', '/api/v1/data/export/download?ticket=xxxxxxxxxxxxxxxxxxxxxxxx'],
      ['POST', '/api/v1/data/delete-all'],
      ['POST', '/api/v1/data/import/check'],
      ['POST', '/api/v1/data/import'],
      ['DELETE', '/api/v1/data/import/uploads/x'],
      ['GET', '/api/v1/data/retention'],
      ['POST', '/api/v1/data/retention/sweep'],
      ['GET', '/api/v1/data/crash-reports'],
      ['GET', '/api/v1/data/crash-reports/x/preview'],
      ['POST', '/api/v1/data/crash-reports/x/send'],
      ['DELETE', '/api/v1/data/crash-reports/x'],
      ['DELETE', '/api/v1/data/crash-reports'],
    ];
    for (const [method, url] of [
      ...routes,
      ['GET', '/api/v1/usage/caps'],
      ['PUT', '/api/v1/usage/caps/openai'],
      ['DELETE', '/api/v1/usage/caps/openai'],
      ['GET', '/api/v1/usage/limits'],
      ['POST', '/api/v1/usage/clear'],
    ] as const) {
      const res = await dataApp.inject({
        method: method as 'GET',
        url,
        headers: HOST,
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    const upload = await dataApp.inject({
      method: 'POST',
      url: '/api/v1/data/import/upload',
      headers: { ...HOST, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(upload.statusCode).toBe(401);

    // Another account (a member) is refused under /api/v1/data but keeps its own caps.
    const t = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, created_at, updated_at) VALUES ('member', 'local', ?, ?)",
      )
      .run(t, t);
    db.raw
      .prepare(
        "INSERT INTO team_member (account_id, role, joined_at) VALUES ('member', 'member', ?)",
      )
      .run(t);
    const token = 'nvs_member_session_token_for_tests_only';
    const { hashToken } = await import('@nova/security');
    db.raw
      .prepare(
        "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES ('ms', 'session', ?, 'member', ?)",
      )
      .run(hashToken(token), t);
    const member = { ...HOST, authorization: `Bearer ${token}` };
    for (const [method, url] of routes) {
      const res = await dataApp.inject({
        method: method as 'GET',
        url,
        headers: member,
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const put = await api('PUT', '/api/v1/usage/caps/openai', { limitUsd: 5 }, member);
    expect(put.status).toBe(200);
    expect((await api('GET', '/api/v1/usage/caps')).json.items).toEqual([]);
    expect(ownerId).toBeTruthy();
  });
});

describe('spend caps on a real turn (FR-116)', () => {
  it('stops the next model call at the cap with a clear error; limits list the provider', async () => {
    const put = await api('PUT', '/api/v1/usage/caps/mock', { limitUsd: 0.5, warnAt: 0.5 });
    expect(put.json).toMatchObject({
      provider: 'mock',
      state: 'ok',
      hardStop: true,
      period: 'month',
    });
    expect((await api('PUT', '/api/v1/usage/caps/mock', { limitUsd: -1 })).status).toBe(400);
    db.raw
      .prepare(
        "INSERT INTO usage_event (id, account_id, provider, model, cost_usd, created_at) VALUES ('u1', ?, 'mock', 'm', 0.6, ?)",
      )
      .run(ownerId, new Date().toISOString());
    const t = await api('POST', '/api/v1/threads', {});
    const id = t.json.id as string;
    await api('POST', `/api/v1/threads/${id}/messages`, { text: 'hello' });
    const detail = await until(
      () => api('GET', `/api/v1/threads/${id}`),
      (r) =>
        (r.json.messages as Json[]).some((m) => m.role === 'assistant' && m.status !== 'streaming'),
    );
    const reply = (detail.json.messages as Json[]).find((m) => m.role === 'assistant')!;
    expect(JSON.stringify(reply)).toContain('over_budget');
    expect(JSON.stringify(reply)).toContain('spend cap of $0.50 a month is reached');
    expect((await api('GET', '/api/v1/usage/caps')).json.items[0]).toMatchObject({
      state: 'reached',
    });
    const limits = (await api('GET', '/api/v1/usage/limits')).json.items as Json[];
    expect(limits[0]).toMatchObject({
      provider: 'mock',
      local: true,
      spendCap: { state: 'reached' },
    });
    const notes = db.raw
      .prepare("SELECT name FROM event WHERE name LIKE 'spend.cap.%' ORDER BY id")
      .all();
    expect(notes).toEqual([{ name: 'spend.cap.reached' }]);
    expect(
      (await api('POST', '/api/v1/usage/clear', { confirm: true })).json.removed,
    ).toBeGreaterThan(0);
    expect(db.raw.prepare('SELECT count(*) AS n FROM usage_event').get()).toEqual({ n: 0 });
    expect((await api('GET', '/api/v1/usage/caps')).json.items[0]).toMatchObject({
      state: 'reached',
      spentUsd: 0.6,
    });
    expect((await api('DELETE', '/api/v1/usage/caps/mock')).status).toBe(200);
    expect((await api('DELETE', '/api/v1/usage/caps/mock')).status).toBe(404);
  });
});

describe('crash reports and retention', () => {
  let server: Server;
  let received: string[];
  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(body);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('lists, previews, sends only when on, deletes', async () => {
    const report = buildCrashReport(new Error('boom'), 'uncaughtException', {
      dataDir: join(dir, 'data'),
      version: '0.8.0',
    });
    writeCrashDump(join(dir, 'data'), report);
    const list = await api('GET', '/api/v1/data/crash-reports');
    expect(list.json).toMatchObject({
      enabled: false,
      endpoint: null,
      items: [{ id: report.id, sentAt: null }],
    });
    const refused = await api('POST', `/api/v1/data/crash-reports/${report.id}/send`);
    expect(refused.status).toBe(403);
    expect(received).toEqual([]);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/c`;
    await api('PATCH', '/api/v1/settings', { key: 'privacy.crashReports', value: true });
    await api('PATCH', '/api/v1/settings', { key: 'privacy.crashReportEndpoint', value: url });
    const preview = await api('GET', `/api/v1/data/crash-reports/${report.id}/preview`);
    expect(preview.json).toMatchObject({ wouldSend: true, endpoint: url });
    expect((await api('POST', `/api/v1/data/crash-reports/${report.id}/send`)).status).toBe(200);
    expect(received).toEqual([preview.json.body]);
    expect(
      (
        await api('PATCH', '/api/v1/settings', {
          key: 'privacy.crashReportEndpoint',
          value: 'http://example.com/x',
        })
      ).status,
    ).toBe(400);
    expect((await api('DELETE', `/api/v1/data/crash-reports/${report.id}`)).status).toBe(200);
    expect((await api('GET', `/api/v1/data/crash-reports/${report.id}/preview`)).status).toBe(404);
  });

  it('sweeps with the retention settings; the audit floor holds', async () => {
    const threadId = await makeData();
    expect(
      (await api('PATCH', '/api/v1/settings', { key: 'retention.auditDays', value: 30 })).status,
    ).toBe(400);
    expect(
      (await api('PATCH', '/api/v1/settings', { key: 'retention.threadsDays', value: 7 })).status,
    ).toBe(200);
    let view = await api('GET', '/api/v1/data/retention');
    expect(view.json.items.find((i: Json) => i.item === 'threads')).toMatchObject({
      days: 7,
      due: 0,
    });
    clock = new Date(Date.now() + 10 * 86_400_000);
    view = await api('GET', '/api/v1/data/retention');
    expect(view.json.items.find((i: Json) => i.item === 'threads')).toMatchObject({ due: 1 });
    const sweep = await api('POST', '/api/v1/data/retention/sweep');
    expect(sweep.json).toMatchObject({ trigger: 'manual', removed: { threads: 1 }, error: null });
    expect((await api('GET', `/api/v1/threads/${threadId}`)).status).toBe(404);
    expect((await api('GET', '/api/v1/data/retention')).json.lastSweep).toMatchObject({
      id: sweep.json.id,
    });
  });
});
