// Every credential in this file is a fixture (secret-scan: fake-file).
// Import from other assistants (FR-200, docs/08 §4.2): a preview of fixture folders (and a zip)
// lists every kind with targets, conflicts and masked secrets and writes nothing; applying
// imports only the selected items, moves secrets to the vault (no value survives in the
// database, the audit or the logs), keeps MCP servers and plugins disabled, records an
// import_record per item, and a second preview marks everything as already imported.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportItemView, ImportKind } from '@nova/shared';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  ImportService,
  ProjectFolderService,
  SkillIndex,
  type AuditRecord,
  type ImportTargets,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

const SECRETS = {
  github: 'ghp_fake0123456789abcdefghijklmn',
  bearer: 'fake-bearer-0123456789abcdef',
  urlToken: 'fake-url-token-123456789',
  dbPassword: 'fake-pass-123456789',
  weather: 'fake-weather-key-0123456789',
  inText: 'sk-test-fake0123456789abcdefghij',
  nova: 'fake-nova-plugin-token-0123456',
};

const ALL: ImportKind[] = [
  'instructions',
  'skills',
  'commands',
  'plugins',
  'mcp_servers',
  'projects',
  'memories',
  'chats',
];

function put(root: string, rel: string, content: string | Uint8Array): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A user's setup from other tools: a config folder, a repository, two plugins and exports. */
function fixtures(root: string): { home: string; exports: string } {
  const home = join(root, 'home');
  const cfg = '.assistant';
  put(home, `${cfg}/ASSISTANT.md`, '# Always\nAnswer briefly.\n');
  put(
    home,
    `${cfg}/commands/review-pr.md`,
    '---\ndescription: Review the current pull request\nallowed-tools: fs.read, fs.search\n---\nReview $ARGUMENTS carefully.\n',
  );
  put(
    home,
    `${cfg}/commands/git/commit.md`,
    '# Commit\n\nWrite a commit message for the staged diff.\n',
  );
  put(
    home,
    `${cfg}/skills/code-review/SKILL.md`,
    '---\nname: code-review\ndescription: Review a diff for correctness, security and style.\n---\n## Steps\nRun scripts/collect.sh.\n',
  );
  put(home, `${cfg}/skills/code-review/scripts/collect.sh`, '#!/bin/sh\ngit diff\n');
  put(home, `${cfg}/skills/broken/SKILL.md`, '---\nname: broken\n---\nno description\n');
  put(
    home,
    `${cfg}/settings.json`,
    JSON.stringify({
      theme: 'dark',
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { GITHUB_TOKEN: SECRETS.github },
        },
        'Remote API': {
          type: 'sse',
          url: `https://mcp.example.com/sse?token=${SECRETS.urlToken}`,
          headers: { Authorization: `Bearer ${SECRETS.bearer}` },
        },
      },
    }),
  );
  // A repository with its own instructions and MCP config.
  const app = join(home, 'code', 'app');
  mkdirSync(join(app, '.git'), { recursive: true });
  put(app, 'AGENTS.md', `Use pnpm. The staging key is ${SECRETS.inText} for tests.\n`);
  put(
    app,
    '.mcp.json',
    JSON.stringify({
      mcpServers: { db: { command: 'db-mcp', args: ['--password', SECRETS.dbPassword] } },
    }),
  );
  put(app, 'node_modules/dep/AGENTS.md', 'never scanned');
  // A plugin in another layout and one in Nova's.
  const other = join(home, 'code', 'plugin-other');
  put(
    other,
    '.acme-plugin/plugin.json',
    JSON.stringify({
      name: 'Weather Tools',
      version: '1.2.0',
      description: 'Forecasts',
      author: { name: 'Ann' },
    }),
  );
  put(
    other,
    'skills/forecast/SKILL.md',
    '---\ndescription: Give a weather forecast for a place.\n---\nUse the weather server.\n',
  );
  put(
    other,
    'commands/umbrella.md',
    '---\ndescription: Do I need an umbrella?\n---\nCheck the forecast.\n',
  );
  put(
    other,
    'agents/meteorologist.md',
    '---\nname: meteorologist\ndescription: Explains weather.\n---\nYou explain weather.\n',
  );
  put(other, 'agents/bad.md', 'no front-matter');
  put(other, 'hooks/hooks.json', '{}');
  put(
    other,
    '.mcp.json',
    JSON.stringify({
      mcpServers: {
        Weather: {
          command: 'node',
          args: ['server.js'],
          env: { WEATHER_API_KEY: SECRETS.weather },
        },
      },
    }),
  );
  const nova = join(home, 'code', 'plugin-nova');
  put(
    nova,
    '.nova-plugin/plugin.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.example.notes',
      name: 'Notes',
      version: '0.3.0',
      permissions: {},
      skills: ['skills/jot'],
      mcpServers: {
        notes: {
          transport: 'stdio',
          command: 'notes-mcp',
          env: { NOTES_TOKEN: SECRETS.nova, MODE: 'local' },
        },
      },
    }),
  );
  put(
    nova,
    'skills/jot/SKILL.md',
    '---\ndescription: Jot a note down for later.\n---\nWrite it down.\n',
  );
  // Exports: memories as JSON and text, chats as JSON and in a zip with projects.
  const exports = join(root, 'exports');
  put(
    exports,
    'memories.json',
    JSON.stringify([
      'The user likes green tea.',
      { content: 'Works at Acme.', category: 'work' },
      42,
    ]),
  );
  put(exports, 'memories.txt', '- Lives in Lisbon\n- Has a cat\n');
  put(
    exports,
    'chats.json',
    JSON.stringify([
      {
        uuid: 'c-1',
        name: 'Trip plans',
        created_at: '2026-01-02T03:04:05Z',
        chat_messages: [
          { sender: 'human', text: 'Where should I go?', created_at: '2026-01-02T03:04:05Z' },
          { sender: 'assistant', text: 'Lisbon.', created_at: '2026-01-02T03:04:09Z' },
        ],
      },
    ]),
  );
  const zip = zipSync({
    'export/conversations.json': strToU8(
      JSON.stringify([
        {
          id: 'z-1',
          title: 'Zipped chat',
          create_time: 1767225600,
          current_node: 'b',
          mapping: {
            a: {
              message: { author: { role: 'user' }, content: { parts: ['Hello from a zip'] } },
              parent: null,
              children: ['b'],
            },
            b: {
              message: { author: { role: 'assistant' }, content: { parts: ['Hi!'] } },
              parent: 'a',
              children: [],
            },
          },
        },
      ]),
    ),
    'export/projects.json': strToU8(
      JSON.stringify([{ uuid: 'p-1', name: 'Garden', prompt_template: 'Talk about plants.' }]),
    ),
    'export/readme.txt': strToU8('ignored'),
  });
  put(exports, 'export.zip', zip);
  return { home, exports };
}

