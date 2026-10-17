// MCP bundles (FR-199): reading with caps and path checks, manifest validation with named errors,
// signatures, extraction, user config and the launch line. Archives are built in memory from
// examples/bundles/hello; no binary is committed.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundleLaunch,
  bundleServerName,
  bundleSignature,
  compatibilityProblems,
  expandTemplate,
  extractBundle,
  manifestWarnings,
  parseManifest,
  readBundle,
  resolveUserConfig,
  safeEntryName,
  splitSignature,
  whichOnPath,
  type LaunchEnvironment,
} from '../src/index.ts';
import { SAMPLE_BUNDLE, sampleZip } from './bundle-fixture.ts';

const sample = () =>
  parseManifest(JSON.parse(readFileSync(join(SAMPLE_BUNDLE, 'manifest.json'), 'utf8')));

const ENV: LaunchEnvironment = {
  platform: 'linux',
  home: '/home/someone',
  nodePath: '/opt/nova/node',
  which: (p) => (p === 'python3' ? '/usr/bin/python3' : null),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-bundle-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reading a bundle', () => {
  it('reads the sample: manifest, entries and checksum', () => {
    const bytes = sampleZip();
    const b = readBundle(bytes);
    expect(b.manifest).toMatchObject({
      manifestVersion: '0.3',
      name: 'nova-hello',
      displayName: 'Hello (sample bundle)',
      version: '1.0.0',
      author: 'Nova contributors',
      server: { type: 'node', entryPoint: 'server/index.mjs' },
    });
    expect(Object.keys(b.manifest.userConfig)).toEqual(['greeting', 'api_key', 'notes_dir']);
    expect(b.manifest.userConfig.api_key).toMatchObject({ sensitive: true, required: false });
    expect(b.manifest.tools.map((t) => t.name)).toEqual(['greet', 'settings_check']);
    expect(b.entries.map((e) => e.name).sort()).toEqual(['manifest.json', 'server/index.mjs']);
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.signed).toBe(false);
    expect(bundleSignature(b, [])).toBe('unverified');
  });

  it('refuses what is not a zip or has no manifest', () => {
    expect(() => readBundle(strToU8('not a zip at all'))).toThrow(/not a valid zip/);
    expect(() => readBundle(zipSync({ 'readme.txt': strToU8('x') }))).toThrow(/no manifest.json/);
    expect(() => readBundle(zipSync({ 'manifest.json': strToU8('{oops') }))).toThrow(
      /not valid JSON/,
    );
  });

  it.each([['../evil.txt'], ['/etc/passwd'], ['a/../../b'], ['C:/windows/x'], ['dir\\file']])(
    'refuses the unsafe path %s',
    (name) => {
      const bytes = sampleZip((files) => {
        files[name] = strToU8('x');
      });
      expect(() => readBundle(bytes)).toThrow(/unsafe path/);
    },
  );

  it('caps the file count and the unpacked size', () => {
    const bytes = sampleZip((files) => {
      for (let i = 0; i < 5; i++) files[`extra/${i}.txt`] = strToU8('data');
    });
    expect(() => readBundle(bytes, { maxFiles: 3, maxTotalBytes: 1e9, maxFileBytes: 1e9 })).toThrow(
      /more than 3 files/,
    );
    expect(() =>
      readBundle(bytes, { maxFiles: 100, maxTotalBytes: 50, maxFileBytes: 1e9 }),
    ).toThrow(/unpacks to more than/);
    expect(() =>
      readBundle(bytes, { maxFiles: 100, maxTotalBytes: 1e9, maxFileBytes: 100 }),
    ).toThrow(/larger than/);
  });

  it('names an unsupported manifest version or server type', () => {
    expect(() => readBundle(sampleZip((_f, m) => void (m.manifest_version = '0.1')))).toThrow(
      /manifest version 0.1 is not supported/,
    );
    expect(() =>
      readBundle(sampleZip((_f, m) => void ((m.server as Record<string, unknown>).type = 'ruby'))),
    ).toThrow(/server type ruby is not supported/);
    expect(() =>
      readBundle(sampleZip((_f, m) => void ((m.server as Record<string, unknown>).type = 'uv'))),
    ).toThrow(/uv needs manifest version 0.4/);
  });

  it('checks required fields, the version and the entry point', () => {
    expect(() => readBundle(sampleZip((_f, m) => void delete m.author))).toThrow(/missing author/);
    expect(() => readBundle(sampleZip((_f, m) => void (m.version = 'one')))).toThrow(
      /not a semantic version/,
    );
    expect(() =>
      readBundle(
        sampleZip(
          (_f, m) =>
            void ((m.server as Record<string, unknown>).entry_point = 'server/missing.mjs'),
        ),
      ),
    ).toThrow(/entry point server\/missing.mjs is not in the bundle/);
    expect(() =>
      readBundle(sampleZip((_f, m) => void (m.user_config = { k: { type: 'color', title: 'K' } }))),
    ).toThrow(/unknown type color/);
    expect(() =>
      readBundle(
        sampleZip(
          (_f, m) =>
            void ((
              m.server as { mcp_config: Record<string, unknown> }
            ).mcp_config.platform_overrides = {
              beos: {},
            }),
        ),
      ),
    ).toThrow(/unknown platform beos/);
  });

  it('keeps unknown manifest fields', () => {
    const b = readBundle(sampleZip((_f, m) => void (m.x_custom = { kept: true })));
    expect(b.manifest.raw.x_custom).toEqual({ kept: true });
  });

  it('safeEntryName normalizes harmless names', () => {
    expect(safeEntryName('./a/./b.txt')).toBe('a/b.txt');
    expect(safeEntryName('dir/')).toBe('dir/');
    expect(safeEntryName('')).toBeNull();
    expect(safeEntryName('a\0b')).toBeNull();
  });
});

