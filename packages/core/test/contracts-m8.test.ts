// The M8 contract schemas agree with the code's zod schemas on the same samples (AGENTS.md §10,
// contracts/README.md "Contract testing"): extension-manifest.json, extension-signature.json,
// catalog-index.json, catalog-signature.json, managed-settings.json and export-manifest.json
// (ADR-097 D2, D4, D5). Real artifacts are checked too: the SDK's sample extension, the sample
// catalog's extension, the sample catalog's index and its signature.
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contracts } from '@nova/contracts';
import { exportManifestSchema, managedPolicySchema } from '@nova/shared';
import {
  EXTENSION_SIGNATURE_FILE,
  extensionManifestSchema,
  generatePublisherKeyPair,
  packBundle,
  readBundleEntries,
} from '../src/sdk/index.ts';
import { marketIndexSchema } from '../src/market/index.ts';
import { managedEnvelopeSchema, signManagedPolicy } from '../src/managed/source.ts';

const root = join(import.meta.dirname, '../../../');
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const c = contracts();

/** Each sample: [label, value, expected]; zod and the JSON Schema must both give `expected`. */
function agree(
  schemaFile: string,
  zodOk: (v: unknown) => boolean,
  samples: [string, unknown, boolean][],
): void {
  const validate = c.validator(schemaFile);
  it.each(samples)('%s', (_label, value, expected) => {
    const r = validate(value);
    expect(r.ok, JSON.stringify(r.errors.slice(0, 3))).toBe(expected);
    expect(zodOk(value)).toBe(expected);
  });
}

describe('extension-manifest.json', () => {
  const hello = json('packages/sdk/examples/hello/.nova-plugin/extension.json') as Record<
    string,
    unknown
  >;
  const permissions = hello['permissions'] as Record<string, unknown>;
  const panel = (permissions['panels'] as Record<string, unknown>[])[0]!;
  agree('extension-manifest.json', (v) => extensionManifestSchema.safeParse(v).success, [
    ['the SDK sample extension', hello, true],
    [
      'the sample catalog extension',
      json('examples/catalog/src/word-count/.nova-plugin/extension.json'),
      true,
    ],
    ['no permissions at all', { api: 1, entry: 'main.mjs', permissions: {} }, true],
    [
      'a file panel with its extensions',
      {
        api: 1,
        entry: 'main.js',
        permissions: {
          panels: [{ ...panel, entryPoint: 'file', extensions: ['.lcov'], file: 'p/view.HTML' }],
        },
      },
      true,
    ],
    [
      'a writable absolute folder',
      { api: 1, entry: 'main.js', permissions: { fs: [{ path: '/srv/notes', write: true }] } },
      true,
    ],
    ['api 2', { ...hello, api: 2 }, false],
    ['an unknown top-level key', { ...hello, main: 'x.js' }, false],
    ['an unknown permission', { ...hello, permissions: { ...permissions, shell: true } }, false],
    ['an entry that is not a module', { ...hello, entry: 'extension.ts' }, false],
    ['an entry outside the folder', { ...hello, entry: '../evil.js' }, false],
    [
      'a file panel without extensions',
      { ...hello, permissions: { panels: [{ ...panel, entryPoint: 'file' }] } },
      false,
    ],
    [
      'a global panel with extensions',
      { ...hello, permissions: { panels: [{ ...panel, extensions: ['.md'] }] } },
      false,
    ],
    [
      'a tool without its action class',
      { ...hello, permissions: { tools: { greet: { default: 'allow' } } } },
      false,
    ],
    [
      'a hook on an unknown event',
      { ...hello, permissions: { hooks: [{ id: 'x', event: 'tool.before' }] } },
      false,
    ],
    ['a host with a path', { ...hello, permissions: { network: ['api.example.com/x'] } }, false],
  ]);
});

