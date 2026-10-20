// extension.json and `nova validate` (FR-117; docs/14 §4.2-§4.3): the schema, filesystem scopes,
// panel CSP domains within the declared network permissions, hook ids and hashes (the bundle digest
// is part of an SDK hook's hash), observable events, tool names, the permission lines and their
// diff, and the validator that lists manifest, permission, CSP-domain, hook, syntax and import
// problems at once, for folders and signed bundles.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXTENSION_SIGNATURE_FILE,
  domainCovered,
  eventAllowed,
  extensionHookHash,
  extensionManifestIssues,
  extensionPermissionDiff,
  extensionPermissionLines,
  extensionToolName,
  fsScopeIssues,
  generatePublisherKeyPair,
  hostDeclared,
  loadExtensionFolder,
  observableEventsFor,
  panelDomainIssues,
  parseExtensionManifest,
  parseExtensionToolName,
  readPanelHtml,
  validateExtension,
  type ExtensionManifest,
} from '../src/index.ts';
import { HELLO_DIR, copyHello, packFolder, probeExtension, tempDir, writeTree } from './sdk-env.ts';

let dir: string;
beforeEach(() => {
  dir = tempDir('nova-sdk-manifest-');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = (permissions: Record<string, unknown> = {}): unknown => ({
  api: 1,
  entry: 'main.js',
  permissions,
});

describe('extension.json', () => {
  it('accepts the sample and refuses unknown keys, versions and bad shapes', () => {
    const sample = loadExtensionFolder(HELLO_DIR);
    expect(sample.manifest.api).toBe(1);
    expect(Object.keys(sample.sources)).toContain('extension.js');
    expect(sample.plugin.manifest.id).toBe('com.example.hello');
    expect(extensionManifestIssues(base())).toEqual([]);
    expect(extensionManifestIssues({ ...(base() as object), api: 2 })[0]?.where).toBe(
      'extension.json.api',
    );
    expect(extensionManifestIssues({ ...(base() as object), extra: 1 })).not.toEqual([]);
    expect(extensionManifestIssues(base({ network: ['http://x.com/path'] }))).not.toEqual([]);
    expect(
      extensionManifestIssues(base({ tools: { 'bad name': { action: 'read' } } })),
    ).not.toEqual([]);
    expect(extensionManifestIssues(base({ commands: ['Bad Id'] }))).not.toEqual([]);
    expect(
      extensionManifestIssues(
        base({
          panels: [
            { id: 'p', title: 'P', resource: 'ui://x/p', entryPoint: 'file', file: 'p.html' },
          ],
        }),
      )[0]?.message,
    ).toMatch(/extensions is required/);
    expect(extensionManifestIssues({ ...(base() as object), entry: '../x.js' })).not.toEqual([]);
    expect(() => parseExtensionManifest({})).toThrow(/extension.json/);
  });

  it('scopes, domains, events and names', () => {
    const m = parseExtensionManifest(
      base({
        network: ['api.example.com', '*.cdn.example.com'],
        fs: [
          '${extensionData}',
          '/srv/x',
          { path: '${extensionRoot}', write: true },
          'rel/path',
          '${home}/x',
        ],
        panels: [
          {
            id: 'p',
            title: 'P',
            resource: 'ui://x/p',
            entryPoint: 'global',
            file: 'p.html',
            connectDomains: ['https://api.example.com', 'evil.com'],
            resourceDomains: ['*.cdn.example.com', 'img.cdn.example.com:8443'],
          },
        ],
        events: ['run.*', 'tool.call'],
      }),
    );
    expect(fsScopeIssues(m).map((i) => i.message)).toEqual([
      'the extension folder is read-only',
      'a folder must be an absolute path',
      'only ${extensionData} and ${extensionRoot} may be used as variables',
    ]);
    expect(panelDomainIssues(m)).toEqual([
      {
        where: 'permissions.panels.0.connectDomains',
        message: 'evil.com is not within the declared network permissions',
      },
    ]);
    expect(domainCovered('x.example.com', ['*'])).toBe(false);
    expect(domainCovered('example.com', ['*.example.com'])).toBe(false);
    expect(domainCovered('not a domain', ['x'])).toBe(false);
    expect(hostDeclared(['*.example.com'], 'a.example.com')).toBe(true);
    expect(hostDeclared(['*.example.com'], 'example.org')).toBe(false);
    expect(observableEventsFor('tool.call')).toEqual(['tool.call.completed']);
    expect(observableEventsFor('nope.*')).toEqual([]);
    expect(eventAllowed(['run.*'], 'run.end')).toBe(true);
    expect(eventAllowed(['run.end'], 'run.*')).toBe(false);
    expect(eventAllowed(['run.*'], 'chat.message.created')).toBe(false);
    expect(extensionToolName('com.a.b', 'go')).toBe('ext:com.a.b/go');
    expect(parseExtensionToolName('ext:com.a.b/go')).toEqual({
      extensionId: 'com.a.b',
      name: 'go',
      hook: null,
    });
    expect(parseExtensionToolName('ext:com.a.b/hooks/h-1')).toEqual({
      extensionId: 'com.a.b',
      name: 'h-1',
      hook: 'h-1',
    });
    expect(parseExtensionToolName('mcp:a.b')).toBeNull();
  });

  it("an SDK hook's hash covers its definition and the bundle digest", () => {
    const h = { id: 'h', event: 'tool.post' as const };
    const a = extensionHookHash('com.a.b', h, 'a'.repeat(64));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(extensionHookHash('com.a.b', h, 'b'.repeat(64))).not.toBe(a);
    expect(extensionHookHash('com.a.b', { ...h, matcher: 'x' }, 'a'.repeat(64))).not.toBe(a);
  });

  it('describes permissions in plain words and diffs two versions', () => {
    const loaded = loadExtensionFolder(HELLO_DIR);
    const lines = extensionPermissionLines(loaded.manifest, loaded.plugin.manifest);
    const texts = lines.map((l) => l.text);
    expect(texts).toContain('Reach api.example.com over the network');
    expect(texts).toContain('Read and write its own data folder');
    expect(texts).toContain('Offer the tool greet to models (reads; allowed without asking)');
    expect(texts).toContain('Offer the tool save_note to models (changes things; asks you first)');
    expect(lines.find((l) => l.kind === 'secret')?.sensitive).toBe(true);
    const next = {
      ...loaded.manifest,
      permissions: { ...loaded.manifest.permissions, network: ['api.example.com', 'evil.com'] },
    } as ExtensionManifest;
    const diff = extensionPermissionDiff(
      lines,
      extensionPermissionLines(next, loaded.plugin.manifest),
    );
    expect(diff.added.map((l) => l.key)).toEqual(['network:evil.com']);
    expect(diff.removed).toEqual([]);
  });

  it('refuses scopes, domains and hook ids that conflict when a folder loads', () => {
    const root = copyHello(dir);
    const file = join(root, '.nova-plugin', 'extension.json');
    const m = JSON.parse(JSON.stringify(loadExtensionFolder(root).manifest)) as {
      permissions: { hooks: unknown[] };
    };
    m.permissions.hooks.push({ id: 'note-greetings', event: 'stop' });
    writeFileSync(file, JSON.stringify(m));
    expect(() => loadExtensionFolder(root)).toThrow(/used twice/);
    expect(
      readPanelHtml(HELLO_DIR, loadExtensionFolder(HELLO_DIR).manifest.permissions.panels![0]!),
    ).toContain('<html');
  });
});

describe('nova validate', () => {
  it('passes the sample with a summary and its warnings', async () => {
    const v = await validateExtension(HELLO_DIR);
    expect(v.errors).toEqual([]);
    expect(v).toMatchObject({
      ok: true,
      id: 'com.example.hello',
      version: '1.0.0',
      signature: null,
      summary: { commands: 1, panels: 1, tools: 3, hooks: 1, events: 1, skills: 0, mcpServers: 0 },
    });
    expect(v.warnings.join('\n')).toMatch(/secrets/);
  });

  it('lists manifest, permission, CSP-domain, hook, syntax and import problems together', async () => {
    const root = probeExtension(dir, {
      code: "import x from 'left-pad';\nimport './missing.js';\nexport function activate( {\n",
      permissions: {
        network: ['api.example.com'],
        fs: ['relative/path'],
        panels: [
          {
            id: 'p',
            title: 'P',
            resource: 'ui://probe/p',
            entryPoint: 'global',
            file: 'p.html',
            connectDomains: ['evil.com'],
          },
        ],
        hooks: [
          { id: 'h', event: 'tool.pre' },
          { id: 'h', event: 'stop' },
        ],
        events: ['nothing.here'],
        commands: ['a', 'a'],
      },
    });
    writeTree(root, { 'lib.js': 'export const ok = 1;' });
    const v = await validateExtension(root);
    expect(v.ok).toBe(false);
    const all = v.errors.map((e) => `${e.where}: ${e.message}`).join('\n');
    expect(all).toMatch(/permissions\.fs\.0: a folder must be an absolute path/);
    expect(all).toMatch(/connectDomains: evil\.com is not within the declared network/);
    expect(all).toMatch(/panel p does not exist|p\.html/);
    expect(all).toMatch(/permissions\.hooks\.h: this hook id is used twice/);
    expect(all).toMatch(/nothing\.here is not an event extensions can observe/);
    expect(all).toMatch(/a command id is listed twice/);
    expect(all).toMatch(/main\.js: SyntaxError/);
    expect(all).toMatch(/cannot import left-pad/);
    expect(all).toMatch(/cannot import \.\/missing\.js/);
  });

  it('reports a broken plugin.json, a missing or invalid extension.json', async () => {
    const root = writeTree(join(dir, 'broken'), {
      '.nova-plugin/plugin.json': { schemaVersion: 1, id: 'Bad Id' },
      'main.js': 'export function activate() {}',
    });
    const v = await validateExtension(root);
    expect(v.errors.map((e) => e.where)).toEqual([
      '.nova-plugin/plugin.json',
      '.nova-plugin/extension.json',
    ]);
    writeTree(root, { '.nova-plugin/extension.json': '{ not json' });
    expect((await validateExtension(root)).errors[1]?.message).toMatch(/not valid JSON/);
    writeTree(root, { '.nova-plugin/extension.json': { api: 1 } });
    expect(
      (await validateExtension(root)).errors.some((e) => e.where.startsWith('extension.json')),
    ).toBe(true);
    expect((await validateExtension(join(dir, 'nowhere'))).errors[0]?.message).toMatch(
      /does not exist/,
    );
  });

  it('checks a bundle: its signature, and the files inside', async () => {
    const key = generatePublisherKeyPair();
    const file = join(dir, 'hello.novax');
    writeFileSync(file, packFolder(HELLO_DIR, key.privateKeyPem));
    const trusted = await validateExtension(file, { trusted: [{ key: key.publicKey }] });
    expect(trusted).toMatchObject({
      ok: true,
      signature: { status: 'verified', publisher: key.publicKey },
    });
    const unknown = await validateExtension(file);
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings[0]).toMatch(/^Unverified/);
    // Tampered: swap a file but keep the signature.
    const { strToU8, zipSync, unzipSync } = await import('fflate');
    const entries = unzipSync(packFolder(HELLO_DIR, key.privateKeyPem));
    entries['extension.js'] = strToU8('export function activate() {}');
    expect(entries[EXTENSION_SIGNATURE_FILE]).toBeDefined();
    writeFileSync(file, zipSync(entries));
    const tampered = await validateExtension(file, { trusted: [{ key: key.publicKey }] });
    expect(tampered.ok).toBe(false);
    expect(tampered.errors[0]).toEqual({
      where: 'signature',
      message: 'the bundle was changed after it was signed',
    });
    writeFileSync(file, 'not a zip');
    expect((await validateExtension(file)).errors[0]?.where).toBe('bundle');
  });
});
