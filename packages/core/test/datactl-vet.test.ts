// What an import cannot take on trust (FR-105, ADR-097 D5; the M8 data review's probes as
// regression tests): secret references that would resolve to the importing Hub's own keys or
// secrets, rows naming folders or files outside where the Hub keeps them, credentials in an
// archive without a passphrase, absolute paths of another data folder, executables and trust
// coming back on, restored sessions, and a disk too full to stage.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportManifest } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  DATA_KEY_REF,
  PluginService,
  ZipWriter,
  applyStaged,
  exportArchive,
  listDataFiles,
  listZip,
  readZipEntry,
  stageArchive,
  useBlobKey,
  wipeHub,
  writeSealedFile,
} from '../src/index.ts';

const T0 = '2026-10-01T10:00:00.000Z';
const OWNER = '01920000-0000-7000-8000-0000000000a1';
const B_OWNER = '01920000-0000-7000-8000-0000000000f1';
const PROV = '01920000-0000-7000-8000-0000000000d1';
const COMPUTER = '01920000-0000-7000-8000-0000000000e1';
const PASS = 'a long export passphrase';
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const MANIFEST = {
  schemaVersion: 1,
  id: 'com.example.helper',
  name: 'Helper',
  version: '1.0.0',
  permissions: {},
};

let dir: string;
let aData: string;
let a: NovaDatabase;
let aSecrets: MemorySecretStore;
let bData: string;
let b: NovaDatabase;
let bSecrets: MemorySecretStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-vet-'));
  aData = join(dir, 'a');
  a = openDatabase({ path: join(aData, 'nova.db') });
  await migrate(a, { backupDir: join(aData, 'backups') });
  aSecrets = new MemorySecretStore();
  const aKey = randomBytes(32);
  await aSecrets.put(DATA_KEY_REF, aKey.toString('base64'));
  useBlobKey(aData, aKey);
  a.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, T0, T0);
  a.raw
    .prepare("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?)")
    .run(OWNER, T0);
  // The importing Hub: fresh, its own identity key in the vault.
  bData = join(dir, 'b');
  b = openDatabase({ path: join(bData, 'nova.db') });
  await migrate(b, { backupDir: join(bData, 'backups') });
  bSecrets = new MemorySecretStore();
  const bKey = randomBytes(32);
  await bSecrets.put(DATA_KEY_REF, bKey.toString('base64'));
  await bSecrets.put('secret://hub/identity', 'B-HUB-IDENTITY-PRIVATE-KEY');
  useBlobKey(bData, bKey);
  b.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(B_OWNER, T0, T0);
});

afterEach(() => {
  a.close();
  b.close();
  useBlobKey(aData, null);
  useBlobKey(bData, null);
  rmSync(dir, { recursive: true, force: true });
});

async function exportA(passphrase?: string): Promise<{ path: string; manifest: ExportManifest }> {
  let manifest: ExportManifest | null = null;
  const chunks: Buffer[] = [];
  for await (const c of exportArchive({
    db: a,
    secrets: aSecrets,
    dataDir: aData,
    hubVersion: 't',
    scrypt: FAST,
    ...(passphrase ? { passphrase } : {}),
    onComplete: (m) => {
      manifest = m;
    },
  }))
    chunks.push(c);
  const path = join(dir, `x-${randomBytes(4).toString('hex')}.novaexport`);
  writeFileSync(path, Buffer.concat(chunks));
  return { path, manifest: manifest! };
}

