// "Build a plugin" (FR-050): plugin.scaffold writes a draft folder that the installer's own loader
// accepts, never installs it, refuses credentials in plugin files, and reports drafts that do
// not validate instead of hiding them.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLUGIN_DRAFTS_DIR,
  pluginFiles,
  pluginScaffoldTool,
  scaffoldPlugin,
} from '../src/documents/index.ts';
import { loadPluginFolder, type ToolContext } from '../src/index.ts';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nova-scaffold-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const REQUEST = {
  name: 'Release Notes',
  description: 'Drafts release notes from merged changes.',
  skills: [
    {
      name: 'release-notes',
      description: 'Write release notes from a list of changes, grouped by area.',
      whenToUse: 'When the user asks for release notes or a changelog.',
      allowedTools: ['fs.read', 'fs.search'],
      instructions: '# Release notes\n\nGroup changes by area: "quotes" and \\backslashes\\ stay.',
    },
  ],
  commands: [{ name: 'notes', description: 'Draft notes now', body: 'Draft the release notes.' }],
  mcpServer: {
    transport: 'stdio' as const,
    command: 'node',
    args: ['${pluginRoot}/server.js'],
    env: { API_KEY: 'secret://plugin/local.release-notes/api', MODE: 'fast' },
  },
};

describe('plugin.scaffold (FR-050)', () => {
  it('writes a draft the installer loader accepts', () => {
    const r = scaffoldPlugin(dataDir, REQUEST, { novaVersion: '0.5.0' });
    expect(r).toMatchObject({
      id: 'local.release-notes',
      path: join(dataDir, PLUGIN_DRAFTS_DIR, 'local.release-notes'),
      valid: true,
      errors: [],
      files: ['.nova-plugin/plugin.json', 'skills/release-notes/SKILL.md', 'commands/notes.md'],
    });
    const manifest = JSON.parse(readFileSync(join(r.path, '.nova-plugin/plugin.json'), 'utf8'));
    expect(manifest).toEqual({
      schemaVersion: 1,
      id: 'local.release-notes',
      name: 'Release Notes',
      version: '0.1.0',
      description: 'Drafts release notes from merged changes.',
      permissions: {},
      skills: ['skills/release-notes'],
      commands: ['commands/notes.md'],
      mcpServers: {
        'release-notes': {
          transport: 'stdio',
          command: 'node',
          args: ['${pluginRoot}/server.js'],
          env: { API_KEY: 'secret://plugin/local.release-notes/api', MODE: 'fast' },
        },
      },
    });
    const loaded = loadPluginFolder(r.path);
    expect(loaded.skills.map((s) => [s.kind, s.name, s.description])).toEqual([
      ['skill', 'release-notes', 'Write release notes from a list of changes, grouped by area.'],
      ['command', 'notes', 'Draft notes now'],
    ]);
    expect(loaded.skills[0]).toMatchObject({
      whenToUse: 'When the user asks for release notes or a changelog.',
      allowedTools: ['fs.read', 'fs.search'],
    });
    expect(loaded.skills[0]!.body).toContain('"quotes" and \\backslashes\\ stay.');
    expect(loaded.servers.map((s) => s.key)).toEqual(['release-notes']);
  });

  it('replaces an earlier draft and declares an http server host as a network permission', () => {
    scaffoldPlugin(dataDir, REQUEST);
    const r = scaffoldPlugin(dataDir, {
      name: 'Release Notes',
      description: 'Now remote.',
      mcpServer: { transport: 'http', url: 'https://notes.example.com:8443/mcp', name: 'remote' },
    });
    expect(r.valid).toBe(true);
    expect(existsSync(join(r.path, 'skills'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(r.path, '.nova-plugin/plugin.json'), 'utf8'));
    expect(manifest.permissions).toEqual({ network: ['notes.example.com:8443'] });
    expect(manifest.mcpServers).toEqual({
      remote: { transport: 'http', url: 'https://notes.example.com:8443/mcp' },
    });
    expect(manifest.skills).toBeUndefined();
  });

  it.each([
    [{ mcpServer: { transport: 'stdio' } }, /needs a command/],
    [{ mcpServer: { transport: 'stdio', command: 'x', url: 'https://a.example' } }, /not a url/],
    [{ mcpServer: { transport: 'http' } }, /needs a url/],
    [{ mcpServer: { transport: 'sse', url: 'https://a.example', command: 'x' } }, /not a command/],
    [
      {
        mcpServer: {
          transport: 'stdio',
          command: 'x',
          env: { TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        },
      },
      /looks like a credential/,
    ],
    [
      { mcpServer: { transport: 'stdio', command: 'x', env: { K: 'secret://plugin/other/key' } } },
      /may only reference secret:\/\/plugin\/local\.p\//,
    ],
    [
      {
        skills: [{ name: 'dup', description: 'one', instructions: 'a' }],
        commands: [{ name: 'dup', body: 'b' }],
      },
      /two skills or commands are named dup/,
    ],
    [
      {
        skills: [
          { name: 'a', description: 'x', instructions: 'y' },
          { name: 'a', description: 'x', instructions: 'y' },
        ],
      },
      /two skills or commands are named a/,
    ],
  ])('refuses an unsafe or incomplete request (%#)', (extra, message) => {
    expect(() => pluginFiles({ name: 'P', description: 'd', ...extra } as never)).toThrow(message);
    expect(existsSync(join(dataDir, PLUGIN_DRAFTS_DIR))).toBe(false);
  });

  it('keeps a draft that does not validate and says why', () => {
    const r = scaffoldPlugin(dataDir, {
      name: 'Escape',
      description: 'Points outside itself.',
      id: 'local.escape',
      mcpServer: { transport: 'stdio', command: 'node', args: ['${pluginRoot}/../outside.js'] },
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/mcpServers\.escape/);
    expect(existsSync(r.path)).toBe(true);
  });
});

describe('the plugin.scaffold tool (FR-050)', () => {
  const ctx = {} as ToolContext;

  it('reports a valid draft as not installed, with the path to install from', async () => {
    const tool = pluginScaffoldTool({ dataDir, novaVersion: '0.5.0' });
    expect(tool.descriptor).toMatchObject({
      name: 'plugin.scaffold',
      annotations: { action: 'write' },
    });
    const r = await tool.handler({ name: 'Tiny', description: 'A tiny plugin.' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain(
      `Drafted plugin local.tiny in ${join(dataDir, PLUGIN_DRAFTS_DIR, 'local.tiny')} (1 file); it validates.`,
    );
    expect(text).toContain('It is not installed');
    expect(r.meta).toMatchObject({ id: 'local.tiny', valid: true });
  });

  it('reports invalid drafts and invalid requests', async () => {
    const tool = pluginScaffoldTool({ dataDir });
    const bad = await tool.handler(
      {
        name: 'Esc',
        description: 'x',
        mcpServer: { transport: 'stdio', command: 'n', args: ['${pluginRoot}/../x'] },
      },
      ctx,
    );
    expect(bad.ok && (bad.content[0] as { text: string }).text).toMatch(
      /does not validate yet: .*Fix it/,
    );
    expect(
      await tool.handler(
        {
          name: 'X',
          description: 'y',
          skills: [{ name: 'Bad Name', description: 'd', instructions: 'i' }],
        },
        ctx,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'validation',
        message: expect.stringMatching(/^the plugin request is not valid: skills\.0\.name/),
      },
    });
    expect(
      await tool.handler({ name: 'X', description: 'y', mcpServer: { transport: 'http' } }, ctx),
    ).toMatchObject({
      ok: false,
      error: { code: 'validation', message: 'an http server needs a url' },
    });
  });
});