describe('extension-signature.json', () => {
  const pair = generatePublisherKeyPair();
  const files = new Map<string, Uint8Array>([
    ['.nova-plugin/plugin.json', Buffer.from('{}')],
    ['main.js', Buffer.from('export function activate() {}')],
  ]);
  const packed = packBundle(files, { privateKey: createPrivateKey(pair.privateKeyPem) });
  const entry = readBundleEntries(packed.bytes).get(EXTENSION_SIGNATURE_FILE)!;
  const sig = JSON.parse(Buffer.from(entry).toString('utf8')) as Record<string, unknown>;
  const ajv = c.validator('extension-signature.json');

  it('describes the signature file nova pack writes', () => {
    expect(sig['publisher']).toBe(pair.publicKey);
    expect(sig['digest']).toBe(packed.digest);
    expect(ajv(sig).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['version 2', { ...sig, v: 2 }],
    ['an upper-case digest', { ...sig, digest: String(sig['digest']).toUpperCase() }],
    ['a padded key', { ...sig, publisher: `${String(sig['publisher'])}=` }],
    ['an extra field', { ...sig, signer: 'me' }],
  ])('refuses %s', (_label, value) => {
    expect(ajv(value).ok).toBe(false);
  });
});

describe('catalog-index.json', () => {
  const sample = json('examples/catalog/catalog.json') as Record<string, unknown>;
  const item = {
    kind: 'plugin',
    id: 'com.example.x',
    name: 'X',
    version: '1.0.0',
    path: 'x',
    digest: 'a'.repeat(64),
  };
  agree('catalog-index.json', (v) => marketIndexSchema.safeParse(v).success, [
    ['the sample catalog', sample, true],
    ['an empty index', {}, true],
    [
      'an entry in another repository',
      { items: [{ ...item, repo: 'https://g/x.git', commit: 'b'.repeat(40) }] },
      true,
    ],
    [
      'an MCP registry entry',
      {
        items: [
          {
            kind: 'mcp',
            id: 'docs',
            name: 'Docs',
            version: '1.0.0',
            server: { transport: 'http', url: 'https://mcp.example.com/mcp' },
          },
        ],
      },
      true,
    ],
    ['a repository without a commit', { items: [{ ...item, repo: 'https://g/x.git' }] }, false],
    [
      'an entry with no location',
      { items: [{ kind: 'skill', id: 'a', name: 'A', version: '1.0.0' }] },
      false,
    ],
    ['an unknown kind', { items: [{ ...item, kind: 'font' }] }, false],
    ['a version that is not semver', { items: [{ ...item, version: '1.0' }] }, false],
    ['a short checksum', { items: [{ ...item, digest: 'abc' }] }, false],
  ]);
});

describe('catalog-signature.json', () => {
  it('describes the sample catalog signature', () => {
    expect(c.validate('catalog-signature.json', json('examples/catalog/catalog.json.sig')).ok).toBe(
      true,
    );
    expect(c.validate('catalog-signature.json', { v: 1, publisher: 'x' }).ok).toBe(false);
  });
});

describe('managed-settings.json', () => {
  const full = {
    version: 1,
    serial: 7,
    settings: { 'code.allowBypass': false, 'routing.allowCloud': false },
    restrict: {
      permissionModes: { deny: ['bypass'] },
      tools: { deny: ['screen.*', 'ext:*'] },
      plugins: { allow: ['com.corp.*'] },
      extensions: { deny: ['com.example.*'] },
      mcpServers: { allow: ['corp-docs'], userAdded: false, localStdio: false },
      sessions: { local: true, ssh: false, sshHosts: ['*.build.corp.example'] },
      folders: { allow: ['~/src', '/work'], deny: ['~/src/secret'] },
      browserDomains: { allow: ['*.corp.example'] },
      egress: { mode: 'limited', allow: ['registry.npmjs.org'], deny: ['paste.example'] },
      telemetryExport: false,
      routing: { allowCloud: false, providers: ['ollama', 'node'] },
      unverifiedInstalls: false,
      apps: false,
    },
    remote: {
      url: 'https://policy.corp.example/nova.json',
      publicKey: 'A'.repeat(43),
      refreshMinutes: 60,
      minSerial: 3,
    },
  };
  agree('managed-settings.json', (v) => managedPolicySchema.safeParse(v).success, [
    ['a full policy', full, true],
    ['only a version', { version: 1 }, true],
    ['version 2', { ...full, version: 2 }, false],
    ['an unknown top-level key', { ...full, hooks: [] }, false],
    ['an unknown restriction', { ...full, restrict: { ...full.restrict, ambient: false } }, false],
    [
      'a mode that does not exist',
      { ...full, restrict: { permissionModes: { deny: ['yolo'] } } },
      false,
    ],
    ['a relative folder', { ...full, restrict: { folders: { allow: ['src'] } } }, false],
    ['a folder with ..', { ...full, restrict: { folders: { allow: ['/work/../etc'] } } }, false],
    ['a bare * host', { ...full, restrict: { egress: { allow: ['*'] } } }, false],
    ['a key that is not base64url', { ...full, remote: { ...full.remote, publicKey: 'x' } }, false],
    [
      'a refresh under 5 minutes',
      { ...full, remote: { ...full.remote, refreshMinutes: 1 } },
      false,
    ],
  ]);

  it('describes the signed remote envelope', () => {
    const pair = generatePublisherKeyPair();
    const env = signManagedPolicy(
      Buffer.from(JSON.stringify(full)),
      createPrivateKey(pair.privateKeyPem),
    );
    const ajv = c.validator('managed-settings.json#/$defs/remoteEnvelope');
    expect(ajv(env).ok).toBe(true);
    expect(managedEnvelopeSchema.safeParse(env).success).toBe(true);
    for (const bad of [
      { ...env, v: 2 },
      { ...env, signature: 'x' },
      { ...env, extra: 1 },
    ]) {
      expect(ajv(bad).ok).toBe(false);
      expect(managedEnvelopeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('export-manifest.json', () => {
  const manifest = {
    format: 1,
    hubVersion: '0.8.0',
    schemaVersion: 51,
    createdAt: '2026-10-19T12:00:00.000Z',
    accountScope: 'hub',
    ownerAccountId: '0192f000-0000-7000-8000-000000000000',
    dataDir: '/var/lib/nova',
    encrypted: false,
    tables: [{ name: 'thread', rows: 3, sha256: 'c'.repeat(64) }],
    blobs: [
      { path: 'attachments/a.png', sha256: 'd'.repeat(64), size: 10 },
      { path: 'browser/x.enc', sha256: 'e'.repeat(64), size: 5, seal: 'browser-state:x' },
    ],
    secrets: null,
    toReEnter: ['secret://providers/abc/apiKey'],
    omitted: [{ kind: 'table', ref: 'trust_identity', reason: 'the Hub keeps its own keys' }],
  };
  agree('export-manifest.json', (v) => exportManifestSchema.safeParse(v).success, [
    ['an export without a passphrase', manifest, true],
    [
      'a sealed export',
      {
        ...manifest,
        encrypted: true,
        secrets: { count: 4, sha256: 'f'.repeat(64) },
        toReEnter: [],
        blobs: [{ path: 'x.enc', sha256: 'e'.repeat(64), size: 1, raw: true }],
      },
      true,
    ],
    [
      "a removed member's account export",
      { ...manifest, accountScope: { accountId: '0192f000-0000-7000-8000-000000000001' } },
      true,
    ],
    ['a scope that is neither', { ...manifest, accountScope: 'account' }, false],
    [
      'an account scope with extra fields',
      { ...manifest, accountScope: { accountId: 'a', all: true } },
      false,
    ],
    ['no schema version', { ...manifest, schemaVersion: 0 }, false],
    [
      'a table with a bad name',
      { ...manifest, tables: [{ name: 'Thread', rows: 1, sha256: 'c'.repeat(64) }] },
      false,
    ],
    [
      'a blob marked raw: false',
      { ...manifest, blobs: [{ path: 'x', sha256: 'e'.repeat(64), size: 1, raw: false }] },
      false,
    ],
    ['no list of secrets to re-enter', { ...manifest, toReEnter: undefined }, false],
  ]);
});