let env: Env;
let root: string;
let dataDir: string;
let paths: { home: string; exports: string };
let audit: AuditRecord[];
let logs: MemorySink;
let installed: { folder: string; manifest: Record<string, unknown>; files: string[] }[];
let folders: { projectId: string; path: string }[];
let svc: ImportService;

function makeService(targets: ImportTargets): ImportService {
  return new ImportService({
    db: env.db,
    secrets: env.secrets,
    events: env.events,
    dataDir,
    memory: env.memory,
    projects: env.projects,
    targets,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    log: new Logger({ module: 'import', sinks: [logs] }),
    home: paths.home,
  });
}

function defaultTargets(): ImportTargets {
  return {
    skills: new SkillIndex({ db: env.db, userDir: join(dataDir, 'skills'), builtinDir: null }),
    plugins: {
      installDisabled: (_accountId, folder) => {
        const manifest = JSON.parse(
          readFileSync(join(folder, '.nova-plugin', 'plugin.json'), 'utf8'),
        ) as Record<string, unknown>;
        const files: string[] = [];
        const walk = (d: string, rel = '') => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
            else files.push(`${rel}${e.name}`);
          }
        };
        walk(folder);
        installed.push({ folder, manifest, files: files.sort() });
        return Promise.resolve({ id: String(manifest.id), name: String(manifest.name) });
      },
    },
    folders: {
      add: (_accountId, projectId, req) => {
        folders.push({ projectId, path: req.path });
        return Promise.resolve();
      },
    },
  };
}

beforeEach(async () => {
  env = await makeEnv();
  root = join(env.dir, 'src');
  dataDir = join(env.dir, 'data');
  paths = fixtures(root);
  audit = [];
  logs = new MemorySink();
  installed = [];
  folders = [];
  svc = makeService(defaultTargets());
});
afterEach(() => env.close());

