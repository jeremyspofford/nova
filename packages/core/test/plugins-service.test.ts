// The plugin installer (FR-045, docs/08 §3.2): preview without side effects, install into
// `<dataDir>/plugins/<id>/<version>`, servers as `mcp_server` rows (source plugin) with env in the
// vault, skills and converted commands, roles, hooks handed over with their hashes, update,
// enable/disable, uninstall, audit and events, and the permission lookup for the gate.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { ToolDescriptor } from '@nova/shared';
import {
  MemoryEventSink,
  PluginCatalogs,
  PluginService,
  SkillIndex,
  type AuditRecord,
  type PluginHookChange,
  type PluginServerRow,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
const SAMPLE_CATALOG = fileURLToPath(new URL('../../../examples/catalog/', import.meta.url));

let dir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let applied: PluginServerRow[];
let removed: string[];
let now: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-plugins-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const ts = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, ts, ts);
  secrets = new MemorySecretStore();
  events = new MemoryEventSink();
  audit = [];
  applied = [];
  removed = [];
  now = Date.parse('2026-10-17T08:00:00Z');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function services(over: Partial<ConstructorParameters<typeof PluginService>[0]> = {}) {
  const skills = new SkillIndex({ db, userDir: join(dir, 'data', 'skills'), events });
  const service = new PluginService({
    db,
    secrets,
    dataDir: join(dir, 'data'),
    catalogs: new PluginCatalogs({ cacheDir: join(dir, 'cache') }),
    catalogConfigs: () =>
      Promise.resolve([{ id: 'sample', name: 'Sample', location: SAMPLE_CATALOG }]),
    servers: {
      apply: (row) => {
        applied.push(row);
        return Promise.resolve();
      },
      remove: (id) => {
        removed.push(id);
        return Promise.resolve();
      },
    },
    skills,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    novaVersion: '0.5.0',
    nodePath: '/opt/nova/node_modules',
    log: new Logger({ module: 'test', sinks: [] }),
    now: () => new Date(now),
    ...over,
  });
  return { service, skills };
}

/** A copy of the sample plugin that a test may edit. */
function samplePlugin(name = 'sample'): string {
  const root = join(dir, 'src', name);
  cpSync(join(SAMPLE_CATALOG, 'sample-plugin'), root, { recursive: true });
  return root;
}

function setVersion(
  root: string,
  version: string,
  edit: (m: Record<string, unknown>) => void = () => undefined,
) {
  const file = join(root, '.nova-plugin', 'plugin.json');
  const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  m.version = version;
  edit(m);
  writeFileSync(file, JSON.stringify(m, null, 2));
}

const tool = (over: Partial<ToolDescriptor>): ToolDescriptor => ({
  name: 'mcp:sample.fetch_status',
  title: 'Fetch status',
  description: '',
  source: 'mcp',
  inputSchema: { type: 'object' },
  ...over,
});

