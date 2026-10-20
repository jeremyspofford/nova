// Marketplace signatures and permission diffs (FR-049; docs/08 §7; ADR-097 D2): catalog index
// signatures (verified by a pinned or trusted key, untrusted, unsigned, invalid when tampered,
// damaged or signed by another key than the pinned one, never valid as a bundle signature), D2
// folder digests, `.novax` bundles written by hand from the D2 format and read by the SDK,
// archives with unsafe paths, the index format and the diff an update shows with its acceptance
// rule.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeZip } from '../src/documents/zip.ts';
import {
  artifactFormat,
  diffNeedsAcceptance,
  expectedChecksum,
  folderDigest,
  mcpPermissionLines,
  parseMarketIndex,
  permissionDiff,
  pickMarketEntry,
  pluginPermissionLines,
  readArchive,
  signCatalogIndex,
  signatureUrl,
  skillPermissionLines,
  verifyCatalogIndex,
  writeArchive,
} from '../src/market/index.ts';
import { extensionDigest, verifyBundle } from '../src/sdk/bundle.ts';
import { EXTENSION_SIGNATURE_CONTEXT, verifyDigest } from '../src/sdk/keys.ts';
import { makeNovax, pluginFolder, testPublisher } from './fixtures/market/env.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-market-sig-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enc = (s: string) => Buffer.from(s);

describe('catalog index signatures', () => {
  const a = testPublisher();
  const b = testPublisher();
  const index = enc('{"schemaVersion":1,"plugins":[]}');
  const sig = enc(signCatalogIndex(index, a.privateKey));

  it('verifies with the pinned key, or with a trusted publisher', () => {
    expect(verifyCatalogIndex(index, sig, { pinned: a.publicKey, trusted: [] })).toEqual({
      status: 'verified',
      publisher: expect.objectContaining({ name: null, key: a.publicKey, trusted: true }),
      reason: null,
    });
    expect(
      verifyCatalogIndex(index, sig, { trusted: [{ name: 'Alice', key: a.publicKey }] }),
    ).toMatchObject({ status: 'verified', publisher: { name: 'Alice' } });
  });

  it('is untrusted when the key is good but nobody trusts it', () => {
    expect(
      verifyCatalogIndex(index, sig, { trusted: [{ name: 'Bob', key: b.publicKey }] }),
    ).toMatchObject({
      status: 'untrusted',
      reason: expect.stringMatching(/not in your trusted publishers/),
    });
  });

  it('is unsigned without a signature file', () => {
    expect(verifyCatalogIndex(index, null, { trusted: [] }).status).toBe('unsigned');
  });

  it('is invalid when the index changed, the file is damaged, the bytes are bad or the key is not the pinned one', () => {
    const tampered = enc('{"schemaVersion":1,"plugins":[{"evil":true}]}');
    expect(verifyCatalogIndex(tampered, sig, { pinned: a.publicKey, trusted: [] })).toMatchObject({
      status: 'invalid',
      reason: 'the index does not match its signature',
    });
    expect(verifyCatalogIndex(index, enc('not json'), { trusted: [] })).toMatchObject({
      status: 'invalid',
      reason: 'the signature file is damaged',
    });
    // Another key's signature over the same digest, claiming to be A.
    const forged = JSON.parse(signCatalogIndex(index, b.privateKey)) as Record<string, string>;
    forged.publisher = a.publicKey;
    expect(
      verifyCatalogIndex(index, enc(JSON.stringify(forged)), {
        trusted: [{ name: 'A', key: a.publicKey }],
      }),
    ).toMatchObject({ status: 'invalid', reason: 'the signature does not verify' });
    expect(verifyCatalogIndex(index, sig, { pinned: b.publicKey, trusted: [] })).toMatchObject({
      status: 'invalid',
      reason: expect.stringMatching(/another key than the one this catalog pins/),
    });
  });

  it('can never pass for a bundle signature', () => {
    const f = JSON.parse(sig.toString()) as {
      digest: string;
      signature: string;
      publisher: string;
    };
    expect(verifyDigest(EXTENSION_SIGNATURE_CONTEXT, f.digest, f.signature, f.publisher)).toBe(
      false,
    );
  });

  it('puts the signature next to a remote index', () => {
    expect(signatureUrl('https://c.example.com/v1/index.json?x=1')).toBe(
      'https://c.example.com/v1/index.json.sig?x=1',
    );
  });
});