async function importB(path: string, passphrase?: string) {
  const staged = await stageArchive({
    dataDir: bData,
    archivePath: path,
    ...(passphrase ? { passphrase } : {}),
  });
  try {
    return {
      staged,
      result: await applyStaged(staged, { db: b, secrets: bSecrets, dataDir: bData }),
    };
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

/** Nothing of the archive reached the importing Hub. */
function expectUntouched(): void {
  expect(b.raw.prepare('SELECT id FROM account').all()).toEqual([{ id: B_OWNER }]);
  expect(existsSync(join(bData, 'plugins'))).toBe(false);
}

/** Rewrite an archive's manifest (entries keep their bytes). */
function rewrite(src: string, edit: (m: ExportManifest) => void): string {
  const zip = new ZipWriter();
  const out: Buffer[] = [];
  for (const e of listZip(src, { maxEntries: 1e6, maxTotalBytes: 1e10 })) {
    const parts: Buffer[] = [];
    readZipEntry(src, e, (c) => parts.push(Buffer.from(c)));
    let data = Buffer.concat(parts);
    if (e.name === 'manifest.json') {
      const m = JSON.parse(data.toString()) as ExportManifest;
      edit(m);
      data = Buffer.from(JSON.stringify(m));
    }
    const w = zip.begin(e.name);
    out.push(w.header, ...w.push(data), ...w.finish());
  }
  out.push(...zip.end());
  const dest = `${src}.edited`;
  writeFileSync(dest, Buffer.concat(out));
  return dest;
}

const provider = (ref: string, baseUrl = 'https://collector.attacker.example/v1') =>
  a.raw
    .prepare(
      `INSERT INTO provider_account (id, account_id, provider, label, auth_kind, base_url, secret_ref, created_at, updated_at)
       VALUES (?, ?, 'openai', 'Cheap models', 'api_key', ?, ?, ?, ?)`,
    )
    .run(PROV, OWNER, baseUrl, ref, T0, T0);

describe('secret references (review #1)', () => {
  it("refuses a row pointing at the Hub's own key, in either kind of archive", async () => {
    provider('secret://hub/identity');
    const plain = await exportA();
    await expect(importB(plain.path)).rejects.toMatchObject({
      details: { reason: 'foreign_secret', table: 'provider_account' },
    });
    expectUntouched();
    const sealed = await exportA(PASS);
    await expect(importB(sealed.path, PASS)).rejects.toMatchObject({
      details: { reason: 'foreign_secret' },
    });
    expectUntouched();
  });

  it('refuses references in any column: egress credentials, MCP env, settings', async () => {
    const cases: [string, string, string][] = [
      [
        'egress_credential',
        `INSERT INTO egress_credential (id, account_id, name, hosts_json, scheme, secret_ref, created_at, updated_at)
         VALUES ('ec1', '${OWNER}', 'x', '["x.example"]', 'bearer', 'secret://push/vapid', '${T0}', '${T0}')`,
        "DELETE FROM egress_credential WHERE id = 'ec1'",
      ],
      [
        'mcp_server',
        `INSERT INTO mcp_server (id, account_id, name, transport, url, env_ref_json, created_at, updated_at)
         VALUES ('m1', '${OWNER}', 'r', 'http', 'https://x.example', '{"K":"secret://relay/abc/route-token"}', '${T0}', '${T0}')`,
        "DELETE FROM mcp_server WHERE id = 'm1'",
      ],
      [
        'setting',
        `INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at)
         VALUES ('x.y', 'global', '', '"secret://hub/ca/1/key"', '${T0}')`,
        "DELETE FROM setting WHERE key = 'x.y'",
      ],
    ];
    for (const [table, seed, undo] of cases) {
      a.raw.exec(seed);
      const plain = await exportA();
      a.raw.exec(undo);
      await expect(importB(plain.path), table).rejects.toMatchObject({
        details: { reason: 'foreign_secret', table },
      });
    }
    expectUntouched();
  });

  it('refuses, without a passphrase, a reference the manifest does not list to re-enter', async () => {
    provider('secret://provider/x/api_key', 'https://api.openai.example/v1');
    const plain = await exportA();
    expect(plain.manifest.toReEnter).toEqual(['secret://provider/x/api_key']);
    const edited = rewrite(plain.path, (m) => {
      m.toReEnter = [];
    });
    await expect(importB(edited)).rejects.toMatchObject({ details: { reason: 'foreign_secret' } });
    expectUntouched();
  });

  it('refuses a reference that would resolve to a secret this Hub holds', async () => {
    provider('secret://provider/x/api_key', 'https://api.openai.example/v1');
    await bSecrets.put('secret://provider/x/api_key', 'B-OWN-PROVIDER-KEY');
    const plain = await exportA();
    await expect(importB(plain.path)).rejects.toMatchObject({
      details: { reason: 'foreign_secret' },
    });
    expectUntouched();
    // With nothing of this Hub's to resolve to, the same archive imports; the key is to re-enter.
    await bSecrets.delete('secret://provider/x/api_key');
    const { staged } = await importB(plain.path);
    expect(staged.refs).toEqual(['secret://provider/x/api_key']);
  });

  it("allows a push subscription's own secret in a sealed archive only", async () => {
    a.raw
      .prepare(
        `INSERT INTO push_subscription (id, account_id, endpoint, p256dh, auth_ref, created_at, updated_at)
         VALUES ('ps1', ?, 'https://push.example/1', 'k', 'secret://push/ps1/auth', ?, ?)`,
      )
      .run(OWNER, T0, T0);
    await aSecrets.put('secret://push/ps1/auth', 'browser-auth');
    const sealed = await exportA(PASS);
    await importB(sealed.path, PASS);
    expect(await bSecrets.get('secret://push/ps1/auth')).toBe('browser-auth');
    // Pointing a subscription at another push secret is refused.
    a.raw.prepare("UPDATE push_subscription SET auth_ref = 'secret://push/vapid'").run();
    const bad = await exportA(PASS);
    rmSync(bData, { recursive: true, force: true });
    await expect(importB(bad.path, PASS)).rejects.toMatchObject({
      details: { reason: 'foreign_secret' },
    });
  });
});

describe('paths (review #2)', () => {
  const plugin = (id: string, installPath: string, manifest: object = { ...MANIFEST, id }) =>
    a.raw
      .prepare(
        `INSERT INTO plugin_install (id, account_id, plugin_id, version, source, origin, manifest_json, install_path, registrations_json, enabled, installed_at, updated_at)
         VALUES ('p1', ?, ?, '1.0.0', 'local', '/x', ?, ?, '{}', 0, ?, ?)`,
      )
      .run(OWNER, id, JSON.stringify(manifest), installPath, T0, T0);

  it('refuses a plugin id that climbs out, a path elsewhere, a mismatched manifest', async () => {
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'thesis.docx'), 'years of work');
    for (const [id, path, manifest] of [
      [
        '../../victim',
        join(aData, 'plugins', '../../victim', '1.0.0'),
        { ...MANIFEST, id: '../../victim' },
      ],
      ['com.example.helper', '/nonexistent', MANIFEST],
      [
        'com.example.helper',
        join(aData, 'plugins', 'com.example.helper', '1.0.0'),
        { ...MANIFEST, id: 'com.other.thing' },
      ],
      [
        'com.example.helper',
        join(aData, 'plugins', 'com.example.helper', '1.0.0'),
        { name: 'no schema' },
      ],
    ] as const) {
      a.raw.prepare('DELETE FROM plugin_install').run();
      plugin(id, path, manifest);
      const plain = await exportA();
      await expect(importB(plain.path), `${id} ${path}`).rejects.toMatchObject({
        details: { reason: 'unsafe_path' },
      });
    }
    expectUntouched();
    expect(readFileSync(join(victim, 'thesis.docx'), 'utf8')).toBe('years of work');
  });

  it('refuses unsafe folder ids, extension ids and blob paths', async () => {
    const cases: [string, string][] = [
      [
        `INSERT INTO account (id, kind, created_at, updated_at) VALUES ('../../x', 'local', '${T0}', '${T0}')`,
        "DELETE FROM account WHERE id = '../../x'",
      ],
      [
        `INSERT INTO extension_install (id, account_id, plugin_id, version, api, signature, digest, manifest_json, installed_at, updated_at)
         VALUES ('e1', '${OWNER}', '../evil', '1.0.0', 1, 'dev', 'd', '{"api":1,"entry":"m.js","permissions":{}}', '${T0}', '${T0}')`,
        "DELETE FROM extension_install WHERE id = 'e1'",
      ],
      [
        `UPDATE account SET avatar_path = 'nova.db' WHERE id = '${OWNER}'`,
        `UPDATE account SET avatar_path = NULL WHERE id = '${OWNER}'`,
      ],
      [
        `UPDATE account SET avatar_path = '/etc/passwd' WHERE id = '${OWNER}'`,
        `UPDATE account SET avatar_path = NULL WHERE id = '${OWNER}'`,
      ],
    ];
    for (const [seed, undo] of cases) {
      a.raw.exec(seed);
      const plain = await exportA();
      a.raw.exec(undo);
      await expect(importB(plain.path), seed).rejects.toMatchObject({
        details: { reason: 'unsafe_path' },
      });
    }
    expectUntouched();
  });

  it('moves absolute paths under the old data folder to this one', async () => {
    const path = join(aData, 'plugins', 'com.example.helper', '1.0.0');
    plugin('com.example.helper', path);
    mkdirSync(join(path, '.nova-plugin'), { recursive: true });
    writeFileSync(join(path, '.nova-plugin', 'plugin.json'), JSON.stringify(MANIFEST));
    const plain = await exportA();
    expect(plain.manifest.dataDir).toBe(aData);
    await importB(plain.path);
    expect(b.raw.prepare('SELECT install_path FROM plugin_install').get()).toEqual({
      install_path: join(bData, 'plugins', 'com.example.helper', '1.0.0'),
    });
    expect(
      existsSync(
        join(bData, 'plugins', 'com.example.helper', '1.0.0', '.nova-plugin', 'plugin.json'),
      ),
    ).toBe(true);
  });

  it('never removes a folder outside the plugins folder, whatever a row says', async () => {
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'thesis.docx'), 'years of work');
    // A row put there by hand (an import refuses it): uninstall refuses before changing anything.
    b.raw
      .prepare(
        `INSERT INTO plugin_install (id, account_id, plugin_id, version, source, origin, manifest_json, install_path, registrations_json, enabled, installed_at, updated_at)
         VALUES ('p1', ?, '../../victim', '1.0.0', 'local', '/x', ?, '/nonexistent', '{}', 0, ?, ?)`,
      )
      .run(B_OWNER, JSON.stringify(MANIFEST), T0, T0);
    const svc = new PluginService({
      db: b,
      secrets: bSecrets,
      dataDir: bData,
      catalogs: {},
      catalogConfigs: () => Promise.resolve([]),
    } as unknown as ConstructorParameters<typeof PluginService>[0]);
    await expect(svc.uninstall(B_OWNER, '../../victim')).rejects.toMatchObject({
      details: { reason: 'unsafe_path' },
    });
    expect(existsSync(join(victim, 'thesis.docx'))).toBe(true);
    expect(b.raw.prepare('SELECT count(*) AS n FROM plugin_install').get()).toEqual({ n: 1 });
  });
});

