// Regressions from the M8 supply-chain review (FR-049, FR-117): zip archives whose stored entries
// lie about their size or share one payload (4 MB that unpacked to 160 MB) are refused by every
// reader, the import scanner's included; an MCP server's approval going from ask to allow is a change the update must have
// accepted; extension lines keep their detail; a catalog that pins a key cannot be downgraded by
// dropping its signature; a catalog index reached through a link is refused; an untrusted signer
// is shown by its fingerprint, never by the name a catalog claims; a file name with a control
// character cannot take part in a folder digest.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NovaDatabase } from '@nova/storage';
import { readZip, writeZip, ZIP_LIMITS } from '../src/documents/zip.ts';
import { extensionLines, readArchive, verifyCatalogIndex } from '../src/market/index.ts';
import { PluginCatalogs } from '../src/plugins/catalog.ts';
import { scanPaths } from '../src/profile/import/scan.ts';
import { readBundleEntries } from '../src/sdk/bundle.ts';
import {
  ACCOUNT,
  folderDigest,
  makeNovax,
  marketEnv,
  openMarketDb,
  pluginFolder,
  sha256Hex,
  testPublisher,
  writeCatalog,
  type MarketEnv,
} from './fixtures/market/env.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-market-review-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- zip archives (#1) ----------------------------------------------------------------------

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/**
 * One stored local file, then `n` central entries pointing at it. `declared` is the uncompressed
 * size the directory states (0 in the review's probe, so the caps never counted it).
 */
function overlapping(
  payload: Buffer,
  n: number,
  declared = 0,
  nameOf: (i: number) => string = (i) => `f${i}.bin`,
): Buffer {
  const lname = Buffer.from('x');
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(10),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(payload.length),
    u32(declared),
    u16(lname.length),
    u16(0),
    lname,
    payload,
  ]);
  const cds: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const name = Buffer.from(nameOf(i));
    cds.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(10),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(payload.length),
        u32(declared),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(0),
        name,
      ]),
    );
  }
  const cd = Buffer.concat(cds);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(n),
    u16(n),
    u32(cd.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, cd, eocd]);
}

describe('zip archives', () => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x41);

  it('refuses the review’s 4 MB archive that unpacked to 160 MB, in every reader', async () => {
    const bomb = overlapping(payload, 40);
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    for (const read of [
      () => readZip(bomb),
      () => readBundleEntries(bomb),
      () => readArchive(bomb),
    ])
      expect(read).toThrow(/not a valid zip package/);
    // The M4 catalog reader's archives go through the same bounded reader.
    const index = JSON.stringify({
      plugins: [{ id: 'a.b', name: 'A', version: '1.0.0', url: 'a.zip' }],
    });
    const fetchIndex = ((url: string) =>
      Promise.resolve(
        new Response(url.endsWith('.json') ? index : bomb, { status: 200 }),
      )) as unknown as typeof fetch;
    const cat = new PluginCatalogs({ cacheDir: join(dir, 'cache2'), fetch: fetchIndex });
    await expect(
      cat.resolve({ id: 'u', name: 'U', location: 'https://c.example.com/catalog.json' }, 'a.b'),
    ).rejects.toThrow(/not a valid zip package/);
  });

  it('makes the import scanner refuse the same archive, while it still reads an honest one', async () => {
    const projects = JSON.stringify([{ uuid: 'p-1', name: 'Garden', prompt_template: 'Plants.' }]);
    // Valid JSON padded to 4 MB: forty directory entries share it, with honest sizes.
    const json = Buffer.from(projects.padEnd(4 * 1024 * 1024, ' '));
    const exports = join(dir, 'exports');
    mkdirSync(exports);
    writeFileSync(
      join(exports, 'bomb.zip'),
      overlapping(json, 40, json.length, (i) => `p${i}/projects.json`),
    );
    expect(
      (await scanPaths([join(exports, 'bomb.zip')], ['projects'], { home: dir })).items,
    ).toEqual([]);
    writeFileSync(
      join(exports, 'honest.zip'),
      writeZip([['export/projects.json', projects]], new Date('2026-01-01')),
    );
    const honest = await scanPaths([join(exports, 'honest.zip')], ['projects'], { home: dir });
    expect(honest.items.map((i) => i.name)).toEqual(['Garden']);
  });

  it('refuses a stored entry whose sizes disagree, even alone', () => {
    const one = overlapping(Buffer.alloc(1024, 0x41), 1, 0);
    expect(() => readZip(one)).toThrow(/not a valid zip package/);
    // Honest sizes read fine.
    expect([...readZip(overlapping(Buffer.alloc(1024, 0x41), 1, 1024)).keys()]).toEqual(['f0.bin']);
  });

  it('refuses entries whose data reaches past the archive', () => {
    const z = Buffer.from(writeZip([['a.txt', 'hello']], new Date('2026-01-01')));
    // Inflate the central directory's compressed size of the only entry past the end.
    const cd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt32LE(z.length * 2, cd + 20);
    expect(() => readZip(z)).toThrow(/not a valid zip package/);
  });

  it('counts the larger of the two sizes toward the caps', () => {
    const z = writeZip([['big.bin', Buffer.alloc(64 * 1024, 7)]], new Date('2026-01-01'));
    expect(() => readZip(z, () => true, { ...ZIP_LIMITS, maxEntryBytes: 32 * 1024 })).toThrow(
      /too large/,
    );
    expect(readZip(z).get('big.bin')?.length).toBe(64 * 1024);
  });
});