describe('digests', () => {
  it('is the D2 digest of the files and changes with any byte', () => {
    const root = pluginFolder(join(dir, 'p'));
    const before = folderDigest(root);
    expect(before).toBe(
      extensionDigest([
        ['.nova-plugin/plugin.json', readFileSync(join(root, '.nova-plugin', 'plugin.json'))],
        [
          'skills/take-notes/SKILL.md',
          readFileSync(join(root, 'skills', 'take-notes', 'SKILL.md')),
        ],
      ]),
    );
    writeFileSync(join(root, 'skills', 'take-notes', 'SKILL.md'), 'changed');
    expect(folderDigest(root)).not.toBe(before);
  });
});

describe('.novax bundles in the D2 format', () => {
  const key = testPublisher();

  it('reads as unsigned, verified, untrusted or invalid', () => {
    const root = pluginFolder(join(dir, 'p'));
    expect(verifyBundle(makeNovax(root), { trusted: [] })).toMatchObject({
      status: 'unverified',
      reason: 'unsigned',
    });
    const signed = makeNovax(root, key);
    expect(verifyBundle(signed, { trusted: [{ name: 'T', key: key.publicKey }] })).toMatchObject({
      status: 'verified',
      publisher: key.publicKey,
    });
    expect(verifyBundle(signed, { trusted: [] })).toMatchObject({
      status: 'unverified',
      reason: 'untrusted',
    });
    expect(verifyBundle(makeNovax(root, key, true), { trusted: [] })).toMatchObject({
      status: 'invalid',
      reason: 'digest_mismatch',
    });
  });

  it('refuses archives with unsafe paths and writes nothing outside its folder', () => {
    for (const name of ['../evil.txt', '/abs.txt', 'a\\b.txt', 'C:/x.txt', 'a//b.txt']) {
      const z = writeZip([[name, 'x']], new Date('2026-01-01'));
      expect(() => readArchive(z), name).toThrow(/unsafe path/);
    }
    expect(() => readArchive(Buffer.from('not a zip'))).toThrow(/not a valid zip/);
    writeArchive(new Map([['ok/a.txt', Buffer.from('a')]]), join(dir, 'out'));
    expect(readFileSync(join(dir, 'out', 'ok', 'a.txt'), 'utf8')).toBe('a');
  });
});

describe('the index', () => {
  it('reads M4 plugins and M8 items, picks versions and formats', () => {
    const idx = parseMarketIndex(
      enc(
        JSON.stringify({
          plugins: [{ id: 'com.a.b', name: 'B', version: '1.0.0', path: 'b' }],
          items: [
            {
              kind: 'theme',
              id: 'com.a.t',
              name: 'T',
              version: '1.0.0',
              path: 't.json',
              sha256: 'a'.repeat(64),
            },
            {
              kind: 'mcp',
              id: 'srv',
              name: 'S',
              version: '2.0.0',
              server: { transport: 'http', url: 'https://mcp.example.com/' },
            },
            { kind: 'mcp', id: 'bun', name: 'B', version: '1.0.0', url: 'bun.mcpb' },
            {
              kind: 'plugin',
              id: 'com.a.b',
              name: 'B',
              version: '1.2.0',
              repo: 'https://git.example.com/b.git',
              commit: 'c'.repeat(40),
              digest: 'd'.repeat(64),
            },
            { kind: 'plugin', id: 'com.a.x', name: 'X', version: '1.0.0', url: 'x.novax' },
          ],
        }),
      ),
      'catalog.json',
    );
    expect(idx.entries.map((e) => `${e.kind}:${e.id}@${e.version}`)).toEqual([
      'plugin:com.a.b@1.0.0',
      'theme:com.a.t@1.0.0',
      'mcp:srv@2.0.0',
      'mcp:bun@1.0.0',
      'plugin:com.a.b@1.2.0',
      'plugin:com.a.x@1.0.0',
    ]);
    expect(pickMarketEntry(idx.entries, 'plugin', 'com.a.b')?.version).toBe('1.2.0');
    expect(pickMarketEntry(idx.entries, 'plugin', 'com.a.b', '1.0.0')?.path).toBe('b');
    expect(pickMarketEntry(idx.entries, 'plugin', 'nope')).toBeNull();
    expect(idx.entries.map(artifactFormat)).toEqual([
      'folder',
      'json',
      'registry',
      'mcpb',
      'folder',
      'novax',
    ]);
    expect(expectedChecksum(idx.entries[1]!)).toBe('a'.repeat(64));
    expect(expectedChecksum(idx.entries[4]!)).toBe('d'.repeat(64));
    expect(expectedChecksum(idx.entries[0]!)).toBeNull();
  });

  it('refuses bad JSON, an entry without a location and a repo without its commit', () => {
    expect(() => parseMarketIndex(enc('{'), 'x')).toThrow(/not valid JSON/);
    expect(() =>
      parseMarketIndex(
        enc(JSON.stringify({ items: [{ kind: 'theme', id: 'a.b', name: 'A', version: '1.0.0' }] })),
        'x',
      ),
    ).toThrow(/needs path, url/);
    expect(() =>
      parseMarketIndex(
        enc(
          JSON.stringify({
            items: [
              { kind: 'plugin', id: 'a.b', name: 'A', version: '1.0.0', repo: 'https://g/x.git' },
            ],
          }),
        ),
        'x',
      ),
    ).toThrow(/repo with commit/);
    expect(() =>
      parseMarketIndex(
        enc(JSON.stringify({ items: [{ kind: 'nope', id: 'a', name: 'A', version: '1' }] })),
        'x',
      ),
    ).toThrow(/x: items/);
  });
});