describe('preview', () => {
  it('describes the plugin without installing or registering anything', async () => {
    const { service, skills } = services();
    const root = samplePlugin();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: root });
    expect(p).toMatchObject({
      verified: false,
      replaces: null,
      permissions: { network: ['api.example.com'] },
      mcpServers: [{ name: 'sample', transport: 'stdio', command: 'node', url: null }],
      skills: [
        { name: 'summarize-notes', description: expect.stringContaining('Summarize notes') },
        { name: 'greet', description: 'Greet someone warmly by name in one short sentence.' },
      ],
    });
    expect(p.hooks).toEqual([
      expect.objectContaining({
        id: 'hook:com.example.sample.check-fetch',
        source: 'plugin',
        pluginId: 'com.example.sample',
        event: 'tool.pre',
        matcher: 'mcp:sample.fetch_status, plugin:com.example.sample.fetch_status',
        handler: { type: 'command', command: ['node', 'hooks/check.mjs'] },
        timeoutMs: 10000,
        status: 'needs_trust',
        contentHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(p.warnings[0]).toMatch(/^Unverified/);
    expect(existsSync(join(dir, 'data'))).toBe(false);
    expect(await db.orm.select().from(schema.pluginInstall)).toEqual([]);
    expect(await db.orm.select().from(schema.mcpServer)).toEqual([]);
    expect(await skills.list(ACCOUNT)).toEqual([]);
    expect(events.events).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('refuses a missing folder, a file and an invalid plugin', async () => {
    const { service } = services();
    await expect(
      service.preview(ACCOUNT, { kind: 'path', path: join(dir, 'nope') }),
    ).rejects.toMatchObject({ code: 'validation' });
    writeFileSync(join(dir, 'file'), 'x');
    await expect(
      service.preview(ACCOUNT, { kind: 'path', path: join(dir, 'file') }),
    ).rejects.toThrow(/not a folder/);
    const root = samplePlugin();
    setVersion(root, 'one');
    await expect(service.preview(ACCOUNT, { kind: 'path', path: root })).rejects.toThrow(/version/);
    await expect(
      service.preview(ACCOUNT, { kind: 'catalog', catalogId: 'nope', pluginId: 'x.y' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('previews from a catalog and expires after 30 minutes', async () => {
    const { service } = services();
    const p = await service.preview(ACCOUNT, {
      kind: 'catalog',
      catalogId: 'sample',
      pluginId: 'com.example.sample',
    });
    expect(p.manifest).toMatchObject({ id: 'com.example.sample' });
    now += 30 * 60_000 + 1;
    await expect(
      service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({
      code: 'request_expired',
    });
    const again = await service.preview(ACCOUNT, {
      kind: 'catalog',
      catalogId: 'sample',
      pluginId: 'com.example.sample',
    });
    await expect(
      service.install(OTHER, { previewId: again.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({
      code: 'request_expired',
    });
  });

  it('refuses an unverified install without the sideload confirmation', async () => {
    const { service } = services();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: samplePlugin() });
    await expect(service.install(ACCOUNT, { previewId: p.previewId })).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'confirmSideload', reason: 'sideload_confirmation_required' },
    });
    expect(await db.orm.select().from(schema.pluginInstall)).toEqual([]);
    expect(await db.orm.select().from(schema.mcpServer)).toEqual([]);
  });

  it('refuses an install when the plugin changed after the preview', async () => {
    const { service } = services();
    const root = samplePlugin();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: root });
    writeFileSync(join(root, 'hooks', 'check.mjs'), '// changed');
    await expect(
      service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(existsSync(join(dir, 'data', 'plugins', 'com.example.sample', '1.0.0'))).toBe(false);
  });
});

describe('install, update, uninstall', () => {
  async function install(
    service: PluginService,
    root: string,
    opts: { enable?: boolean; trust?: boolean } = {},
  ) {
    const p = await service.preview(ACCOUNT, { kind: 'path', path: root });
    const view = await service.install(ACCOUNT, {
      previewId: p.previewId,
      confirmSideload: true,
      ...(opts.enable === undefined ? {} : { enable: opts.enable }),
      ...(opts.trust
        ? { trustHooks: p.hooks.map((h) => ({ id: h.id, contentHash: h.contentHash })) }
        : {}),
    });
    return { p, view };
  }

  it('installs the sample: files, converted command, server row, vault env, skills, events and audit', async () => {
    const { service, skills } = services();
    const changes: PluginHookChange[] = [];
    service.hooks.onChange((c) => {
      changes.push(c);
    });
    const { view } = await install(service, samplePlugin());
    const installDir = join(dir, 'data', 'plugins', 'com.example.sample', '1.0.0');
    expect(view).toMatchObject({
      id: 'com.example.sample',
      version: '1.0.0',
      source: 'local',
      enabled: true,
      verified: false,
      status: 'needs_trust',
      components: { skills: 1, commands: 1, agents: 0, hooks: 1, mcpServers: 1, uiEntryPoints: 2 },
    });
    expect(existsSync(join(installDir, 'server', 'server.mjs'))).toBe(true);
    expect(
      readFileSync(join(installDir, '.nova-plugin', 'commands', 'greet', 'SKILL.md'), 'utf8'),
    ).toMatch(/^---\n[\s\S]*name: "greet"[\s\S]*---\n# Greet/);
    const [srv] = await db.orm.select().from(schema.mcpServer);
    expect(srv).toMatchObject({
      name: 'sample',
      source: 'plugin',
      pluginId: 'com.example.sample',
      enabled: true,
      command: 'node',
    });
    expect(JSON.parse(srv!.argsJson!)).toEqual([join(installDir, 'server', 'server.mjs')]);
    const env = JSON.parse(srv!.envRefJson!) as Record<string, string>;
    expect(env).toEqual({ NODE_PATH: `secret://mcp/${srv!.id}/env/NODE_PATH` });
    expect(await secrets.get(env.NODE_PATH!)).toBe('/opt/nova/node_modules');
    expect(JSON.parse(srv!.configJson!)).toMatchObject({
      startupTimeoutMs: 20000,
      defaultApproval: 'ask',
      pluginServerKey: 'sample',
    });
    expect(applied.map((r) => r.id)).toEqual([srv!.id]);
    expect((await skills.slashCommands(ACCOUNT)).map((s) => [s.name, s.skillId])).toEqual([
      ['greet', 'skill:com.example.sample:greet'],
      ['summarize-notes', 'skill:com.example.sample:summarize-notes'],
    ]);
    expect((await skills.get(ACCOUNT, 'skill:com.example.sample:summarize-notes')).files).toEqual([
      'template.md',
    ]);
    expect(events.events.map((e) => [e.name, e.payload])).toEqual([
      ['plugin.installed', { pluginId: 'com.example.sample', version: '1.0.0' }],
    ]);
    expect(audit).toEqual([
      expect.objectContaining({
        kind: 'settings',
        action: 'plugin.install',
        resource: 'plugin:com.example.sample',
      }),
    ]);
    expect(changes).toEqual([
      { accountId: ACCOUNT, pluginId: 'com.example.sample', change: 'installed', trust: [] },
    ]);
    const hooks = await service.hooks.list(ACCOUNT);
    expect(hooks).toEqual([
      expect.objectContaining({
        id: 'hook:com.example.sample.check-fetch',
        pluginId: 'com.example.sample',
        root: installDir,
        pluginEnabled: true,
        answersAsks: false,
        network: ['api.example.com'],
      }),
    ]);
    expect(await service.list(ACCOUNT)).toHaveLength(1);
    expect(await service.list(OTHER)).toEqual([]);
  });

  it('trusts hooks named on the install screen when the hash matches', async () => {
    const { service } = services();
    const changes: PluginHookChange[] = [];
    service.hooks.onChange((c) => {
      changes.push(c);
    });
    const root = samplePlugin();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: root });
    const hook = p.hooks[0]!;
    const view = await service.install(ACCOUNT, {
      previewId: p.previewId,
      confirmSideload: true,
      trustHooks: [
        { id: 'check-fetch', contentHash: hook.contentHash },
        { id: 'hook:com.example.sample.other', contentHash: hook.contentHash },
      ],
    });
    expect(view.status).toBe('ok');
    expect(changes[0]?.trust).toEqual([{ id: hook.id, contentHash: hook.contentHash }]);
    // The hooks area's answer wins once wired.
    service.useHookTrust(() => Promise.resolve(1));
    expect((await service.get(ACCOUNT, 'com.example.sample')).status).toBe('needs_trust');
    service.useHookTrust(() => Promise.reject(new Error('down')));
    expect((await service.get(ACCOUNT, 'com.example.sample')).status).toBe('ok');
    // A wrong hash trusts nothing.
    const again = await service.preview(ACCOUNT, { kind: 'path', path: root });
    const v2 = await service.install(ACCOUNT, {
      previewId: again.previewId,
      confirmSideload: true,
      trustHooks: [{ id: hook.id, contentHash: 'sha256:00' }],
    });
    expect(changes.at(-1)?.trust).toEqual([{ id: hook.id, contentHash: hook.contentHash }]);
    expect(v2.status).toBe('ok');
  });

  it('installs disabled: servers created disabled, skills hidden until enabled', async () => {
    const { service, skills } = services();
    const { view } = await install(service, samplePlugin(), { enable: false });
    expect(view).toMatchObject({ enabled: false, status: 'disabled' });
    const [srv] = await db.orm.select().from(schema.mcpServer);
    expect(srv?.enabled).toBe(false);
    expect(await skills.list(ACCOUNT)).toEqual([]);
    const on = await service.setEnabled(ACCOUNT, 'com.example.sample', true);
    expect(on.enabled).toBe(true);
    expect((await db.orm.select().from(schema.mcpServer))[0]?.enabled).toBe(true);
    expect((await skills.list(ACCOUNT)).length).toBe(2);
    const off = await service.setEnabled(ACCOUNT, 'com.example.sample', false);
    expect(off.status).toBe('disabled');
    expect(applied.at(-1)?.enabled).toBe(false);
    expect(audit.map((a) => a.action)).toEqual([
      'plugin.install',
      'plugin.enable',
      'plugin.disable',
    ]);
    expect(events.names()).toEqual(['plugin.installed', 'plugin.updated', 'plugin.updated']);
    // Setting the same state again records nothing new.
    await service.setEnabled(ACCOUNT, 'com.example.sample', false);
    expect(audit).toHaveLength(3);
    await expect(service.setEnabled(ACCOUNT, 'nope.x', true)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('updates to a new version: same server id, new paths, old folder gone, trust kept for unchanged hooks', async () => {
    const { service, skills } = services();
    const root = samplePlugin();
    const first = await install(service, root, { trust: true });
    const [srv1] = await db.orm.select().from(schema.mcpServer);
    await skills.setEnabled(ACCOUNT, 'skill:com.example.sample:greet', false);
    setVersion(root, '1.1.0', (m) => {
      m.agents = ['agents/helper.md'];
    });
    mkdirSync(join(root, 'agents'));
    writeFileSync(
      join(root, 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Helps.\ntools: [fs.read]\n---\nHelp out.\n',
    );
    const p = await service.preview(ACCOUNT, { kind: 'path', path: root });
    expect(p.replaces).toEqual({ version: '1.0.0' });
    const v = await service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    expect(v).toMatchObject({
      version: '1.1.0',
      status: 'ok',
      installedAt: first.view.installedAt,
      components: { agents: 1 },
    });
    const servers = await db.orm.select().from(schema.mcpServer);
    expect(servers.map((s) => s.id)).toEqual([srv1!.id]);
    expect(JSON.parse(servers[0]!.argsJson!)[0]).toContain(join('com.example.sample', '1.1.0'));
    expect(existsSync(join(dir, 'data', 'plugins', 'com.example.sample', '1.0.0'))).toBe(false);
    expect(readdirSync(join(dir, 'data', 'plugins', 'com.example.sample'))).toEqual(['1.1.0']);
    expect(await service.roles(ACCOUNT)).toEqual([
      expect.objectContaining({
        roleKey: 'com.example.sample:helper',
        pluginId: 'com.example.sample',
        toolsJson: '["fs.read"]',
        instructions: 'Help out.\n',
      }),
    ]);
    // A skill's switch survives the update.
    expect((await skills.list(ACCOUNT)).find((s) => s.name === 'greet')?.enabled).toBe(false);
    expect(events.names().filter((n) => n.startsWith('plugin.'))).toEqual([
      'plugin.installed',
      'plugin.updated',
    ]);
    expect(audit.at(-1)).toMatchObject({
      action: 'plugin.update',
      detail: expect.objectContaining({ previousVersion: '1.0.0' }),
    });

    // An older version is allowed with a warning, and a changed hook loses its trust.
    setVersion(root, '1.0.5');
    writeFileSync(join(root, 'hooks', 'check.mjs'), '// edited hook');
    const older = await service.preview(ACCOUNT, { kind: 'path', path: root });
    expect(older.warnings.join(' ')).toMatch(/older version than the installed 1.1.0/);
    const v3 = await service.install(ACCOUNT, {
      previewId: older.previewId,
      confirmSideload: true,
    });
    expect(v3.status).toBe('needs_trust');
  });

  it('reinstalls the same version in place and drops servers the manifest no longer has', async () => {
    const { service } = services();
    const root = samplePlugin();
    await install(service, root);
    const [srv] = await db.orm.select().from(schema.mcpServer);
    setVersion(root, '1.0.0', (m) => {
      m.mcpServers = {};
      delete m.ui;
    });
    const v = await install(service, root);
    expect(v.view.components.mcpServers).toBe(0);
    expect(await db.orm.select().from(schema.mcpServer)).toEqual([]);
    expect(removed).toEqual([srv!.id]);
    expect(await secrets.list(`secret://mcp/${srv!.id}/`)).toEqual([]);
    expect(
      existsSync(
        join(dir, 'data', 'plugins', 'com.example.sample', '1.0.0', 'server', 'server.mjs'),
      ),
    ).toBe(true);
  });

  it('renames a server whose name is taken and keeps env literals and own secret refs', async () => {
    const { service } = services();
    const ts = new Date().toISOString();
    await db.orm.insert(schema.mcpServer).values({
      id: 'user-1',
      accountId: ACCOUNT,
      name: 'sample',
      transport: 'stdio',
      command: 'x',
      source: 'user',
      createdAt: ts,
      updatedAt: ts,
    });
    const root = samplePlugin();
    setVersion(root, '1.0.0', (m) => {
      const s = (m.mcpServers as Record<string, Record<string, unknown>>).sample!;
      s.env = {
        LEVEL: 'debug',
        TOKEN: 'secret://plugin/com.example.sample/token',
        NODE_PATH: '/own',
      };
      (m.mcpServers as Record<string, unknown>).remote = {
        transport: 'http',
        url: 'https://mcp.example.com/v1',
        headers: { 'X-Api-Key': 'secret://plugin/com.example.sample/key' },
        enabled: false,
      };
    });
    await install(service, root);
    const rows = await db.orm.select().from(schema.mcpServer);
    const mine = rows.filter((r) => r.source === 'plugin');
    expect(mine.map((r) => r.name).sort()).toEqual(['remote', 'sample-2']);
    const sample = mine.find((r) => r.name === 'sample-2')!;
    const env = JSON.parse(sample.envRefJson!) as Record<string, string>;
    expect(env.TOKEN).toBe('secret://plugin/com.example.sample/token');
    expect(await secrets.get(env.LEVEL!)).toBe('debug');
    expect(await secrets.get(env.NODE_PATH!)).toBe('/own');
    const remote = mine.find((r) => r.name === 'remote')!;
    expect(remote).toMatchObject({
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      command: null,
      enabled: false,
    });
    expect(JSON.parse(remote.envRefJson!)).toEqual({
      X_Api_Key: 'secret://plugin/com.example.sample/key',
    });
    // The stored manifest holds the vault references, never the literal values.
    const [stored] = await db.orm.select().from(schema.pluginInstall);
    expect(stored!.manifestJson).not.toContain('debug');
    expect(stored!.manifestJson).not.toContain('/own');
    const sm = JSON.parse(stored!.manifestJson) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(sm.mcpServers.sample!.env).toEqual(env);
    // Enabling the plugin keeps a server the manifest turned off.
    await service.setEnabled(ACCOUNT, 'com.example.sample', false);
    await service.setEnabled(ACCOUNT, 'com.example.sample', true);
    const after = await db.orm.select().from(schema.mcpServer);
    expect(after.find((r) => r.name === 'remote')?.enabled).toBe(false);
    expect(after.find((r) => r.name === 'sample-2')?.enabled).toBe(true);
    // An update that drops an env name removes its value from the vault and keeps the name.
    setVersion(root, '1.0.1', (m) => {
      const s = (m.mcpServers as Record<string, Record<string, unknown>>).sample!;
      s.env = { NODE_PATH: '/own' };
    });
    await install(service, root);
    expect(await secrets.get(env.LEVEL!)).toBeNull();
    expect(await secrets.get(env.NODE_PATH!)).toBe('/own');
    const updated = (await db.orm.select().from(schema.mcpServer)).find((r) => r.id === sample.id);
    expect(updated?.name).toBe('sample-2');
  });

  it('uninstalls everything it added', async () => {
    const { service, skills } = services();
    const changes: string[] = [];
    service.hooks.onChange((c) => {
      changes.push(c.change);
      throw new Error('listener failures are logged, not raised');
    });
    const root = samplePlugin();
    await install(service, root);
    const [srv] = await db.orm.select().from(schema.mcpServer);
    await skills.setEnabled(ACCOUNT, 'skill:com.example.sample:greet', false);
    await service.uninstall(ACCOUNT, 'com.example.sample');
    expect(removed).toEqual([srv!.id]);
    expect(await db.orm.select().from(schema.mcpServer)).toEqual([]);
    expect(await db.orm.select().from(schema.pluginInstall)).toEqual([]);
    expect(await db.orm.select().from(schema.skillState)).toEqual([]);
    expect(await secrets.list('secret://mcp/')).toEqual([]);
    expect(existsSync(join(dir, 'data', 'plugins', 'com.example.sample'))).toBe(false);
    expect(await skills.list(ACCOUNT)).toEqual([]);
    expect(await service.hooks.list(ACCOUNT)).toEqual([]);
    expect(events.names()).toEqual(['plugin.installed', 'skill.changed', 'plugin.removed']);
    expect(audit.map((a) => a.action)).toEqual(['plugin.install', 'plugin.uninstall']);
    expect(changes).toEqual(['installed', 'removed']);
    await expect(service.uninstall(ACCOUNT, 'com.example.sample')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rolls back the files when the database write fails', async () => {
    const { service } = services();
    const root = samplePlugin();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: root });
    db.raw.exec(
      "CREATE TRIGGER fail_install BEFORE INSERT ON plugin_install BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    await expect(
      service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true }),
    ).rejects.toThrow(/plugin_install/);
    expect(existsSync(join(dir, 'data', 'plugins', 'com.example.sample', '1.0.0'))).toBe(false);
    expect(await db.orm.select().from(schema.mcpServer)).toEqual([]);
    expect(await secrets.list('secret://mcp/')).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('runs concurrent installs one at a time and refuses a preview whose folder is gone', async () => {
    const { service } = services();
    const root = samplePlugin();
    const a = await service.preview(ACCOUNT, { kind: 'path', path: root });
    const b = await service.preview(ACCOUNT, { kind: 'path', path: root });
    const [va, vb] = await Promise.all([
      service.install(ACCOUNT, { previewId: a.previewId, confirmSideload: true }),
      service.install(ACCOUNT, { previewId: b.previewId, confirmSideload: true }),
    ]);
    expect([va.version, vb.version]).toEqual(['1.0.0', '1.0.0']);
    expect(readdirSync(join(dir, 'data', 'plugins', 'com.example.sample'))).toEqual(['1.0.0']);
    expect(await db.orm.select().from(schema.mcpServer)).toHaveLength(1);
    const gone = samplePlugin('gone');
    const c = await service.preview(ACCOUNT, { kind: 'path', path: gone });
    rmSync(gone, { recursive: true });
    await expect(
      service.install(ACCOUNT, { previewId: c.previewId, confirmSideload: true }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('re-reads hooks from disk so an edited hook gets a new hash', async () => {
    const { service } = services();
    await install(service, samplePlugin());
    const [before] = await service.hooks.list(ACCOUNT);
    writeFileSync(join(before!.root, 'hooks', 'check.mjs'), '// tampered');
    const [after] = await service.hooks.list(ACCOUNT);
    expect(after!.contentHash).not.toBe(before!.contentHash);
    rmSync(join(before!.root, 'hooks', 'hooks.json'));
    expect(await service.hooks.list(ACCOUNT)).toEqual([]);
  });
});

describe('permissions for the gate', () => {
  it('returns the confirmed permissions for tools of the plugin or its servers', async () => {
    const { service } = services();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: samplePlugin() });
    await service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const [srv] = await db.orm.select().from(schema.mcpServer);
    const perms = await service.forTool(ACCOUNT, tool({ serverId: srv!.id }));
    expect(perms).toMatchObject({
      pluginId: 'com.example.sample',
      network: ['api.example.com'],
      fs: [],
      actionDefaults: { read: 'allow', write: 'ask', delete: 'deny' },
      // The server's manifest `defaultApproval` travels as the plugin's, not as a user default.
      serverDefault: 'ask',
      hooksAnswerAsks: false,
    });
    // The manifest's `plugin:<id>.<tool>` entry also answers for the server's canonical name.
    expect(perms?.tools['mcp:sample.fetch_status']).toEqual({ action: 'read' });
    expect(perms?.tools['plugin:com.example.sample.panel_action']).toEqual({
      action: 'write',
      default: 'ask',
    });
    const panel = await service.forTool(
      ACCOUNT,
      tool({ name: 'mcp:sample.panel_action', serverId: srv!.id }),
    );
    expect(panel?.tools['mcp:sample.panel_action']).toEqual({ action: 'write', default: 'ask' });
    const byPlugin = await service.forTool(
      ACCOUNT,
      tool({
        name: 'plugin:com.example.sample.other',
        source: 'plugin',
        pluginId: 'com.example.sample',
      }),
    );
    expect(byPlugin?.pluginId).toBe('com.example.sample');
    expect(byPlugin?.tools['plugin:com.example.sample.other']).toBeUndefined();
    expect(byPlugin?.serverDefault).toBeUndefined();
  });

  it('answers null for tools no plugin owns, and for other accounts', async () => {
    const { service } = services();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: samplePlugin() });
    await service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const [srv] = await db.orm.select().from(schema.mcpServer);
    expect(await service.forTool(OTHER, tool({ serverId: srv!.id }))).toBeNull();
    expect(await service.forTool(ACCOUNT, tool({ name: 'fs.read', source: 'builtin' }))).toBeNull();
    expect(await service.forTool(ACCOUNT, tool({ serverId: 'user-server' }))).toBeNull();
    expect(await service.forTool(ACCOUNT, tool({ pluginId: 'com.example.gone' }))).toBeNull();
  });

  it('gives server defaults and UI entry points of enabled plugins', async () => {
    const { service } = services();
    const p = await service.preview(ACCOUNT, { kind: 'path', path: samplePlugin() });
    await service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    const [srv] = await db.orm.select().from(schema.mcpServer);
    expect(await service.serverDefault(ACCOUNT, srv!.id)).toBe('ask');
    expect(await service.serverDefault(OTHER, srv!.id)).toBeNull();
    expect(await service.serverDefault(ACCOUNT, 'nope')).toBeNull();
    expect(await service.uiEntryPoints(ACCOUNT)).toEqual([
      {
        pluginId: 'com.example.sample',
        kind: 'global',
        resource: 'ui://sample/panel',
        title: 'Sample panel',
        extensions: [],
        serverIds: [srv!.id],
        connectDomains: ['api.example.com'],
        resourceDomains: [],
        network: ['api.example.com'],
      },
      expect.objectContaining({ kind: 'thread', resource: 'ui://sample/panel' }),
    ]);
    expect(await service.enabledManifests(ACCOUNT)).toEqual([
      {
        pluginId: 'com.example.sample',
        manifest: expect.objectContaining({ id: 'com.example.sample', ui: expect.any(Object) }),
      },
    ]);
    await service.setEnabled(ACCOUNT, 'com.example.sample', false);
    expect(await service.uiEntryPoints(ACCOUNT)).toEqual([]);
    expect(await service.enabledManifests(ACCOUNT)).toEqual([]);
  });
});

describe('catalog entries', () => {
  it('lists entries with the installed version and filters by text', async () => {
    const { service } = services({
      catalogConfigs: () =>
        Promise.resolve([
          { id: 'sample', name: 'Sample', location: SAMPLE_CATALOG },
          { id: 'broken', name: 'Broken', location: join(dir, 'missing') },
        ]),
    });
    expect(await service.catalogViews()).toEqual([
      { id: 'sample', name: 'Sample', location: SAMPLE_CATALOG, kind: 'local' },
      { id: 'broken', name: 'Broken', location: join(dir, 'missing'), kind: 'local' },
    ]);
    expect(await service.catalogEntries(ACCOUNT)).toEqual([
      expect.objectContaining({
        catalogId: 'sample',
        pluginId: 'com.example.sample',
        version: '1.0.0',
        verified: false,
        installedVersion: null,
      }),
    ]);
    const p = await service.preview(ACCOUNT, {
      kind: 'catalog',
      catalogId: 'sample',
      pluginId: 'com.example.sample',
    });
    const v = await service.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    expect(v).toMatchObject({ source: 'catalog', origin: 'sample/com.example.sample@1.0.0' });
    expect((await service.catalogEntries(ACCOUNT, 'SAMPLE'))[0]?.installedVersion).toBe('1.0.0');
    expect(await service.catalogEntries(ACCOUNT, 'nothing-matches')).toEqual([]);
  });
});