describe('credentials and folders (review #7, #8)', () => {
  it('leaves the agent browser cookie jar out of an archive without a passphrase', async () => {
    const cookies = JSON.stringify({
      cookies: [{ name: 'SESSION', value: 'bank-session-cookie-123' }],
    });
    const rel = join('browser', 'profiles', OWNER, COMPUTER, 'state.json');
    writeSealedFile(
      aData,
      join(aData, rel),
      `browser-state:${OWNER}:${COMPUTER}`,
      Buffer.from(cookies),
    );
    const plain = await exportA();
    expect(plain.manifest.blobs.some((x) => x.path.endsWith('state.json'))).toBe(false);
    expect(plain.manifest.omitted).toContainEqual(
      expect.objectContaining({ kind: 'file', ref: rel.split('\\').join('/') }),
    );
    expect(readFileSync(plain.path).includes(Buffer.from('bank-session-cookie'))).toBe(false);
    // In a sealed archive it travels (and comes back sealed with this Hub's key).
    const sealed = await exportA(PASS);
    expect(sealed.manifest.blobs.find((x) => x.path.endsWith('state.json'))).toMatchObject({
      seal: `browser-state:${OWNER}:${COMPUTER}`,
    });
  });

  it('exports and deletes extension and marketplace folders', async () => {
    const ext = join(aData, 'extensions', 'data', OWNER, 'com.example.notes', 'notes.json');
    mkdirSync(join(ext, '..'), { recursive: true });
    writeFileSync(ext, '{"note":"kept by an extension"}');
    const pet = join(aData, 'market', 'pets', 'cat', 'pet.json');
    mkdirSync(join(pet, '..'), { recursive: true });
    writeFileSync(pet, '{}');
    // A write in progress is never exported.
    mkdirSync(join(aData, 'extensions', '.staging', 'x'), { recursive: true });
    writeFileSync(join(aData, 'extensions', '.staging', 'x', 'partial'), 'x');
    const paths = listDataFiles(aData).map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `extensions/data/${OWNER}/com.example.notes/notes.json`,
        'market/pets/cat/pet.json',
      ]),
    );
    expect(paths.some((p) => p.includes('.staging'))).toBe(false);
    const r = await wipeHub({
      db: a,
      secrets: aSecrets,
      dataDir: aData,
      ownerAccountId: OWNER,
      keepSessionId: null,
    });
    expect(r.keptPaths).toEqual([]);
    expect(existsSync(ext)).toBe(false);
    expect(existsSync(pet)).toBe(false);
  });
});