describe('permission lines and diffs', () => {
  const v1 = pluginPermissionLines({
    permissions: {
      network: ['api.example.com'],
      tools: { 'plugin:a.b.read': { action: 'read', default: 'ask' } },
      actionDefaults: { read: 'allow' },
    },
    mcpServers: { s: { transport: 'stdio', command: 'node', args: ['server.js'] } },
    hooks: [{ id: 'hook:a.b.h', event: 'tool.pre', command: 'node h.mjs' }],
  });

  it('says what a plugin can do in plain words', () => {
    expect(v1.map((l) => l.text)).toEqual([
      'Reach api.example.com on the network',
      'Offer the tool plugin:a.b.read (read)',
      'A read action runs without asking by default',
      'Add the MCP server s, which runs node server.js',
      'Run the hook hook:a.b.h on tool.pre (node h.mjs)',
    ]);
    expect(skillPermissionLines(['fs.read'])[0]!.text).toBe('Ask to use the tool fs.read');
    expect(
      mcpPermissionLines({ transport: 'http', url: 'https://mcp.example.com/x' })[0]!.text,
    ).toBe('Connect to mcp.example.com');
    expect(
      pluginPermissionLines({
        permissions: {
          hooks: { answersAsks: true },
          ui: { connectDomains: ['cdn.example.com'] },
          browserExtensions: ['helper'],
          secrets: ['gh.token'],
          fs: ['${project}'],
        },
        roles: ['a.b:reviewer'],
        uiEntryPoints: [{ kind: 'global', title: 'Panel' }],
      }).map((l) => l.kind),
    ).toEqual([
      'fs',
      'secret',
      'hooks_answer_asks',
      'browser_extension',
      'ui_domain',
      'role',
      'ui_entry',
    ]);
  });

  it('shows added, removed and changed lines with a stable hash', () => {
    const v2 = pluginPermissionLines({
      permissions: {
        network: ['api.example.com', 'uploads.example.com'],
        tools: { 'plugin:a.b.read': { action: 'read', default: 'allow' } },
      },
      mcpServers: { s: { transport: 'stdio', command: 'node', args: ['server.js'] } },
      hooks: [{ id: 'hook:a.b.h', event: 'tool.pre', command: 'node other.mjs' }],
    });
    const d = permissionDiff({ version: '1.0.0', lines: v1 }, { version: '1.1.0', lines: v2 });
    expect(d.added.map((l) => l.key)).toEqual(['network:uploads.example.com']);
    expect(d.removed.map((l) => l.key)).toEqual(['action_default:read']);
    expect(d.changed).toEqual([
      {
        key: 'tool:plugin:a.b.read',
        text: 'Offer the tool plugin:a.b.read (read)',
        before: 'read, ask',
        after: 'read, allow',
      },
      {
        key: 'hook:hook:a.b.h',
        text: 'Run the hook hook:a.b.h on tool.pre (node other.mjs)',
        before: 'tool.pre node h.mjs',
        after: 'tool.pre node other.mjs',
      },
    ]);
    expect(d.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      permissionDiff({ version: '1.0.0', lines: v1 }, { version: '1.1.0', lines: v2 }).hash,
    ).toBe(d.hash);
    expect(
      permissionDiff({ version: '1.0.0', lines: v1 }, { version: '1.2.0', lines: v2 }).hash,
    ).not.toBe(d.hash);
    expect(diffNeedsAcceptance(d)).toBe(true);
    // Only removals: shown, nothing to accept.
    const fewer = permissionDiff({ version: '1', lines: v1 }, { version: '2', lines: v1.slice(1) });
    expect(fewer.removed).toHaveLength(1);
    expect(diffNeedsAcceptance(fewer)).toBe(false);
    expect(diffNeedsAcceptance(null)).toBe(false);
  });
});

it('a folder with a nested file digests every file', () => {
  mkdirSync(join(dir, 'f', 'a'), { recursive: true });
  writeFileSync(join(dir, 'f', 'a', 'x.txt'), 'x');
  expect(folderDigest(join(dir, 'f'))).toMatch(/^[0-9a-f]{64}$/);
});