describe('signatures', () => {
  it('splits a trailing signature block and verifies only with a trusted publisher', () => {
    const zip = sampleZip();
    const signed = Buffer.concat([
      Buffer.from(zip),
      Buffer.from('MCPB_SIG_V1'),
      Buffer.from('sig'),
      Buffer.from('MCPB_SIG_END'),
    ]);
    const split = splitSignature(signed);
    expect(Buffer.from(split.signature!).toString()).toBe('sig');
    expect(split.archive.length).toBe(zip.length);
    const b = readBundle(signed);
    expect(b.signed).toBe(true);
    expect(bundleSignature(b, [])).toBe('unverified');
    const trusted = { id: 'p', verify: () => true };
    const broken = {
      id: 'q',
      verify: () => {
        throw new Error('bad');
      },
    };
    expect(bundleSignature(b, [broken, trusted])).toBe('verified');
    expect(bundleSignature(readBundle(zip), [trusted])).toBe('unverified');
    expect(splitSignature(strToU8('MCPB_SIG_END')).signature).toBeNull();
  });
});

describe('extraction', () => {
  it('writes every file inside the destination, never over an existing one', () => {
    const b = readBundle(sampleZip());
    const dest = join(dir, 'nova-hello', '1.0.0');
    expect(extractBundle(b, dest)).toBe(2);
    expect(readFileSync(join(dest, 'server', 'index.mjs'), 'utf8')).toContain('tools/list');
    expect(statSync(join(dest, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(() => extractBundle(b, dest)).toThrow(/could not be unpacked/);
  });

  it('refuses entries that clash with a folder', () => {
    const zip = sampleZip((files) => {
      files.clash = strToU8('file');
      files['clash/inner.txt'] = strToU8('inner');
    });
    const b = readBundle(zip);
    expect(() => extractBundle(b, join(dir, 'x'))).toThrow(/could not be unpacked/);
  });
});

describe('user config and templates', () => {
  it('fills defaults and checks types, ranges and paths', () => {
    const m = sample();
    expect(resolveUserConfig(m, {})).toEqual({ greeting: 'Hello' });
    expect(resolveUserConfig(m, { greeting: 'Hi', api_key: 'k', notes_dir: '/srv/notes' })).toEqual(
      {
        greeting: 'Hi',
        api_key: 'k',
        notes_dir: '/srv/notes',
      },
    );
    expect(() => resolveUserConfig(m, { notes_dir: 'relative/path' })).toThrow(/absolute path/);
    expect(() => resolveUserConfig(m, { nope: 1 })).toThrow(/unknown setting nope/);
    expect(() => resolveUserConfig(m, { greeting: 5 })).toThrow(/must be text/);
    const typed = {
      userConfig: {
        n: {
          type: 'number' as const,
          title: 'N',
          required: true,
          sensitive: false,
          multiple: false,
          min: 1,
          max: 5,
        },
        b: {
          type: 'boolean' as const,
          title: 'B',
          required: false,
          sensitive: false,
          multiple: false,
        },
        dirs: {
          type: 'directory' as const,
          title: 'Dirs',
          required: false,
          sensitive: false,
          multiple: true,
        },
        one: {
          type: 'file' as const,
          title: 'One',
          required: false,
          sensitive: false,
          multiple: false,
        },
      },
    };
    expect(() => resolveUserConfig(typed, {})).toThrow(/N is required/);
    expect(resolveUserConfig(typed, { n: '3', b: false, dirs: ['/a', '/b'] })).toEqual({
      n: 3,
      b: false,
      dirs: ['/a', '/b'],
    });
    expect(() => resolveUserConfig(typed, { n: 9 })).toThrow(/at most 5/);
    expect(() => resolveUserConfig(typed, { n: 0 })).toThrow(/at least 1/);
    expect(() => resolveUserConfig(typed, { n: 'x' })).toThrow(/must be a number/);
    expect(() => resolveUserConfig(typed, { n: 2, b: 'yes' })).toThrow(/true or false/);
    expect(() => resolveUserConfig(typed, { n: 2, one: ['/a', '/b'] })).toThrow(/takes one value/);
  });

  it('expands templates into argv elements without a shell', () => {
    const ctx = { dir: '/b', home: '/h', values: { many: ['x', 'y'], one: 'v w' } };
    expect(expandTemplate('${__dirname}/s.js', ctx)).toEqual(['/b/s.js']);
    expect(expandTemplate('${user_config.many}', ctx)).toEqual(['x', 'y']);
    expect(expandTemplate('--a=${user_config.one}', ctx)).toEqual(['--a=v w']);
    expect(expandTemplate('${user_config.unset}', ctx)).toEqual([]);
    expect(expandTemplate('${MYSTERY}', ctx)).toEqual(['${MYSTERY}']);
    expect(expandTemplate('$(rm -rf /)', ctx)).toEqual(['$(rm -rf /)']);
    expect(expandTemplate('${HOME}${/}docs', ctx)[0]).toMatch(/^\/h.docs$/);
    expect(expandTemplate('${DOCUMENTS}', ctx)).toEqual(['/h/Documents']);
  });

  it('builds the launch line: the Hub runtime for node, env expanded, secrets tracked', () => {
    const m = sample();
    const l = bundleLaunch(m, '/data/b', { greeting: 'Hi', api_key: 'sk-1' }, ENV);
    expect(l).toEqual({
      command: '/opt/nova/node',
      args: ['/data/b/server/index.mjs'],
      env: { HELLO_GREETING: 'Hi', HELLO_API_KEY: 'sk-1', HELLO_NOTES_DIR: '' },
      secretArgs: [],
      secretEnv: ['HELLO_API_KEY'],
    });
    const leaky = parseManifest({
      ...m.raw,
      server: {
        type: 'python',
        entry_point: 'server/index.mjs',
        mcp_config: {
          command: 'python3',
          args: ['main.py', '--key', '${user_config.api_key}'],
          platform_overrides: { darwin: { command: 'python3.12' } },
        },
      },
    });
    const p = bundleLaunch(leaky, '/data/b', { api_key: 'sk-2' }, ENV);
    expect(p).toMatchObject({
      command: '/usr/bin/python3',
      args: ['main.py', '--key', 'sk-2'],
      secretArgs: [2],
    });
    expect(manifestWarnings(leaky)).toEqual([
      'API key is passed on the command line, where other programs on the Hub can see it',
    ]);
    expect(() => bundleLaunch(leaky, '/data/b', {}, { ...ENV, platform: 'darwin' })).toThrow(
      /needs python3.12/,
    );
  });

  it('refuses bundles that cannot run here', () => {
    const m = sample();
    const uv = parseManifest({
      ...m.raw,
      manifest_version: '0.4',
      server: {
        type: 'uv',
        entry_point: 'server/index.mjs',
        mcp_config: { command: 'uv', args: ['run', '--directory', '${__dirname}', 'server.py'] },
      },
    });
    expect(compatibilityProblems(uv, ENV)).toEqual([
      'this bundle needs the uv tool, which is not installed on the Hub',
    ]);
    expect(() => bundleLaunch(uv, '/b', {}, ENV)).toThrow(/uv tool/);
    expect(
      bundleLaunch(uv, '/b', {}, { ...ENV, which: (p) => (p === 'uv' ? '/usr/bin/uv' : null) })
        .command,
    ).toBe('/usr/bin/uv');
    const mac = parseManifest({ ...m.raw, compatibility: { platforms: ['darwin'] } });
    expect(() => bundleLaunch(mac, '/b', {}, ENV)).toThrow(/does not support linux/);
    const future = parseManifest({ ...m.raw, compatibility: { runtimes: { node: '>=999.0.0' } } });
    expect(compatibilityProblems(future, ENV)[0]).toMatch(/needs Node >=999/);
  });

  it('makes a program shipped in the bundle executable', () => {
    const m = sample();
    const bin = parseManifest({
      ...m.raw,
      server: {
        type: 'binary',
        entry_point: 'bin/srv',
        mcp_config: { command: '${__dirname}/bin/srv' },
      },
    });
    const dest = join(dir, 'b');
    extractBundle(
      {
        archive: zipSync({ 'bin/srv': strToU8('#!/bin/sh\n') }),
        entries: [{ name: 'bin/srv', dir: false, size: 10 }],
      },
      dest,
    );
    const l = bundleLaunch(bin, dest, {}, ENV);
    expect(l.command).toBe(join(dest, 'bin', 'srv'));
    expect(statSync(l.command).mode & 0o111).not.toBe(0);
    expect(() => bundleLaunch(bin, join(dir, 'empty'), {}, ENV)).toThrow(/not in the bundle/);
  });

  it('warns about unknown variables and finds programs on PATH', () => {
    const m = sample();
    const odd = parseManifest({
      ...m.raw,
      server: {
        ...(m.raw.server as object),
        mcp_config: { command: 'node', args: ['${WHAT}'], env: { A: '${ALSO}' } },
      },
    });
    expect(manifestWarnings(odd)).toEqual([
      'the launch line uses an unknown variable ${WHAT}',
      'the launch line uses an unknown variable ${ALSO}',
    ]);
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    expect(whichOnPath('tool', dir)).toBe(join(dir, 'tool'));
    expect(whichOnPath('missing-tool', dir)).toBeNull();
    expect(whichOnPath(join(dir, 'tool'))).toBe(join(dir, 'tool'));
    expect(whichOnPath('rel/tool')).toBeNull();
  });

  it('turns a bundle name into a server name', () => {
    expect(bundleServerName('nova-hello')).toBe('nova-hello');
    expect(bundleServerName('@Scope/My_Server!')).toBe('scope-my-server');
    expect(bundleServerName('../..')).toBe('bundle');
    expect(bundleServerName('x'.repeat(60))).toHaveLength(40);
  });
});