describe('what an archive cannot vouch for comes back off', () => {
  it('disables stdio servers, plugins and agent programs, untrusts hooks, revokes sessions', async () => {
    const path = join(aData, 'plugins', 'com.example.helper', '1.0.0');
    a.raw
      .prepare(
        `INSERT INTO plugin_install (id, account_id, plugin_id, version, source, origin, manifest_json, install_path, registrations_json, enabled, installed_at, updated_at)
         VALUES ('p1', ?, 'com.example.helper', '1.0.0', 'local', '/x', ?, ?, '{}', 1, ?, ?)`,
      )
      .run(OWNER, JSON.stringify(MANIFEST), path, T0, T0);
    a.raw
      .prepare(
        `INSERT INTO mcp_server (id, account_id, name, transport, command, enabled, created_at, updated_at)
         VALUES ('s1', ?, 'stdio', 'stdio', 'node', 1, ?, ?), ('s2', ?, 'web', 'http', NULL, 1, ?, ?)`,
      )
      .run(OWNER, T0, T0, OWNER, T0, T0);
    a.raw
      .prepare(
        "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES ('s', 'session', 'h', ?, ?)",
      )
      .run(OWNER, T0);
    const plain = await exportA();
    const { staged } = await importB(plain.path);
    expect(staged.restoredOff).toMatchObject({ mcpServers: 1, plugins: 1, sessions: 1 });
    expect(b.raw.prepare('SELECT id, enabled FROM mcp_server ORDER BY id').all()).toEqual([
      { id: 's1', enabled: 0 },
      { id: 's2', enabled: 1 },
    ]);
    expect(b.raw.prepare('SELECT enabled FROM plugin_install').get()).toEqual({ enabled: 0 });
    expect(
      b.raw.prepare("SELECT revoked_at IS NOT NULL AS r FROM auth_token WHERE id = 's'").get(),
    ).toEqual({ r: 1 });
  });

  it('refuses to stage when the disk cannot hold it, writing nothing', async () => {
    const plain = await exportA();
    await expect(
      stageArchive({ dataDir: bData, archivePath: plain.path, freeBytes: () => 1024 }),
    ).rejects.toMatchObject({ details: { reason: 'disk_full' } });
    expect(existsSync(join(bData, 'datactl', 'staging'))).toBe(true);
    expectUntouched();
  });
});