// ---- the market (#2, #7, hardening) --------------------------------------------------------

describe('the marketplace', () => {
  let db: NovaDatabase;
  let env: MarketEnv;
  const key = testPublisher();
  beforeEach(async () => {
    db = await openMarketDb();
    env = marketEnv(dir, db);
  });
  afterEach(() => {
    env.market.close();
    db.close();
  });

  function serverPlugin(root: string, version: string, approval: string): string {
    pluginFolder(root, { id: 'com.test.srv', version });
    const file = join(root, '.nova-plugin', 'plugin.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    m.mcpServers = {
      helper: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        defaultApproval: approval,
      },
    };
    writeFileSync(file, JSON.stringify(m));
    return root;
  }

  it('makes an MCP server going from ask to allow a change to accept (review probe c)', async () => {
    const root = join(dir, 'cat');
    const v1 = serverPlugin(join(root, 'v1'), '1.0.0', 'ask');
    const item = (version: string, path: string, d: string) => ({
      kind: 'plugin',
      id: 'com.test.srv',
      name: 'Srv',
      version,
      path,
      digest: folderDigest(d),
    });
    writeCatalog(root, { items: [item('1.0.0', 'v1', v1)] }, key.privateKey);
    env.catalogs.push({ id: 'cat', name: 'Cat', location: root, publisherKey: key.publicKey });
    const p1 = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.srv',
    });
    expect(p1.permissions.find((l) => l.kind === 'mcp_server')?.text).toBe(
      'Add the MCP server helper, which runs node server.js; its tools ask you first',
    );
    await env.market.install(ACCOUNT, { previewId: p1.previewId });
    const v2 = serverPlugin(join(root, 'v2'), '1.1.0', 'allow');
    writeCatalog(
      root,
      { items: [item('1.0.0', 'v1', v1), item('1.1.0', 'v2', v2)] },
      key.privateKey,
    );
    const p2 = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.srv',
    });
    expect(p2.diff?.changed.map((c) => c.key)).toEqual(['mcp_server:helper']);
    expect(p2.diff?.changed[0]?.after).toContain('"defaultApproval":"allow"');
    expect(p2.requires.permissionAcceptance).toBe(true);
    await expect(env.market.install(ACCOUNT, { previewId: p2.previewId })).rejects.toMatchObject({
      details: { reason: 'permission_diff_not_accepted' },
    });
    expect(
      (
        await env.market.install(ACCOUNT, {
          previewId: p2.previewId,
          acceptPermissions: p2.diff!.hash,
        })
      ).version,
    ).toBe('1.1.0');
  });

  it('keeps an extension line’s detail, or its wording, for the diff', () => {
    const [withDetail, plain] = extensionLines([
      {
        key: 'tool:greet',
        kind: 'tool',
        text: 'greet',
        sensitive: false,
        detail: 'execute, allow',
      },
      { key: 'tool:save', kind: 'tool', text: 'Offer save (runs programs)', sensitive: true },
    ]);
    expect(withDetail?.detail).toBe('execute, allow');
    expect(plain?.detail).toBe('Offer save (runs programs) (sensitive)');
    expect(extensionLines([{ key: 'x', kind: 'something_new', text: 't' }])[0]?.kind).toBe(
      'plugin',
    );
  });

  it('refuses a catalog that pins a key but has no signature (review probe d)', async () => {
    const root = join(dir, 'cat');
    const p = pluginFolder(join(root, 'p'), { id: 'com.test.notes' });
    writeCatalog(root, {
      items: [
        {
          kind: 'plugin',
          id: 'com.test.notes',
          name: 'N',
          version: '1.0.0',
          path: 'p',
          digest: folderDigest(p),
        },
      ],
    });
    env.catalogs.push({ id: 'cat', name: 'Cat', location: root, publisherKey: key.publicKey });
    expect((await env.market.catalogs())[0]).toMatchObject({
      signature: 'invalid',
      items: 0,
      error: 'this catalog pins a publisher key, but its index is not signed',
    });
    await expect(
      env.market.preview(ACCOUNT, { catalogId: 'cat', kind: 'plugin', id: 'com.test.notes' }),
    ).rejects.toMatchObject({ details: { reason: 'catalog_signature_invalid' } });
    // Without a pin it is only unsigned.
    expect(verifyCatalogIndex(Buffer.from('{}'), null, { trusted: [] }).status).toBe('unsigned');
  });

  it('refuses a catalog index or signature reached through a link out of the folder', async () => {
    const outside = join(dir, 'outside');
    const p = pluginFolder(join(outside, 'p'), { id: 'com.test.notes' });
    writeCatalog(
      outside,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'N',
            version: '1.0.0',
            path: 'p',
            digest: folderDigest(p),
          },
        ],
      },
      key.privateKey,
    );
    const root = join(dir, 'linked');
    mkdirSync(root);
    symlinkSync(join(outside, 'catalog.json'), join(root, 'catalog.json'));
    env.catalogs.push({ id: 'linked', name: 'Linked', location: root });
    expect((await env.market.catalogs())[0]?.error).toMatch(/points outside/);

    const sigOnly = join(dir, 'sig-linked');
    mkdirSync(sigOnly);
    writeFileSync(join(sigOnly, 'catalog.json'), readFileSync(join(outside, 'catalog.json')));
    symlinkSync(join(outside, 'catalog.json.sig'), join(sigOnly, 'catalog.json.sig'));
    env.catalogs.splice(0, 1, { id: 'sig', name: 'Sig', location: sigOnly });
    expect((await env.market.catalogs())[0]?.error).toMatch(/points outside/);
  });

  it('shows an untrusted signer by its fingerprint, never by the name the catalog claims', async () => {
    const stranger = testPublisher();
    const root = join(dir, 'cat');
    mkdirSync(root, { recursive: true });
    const bundle = makeNovax(pluginFolder(join(dir, 'src'), { id: 'com.test.notes' }), stranger);
    writeFileSync(join(root, 'notes.novax'), bundle);
    writeCatalog(
      root,
      {
        items: [
          {
            kind: 'plugin',
            id: 'com.test.notes',
            name: 'N',
            version: '1.0.0',
            path: 'notes.novax',
            sha256: sha256Hex(bundle),
            publisher: { name: 'Nova Official', key: stranger.publicKey },
          },
        ],
      },
      key.privateKey,
    );
    env.catalogs.push({ id: 'cat', name: 'Cat', location: root, publisherKey: key.publicKey });
    const [card] = await env.market.search(ACCOUNT);
    expect(card?.publisher).toMatchObject({ key: stranger.publicKey, name: null, trusted: false });
    // No author of its own: the claimed publisher name is not shown as one either.
    expect(card?.author).toBeNull();
    const p = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(p.verification).toMatchObject({
      status: 'unverified',
      reasons: ['bundle_untrusted'],
      publisher: { key: stranger.publicKey, name: null, trusted: false },
    });
    const fp = p.verification.publisher!.fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
    expect(p.warnings[0]).toBe(
      `Signed by a publisher you have not trusted (key ${fp}); the name the catalog gives it is not checked.`,
    );
    // Trusted, it carries the owner's own name for the key.
    env.trusted.push({ name: 'Stranger Inc', key: stranger.publicKey });
    const again = await env.market.preview(ACCOUNT, {
      catalogId: 'cat',
      kind: 'plugin',
      id: 'com.test.notes',
    });
    expect(again.verification.publisher).toMatchObject({ name: 'Stranger Inc', trusted: true });
  });

  it('refuses a file name with a control character in a folder digest', () => {
    const root = pluginFolder(join(dir, 'p'));
    writeFileSync(join(root, 'lib\nmain.js'), 'x');
    expect(() => folderDigest(root)).toThrow(/control character/);
  });
});
