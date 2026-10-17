// Plugin catalogs (FR-045, FR-049 stub; docs/08 §7): folder catalogs, https URL catalogs fetched
// with a size cap and no redirects to other hosts (plugin archives checked by SHA-256), Git
// catalogs through the git command, and a clear refusal when git is absent.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PluginCatalogs,
  catalogKind,
  loadPluginFolder,
  type CatalogGitRunner,
} from '../src/index.ts';
import { pickEntry } from '../src/plugins/catalog.ts';

const SAMPLE_CATALOG = fileURLToPath(new URL('../../../examples/catalog/', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-catalog-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function zipFolder(root: string, prefix = ''): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) walk(full);
      else files[prefix + relative(root, full).split('\\').join('/')] = readFileSync(full);
    }
  };
  walk(root);
  return zipSync(files);
}

type Route = { status?: number; body?: Uint8Array | string; headers?: Record<string, string> };
function fakeFetch(routes: Record<string, Route>, seen: string[] = []): typeof fetch {
  return ((input: string) => {
    seen.push(input);
    const r = routes[input];
    if (!r) return Promise.resolve(new Response('missing', { status: 404 }));
    const body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body;
    return Promise.resolve(
      new Response(body ?? null, { status: r.status ?? 200, headers: r.headers }),
    );
  }) as typeof fetch;
}

describe('catalog kinds', () => {
  it('tells folders, URLs and Git URLs apart', () => {
    expect(catalogKind('/srv/catalog')).toBe('local');
    expect(catalogKind('https://catalog.example.com/index.json')).toBe('url');
    expect(catalogKind('https://git.example.com/org/catalog.git')).toBe('git');
    expect(catalogKind('git@git.example.com:org/catalog.git')).toBe('git');
    expect(catalogKind('ssh://git.example.com/org/catalog')).toBe('git');
    expect(catalogKind('git+https://git.example.com/org/catalog')).toBe('git');
  });

  it('picks the requested version or the highest one', () => {
    const e = (version: string) => ({ id: 'a.b', name: 'A', version, path: 'x' });
    const list = [e('1.0.0'), e('1.10.0'), e('1.2.0'), e('2.0.0-beta.1')];
    expect(pickEntry(list, 'a.b')?.version).toBe('2.0.0-beta.1');
    expect(pickEntry([e('2.0.0-beta.1'), e('2.0.0')], 'a.b')?.version).toBe('2.0.0');
    expect(pickEntry(list, 'a.b', '1.2.0')?.version).toBe('1.2.0');
    expect(pickEntry(list, 'a.b', '9.9.9')).toBeNull();
    expect(pickEntry(list, 'x.y')).toBeNull();
  });
});

