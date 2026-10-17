// MCP bundles through the Hub (FR-199; docs/08 §2.5): preview with validation errors, the
// sideload rule for unverified bundles, install with sensitive settings in the vault only, the
// install record and confirmed permissions, the server running the sample bundle, update keeping
// the previous version, name conflicts and removal. Archives are built in memory.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { uuidv7, type BundlePreview, type McpServerView } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { sampleZip, zipOf } from '../../../packages/mcp/test/bundle-fixture.ts';

const HOST = { host: '127.0.0.1:7419' };
const KEY = 'sk-sample-0123456789abcdef';

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let secrets: MemorySecretStore;
let hub: Hub;
let cookie: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-bundles-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  secrets = new MemorySecretStore();
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets,
    events: new EventStore(db),
  });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code },
  });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, url: string, payload?: unknown, auth = true) {
  const res = await hub.app.inject({
    method: method as 'GET',
    url,
    headers: { ...HOST, ...(auth ? { cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null };
}

const upload = (bytes: Uint8Array, name = 'hello.mcpb') =>
  api('POST', '/api/v1/mcp/bundles/preview', { name, data: Buffer.from(bytes).toString('base64') });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function install(
  over?: Parameters<typeof sampleZip>[0],
  userConfig: Record<string, unknown> = {},
) {
  const preview = (await upload(sampleZip(over))).json as BundlePreview;
  return api('POST', '/api/v1/mcp/bundles/install', {
    previewId: preview.previewId,
    permissions: { network: [], fs: 'read' },
    userConfig,
    confirmSideload: true,
  });
}

describe('bundle preview', () => {
  it('requires a session', async () => {
    expect((await api('POST', '/api/v1/mcp/bundles/preview', {}, false)).status).toBe(401);
    expect((await api('POST', '/api/v1/mcp/bundles/install', {}, false)).status).toBe(401);
  });

  it('describes the bundle, its settings, proposed permissions and warnings', async () => {
    const r = await upload(sampleZip());
    expect(r.status).toBe(200);
    const p = r.json as BundlePreview;
    expect(p).toMatchObject({
      name: 'nova-hello',
      displayName: 'Hello (sample bundle)',
      version: '1.0.0',
      author: 'Nova contributors',
      serverType: 'node',
      signature: 'unverified',
      permissions: { network: [], fs: 'read' },
      tools: [
        { name: 'greet', description: 'Greet someone by name' },
        { name: 'settings_check', description: 'Report which settings are set' },
      ],
    });
    expect(p.userConfig.map((f) => [f.key, f.type, f.sensitive])).toEqual([
      ['greeting', 'string', false],
      ['api_key', 'string', true],
      ['notes_dir', 'directory', false],
    ]);
    expect(p.warnings).toContain('the bundle is not signed; installing it needs your confirmation');
  });

  it('refuses bad uploads with errors that say what is wrong', async () => {
    const cases: [unknown, RegExp][] = [
      [{ name: 'x.mcpb' }, /validation/],
      [{ name: 'x.mcpb', data: '!!!not base64!!!' }, /base64/],
      [{ name: 'x.mcpb', data: Buffer.from('plain text').toString('base64') }, /not a valid zip/],
    ];
    for (const [body, msg] of cases) {
      const r = await api('POST', '/api/v1/mcp/bundles/preview', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(`${r.json.error.code} ${r.json.error.message}`).toMatch(msg);
    }
    const traversal = await upload(
      sampleZip((files) => void (files['../../escape.txt'] = new Uint8Array(1))),
    );
    expect(traversal.status).toBe(400);
    expect(traversal.json.error.message).toMatch(/unsafe path/);
    const version = await upload(sampleZip((_f, m) => void (m.manifest_version = '9.9')));
    expect(version.json.error.message).toMatch(/manifest version 9.9 is not supported/);
    const noManifest = await upload(zipOf({ 'server/index.mjs': '' }));
    expect(noManifest.json.error.message).toMatch(/no manifest.json/);
    expect(existsSync(join(config.dataDir, 'mcp', 'previews'))).toBe(false);
  });
});

describe('bundle install', () => {
  it('needs an explicit sideload confirmation for an unverified bundle', async () => {
    const p = (await upload(sampleZip())).json as BundlePreview;
    const body = { previewId: p.previewId, permissions: { network: [], fs: 'none' } };
    const r = await api('POST', '/api/v1/mcp/bundles/install', body);
    expect(r.status).toBe(400);
    expect(r.json.error.details).toMatchObject({ reason: 'sideload_confirmation_required' });
    expect(
      (await api('POST', '/api/v1/mcp/bundles/install', { ...body, confirmSideload: false }))
        .status,
    ).toBe(400);
    expect(
      (
        await api('POST', '/api/v1/mcp/bundles/install', {
          ...body,
          previewId: uuidv7(),
          confirmSideload: true,
        })
      ).status,
    ).toBe(404);
    expect((await api('GET', '/api/v1/mcp/servers')).json.items).toEqual([]);
  });

  it('installs: settings in the vault, the install record, and a running server', async () => {
    const r = await install(undefined, {
      greeting: 'Howdy',
      api_key: KEY,
      notes_dir: '/srv/notes',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const v = r.json as McpServerView;
    expect(v).toMatchObject({
      name: 'nova-hello',
      transport: 'stdio',
      bundle: { name: 'nova-hello', version: '1.0.0', signature: 'unverified' },
      defaultApproval: 'ask',
      envKeys: ['HELLO_API_KEY', 'HELLO_GREETING', 'HELLO_NOTES_DIR'],
    });
    expect(v.args[0]).toMatch(/mcp\/bundles\/nova-hello\/1\.0\.0\/server\/index\.mjs$/);
    expect(
      existsSync(
        join(config.dataDir, 'mcp', 'bundles', 'nova-hello', '1.0.0', 'server', 'index.mjs'),
      ),
    ).toBe(true);
    // The key is only in the vault.
    expect(await secrets.get(`secret://mcp/${v.id}/env/HELLO_API_KEY`)).toBe(KEY);
    expect(await secrets.get(`secret://mcp/${v.id}/config/api_key`)).toBe(KEY);
    const row = db.raw.prepare('SELECT * FROM mcp_server WHERE id = ?').get(v.id) as Record<
      string,
      string
    >;
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(row.source).toBe('bundle');
    expect(row.signature_status).toBe('unverified');
    expect(row.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(row.install_record_json!)).toMatchObject({
      serverId: v.id,
      sha256: row.bundle_sha256,
      source: 'file',
      signature: 'unverified',
      permissions: {
        network: [],
        fs: [{ path: '/srv/notes', access: 'read' }],
        secrets: [`secret://mcp/${v.id}/config/api_key`],
      },
      userConfig: {
        greeting: 'Howdy',
        api_key: `secret://mcp/${v.id}/config/api_key`,
        notes_dir: '/srv/notes',
      },
      enabled: true,
    });
    const connected = await waitFor(async () => {
      const s = (await api('GET', `/api/v1/mcp/servers/${v.id}`)).json as McpServerView;
      return s.status === 'connected' ? s : null;
    });
    expect(connected.connectedAt).not.toBeNull();
    expect(connected.restarts).toBe(0);
    // The tools run with the settings: the greeting and the key reach the process. The user runs
    // them from settings (`initiator: 'user'`), with their defaults set to allow.
    for (const tool of ['mcp:nova-hello.greet', 'mcp:nova-hello.settings_check'])
      await api('PUT', '/api/v1/tool-defaults', { tool, default: 'allow' });
    const greet = await api('POST', '/api/v1/tools/mcp:nova-hello.greet/invoke', {
      args: { name: 'Ada' },
      initiator: 'user',
    });
    expect(greet.json).toMatchObject({ ok: true });
    expect(greet.json.text).toContain('Howdy, Ada!');
    const key = await api('POST', '/api/v1/tools/mcp:nova-hello.settings_check/invoke', {
      args: {},
      initiator: 'user',
    });
    expect(key.json.text).toContain(`an API key is set (${KEY.length} characters)`);
    expect(
      JSON.stringify((await api('GET', `/api/v1/mcp/servers/${v.id}/logs`)).json),
    ).not.toContain(KEY);
    const events = (await api('GET', '/api/v1/events?limit=500')).json.events as {
      name: string;
      payload: Record<string, unknown>;
    }[];
    expect(events.find((e) => e.name === 'mcp.bundle.installed')!.payload).toEqual({
      serverId: v.id,
      name: 'nova-hello',
      signature: 'unverified',
    });
    const audit = (await api('GET', '/api/v1/audit?limit=200')).json.items as {
      action: string;
      resource: string;
    }[];
    expect(audit.find((a) => a.action === 'bundle.install')!.resource).toBe(`mcp_server:${v.id}`);
  });

  it('validates the settings against the bundle', async () => {
    const p = (await upload(sampleZip())).json as BundlePreview;
    const r = await api('POST', '/api/v1/mcp/bundles/install', {
      previewId: p.previewId,
      permissions: { network: [], fs: 'read' },
      userConfig: { notes_dir: 'relative/path' },
      confirmSideload: true,
    });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/absolute path/);
  });

  it('refuses a bundle that cannot run on this Hub', async () => {
    const other = (['darwin', 'linux', 'win32'] as const).filter((p) => p !== process.platform);
    const bytes = sampleZip((_f, m) => void (m.compatibility = { platforms: other }));
    const p = (await upload(bytes)).json as BundlePreview;
    expect(p.warnings.join(' ')).toMatch(/does not support/);
    const r = await api('POST', '/api/v1/mcp/bundles/install', {
      previewId: p.previewId,
      permissions: { network: [], fs: 'none' },
      confirmSideload: true,
    });
    expect(r.status).toBe(400);
    expect(existsSync(join(config.dataDir, 'mcp', 'bundles', 'nova-hello', '1.0.0'))).toBe(false);
  });

  it('updates in place, keeps the previous version, and removes everything on delete', async () => {
    const first = (await install()).json as McpServerView;
    const second = await install((_f, m) => void (m.version = '1.1.0'), { api_key: KEY });
    expect(second.status).toBe(201);
    expect(second.json).toMatchObject({ id: first.id, bundle: { version: '1.1.0' } });
    expect(existsSync(join(config.dataDir, 'mcp', 'bundles', 'nova-hello', '1.0.0'))).toBe(true);
    expect(existsSync(join(config.dataDir, 'mcp', 'bundles', 'nova-hello', '1.1.0'))).toBe(true);
    expect((await api('GET', '/api/v1/mcp/servers')).json.items).toHaveLength(1);
    const audit = (await api('GET', '/api/v1/audit?limit=200')).json.items as { action: string }[];
    expect(audit.some((a) => a.action === 'bundle.update')).toBe(true);
    expect((await api('DELETE', `/api/v1/mcp/servers/${first.id}`)).json).toEqual({ ok: true });
    expect(existsSync(join(config.dataDir, 'mcp', 'bundles', 'nova-hello'))).toBe(false);
    expect(await secrets.list(`secret://mcp/${first.id}/`)).toEqual([]);
  });

  it('refuses a name that another server already uses', async () => {
    const user = await api('POST', '/api/v1/mcp/servers', {
      name: 'nova-hello',
      transport: 'stdio',
      command: process.execPath,
      enabled: false,
    });
    expect(user.status).toBe(201);
    const p = (await upload(sampleZip())).json as BundlePreview;
    expect(p.warnings.join(' ')).toMatch(/already exists/);
    const r = await api('POST', '/api/v1/mcp/bundles/install', {
      previewId: p.previewId,
      permissions: { network: [], fs: 'none' },
      confirmSideload: true,
    });
    expect(r.status).toBe(409);
  });

  it('never lets a session point a server at a vault reference', async () => {
    const r = await api('POST', '/api/v1/mcp/servers', {
      name: 'sneaky',
      transport: 'stdio',
      command: process.execPath,
      args: ['secret://provider/p1/api_key'],
    });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not a secret reference/);
  });
});
