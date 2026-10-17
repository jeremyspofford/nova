// Plugin manifests and folders (FR-045, docs/08 §3.1): schema validation with unknown fields
// refused, ids and versions, path safety (no `..`, no absolute paths, no link escapes), components
// (skills, commands, roles, hooks, servers) and hook content hashes (FR-197).
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expandPluginRoot,
  loadPluginFolder,
  pluginHookContentHash,
  pluginHookScriptPaths,
  validatePluginManifest,
} from '../src/index.ts';
import { satisfiesEngine } from '../src/plugins/manifest.ts';
import { resolveInside, treeDigest, walkTree } from '../src/plugins/paths.ts';

const SAMPLE = fileURLToPath(new URL('../../../examples/catalog/sample-plugin/', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-manifest-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function base(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'com.example.test',
    name: 'Test',
    version: '1.0.0',
    permissions: {},
    ...over,
  };
}

function plugin(
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  name = 'p',
): string {
  const root = join(dir, name);
  mkdirSync(join(root, '.nova-plugin'), { recursive: true });
  writeFileSync(join(root, '.nova-plugin', 'plugin.json'), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const SKILL = '---\ndescription: Review the code for bugs and style issues.\n---\nReview.\n';

describe('manifest schema', () => {
  it('accepts a minimal manifest and the full documented one', () => {
    expect(validatePluginManifest(base()).id).toBe('com.example.test');
    const full = base({
      description: 'd',
      author: { name: 'A', url: 'https://example.com' },
      license: 'MIT',
      engines: { nova: '>=0.0.0' },
      permissions: {
        network: ['api.github.com'],
        fs: ['${project}'],
        secrets: ['github.token'],
        tools: { 'plugin:com.example.test.lint': { action: 'read', default: 'allow' } },
        actionDefaults: { read: 'allow', delete: 'deny' },
        hooks: { answersAsks: false },
        ui: { connectDomains: ['api.github.com'] },
      },
      ui: { entryPoints: [{ kind: 'file', resource: 'ui://x/y', extensions: ['.lcov'] }] },
    });
    expect(() => validatePluginManifest(full)).not.toThrow();
  });

  it('refuses unknown fields, bad ids, bad versions and missing permissions', () => {
    const cases: [unknown, RegExp][] = [
      [base({ extra: 1 }), /additional properties.*extra/],
      [base({ id: 'NoDots' }), /id/],
      [base({ id: 'com.Example.x' }), /id/],
      [base({ version: '1.0' }), /version/],
      [{ ...base(), permissions: undefined }, /permissions/],
      [base({ permissions: { tools: { x: { action: 'fly' } } } }), /action/],
      [base({ schemaVersion: 2 }), /schemaVersion/],
    ];
    for (const [m, re] of cases) {
      let msg = '';
      try {
        validatePluginManifest(m);
      } catch (err) {
        msg = (err as Error).message;
        expect((err as { code?: string }).code).toBe('validation');
      }
      expect(msg, JSON.stringify(m)).toMatch(re);
    }
  });
});

describe('plugin folders', () => {
  it('loads the sample plugin with every component', () => {
    const p = loadPluginFolder(SAMPLE, { novaVersion: '0.5.0' });
    expect(p.manifest.id).toBe('com.example.sample');
    expect(p.skills.map((s) => [s.name, s.kind])).toEqual([
      ['summarize-notes', 'skill'],
      ['greet', 'command'],
    ]);
    expect(p.hooks).toHaveLength(1);
    expect(p.hooks[0]?.hook).toMatchObject({ id: 'check-fetch', event: 'tool.pre' });
    expect(p.hooks[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.servers.map((s) => s.key)).toEqual(['sample']);
    expect(p.uiEntryPoints.map((u) => u.resource)).toContain('ui://sample/panel');
  });

  it('reads roles and refuses broken ones', () => {
    const ok = plugin(base({ agents: ['agents/reviewer.md'] }), {
      'agents/reviewer.md':
        '---\nname: reviewer\ndescription: Reviews pull requests.\ntools: [fs.read, fs.search]\nmodel_hint: { reasoning: high }\n---\nYou review code.\n',
    });
    expect(loadPluginFolder(ok).roles).toEqual([
      {
        key: 'com.example.test:reviewer',
        name: 'reviewer',
        description: 'Reviews pull requests.',
        tools: ['fs.read', 'fs.search'],
        modelHint: 'reasoning: high',
        instructions: 'You review code.\n',
        sourcePath: 'agents/reviewer.md',
      },
    ]);
    const cases: [Record<string, string>, RegExp][] = [
      [{ 'agents/a.md': '---\nname: a\n---\nx' }, /description/],
      [{ 'agents/a.md': '---\nname: Bad\ndescription: d\n---\nx' }, /role name/],
      [{ 'agents/a.md': '---\ndescription: d\n---\n' }, /instructions/],
      [{ 'agents/a.md': '---\nname: [\n---\n' }, /unclosed/],
    ];
    cases.forEach(([files, re], i) => {
      const root = plugin(base({ agents: ['agents/a.md'] }), files, `r${i}`);
      expect(() => loadPluginFolder(root)).toThrow(re);
    });
    const dup = plugin(
      base({ agents: ['agents/a.md', 'agents/b.md'] }),
      {
        'agents/a.md': '---\nname: same\ndescription: d\n---\nx',
        'agents/b.md': '---\nname: same\ndescription: d\n---\nx',
      },
      'dup',
    );
    expect(() => loadPluginFolder(dup)).toThrow(/another role/);
  });

  it('keeps every path inside the plugin folder', () => {
    writeFileSync(join(dir, 'outside.md'), SKILL);
    mkdirSync(join(dir, 'outside-skill'));
    writeFileSync(join(dir, 'outside-skill', 'SKILL.md'), SKILL);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ skills: ['../outside-skill'] }, /leaves the plugin folder/],
      [{ skills: ['/etc'] }, /must be relative/],
      [{ commands: ['../outside.md'] }, /leaves the plugin folder/],
      [{ skills: ['skills/missing'] }, /does not exist/],
      [{ hooks: '../hooks.json' }, /leaves the plugin folder/],
      [{ agents: ['C:/x.md'] }, /must be relative/],
    ];
    cases.forEach(([over, re], i) => {
      const root = plugin(base(over), {}, `c${i}`);
      expect(() => loadPluginFolder(root), JSON.stringify(over)).toThrow(re);
    });
    // A link inside the plugin that points outside is refused, for components and for copies.
    const linked = plugin(base({ skills: ['skills/review'] }), {}, 'linked');
    mkdirSync(join(linked, 'skills'));
    symlinkSync(join(dir, 'outside-skill'), join(linked, 'skills', 'review'));
    expect(() => loadPluginFolder(linked)).toThrow(/points outside/);
    const stray = plugin(base(), {}, 'stray');
    symlinkSync(join(dir, 'outside.md'), join(stray, 'stray.md'));
    expect(() => walkTree(stray)).toThrow(/outside the plugin folder/);
    const inner = plugin(base(), { 'a.md': 'x' }, 'inner');
    symlinkSync(join(inner, 'a.md'), join(inner, 'b.md'));
    expect(walkTree(inner).map((e) => e.path)).toEqual([
      '.nova-plugin/plugin.json',
      'a.md',
      'b.md',
    ]);
    expect(() => resolveInside(dir, 'a\0b')).toThrow(/relative/);
    expect(resolveInside(dir, '${pluginRoot}/x/y')).toBe(join(dir, 'x', 'y'));
  });

  it('refuses broken skills and commands, duplicate names and the reserved folder', () => {
    const cases: [Record<string, unknown>, Record<string, string>, RegExp][] = [
      [{ skills: ['skills/a'] }, { 'skills/a/SKILL.md': 'no front-matter' }, /front-matter/],
      [{ skills: ['skills/a/SKILL.md'] }, { 'skills/a/SKILL.md': SKILL }, /not a folder/],
      [{ commands: ['commands/a.txt'] }, { 'commands/a.txt': 'x' }, /Markdown/],
      [{ commands: ['commands/a.md'] }, { 'commands/a.md': '---\nname: [\n---\n' }, /unclosed/],
      [
        { skills: ['skills/greet'], commands: ['commands/greet.md'] },
        { 'skills/greet/SKILL.md': SKILL, 'commands/greet.md': '# Greet\n\nSay hi to them.' },
        /another skill or command is named greet/,
      ],
      [{}, { '.nova-plugin/commands/x/SKILL.md': SKILL }, /reserved/],
    ];
    cases.forEach(([over, files, re], i) => {
      const root = plugin(base(over), files, `b${i}`);
      expect(() => loadPluginFolder(root), JSON.stringify(over)).toThrow(re);
    });
    expect(() => loadPluginFolder(join(dir, 'nope'))).toThrow(/not found/);
    const noManifest = join(dir, 'empty');
    mkdirSync(noManifest);
    expect(() => loadPluginFolder(noManifest)).toThrow(/plugin.json/);
    const badJson = plugin(base(), {}, 'badjson');
    writeFileSync(join(badJson, '.nova-plugin', 'plugin.json'), '{ nope');
    expect(() => loadPluginFolder(badJson)).toThrow(/not valid JSON/);
  });

  it('checks MCP servers: no devices, own secrets only, names distinct, root paths inside', () => {
    const srv = (s: Record<string, unknown>) => base({ mcpServers: s });
    const cases: [Record<string, unknown>, RegExp][] = [
      [srv({ a: { transport: 'stdio', command: 'node', deviceId: 'd1' } }), /deviceId/],
      [
        srv({ a: { transport: 'stdio', command: 'node', env: { T: 'secret://mcp/other/env/T' } } }),
        /own|secret:\/\/plugin/,
      ],
      [
        srv({
          a: { transport: 'http', url: 'https://x.example', headers: { A: 'secret://vault/x' } },
        }),
        /secret/,
      ],
      [
        srv({ a: { transport: 'http', url: 'https://x.example', auth: 'secret://other' } }),
        /secret/,
      ],
      [
        srv({
          'A b': { transport: 'stdio', command: 'x' },
          'a-b': { transport: 'stdio', command: 'y' },
        }),
        /distinct/,
      ],
      [
        srv({ a: { transport: 'stdio', command: 'node', args: ['${pluginRoot}/../escape.js'] } }),
        /leaves the plugin folder/,
      ],
      [srv({ a: { transport: 'stdio' } }), /command/],
    ];
    cases.forEach(([m, re], i) => {
      const root = plugin(m, {}, `s${i}`);
      expect(() => loadPluginFolder(root), JSON.stringify(m)).toThrow(re);
    });
    const ok = plugin(
      srv({
        a: {
          transport: 'stdio',
          command: 'node',
          env: { T: 'secret://plugin/com.example.test/token', L: 'debug' },
        },
      }),
      {},
      'ok',
    );
    expect(loadPluginFolder(ok).servers[0]?.key).toBe('a');
  });

  it('collects warnings without refusing', () => {
    const root = plugin(
      base({
        engines: { nova: '>=9.0.0' },
        permissions: {
          secrets: ['github.token'],
          hooks: { answersAsks: true },
          browserExtensions: ['helper'],
        },
        browserExtensions: [{ id: 'helper', path: 'ext' }],
        ui: { entryPoints: [{ kind: 'global', resource: 'ui://x/y' }] },
        skills: ['skills/short'],
      }),
      { 'ext/manifest.json': '{}', 'skills/short/SKILL.md': '---\ndescription: Short.\n---\nx' },
    );
    const w = loadPluginFolder(root, { novaVersion: '1.0.0' }).warnings.join('\n');
    expect(w).toMatch(/Nova >=9.0.0/);
    expect(w).toMatch(/secrets: github.token/);
    expect(w).toMatch(/answer approval questions/);
    expect(w).toMatch(/Browser extensions/);
    expect(w).toMatch(/UI entry points need an MCP server/);
    expect(w).toMatch(/description is short/);
    const undeclared = plugin(base({ permissions: { browserExtensions: ['ghost'] } }), {}, 'ghost');
    expect(() => loadPluginFolder(undeclared)).toThrow(/not declared/);
  });

  it('compares engine ranges', () => {
    expect(satisfiesEngine('>=0.5.0', '0.5.0')).toBe(true);
    expect(satisfiesEngine('>=0.5.0', '0.4.9')).toBe(false);
    expect(satisfiesEngine('>0.5.0', '0.5.0')).toBe(false);
    expect(satisfiesEngine('1.2.3', '1.2.3-dev')).toBe(true);
    expect(satisfiesEngine('^1.0.0', '1.0.0')).toBeNull();
    expect(satisfiesEngine('>=1.0.0', 'dev')).toBeNull();
  });
});

describe('hooks', () => {
  const hooksFile = (hooks: unknown[]) => JSON.stringify({ hooks });
  const hook = {
    id: 'check',
    event: 'tool.pre',
    handler: { type: 'command', command: ['node', 'hooks/check.mjs'] },
  };

  it('validates hook files and refuses duplicate ids', () => {
    const bad = plugin(
      base({ hooks: 'hooks/hooks.json' }),
      { 'hooks/hooks.json': hooksFile([{ id: 'x', event: 'nope', handler: {} }]) },
      'bad',
    );
    expect(() => loadPluginFolder(bad)).toThrow(/hooks file/);
    const dup = plugin(base({ hooks: [hook, hook] }), {}, 'dup');
    expect(() => loadPluginFolder(dup)).toThrow(/duplicate hook id/);
    const missing = plugin(base({ hooks: 'hooks/none.json' }), {}, 'missing');
    expect(() => loadPluginFolder(missing)).toThrow(/does not exist/);
  });

  it('hashes the definition and the scripts it runs inside the folder', () => {
    const root = plugin(base({ hooks: 'hooks/hooks.json' }), {
      'hooks/hooks.json': hooksFile([hook]),
      'hooks/check.mjs': 'console.log(1)',
    });
    const h = loadPluginFolder(root).hooks[0]!;
    expect(pluginHookScriptPaths(h.hook, root)).toEqual([join(root, 'hooks', 'check.mjs')]);
    // Same files elsewhere hash the same: the hash does not depend on where the plugin lives.
    const copy = join(dir, 'copy');
    cpSync(root, copy, { recursive: true });
    expect(pluginHookContentHash(h.hook, copy)).toBe(h.contentHash);
    writeFileSync(join(copy, 'hooks', 'check.mjs'), 'console.log(2)');
    expect(pluginHookContentHash(h.hook, copy)).not.toBe(h.contentHash);
    const edited = { ...h.hook, failClosed: true };
    expect(pluginHookContentHash(edited, root)).not.toBe(h.contentHash);
    const mcpHook = {
      id: 'm',
      event: 'tool.pre',
      handler: { type: 'mcp_tool' as const, tool: 'mcp:guard.check' },
    };
    expect(pluginHookScriptPaths(mcpHook, root)).toEqual([]);
    expect(
      pluginHookScriptPaths(
        {
          ...hook,
          handler: {
            type: 'command',
            command: ['node', '--flag', '../x', '${pluginRoot}/hooks/check.mjs'],
          },
        } as never,
        root,
      ),
    ).toEqual([join(root, 'hooks', 'check.mjs')]);
    expect(expandPluginRoot('${pluginRoot}/a ${pluginRoot}/b', '/r')).toBe('/r/a /r/b');
  });

  it('gives the same tree digest for the same files and a new one after a change', () => {
    const root = plugin(base(), { 'a.txt': 'one' });
    const d1 = treeDigest(walkTree(root));
    expect(treeDigest(walkTree(root))).toBe(d1);
    writeFileSync(join(root, 'a.txt'), 'two');
    expect(treeDigest(walkTree(root))).not.toBe(d1);
    expect(() => walkTree(root, { files: 1, bytes: 1e9, depth: 8 })).toThrow(/more than 1 files/);
    expect(() => walkTree(root, { files: 100, bytes: 2, depth: 8 })).toThrow(/larger than/);
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c'), 'x');
    expect(() => walkTree(root, { files: 100, bytes: 1e9, depth: 1 })).toThrow(/too deep/);
  });
});