describe('folder catalogs', () => {
  it('lists the sample catalog and resolves its plugin folder', async () => {
    const c = new PluginCatalogs({ cacheDir: join(dir, 'cache') });
    const cfg = { id: 'sample', name: 'Sample', location: SAMPLE_CATALOG };
    const listing = await c.listing(cfg);
    expect(listing.entries).toEqual([
      expect.objectContaining({
        id: 'com.example.sample',
        version: '1.0.0',
        path: 'sample-plugin',
      }),
    ]);
    const r = await c.resolve(cfg, 'com.example.sample');
    expect(loadPluginFolder(r.root).manifest.id).toBe('com.example.sample');
    expect(r.origin).toBe('sample/com.example.sample@1.0.0');
    expect(c.view(cfg)).toEqual({ ...cfg, kind: 'local' });
  });

  it('refuses bad catalogs and entries that leave the folder', async () => {
    const c = new PluginCatalogs({ cacheDir: join(dir, 'cache') });
    const cat = join(dir, 'cat');
    mkdirSync(cat);
    const cfg = { id: 'c', name: 'C', location: cat };
    await expect(c.listing(cfg)).rejects.toMatchObject({ code: 'not_found' });
    writeFileSync(join(cat, 'nova-catalog.json'), '{ nope');
    await expect(c.listing(cfg)).rejects.toThrow(/not valid JSON/);
    writeFileSync(
      join(cat, 'nova-catalog.json'),
      JSON.stringify({ plugins: [{ id: 'a.b', name: 'A', version: 'x', path: 'p' }] }),
    );
    await expect(c.listing(cfg)).rejects.toThrow(/version/);
    writeFileSync(
      join(cat, 'nova-catalog.json'),
      JSON.stringify({ plugins: [{ id: 'a.b', name: 'A', version: '1.0.0' }] }),
    );
    await expect(c.listing(cfg)).rejects.toThrow(/path or url/);
    writeFileSync(
      join(cat, 'nova-catalog.json'),
      JSON.stringify({
        plugins: [{ id: 'a.b', name: 'A', version: '1.0.0', path: '../elsewhere' }],
      }),
    );
    await expect(c.resolve(cfg, 'a.b')).rejects.toThrow(/leaves the plugin folder/);
    writeFileSync(
      join(cat, 'nova-catalog.json'),
      JSON.stringify({ plugins: [{ id: 'a.b', name: 'A', version: '1.0.0', url: 'x.zip' }] }),
    );
    await expect(c.resolve(cfg, 'a.b')).rejects.toThrow(/has no path/);
    await expect(c.resolve(cfg, 'c.d')).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.listing({ ...cfg, location: 'relative/path' })).rejects.toThrow(/absolute path/);
    await expect(c.listing({ ...cfg, location: join(dir, 'gone') })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('URL catalogs', () => {
  const index = (entries: unknown[]) => JSON.stringify({ schemaVersion: 1, plugins: entries });
  const pluginZip = (prefix = '') => {
    const root = join(dir, `zip-src-${prefix.length}`);
    cpSync(join(SAMPLE_CATALOG, 'sample-plugin'), root, { recursive: true });
    return zipFolder(root, prefix);
  };

  it('fetches the index and an archive from the same host and checks its checksum', async () => {
    const zip = pluginZip('sample/');
    const sha = createHash('sha256').update(zip).digest('hex');
    const seen: string[] = [];
    const c = new PluginCatalogs({
      cacheDir: join(dir, 'cache'),
      fetch: fakeFetch(
        {
          'https://catalog.example.com/nova/catalog.json': {
            body: index([
              {
                id: 'com.example.sample',
                name: 'Sample',
                version: '1.0.0',
                url: 'files/sample.zip',
                sha256: sha,
              },
            ]),
          },
          'https://catalog.example.com/nova/files/sample.zip': {
            status: 302,
            headers: { location: '/nova/files/sample-1.zip' },
          },
          'https://catalog.example.com/nova/files/sample-1.zip': { body: zip },
        },
        seen,
      ),
    });
    const cfg = { id: 'remote', name: 'Remote', location: 'https://catalog.example.com/nova' };
    expect((await c.listing(cfg)).entries).toHaveLength(1);
    const r = await c.resolve(cfg, 'com.example.sample');
    expect(loadPluginFolder(r.root).manifest.id).toBe('com.example.sample');
    expect(r.root.endsWith(join('archives', sha.slice(0, 32), 'sample'))).toBe(true);
    // The index is cached for a while.
    expect(seen.filter((u) => u.endsWith('catalog.json'))).toHaveLength(1);
    const again = await c.resolve(cfg, 'com.example.sample');
    expect(again.root).toBe(r.root);
  });

  it('refuses redirects to other hosts, oversized files, bad checksums and plain http', async () => {
    const zip = pluginZip();
    const routes: Record<string, Route> = {
      'https://a.example.com/catalog.json': {
        status: 301,
        headers: { location: 'https://b.example.com/catalog.json' },
      },
      'https://big.example.com/catalog.json': { body: 'x'.repeat(2000) },
      'https://len.example.com/catalog.json': {
        body: '{}',
        headers: { 'content-length': '999999999' },
      },
      'https://sum.example.com/catalog.json': {
        body: index([
          { id: 'a.b', name: 'A', version: '1.0.0', url: 'p.zip', sha256: '0'.repeat(64) },
        ]),
      },
      'https://sum.example.com/p.zip': { body: zip },
      'https://far.example.com/catalog.json': {
        body: index([
          { id: 'a.b', name: 'A', version: '1.0.0', url: 'https://cdn.example.net/p.zip' },
        ]),
      },
      'https://bad.example.com/catalog.json': {
        body: index([{ id: 'a.b', name: 'A', version: '1.0.0', url: 'p.zip' }]),
      },
      'https://bad.example.com/p.zip': { body: 'not a zip' },
      'https://nolo.example.com/catalog.json': { status: 302 },
      'https://err.example.com/catalog.json': { status: 500 },
      'https://empty.example.com/catalog.json': {
        body: index([{ id: 'a.b', name: 'A', version: '1.0.0', url: 'p.zip' }]),
      },
      'https://empty.example.com/p.zip': {
        body: zipSync({ 'readme.txt': new TextEncoder().encode('x') }),
      },
    };
    const c = new PluginCatalogs({
      cacheDir: join(dir, 'cache'),
      fetch: fakeFetch(routes),
      maxIndexBytes: 1000,
    });
    const at = (host: string) => ({ id: 'x', name: 'X', location: `https://${host}/catalog.json` });
    await expect(c.listing(at('a.example.com'))).rejects.toThrow(/redirected to another host/);
    await expect(c.listing(at('big.example.com'))).rejects.toThrow(/larger than 1000 bytes/);
    await expect(c.listing(at('len.example.com'))).rejects.toThrow(/larger than/);
    await expect(c.resolve(at('sum.example.com'), 'a.b')).rejects.toThrow(/checksum/);
    await expect(c.resolve(at('far.example.com'), 'a.b')).rejects.toThrow(/catalog host/);
    await expect(c.resolve(at('bad.example.com'), 'a.b')).rejects.toThrow(/not a valid zip/);
    await expect(c.resolve(at('empty.example.com'), 'a.b')).rejects.toThrow(/no .nova-plugin/);
    await expect(c.listing(at('nolo.example.com'))).rejects.toThrow(/without a location/);
    await expect(c.listing(at('err.example.com'))).rejects.toThrow(/answered 500/);
    await expect(
      c.listing({ id: 'x', name: 'X', location: 'http://plain.example.com/catalog.json' }),
    ).rejects.toThrow();
    const down = new PluginCatalogs({
      cacheDir: join(dir, 'c2'),
      fetch: () => Promise.reject(new Error('offline')),
    });
    await expect(down.listing(at('any.example.com'))).rejects.toThrow(/could not reach/);
  });

  it('refuses archive entries that climb out of the folder', async () => {
    const evil = zipSync({
      '../evil.txt': new TextEncoder().encode('x'),
      '.nova-plugin/plugin.json': new TextEncoder().encode('{}'),
    });
    const c = new PluginCatalogs({
      cacheDir: join(dir, 'cache'),
      fetch: fakeFetch({
        'https://e.example.com/catalog.json': {
          body: index([{ id: 'a.b', name: 'A', version: '1.0.0', url: 'p.zip' }]),
        },
        'https://e.example.com/p.zip': { body: evil },
      }),
    });
    await expect(
      c.resolve({ id: 'e', name: 'E', location: 'https://e.example.com/catalog.json' }, 'a.b'),
    ).rejects.toThrow(/leaves the plugin folder/);
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
  });
});

describe('Git catalogs', () => {
  /** A fake git: `clone … <url> <dir>` copies a fixture folder; `rev-parse` prints a commit. */
  function fakeGit(calls: string[][], fixture: string): CatalogGitRunner {
    return (args) => {
      calls.push(args);
      if (args[0] === '--version')
        return Promise.resolve({ code: 0, stdout: 'git version 2.50.0', stderr: '' });
      if (args.includes('clone')) {
        const target = args.at(-1)!;
        if (args.includes('missing-ref'))
          return Promise.resolve({
            code: 128,
            stdout: '',
            stderr: 'fatal: Remote branch missing-ref not found',
          });
        cpSync(fixture, target, { recursive: true });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      if (args.includes('rev-parse'))
        return Promise.resolve({ code: 0, stdout: 'abc123\n', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' });
    };
  }

  it('clones shallow with hooks off, reads the index and pins the commit', async () => {
    const calls: string[][] = [];
    const c = new PluginCatalogs({
      cacheDir: join(dir, 'cache'),
      git: fakeGit(calls, SAMPLE_CATALOG),
    });
    const cfg = { id: 'g', name: 'G', location: 'https://git.example.com/org/catalog.git#main' };
    expect((await c.listing(cfg)).entries.map((e) => e.id)).toEqual(['com.example.sample']);
    const clone = calls.find((a) => a.includes('clone'))!;
    expect(clone).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        '--depth',
        '1',
        '--branch',
        'main',
        '--',
        'https://git.example.com/org/catalog.git',
      ]),
    );
    const r = await c.resolve(cfg, 'com.example.sample');
    expect(r.origin).toBe('g/com.example.sample@1.0.0#abc123');
    // The clone is reused while fresh.
    expect(calls.filter((a) => a.includes('clone'))).toHaveLength(1);
    const plugin = await c.cloneGit('https://git.example.com/org/plugin', 'v1.0.0');
    expect(plugin.commit).toBe('abc123');
  });

  it('refuses unsafe URLs and refs and reports clone failures', async () => {
    const c = new PluginCatalogs({
      cacheDir: join(dir, 'cache'),
      git: fakeGit([], SAMPLE_CATALOG),
    });
    await expect(c.cloneGit('--upload-pack=evil')).rejects.toThrow(/https, ssh or git/);
    await expect(c.cloneGit('file:///etc')).rejects.toThrow(/https, ssh or git/);
    await expect(c.cloneGit('https://git.example.com/x', '--evil')).rejects.toThrow(
      /invalid Git ref/,
    );
    await expect(c.cloneGit('https://git.example.com/x', 'a..b')).rejects.toThrow(
      /invalid Git ref/,
    );
    await expect(c.cloneGit('https://git.example.com/x', 'missing-ref')).rejects.toThrow(
      /git clone failed: fatal: Remote branch/,
    );
  });

  it('refuses with a clear message when git is absent', async () => {
    const c = new PluginCatalogs({
      cacheDir: join(dir, 'cache'),
      gitCommand: join(dir, 'no-such-git'),
    });
    await expect(
      c.listing({ id: 'g', name: 'G', location: 'https://git.example.com/org/catalog.git' }),
    ).rejects.toMatchObject({
      code: 'capability_missing',
      message: expect.stringMatching(/need the git command/),
    });
    const failing = new PluginCatalogs({
      cacheDir: join(dir, 'c2'),
      git: () => Promise.resolve({ code: 127, stdout: '', stderr: '' }),
    });
    await expect(failing.cloneGit('https://git.example.com/x')).rejects.toMatchObject({
      code: 'capability_missing',
    });
  });
});
