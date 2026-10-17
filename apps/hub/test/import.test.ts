// Every credential in this file is a fixture (secret-scan: fake-file).
// Import from other assistants through the Hub (FR-200; hub-api M4): preview and apply over
// HTTP with the real plugins area, so imported plugins are installed disabled by the plugins
// installer, imported skills appear in /skills, imported MCP servers are listed disabled by the
// MCP area, the ledger is served, and no secret value reaches the database, the logs or a
// response.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const HOST = { host: '127.0.0.1:7419' };
const SECRETS = {
  github: 'ghp_fake0123456789abcdefghijklmn',
  weather: 'fake-weather-key-0123456789',
  notes: 'fake-notes-token-0123456789',
};

let dir: string;
let src: string;
let db: NovaDatabase;
let hub: Hub;
let logs: MemorySink;
let auth: Record<string, string>;

function put(rel: string, content: string | Uint8Array): void {
  const file = join(src, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-import-'));
  src = join(dir, 'src');
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  logs = new MemorySink();
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [logs] }),
    secrets: new MemorySecretStore(),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  auth = {
    ...HOST,
    authorization: `Bearer ${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
  };

  // A config folder with servers, a skill and a command; two plugins; a zipped chat export.
  put(
    'cfg/.assistant/settings.json',
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { GITHUB_TOKEN: SECRETS.github },
        },
      },
    }),
  );
  put(
    'cfg/.assistant/skills/tidy/SKILL.md',
    '---\ndescription: Tidy up a messy list into groups.\n---\nGroup the items.\n',
  );
  put(
    'cfg/.assistant/commands/standup.md',
    '---\ndescription: Draft my standup update\n---\nSummarise yesterday.\n',
  );
  put(
    'plugins/weather/.acme-plugin/plugin.json',
    JSON.stringify({ name: 'Weather', version: '2.0.0' }),
  );
  put(
    'plugins/weather/skills/forecast/SKILL.md',
    '---\ndescription: Give a weather forecast for a place.\n---\nForecast.\n',
  );
  put(
    'plugins/weather/.mcp.json',
    JSON.stringify({
      mcpServers: {
        weather: {
          command: 'node',
          args: ['server.js'],
          env: { WEATHER_API_KEY: SECRETS.weather },
        },
      },
    }),
  );
  put(
    'plugins/notes/.nova-plugin/plugin.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.example.notes',
      name: 'Notes',
      version: '0.3.0',
      permissions: {},
      skills: ['skills/jot'],
      mcpServers: {
        notes: { transport: 'stdio', command: 'notes-mcp', env: { NOTES_TOKEN: SECRETS.notes } },
      },
    }),
  );
  put(
    'plugins/notes/skills/jot/SKILL.md',
    '---\ndescription: Jot a note down for later.\n---\nWrite it down.\n',
  );
  put(
    'exports/chats.zip',
    zipSync({
      'conversations.json': strToU8(
        JSON.stringify([
          {
            id: 'c1',
            title: 'Hello',
            messages: [
              { role: 'user', content: 'Hi' },
              { role: 'assistant', content: 'Hello!' },
            ],
          },
        ]),
      ),
    }),
  );
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => hub.app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, payload: Record<string, unknown>) =>
  hub.app.inject({ method: 'POST', url, headers: auth, payload });

describe('import routes (FR-200)', () => {
  it('previews, applies through the plugins and MCP areas, and keeps secrets in the vault', async () => {
    const preview = await post('/api/v1/import/preview', {
      paths: [src],
      kinds: ['skills', 'commands', 'plugins', 'mcp_servers', 'chats'],
    });
    expect(preview.statusCode).toBe(200);
    const p = preview.json<{
      previewId: string;
      items: { id: string; name: string; status: string; target: string }[];
    }>();
    expect(p.items.map((i) => [i.name, i.status]).sort()).toEqual([
      ['Hello', 'new'],
      ['Notes', 'new'],
      ['Weather', 'new'],
      ['github', 'new'],
      ['standup', 'new'],
      ['tidy', 'new'],
    ]);
    for (const v of Object.values(SECRETS)) expect(preview.body).not.toContain(v);

    const applied = await post('/api/v1/import/apply', {
      previewId: p.previewId,
      items: p.items.map((i) => i.id),
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      imported: 6,
      duplicates: 0,
      disabled: 3,
      secretsMigrated: 3,
    });

    // Plugins: installed by the plugins area, disabled.
    const plugins = (await get('/api/v1/plugins')).json().items as {
      id: string;
      enabled: boolean;
      components: { skills: number; mcpServers: number };
    }[];
    expect(plugins.map((x) => [x.id, x.enabled]).sort()).toEqual([
      ['dev.example.notes', false],
      ['imported.weather', false],
    ]);
    expect(plugins.find((x) => x.id === 'imported.weather')?.components).toMatchObject({
      skills: 1,
      mcpServers: 1,
    });
    // MCP servers: the imported one and the plugins' ones, all disabled.
    const servers = (await get('/api/v1/mcp/servers')).json().items as {
      name: string;
      enabled: boolean;
      status: string;
      envKeys: string[];
    }[];
    expect(servers.find((s) => s.name === 'github')).toMatchObject({
      enabled: false,
      status: 'disabled',
      envKeys: ['GITHUB_TOKEN'],
    });
    expect(servers.every((s) => !s.enabled)).toBe(true);
    // Skills: the imported user skills (and the plugins' skills, which stay off with them).
    const skills = (await get('/api/v1/skills')).json().items as { name: string; source: string }[];
    expect(
      skills
        .filter((s) => s.source === 'import')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['standup', 'tidy']);
    // The chat.
    const threads = (await get('/api/v1/threads')).json().items as { title: string }[];
    expect(threads.map((t) => t.title)).toEqual(['Hello']);
    // The ledger.
    const records = (await get('/api/v1/import/records')).json().items as {
      kind: string;
      target: string;
    }[];
    expect(records).toHaveLength(6);
    expect(records.find((r) => r.kind === 'mcp_servers')?.target).toBe(
      'MCP server github (disabled)',
    );
    // The event.
    const events = (await get('/api/v1/events?limit=500')).json().events as { name: string }[];
    expect(events.some((e) => e.name === 'import.completed')).toBe(true);

    // A second preview finds everything already imported.
    const again = (
      await post('/api/v1/import/preview', {
        paths: [src],
        kinds: ['skills', 'commands', 'plugins', 'mcp_servers', 'chats'],
      })
    ).json<{ items: { status: string }[] }>();
    expect(again.items.every((i) => i.status === 'duplicate')).toBe(true);

    // No secret value in the database, the logs or any response.
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'")
      .all() as { name: string }[];
    const dump = tables
      .map((t) => JSON.stringify(db.raw.prepare(`SELECT * FROM "${t.name}"`).all()))
      .join('\n');
    const bodies = [
      preview.body,
      applied.body,
      JSON.stringify(plugins),
      JSON.stringify(servers),
      JSON.stringify(records),
    ].join('\n');
    for (const v of Object.values(SECRETS)) {
      expect(dump, v).not.toContain(v);
      expect(JSON.stringify(logs.records), v).not.toContain(v);
      expect(bodies, v).not.toContain(v);
    }
  });

  it('validates its input', async () => {
    expect(
      (await post('/api/v1/import/preview', { paths: [], kinds: ['skills'] })).statusCode,
    ).toBe(400);
    expect(
      (await post('/api/v1/import/preview', { paths: [src], kinds: ['nope'] })).statusCode,
    ).toBe(400);
    expect(
      (await post('/api/v1/import/preview', { paths: [join(dir, 'missing')], kinds: ['skills'] }))
        .statusCode,
    ).toBe(400);
    expect((await post('/api/v1/import/apply', { previewId: 'x', items: [] })).statusCode).toBe(
      400,
    );
    expect((await post('/api/v1/import/apply', { previewId: 'x', items: ['i1'] })).statusCode).toBe(
      404,
    );
    expect((await get('/api/v1/import/records')).json()).toEqual({ items: [] });
  });
});