const byName = (items: ImportItemView[], name: string) => {
  const it = items.find((i) => i.name === name);
  if (!it) throw new Error(`no item ${name}: ${items.map((i) => i.name).join(', ')}`);
  return it;
};

/** Every row of every table, for "no secret value survives in the database". */
function dumpDb(): string {
  const tables = env.db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'")
    .all() as { name: string }[];
  return tables
    .map((t) => JSON.stringify(env.db.raw.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join('\n');
}

describe('import preview', () => {
  it('lists every kind with targets, statuses and masked secrets, and writes nothing', async () => {
    const p = await svc.preview(ACCOUNT, { paths: [paths.home, paths.exports], kinds: ALL });
    const kinds = new Map<string, number>();
    for (const i of p.items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
    expect(Object.fromEntries(kinds)).toEqual({
      instructions: 2,
      skills: 2,
      commands: 2,
      plugins: 2,
      mcp_servers: 3,
      projects: 2,
      memories: 2,
      chats: 2,
    });
    expect(byName(p.items, '.assistant/ASSISTANT.md')).toMatchObject({
      target: 'user instructions',
      status: 'new',
    });
    expect(byName(p.items, 'app/AGENTS.md').target).toBe('instructions of project app');
    expect(byName(p.items, 'app/AGENTS.md').maskedSecrets).toEqual([
      expect.stringMatching(
        /^a token in the text: sk…•••• → secret:\/\/import\/[a-z0-9]+\/text\/secret_1$/,
      ),
    ]);
    expect(byName(p.items, 'code-review')).toMatchObject({
      target: 'skill code-review',
      status: 'new',
    });
    expect(byName(p.items, 'broken')).toMatchObject({ status: 'unsupported' });
    expect(byName(p.items, 'review-pr').target).toBe('skill review-pr (from a command)');
    expect(byName(p.items, 'git-commit').status).toBe('new');
    expect(byName(p.items, 'Weather Tools')).toMatchObject({
      target: 'plugin Weather Tools (disabled)',
      status: 'new',
    });
    expect(byName(p.items, 'Weather Tools').note).toMatch(/hooks use another format/);
    expect(byName(p.items, 'Weather Tools').note).toMatch(/agents\/bad\.md/);
    expect(byName(p.items, 'Notes').maskedSecrets).toEqual([
      'MCP server notes, env NOTES_TOKEN: fa…•••• → secret://plugin/dev.example.notes/notes/NOTES_TOKEN',
    ]);
    const github = byName(p.items, 'github');
    expect(github.target).toBe('MCP server github (disabled)');
    expect(github.maskedSecrets).toEqual([
      expect.stringMatching(
        /^env GITHUB_TOKEN: gh…•••• → secret:\/\/mcp\/[^/]+\/env\/GITHUB_TOKEN$/,
      ),
    ]);
    expect(byName(p.items, 'Remote API').maskedSecrets).toHaveLength(2);
    expect(byName(p.items, 'db').maskedSecrets).toEqual([
      expect.stringMatching(/^argument --password: /),
    ]);
    expect(byName(p.items, 'app').target).toBe(
      `project app with folder ${join(paths.home, 'code', 'app')}`,
    );
    expect(byName(p.items, 'Garden').target).toBe('project Garden');
    expect(byName(p.items, 'memories.json (2 memories)').target).toBe('2 memory items');
    expect(byName(p.items, 'Zipped chat').sourcePath).toBe(
      `${join(paths.exports, 'export.zip')}!export/conversations.json#z-1`,
    );
    expect(byName(p.items, 'Trip plans').target).toBe('chat Trip plans (2 messages)');

    // Nothing is written by a preview, and no secret value is in it.
    const body = JSON.stringify(p);
    for (const v of Object.values(SECRETS)) expect(body).not.toContain(v);
    expect(existsSync(dataDir) ? readdirSync(dataDir) : []).toEqual([]);
    expect(env.db.raw.prepare('SELECT count(*) AS n FROM import_record').get()).toEqual({ n: 0 });
    expect(env.db.raw.prepare('SELECT count(*) AS n FROM mcp_server').get()).toEqual({ n: 0 });
    expect(await env.secrets.list('secret://mcp/')).toEqual([]);
  });

  it('scans only the kinds asked for, and refuses a path that does not exist', async () => {
    const p = await svc.preview(ACCOUNT, { paths: [paths.home], kinds: ['mcp_servers'] });
    expect(p.items.map((i) => i.name).sort()).toEqual(['Remote API', 'db', 'github']);
    await expect(
      svc.preview(ACCOUNT, { paths: [join(root, 'missing')], kinds: ALL }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    // An explicitly chosen file is an instruction file whatever its name.
    put(root, 'notes/house-rules.md', 'Be kind.');
    const one = await svc.preview(ACCOUNT, {
      paths: [join(root, 'notes/house-rules.md')],
      kinds: ['instructions'],
    });
    expect(one.items).toHaveLength(1);
  });

  it('marks name conflicts and imports them under a free name', async () => {
    mkdirSync(join(dataDir, 'skills', 'code-review'), { recursive: true });
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        `INSERT INTO mcp_server (id, account_id, name, transport, command, created_at, updated_at)
         VALUES ('existing', ?, 'github', 'stdio', 'x', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    await env.projects.create(ACCOUNT, { name: 'Garden' });
    const p = await svc.preview(ACCOUNT, {
      paths: [paths.home, paths.exports],
      kinds: ['skills', 'mcp_servers', 'projects'],
    });
    expect(byName(p.items, 'code-review')).toMatchObject({
      status: 'conflict',
      target: 'skill code-review-2',
    });
    expect(byName(p.items, 'github')).toMatchObject({
      status: 'conflict',
      target: 'MCP server github-2 (disabled)',
    });
    expect(byName(p.items, 'Garden')).toMatchObject({
      status: 'conflict',
      target: 'project Garden (2)',
    });
    const r = await svc.apply(ACCOUNT, {
      previewId: p.previewId,
      items: p.items
        .filter((i) => ['code-review', 'github', 'Garden'].includes(i.name))
        .map((i) => i.id),
    });
    expect(r.imported).toBe(3);
    const md = readFileSync(join(dataDir, 'skills', 'code-review-2', 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^name: code-review-2$/m);
    expect(existsSync(join(dataDir, 'skills', 'code-review-2', 'scripts', 'collect.sh'))).toBe(
      true,
    );
    expect(env.db.raw.prepare("SELECT name FROM mcp_server WHERE source = 'import'").all()).toEqual(
      [{ name: 'github-2' }],
    );
    expect((await env.projects.list(ACCOUNT)).map((x) => x.name).sort()).toEqual([
      'Garden',
      'Garden (2)',
    ]);
  });
});

describe('import apply', () => {
  it('imports the selected items, keeps servers and plugins disabled and moves every secret', async () => {
    const p = await svc.preview(ACCOUNT, { paths: [paths.home, paths.exports], kinds: ALL });
    const selectable = p.items.filter((i) => i.status !== 'unsupported');
    const r = await svc.apply(ACCOUNT, { previewId: p.previewId, items: p.items.map((i) => i.id) });
    expect(r).toMatchObject({ imported: selectable.length, duplicates: 0, disabled: 5 });
    // github, Remote API (2), db, Weather (1), Notes (1), AGENTS.md token (1).
    expect(r.secretsMigrated).toBe(7);

    // MCP servers: disabled, source import, references only.
    const servers = env.db.raw
      .prepare("SELECT * FROM mcp_server WHERE source = 'import' ORDER BY name")
      .all() as {
      name: string;
      enabled: number;
      env_ref_json: string;
      args_json: string;
      url: string | null;
    }[];
    expect(servers.map((s) => [s.name, s.enabled])).toEqual([
      ['db', 0],
      ['github', 0],
      ['remote-api', 0],
    ]);
    const db = servers.find((s) => s.name === 'db')!;
    expect(JSON.parse(db.args_json)).toEqual([]);
    const dbEnv = JSON.parse(db.env_ref_json) as Record<string, string>;
    expect(await env.secrets.get(dbEnv.password!)).toBe(SECRETS.dbPassword);
    const remote = servers.find((s) => s.name === 'remote-api')!;
    expect(remote.url).toBe('https://mcp.example.com/sse');
    const gh = JSON.parse(servers.find((s) => s.name === 'github')!.env_ref_json) as Record<
      string,
      string
    >;
    expect(gh.GITHUB_TOKEN).toMatch(/^secret:\/\/mcp\/[^/]+\/env\/GITHUB_TOKEN$/);
    expect(await env.secrets.get(gh.GITHUB_TOKEN!)).toBe(SECRETS.github);

    // Plugins: installed disabled from a staging copy with a generated manifest; sources untouched.
    expect(installed.map((x) => x.manifest.id).sort()).toEqual([
      'dev.example.notes',
      'imported.weather-tools',
    ]);
    const weather = installed.find((x) => x.manifest.id === 'imported.weather-tools')!;
    expect(weather.manifest).toMatchObject({
      schemaVersion: 1,
      name: 'Weather Tools',
      version: '1.2.0',
      author: { name: 'Ann' },
      skills: ['skills/forecast'],
      commands: ['commands/umbrella.md'],
      agents: ['agents/meteorologist.md'],
      mcpServers: {
        weather: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {
            WEATHER_API_KEY: 'secret://plugin/imported.weather-tools/weather/WEATHER_API_KEY',
          },
        },
      },
    });
    expect(
      await env.secrets.get('secret://plugin/imported.weather-tools/weather/WEATHER_API_KEY'),
    ).toBe(SECRETS.weather);
    expect(weather.files).toContain('.nova-plugin/plugin.json');
    expect(weather.files).toContain('.acme-plugin/plugin.json');
    expect(existsSync(weather.folder)).toBe(false); // the staging copy is gone
    expect(existsSync(join(paths.home, 'code', 'plugin-other', '.nova-plugin'))).toBe(false);
    const notes = installed.find((x) => x.manifest.id === 'dev.example.notes')!;
    expect(notes.manifest.mcpServers).toEqual({
      notes: {
        transport: 'stdio',
        command: 'notes-mcp',
        env: { NOTES_TOKEN: 'secret://plugin/dev.example.notes/notes/NOTES_TOKEN', MODE: 'local' },
      },
    });
    expect(
      readFileSync(join(paths.home, 'code', 'plugin-nova', '.nova-plugin', 'plugin.json'), 'utf8'),
    ).toContain(SECRETS.nova);

    // Skills and commands become user skills with an import origin.
    const skills = new SkillIndex({
      db: env.db,
      userDir: join(dataDir, 'skills'),
      builtinDir: null,
    });
    const views = await skills.views(ACCOUNT);
    expect(views.map((v) => [v.name, v.source]).sort()).toEqual([
      ['code-review', 'import'],
      ['git-commit', 'import'],
      ['review-pr', 'import'],
    ]);
    expect(views.find((v) => v.name === 'review-pr')).toMatchObject({
      description: 'Review the current pull request',
      allowedTools: ['fs.read', 'fs.search'],
    });

    // Projects with folders, and instructions in the right places.
    const projects = await env.projects.list(ACCOUNT);
    const app = projects.find((x) => x.name === 'app')!;
    expect(folders).toEqual([{ projectId: app.id, path: join(paths.home, 'code', 'app') }]);
    expect(app.instructions).toMatch(
      /^Use pnpm\. The staging key is secret:\/\/import\/[a-z0-9]+\/text\/secret_1 for tests\.$/,
    );
    expect(projects.find((x) => x.name === 'Garden')?.instructions).toBe('Talk about plants.');
    expect(readFileSync(join(dataDir, 'instructions.md'), 'utf8')).toMatch(
      /<!-- Imported from .*ASSISTANT\.md -->\n# Always\nAnswer briefly\./,
    );

    // Memories (deduplicated by content) and chats as imported threads.
    const memories = (await env.memory.list(ACCOUNT)).map((m) => m.content).sort();
    expect(memories).toEqual([
      'Has a cat',
      'Lives in Lisbon',
      'The user likes green tea.',
      'Works at Acme.',
    ]);
    const threads = (await env.threads.list(ACCOUNT)).items;
    expect(threads.map((t) => t.title).sort()).toEqual(['Trip plans', 'Zipped chat']);
    const trip = threads.find((t) => t.title === 'Trip plans')!;
    const detail = await env.threads.detail(ACCOUNT, trip.id);
    expect(detail.messages.map((m) => [m.role, m.parts[0]])).toEqual([
      ['user', expect.objectContaining({ type: 'text', text: 'Where should I go?' })],
      ['assistant', expect.objectContaining({ type: 'text', text: 'Lisbon.' })],
    ]);
    const row = env.db.raw
      .prepare('SELECT metadata, created_at FROM thread WHERE id = ?')
      .get(trip.id) as {
      metadata: string;
      created_at: string;
    };
    expect(JSON.parse(row.metadata)).toEqual({
      imported: { importId: r.importId, source: `${join(paths.exports, 'chats.json')}#c-1` },
    });
    expect(row.created_at).toBe('2026-01-02T03:04:05.000Z');
    expect(
      env.db.raw
        .prepare('SELECT DISTINCT provenance FROM message WHERE thread_id = ?')
        .all(trip.id),
    ).toEqual([{ provenance: 'import' }]);
    expect(env.threads.search(ACCOUNT, 'Lisbon', { limit: 5 }).length).toBeGreaterThan(0);

    // The ledger, the event and the audit.
    const records = await svc.records(ACCOUNT);
    expect(records).toHaveLength(selectable.length);
    const statuses = env.db.raw
      .prepare(
        'SELECT item_kind, status, count(*) AS n FROM import_record GROUP BY 1, 2 ORDER BY 1, 2',
      )
      .all();
    expect(statuses).toEqual([
      { item_kind: 'instruction', status: 'imported', n: 2 },
      { item_kind: 'mcp_server', status: 'disabled_pending_permissions', n: 3 },
      { item_kind: 'memory', status: 'imported', n: 2 },
      { item_kind: 'plugin', status: 'disabled_pending_permissions', n: 2 },
      { item_kind: 'project', status: 'imported', n: 2 },
      { item_kind: 'skill', status: 'imported', n: 3 },
      { item_kind: 'thread', status: 'imported', n: 2 },
    ]);
    expect(
      records
        .filter((x) => x.kind === 'commands')
        .map((x) => x.target)
        .sort(),
    ).toEqual(['skill git-commit (from a command)', 'skill review-pr (from a command)']);
    const done = env.events.events.find((e) => e.name === 'import.completed');
    expect(done?.payload).toEqual({ ...r });
    expect(audit.find((a) => a.action === 'import.applied')).toMatchObject({
      kind: 'settings',
      resource: `import:${r.importId}`,
    });
    expect(audit.filter((a) => a.action === 'import.secret.moved')).toHaveLength(7);

    // No secret value survives anywhere but the vault.
    const dump =
      dumpDb() +
      JSON.stringify(audit) +
      JSON.stringify(logs.records) +
      JSON.stringify(env.events.events);
    for (const v of Object.values(SECRETS)) expect(dump, v).not.toContain(v);
  });

  it('marks everything as already imported on a second preview, and skips it on apply', async () => {
    const first = await svc.preview(ACCOUNT, { paths: [paths.home, paths.exports], kinds: ALL });
    await svc.apply(ACCOUNT, { previewId: first.previewId, items: first.items.map((i) => i.id) });
    const again = await svc.preview(ACCOUNT, { paths: [paths.home, paths.exports], kinds: ALL });
    const statuses = new Set(again.items.map((i) => i.status));
    expect(statuses).toEqual(new Set(['duplicate', 'unsupported']));
    expect(byName(again.items, 'github').note).toMatch(/already imported/);
    const r = await svc.apply(ACCOUNT, {
      previewId: again.previewId,
      items: again.items.map((i) => i.id),
    });
    expect(r).toMatchObject({ imported: 0, disabled: 0, secretsMigrated: 0 });
    expect(r.duplicates).toBe(again.items.filter((i) => i.status === 'duplicate').length);
    // Applying the same preview twice imports nothing the second time either.
    const r2 = await svc.apply(ACCOUNT, {
      previewId: first.previewId,
      items: first.items.map((i) => i.id),
    });
    expect(r2.imported).toBe(0);
    // A changed file is new again.
    put(paths.exports, 'memories.txt', '- Lives in Lisbon\n- Has a cat\n- Plays chess\n');
    const changed = await svc.preview(ACCOUNT, { paths: [paths.exports], kinds: ['memories'] });
    expect(changed.items.map((i) => i.status).sort()).toEqual(['duplicate', 'new']);
  });

  it('records a failed item, continues with the rest, and lets it be retried', async () => {
    const bare = makeService({ skills: defaultTargets().skills! });
    const p = await bare.preview(ACCOUNT, {
      paths: [paths.home],
      kinds: ['plugins', 'skills', 'projects'],
    });
    const r = await bare.apply(ACCOUNT, {
      previewId: p.previewId,
      items: p.items.map((i) => i.id),
    });
    expect(r.imported).toBe(2); // the skill and the project
    const failed = env.db.raw
      .prepare("SELECT target FROM import_record WHERE status = 'failed'")
      .all() as { target: string }[];
    expect(failed).toHaveLength(2);
    expect(failed[0]!.target).toMatch(/^not imported: plugins cannot be installed/);
    expect((await env.projects.list(ACCOUNT))[0]?.name).toBe('app');
    // The project was made without its folder, and says so.
    expect((await bare.records(ACCOUNT)).find((x) => x.kind === 'projects')?.target).toMatch(
      /folder not attached/,
    );
    // With the plugins area available, the failed plugins import on a fresh preview.
    const retry = await svc.preview(ACCOUNT, { paths: [paths.home], kinds: ['plugins'] });
    expect(retry.items.map((i) => i.status)).toEqual(['new', 'new']);
    expect(
      (
        await svc.apply(ACCOUNT, {
          previewId: retry.previewId,
          items: retry.items.map((i) => i.id),
        })
      ).imported,
    ).toBe(2);
  });

  it('refuses an expired, unknown or foreign preview and unknown items', async () => {
    const p = await svc.preview(ACCOUNT, { paths: [paths.exports], kinds: ['memories'] });
    await expect(svc.apply(ACCOUNT, { previewId: 'nope', items: ['i1'] })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      svc.apply('someone-else', { previewId: p.previewId, items: ['i1'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      svc.apply(ACCOUNT, { previewId: p.previewId, items: ['i99'] }),
    ).rejects.toMatchObject({ code: 'validation' });
    const quick = new ImportService({
      db: env.db,
      secrets: env.secrets,
      events: env.events,
      dataDir,
      memory: env.memory,
      projects: env.projects,
      previewTtlMs: -1,
    });
    const gone = await quick.preview(ACCOUNT, { paths: [paths.exports], kinds: ['memories'] });
    await expect(
      quick.apply(ACCOUNT, { previewId: gone.previewId, items: ['i1'] }),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'preview_expired' },
    });
  });

  it('attaches project folders through the workspace folder service', async () => {
    const service = new ProjectFolderService({
      db: env.db,
      events: env.events,
      dataDir,
      home: paths.home,
    });
    try {
      const withFolders = makeService({ ...defaultTargets(), folders: service });
      const p = await withFolders.preview(ACCOUNT, {
        paths: [paths.home],
        kinds: ['projects', 'instructions'],
      });
      const r = await withFolders.apply(ACCOUNT, {
        previewId: p.previewId,
        items: p.items
          .filter((i) => i.name === 'app' || i.name === 'app/AGENTS.md')
          .map((i) => i.id),
      });
      expect(r.imported).toBe(2);
      const app = (await env.projects.list(ACCOUNT)).find((x) => x.name === 'app')!;
      await service.idle();
      const list = await service.list(ACCOUNT, app.id);
      expect(list).toEqual([
        expect.objectContaining({ path: join(paths.home, 'code', 'app'), access: 'read' }),
      ]);
      expect((await withFolders.records(ACCOUNT)).find((x) => x.kind === 'projects')?.target).toBe(
        `project app with folder ${join(paths.home, 'code', 'app')}`,
      );
    } finally {
      await service.stop();
    }
  });

  it('puts instruction files of a known project folder into that project', async () => {
    const appDir = join(paths.home, 'code', 'app');
    const existing = await env.projects.create(ACCOUNT, {
      name: 'My app',
      instructions: 'Existing rules.',
    });
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        `INSERT INTO project_folder (id, project_id, path, access, index_status, file_count, created_at, updated_at)
         VALUES ('f1', ?, ?, 'read', 'ready', 0, ?, ?)`,
      )
      .run(existing.id, appDir, now, now);
    const p = await svc.preview(ACCOUNT, { paths: [appDir], kinds: ['instructions', 'projects'] });
    expect(p.items.map((i) => i.kind).sort()).toEqual(['instructions', 'projects']);
    await svc.apply(ACCOUNT, { previewId: p.previewId, items: p.items.map((i) => i.id) });
    expect((await svc.records(ACCOUNT)).find((x) => x.kind === 'projects')?.target).toBe(
      'project My app (it already has this folder)',
    );
    const after = await env.projects.get(ACCOUNT, existing.id);
    expect(after.instructions).toMatch(/^Existing rules\.\n\nUse pnpm\./);
    expect(await env.projects.list(ACCOUNT)).toHaveLength(1);
  });
});
