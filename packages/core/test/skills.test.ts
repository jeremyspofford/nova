// The skill index (FR-046, docs/08 §4): discovery across roots, precedence managed > project >
// user > plugin > built-in with shadowedBy, the enabled switch, the catalog budget, slash
// commands, resolve, skill.load and the user/project/import writes.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import {
  MemoryEventSink,
  SkillIndex,
  UnavailableSandbox,
  buildSkillCatalog,
  parseSkillId,
  skillCatalogChars,
  type IndexedSkill,
  type ToolContext,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const PROJECT = '01920000-0000-7000-8000-0000000000p1';

let dir: string;
let db: NovaDatabase;
let events: MemoryEventSink;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-skills-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  events = new MemoryEventSink();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(
  root: string,
  name: string,
  description = `The ${name} skill does a useful thing.`,
  body = `Body of ${name}.`,
  extra = '',
): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\ndescription: ${description}\n${extra}---\n${body}\n`);
  return d;
}

async function installPluginRow(
  pluginId: string,
  root: string,
  skills: { name: string; path: string }[],
  enabled = true,
) {
  const now = new Date().toISOString();
  await db.orm.insert(schema.pluginInstall).values({
    id: `p-${pluginId}`,
    accountId: ACCOUNT,
    pluginId,
    version: '1.0.0',
    source: 'local',
    origin: root,
    manifestJson: JSON.stringify({ id: pluginId, permissions: {} }),
    installPath: root,
    registrationsJson: JSON.stringify({
      servers: {},
      skills: skills.map((s) => ({ ...s, description: '', kind: 'skill' })),
      roles: [],
      hooks: [],
      trustedHooks: [],
      uiEntryPoints: 0,
      digest: '',
    }),
    enabled,
    installedAt: now,
    updatedAt: now,
  });
}

function makeIndex(over: Partial<ConstructorParameters<typeof SkillIndex>[0]> = {}) {
  return new SkillIndex({
    db,
    userDir: join(dir, 'user'),
    builtinDir: join(dir, 'builtin'),
    managedDir: () => join(dir, 'managed'),
    projectFolders: () =>
      Promise.resolve([
        { path: join(dir, 'proj-a') },
        { path: join(dir, 'proj-b'), access: 'read' },
      ]),
    events,
    log: new Logger({ module: 'test', sinks: [] }),
    ...over,
  });
}

function ctx(projectId: string | null = null): ToolContext {
  return {
    accountId: ACCOUNT,
    threadId: 't',
    turnId: 'u',
    callId: 'c',
    projectId,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: new UnavailableSandbox(),
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
  };
}

describe('skill ids', () => {
  it('parses every id form and refuses others', () => {
    expect(parseSkillId('skill:user:review')).toEqual({
      source: 'user',
      name: 'review',
      pluginId: null,
      projectId: null,
    });
    expect(parseSkillId('skill:com.example.dev:review')).toEqual({
      source: 'plugin',
      name: 'review',
      pluginId: 'com.example.dev',
      projectId: null,
    });
    expect(parseSkillId(`skill:project:${PROJECT}:review`)).toEqual({
      source: 'project',
      name: 'review',
      pluginId: null,
      projectId: PROJECT,
    });
    for (const bad of [
      'review',
      'skill:',
      'skill:user:Bad',
      'skill:nodots:x',
      'skill:project:x',
      'skill::x',
    ])
      expect(parseSkillId(bad), bad).toBeNull();
  });
});

describe('discovery and precedence', () => {
  it('orders managed > project > user > plugin > built-in and marks the shadowed', async () => {
    writeSkill(join(dir, 'builtin'), 'review', 'Built-in review skill for code.');
    writeSkill(join(dir, 'builtin'), 'docx', 'Write Word documents from Markdown.');
    writeSkill(join(dir, 'user'), 'review', 'My own review skill for code.');
    writeSkill(join(dir, 'user'), 'notes', 'Take notes in my personal format.');
    writeSkill(join(dir, 'proj-a', '.nova', 'skills'), 'notes', 'Project notes skill, near.');
    writeSkill(join(dir, 'proj-a', '.agents', 'skills'), 'notes', 'Project notes from .agents.');
    writeSkill(join(dir, 'proj-b', '.nova', 'skills'), 'deploy', 'Deploy this project to staging.');
    writeSkill(join(dir, 'managed'), 'policy', 'Company policy on data handling.');
    const plug = join(dir, 'plug');
    writeSkill(join(plug, 'skills'), 'review', 'Plugin review skill for code.');
    writeSkill(join(plug, 'skills'), 'lint', 'Lint the code with the plugin.');
    await installPluginRow('com.example.dev', plug, [
      { name: 'review', path: 'skills/review' },
      { name: 'lint', path: 'skills/lint' },
      { name: 'escape', path: '../outside' },
    ]);
    const idx = makeIndex();
    const global = await idx.list(ACCOUNT);
    const byId = new Map(global.map((s) => [s.id, s]));
    expect(byId.get('skill:user:review')?.active).toBe(true);
    expect(byId.get('skill:com.example.dev:review')?.shadowedBy).toBe('skill:user:review');
    expect(byId.get('skill:builtin:review')?.shadowedBy).toBe('skill:user:review');
    expect(byId.get('skill:managed:policy')?.active).toBe(true);
    expect(byId.get('skill:com.example.dev:lint')?.active).toBe(true);
    expect(global.some((s) => s.source === 'project')).toBe(false);

    const inProject = await idx.list(ACCOUNT, PROJECT);
    const notes = inProject.filter((s) => s.name === 'notes');
    // One project skill per name: `.nova` in the nearest folder wins over `.agents`.
    expect(notes.map((s) => [s.id, s.description, s.shadowedBy])).toEqual([
      [`skill:project:${PROJECT}:notes`, 'Project notes skill, near.', null],
      ['skill:user:notes', 'Take notes in my personal format.', `skill:project:${PROJECT}:notes`],
    ]);
    expect(inProject.find((s) => s.name === 'deploy')?.projectId).toBe(PROJECT);
  });

  it('lets a lower skill take over when the winner is disabled, and hides disabled plugins', async () => {
    writeSkill(join(dir, 'builtin'), 'review', 'Built-in review skill for code.');
    writeSkill(join(dir, 'user'), 'review', 'My own review skill for code.');
    const plug = join(dir, 'plug');
    writeSkill(join(plug, 'skills'), 'gone', 'A skill of a disabled plugin.');
    await installPluginRow('com.example.off', plug, [{ name: 'gone', path: 'skills/gone' }], false);
    const idx = makeIndex();
    const user = await idx.setEnabled(ACCOUNT, 'skill:user:review', false);
    expect(user).toMatchObject({ enabled: false, shadowedBy: null });
    const list = await idx.list(ACCOUNT);
    expect(list.find((s) => s.id === 'skill:builtin:review')).toMatchObject({
      active: true,
      shadowedBy: null,
    });
    expect(list.some((s) => s.pluginId === 'com.example.off')).toBe(false);
    expect(events.names()).toContain('skill.changed');
    await idx.setEnabled(ACCOUNT, 'skill:user:review', true);
    expect((await idx.list(ACCOUNT)).find((s) => s.id === 'skill:user:review')?.active).toBe(true);
  });

  it('never disables a managed skill and skips broken skills', async () => {
    writeSkill(join(dir, 'managed'), 'policy', 'Company policy on data handling.');
    mkdirSync(join(dir, 'user', 'broken'), { recursive: true });
    writeFileSync(join(dir, 'user', 'broken', 'SKILL.md'), 'no front-matter');
    mkdirSync(join(dir, 'user', '.hidden'), { recursive: true });
    writeFileSync(join(dir, 'user', 'loose-file.md'), 'x');
    const idx = makeIndex();
    await expect(idx.setEnabled(ACCOUNT, 'skill:managed:policy', false)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect((await idx.list(ACCOUNT)).map((s) => s.id)).toEqual(['skill:managed:policy']);
    await expect(idx.setEnabled(ACCOUNT, 'skill:user:nope', false)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(idx.get(ACCOUNT, 'not-an-id')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('re-reads a SKILL.md only when it changes', async () => {
    const d = writeSkill(join(dir, 'user'), 'notes', 'First description of the notes skill.');
    const idx = makeIndex();
    expect((await idx.list(ACCOUNT))[0]?.description).toBe('First description of the notes skill.');
    writeFileSync(
      join(d, 'SKILL.md'),
      '---\ndescription: Second, longer description of the notes skill.\n---\nx',
    );
    expect((await idx.list(ACCOUNT))[0]?.description).toBe(
      'Second, longer description of the notes skill.',
    );
  });

  it('reads project folders from the project_folder table when it exists', async () => {
    const idx = makeIndex({ projectFolders: undefined });
    writeSkill(join(dir, 'proj-a', '.nova', 'skills'), 'local', 'A project skill from the table.');
    expect(await idx.list(ACCOUNT, PROJECT)).toEqual([]);
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO project (id, account_id, name, kind, memory_scope, created_at, updated_at) VALUES (?, ?, 'P', 'chat', 'shared', ?, ?)",
      )
      .run(PROJECT, ACCOUNT, now, now);
    db.raw
      .prepare(
        'INSERT INTO project_folder (id, project_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('f1', PROJECT, join(dir, 'proj-a'), now, now);
    expect((await idx.list(ACCOUNT, PROJECT)).map((s) => s.id)).toEqual([
      `skill:project:${PROJECT}:local`,
    ]);
    // A read-only folder still takes a skill the user creates.
    const made = await idx.create(ACCOUNT, {
      name: 'made',
      description: 'Made by the user in a read folder.',
      body: 'x',
      projectId: PROJECT,
    });
    expect(made.id).toBe(`skill:project:${PROJECT}:made`);
    // Another account's project gives nothing.
    expect(await idx.list('someone-else', PROJECT)).toEqual([]);
    // Without the workspace tables there are no project folders.
    db.raw.exec('DROP TABLE project_folder_file; DROP TABLE project_folder');
    expect(await idx.list(ACCOUNT, PROJECT)).toEqual([]);
  });
});

describe('catalog section', () => {
  const fake = (name: string, rank: number, description: string): IndexedSkill => ({
    id: `skill:user:${name}`,
    name,
    description,
    whenToUse: null,
    allowedTools: [],
    modelHint: null,
    body: '',
    frontmatter: {},
    warnings: [],
    updatedAt: '',
    source: 'user',
    pluginId: null,
    projectId: null,
    dir: '',
    rank,
    order: 0,
    enabled: true,
    shadowedBy: null,
    active: true,
  });

  it('budgets 2 % of the window, at most 10,000 tokens, 8,000 characters when unknown', () => {
    expect(skillCatalogChars(0)).toBe(8000);
    expect(skillCatalogChars(Number.NaN)).toBe(8000);
    expect(skillCatalogChars(100_000)).toBe(2000 * 4);
    expect(skillCatalogChars(10_000_000)).toBe(10_000 * 4);
  });

  it('lists names and descriptions in a deterministic order, shortening then dropping', () => {
    const skills = [
      fake('zeta', 3, 'Zeta first sentence. Then a lot more detail about zeta that is long.'),
      fake('alpha', 3, 'Alpha first sentence! More alpha detail follows here.'),
      fake('managed', 1, 'Managed skill. Extra.'),
      { ...fake('hidden', 3, 'Not active.'), active: false },
    ];
    const full = buildSkillCatalog(skills, 10_000)!;
    expect(full.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- managed: Managed skill. Extra.',
      '- alpha: Alpha first sentence! More alpha detail follows here.',
      '- zeta: Zeta first sentence. Then a lot more detail about zeta that is long.',
    ]);
    expect(full).toContain('skill.load');
    const head = full.split('\n').slice(0, 2).join('\n').length;
    const short = buildSkillCatalog(skills, head + 90)!;
    expect(short).toContain('- alpha: Alpha first sentence!');
    expect(short).not.toContain('More alpha');
    const dropped = buildSkillCatalog(skills, head + 75)!;
    expect(dropped).toContain('- managed: Managed skill.');
    expect(dropped).toMatch(/more skills? available through \/skills/);
    expect(dropped).not.toContain('zeta');
    expect(buildSkillCatalog(skills, 10)).toBeNull();
    expect(buildSkillCatalog([], 10_000)).toBeNull();
  });

  it('builds the section for an account and keeps it within budget', async () => {
    for (let i = 0; i < 60; i++)
      writeSkill(
        join(dir, 'user'),
        `skill-${String(i).padStart(2, '0')}`,
        `Skill number ${i} does a thing. ${'More words. '.repeat(10)}`,
      );
    const idx = makeIndex();
    const text = await idx.catalogSection(ACCOUNT, null, 20_000);
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(skillCatalogChars(20_000));
    expect(text).toMatch(/available through \/skills/);
    expect(
      await makeIndex({ userDir: join(dir, 'empty') }).catalogSection(ACCOUNT, null, 50_000),
    ).toBeNull();
  });
});

describe('slash commands and resolve', () => {
  beforeEach(async () => {
    writeSkill(
      join(dir, 'user'),
      'review',
      'My own review skill for code.',
      'User review body.',
      'allowed_tools: [fs.read]\n',
    );
    const a = join(dir, 'plug-a');
    const b = join(dir, 'plug-b');
    writeSkill(join(a, 'skills'), 'review', 'Plugin A review skill for code.', 'A review body.');
    writeSkill(join(a, 'skills'), 'greet', 'Greet someone warmly by name.', 'A greet body.');
    writeSkill(join(b, 'skills'), 'greet', 'Greet from plugin B, also warm.', 'B greet body.');
    await installPluginRow('com.example.a', a, [
      { name: 'review', path: 'skills/review' },
      { name: 'greet', path: 'skills/greet' },
    ]);
    await installPluginRow('com.example.b', b, [{ name: 'greet', path: 'skills/greet' }]);
  });

  it('lists winners by bare name and plugin losers by their namespaced name', async () => {
    const items = await makeIndex().slashCommands(ACCOUNT);
    expect(items.map((s) => [s.name, s.skillId])).toEqual([
      ['com.example.a:review', 'skill:com.example.a:review'],
      ['com.example.b:greet', 'skill:com.example.b:greet'],
      ['greet', 'skill:com.example.a:greet'],
      ['review', 'skill:user:review'],
    ]);
  });

  it('resolves bare names, namespaced names and ids; disabled skills do not resolve', async () => {
    const idx = makeIndex();
    expect(await idx.resolve(ACCOUNT, null, 'review')).toMatchObject({
      skillId: 'skill:user:review',
      body: 'User review body.\n',
      allowedTools: ['fs.read'],
    });
    expect(await idx.resolve(ACCOUNT, null, '/greet')).toMatchObject({
      skillId: 'skill:com.example.a:greet',
    });
    expect(await idx.resolve(ACCOUNT, null, 'com.example.b:greet')).toMatchObject({
      body: 'B greet body.\n',
    });
    expect(await idx.resolve(ACCOUNT, null, 'skill:com.example.a:review')).toMatchObject({
      body: 'A review body.\n',
    });
    expect(await idx.resolve(ACCOUNT, null, 'missing')).toBeNull();
    await idx.setEnabled(ACCOUNT, 'skill:com.example.b:greet', false);
    expect(await idx.resolve(ACCOUNT, null, 'com.example.b:greet')).toBeNull();
  });
});

describe('skill.load', () => {
  it('is listed only while the account has a skill, and returns the body and file list', async () => {
    const empty = makeIndex({
      userDir: join(dir, 'none'),
      builtinDir: null,
      managedDir: undefined,
    });
    expect(await empty.tools.list(ACCOUNT)).toEqual([]);
    const d = writeSkill(
      join(dir, 'user'),
      'report',
      'Write a report from a template file.',
      'Use templates/report.md.',
    );
    mkdirSync(join(d, 'templates'));
    writeFileSync(join(d, 'templates', 'report.md'), '# Report template');
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    symlinkSync(join(dir, 'secret.txt'), join(d, 'link.txt'));
    const idx = makeIndex();
    const [tool] = await idx.tools.list(ACCOUNT);
    expect(tool?.descriptor).toMatchObject({
      name: 'skill.load',
      source: 'builtin',
      loading: 'always',
      annotations: { readOnly: true, action: 'read' },
    });
    const r = await tool!.handler({ name: 'report' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content[0]).toMatchObject({ type: 'text' });
      expect((r.content[0] as { text: string }).text).toContain('Use templates/report.md.');
      expect(r.meta).toMatchObject({
        skillId: 'skill:user:report',
        files: ['templates/report.md'],
      });
    }
    const f = await tool!.handler({ name: 'report', file: 'templates/report.md' }, ctx());
    expect(f.ok && (f.content[0] as { text: string }).text).toContain('# Report template');
    expect(await tool!.handler({ name: 'report', file: '../../secret.txt' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'skill.invalid_file' },
    });
    expect(await tool!.handler({ name: 'report', file: 'link.txt' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'skill.file_not_found' },
    });
    expect(await tool!.handler({ name: 'report', file: 'nope.md' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'skill.file_not_found' },
    });
    expect(await tool!.handler({ name: 'nope' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'skill.not_found' },
    });
  });
});

describe('writes', () => {
  it('creates, details and deletes a user skill', async () => {
    const idx = makeIndex();
    const v = await idx.create(ACCOUNT, {
      name: 'standup',
      description: 'Write my daily standup from the notes I give.',
      whenToUse: 'Every morning.',
      allowedTools: ['fs.read'],
      body: '1. Read.\n2. Write.',
    });
    expect(v).toMatchObject({
      id: 'skill:user:standup',
      source: 'user',
      allowedTools: ['fs.read'],
      whenToUse: 'Every morning.',
    });
    expect(readFileSync(join(dir, 'user', 'standup', 'SKILL.md'), 'utf8')).toContain('1. Read.');
    const detail = await idx.get(ACCOUNT, v.id);
    expect(detail).toMatchObject({ body: '1. Read.\n2. Write.', files: [] });
    await expect(
      idx.create(ACCOUNT, { name: 'standup', description: 'Again with the same name.', body: 'x' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      idx.create(ACCOUNT, { name: 'Bad', description: 'Bad name here.', body: 'x' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      idx.create(ACCOUNT, {
        name: 'huge',
        description: 'Too big to store.',
        body: 'x'.repeat(1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await idx.setEnabled(ACCOUNT, v.id, false);
    await idx.delete(ACCOUNT, v.id);
    expect(existsSync(join(dir, 'user', 'standup'))).toBe(false);
    expect(await db.orm.select().from(schema.skillState)).toEqual([]);
    expect(
      events.events.filter((e) => e.name === 'skill.changed').map((e) => e.payload.skillId),
    ).toEqual([v.id, v.id, v.id]);
  });

  it('creates project skills in the first writable project folder only', async () => {
    const idx = makeIndex();
    const v = await idx.create(ACCOUNT, {
      name: 'ship',
      description: 'Ship this project to staging.',
      body: 'Ship it.',
      projectId: PROJECT,
    });
    expect(v.id).toBe(`skill:project:${PROJECT}:ship`);
    expect(existsSync(join(dir, 'proj-a', '.nova', 'skills', 'ship', 'SKILL.md'))).toBe(true);
    await idx.delete(ACCOUNT, v.id);
    expect(existsSync(join(dir, 'proj-b', '.nova', 'skills', 'ship'))).toBe(false);
    const none = makeIndex({ projectFolders: () => Promise.resolve([]) });
    await expect(
      none.create(ACCOUNT, {
        name: 'x',
        description: 'No folders at all here.',
        body: 'x',
        projectId: PROJECT,
      }),
    ).rejects.toThrow(/add a local folder/);
  });

  it('refuses to delete built-in, managed and plugin skills', async () => {
    writeSkill(join(dir, 'builtin'), 'docx', 'Write Word documents from Markdown.');
    const idx = makeIndex();
    await expect(idx.delete(ACCOUNT, 'skill:builtin:docx')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(existsSync(join(dir, 'builtin', 'docx'))).toBe(true);
  });

  it('imports a skill folder with its files and shows it as an import', async () => {
    const src = writeSkill(join(dir, 'elsewhere'), 'review-pr', 'Review a pull request carefully.');
    mkdirSync(join(src, 'scripts'));
    writeFileSync(join(src, 'scripts', 'diff.sh'), 'echo diff');
    const idx = makeIndex();
    const v = await idx.importFolder(ACCOUNT, src, { provenance: { importId: 'i1' } });
    expect(v).toMatchObject({ id: 'skill:import:review-pr', source: 'import' });
    expect((await idx.get(ACCOUNT, v.id)).files).toEqual(['scripts/diff.sh']);
    const [state] = await db.orm.select().from(schema.skillState);
    expect(state).toMatchObject({ origin: 'import', provenanceJson: '{"importId":"i1"}' });
    await expect(idx.importFolder(ACCOUNT, src)).rejects.toMatchObject({ code: 'conflict' });
    await expect(idx.importFolder(ACCOUNT, join(dir, 'missing'))).rejects.toMatchObject({
      code: 'validation',
    });
    const cmd = await idx.create(
      ACCOUNT,
      { name: 'from-cmd', description: 'An imported command as a skill.', body: 'x' },
      { origin: 'import' },
    );
    expect(cmd.source).toBe('import');
    await idx.delete(ACCOUNT, v.id);
    void MemorySecretStore;
  });
});
