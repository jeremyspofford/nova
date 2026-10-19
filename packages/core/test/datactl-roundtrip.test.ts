// J10 step 3 in core (FR-105, ADR-097 D5): export -> delete-all -> import, compared table by table
// and file by file, with and without a passphrase; a damaged, mis-summed or newer archive is
// refused with nothing written; an older one migrates forward.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExportManifest } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { loadMigrations, migrate, openDatabase, schema, type NovaDatabase } from '@nova/storage';
import {
  AuditLog,
  DATA_KEY_REF,
  DERIVED_TABLES,
  HUB_KEY_DEPENDENTS,
  HUB_KEY_TABLES,
  ZipWriter,
  applyStaged,
  dataTables,
  exportArchive,
  hubEmptiness,
  listZip,
  readAttachmentBlob,
  readSealedFile,
  readZipEntry,
  stageArchive,
  storedTables,
  tableLines,
  useBlobKey,
  verifyAuditChain,
  wipeHub,
  writeAttachmentBlob,
  writeSealedFile,
  type StagedArchive,
} from '../src/index.ts';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const SESSION = '01920000-0000-7000-8000-00000000005e';
const THREAD = '01920000-0000-7000-8000-0000000000b1';
const MESSAGE = '01920000-0000-7000-8000-0000000000c1';
const PROVIDER = '01920000-0000-7000-8000-0000000000d1';
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'a long export passphrase';
const T0 = '2026-10-01T10:00:00.000Z';

let dir: string;
let dataDir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let key: Buffer;

const attachment = Buffer.from('a picture, really '.repeat(400));
const screenshot = randomBytes(5000);
const snapshot = Buffer.from(JSON.stringify({ secureBoot: true }));
const mystery = Buffer.from('sealed with a label nobody knows');
const skill = Buffer.from('# A skill\nDo the thing.\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-rt-'));
  dataDir = join(dir, 'data');
  db = openDatabase({ path: join(dataDir, 'nova.db') });
  await migrate(db, { backupDir: join(dataDir, 'backups') });
  secrets = new MemorySecretStore();
  key = randomBytes(32);
  await secrets.put(DATA_KEY_REF, key.toString('base64'));
  await secrets.put('secret://hub/identity', 'identity-private-key');
  await secrets.put(`secret://provider/${PROVIDER}/api_key`, 'sk-test-provider-key-123456');
  useBlobKey(dataDir, key);
  await seed();
});

afterEach(() => {
  db.close();
  useBlobKey(dataDir, null);
  rmSync(dir, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  const run = (sql: string, ...args: (string | number | null)[]) =>
    db.raw.prepare(sql).run(...args);
  run(
    "INSERT INTO account (id, kind, display_name, username, created_at, updated_at) VALUES (?, 'local', 'Owner', 'owner', ?, ?)",
    OWNER,
    T0,
    T0,
  );
  run("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?)", OWNER, T0);
  run(
    "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES (?, 'session', 'hash-s', ?, ?)",
    SESSION,
    OWNER,
    T0,
  );
  run(
    `INSERT INTO provider_account (id, account_id, provider, label, auth_kind, secret_ref, created_at, updated_at)
     VALUES (?, ?, 'anthropic', 'Work', 'api_key', ?, ?, ?)`,
    PROVIDER,
    OWNER,
    `secret://provider/${PROVIDER}/api_key`,
    T0,
    T0,
  );
  run(
    "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES ('appearance.theme', 'global', '', '\"dark\"', ?)",
    T0,
  );
  run(
    "INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, 'chat', 'Plans', ?, ?)",
    THREAD,
    OWNER,
    T0,
    T0,
  );
  run(
    "INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
    MESSAGE,
    THREAD,
    T0,
    T0,
  );
  run(
    "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES ('p1', ?, 0, 'text', 'find the needle', ?)",
    MESSAGE,
    T0,
  );
  const blob = writeAttachmentBlob(dataDir, attachment);
  run(
    "INSERT INTO attachment (id, message_id, thread_id, name, blob_path, created_at) VALUES ('a1', ?, ?, 'pic.txt', ?, ?)",
    MESSAGE,
    THREAD,
    blob.blobPath,
    T0,
  );
  run(
    `INSERT INTO memory_item (id, account_id, scope_kind, content, content_key, created_at, updated_at)
     VALUES ('m1', ?, 'global', 'likes tea', 'likes tea', ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  run(
    "INSERT INTO usage_event (id, account_id, provider, model, input_tokens, cost_usd, created_at) VALUES ('u1', ?, 'anthropic', 'm', 7, 0.25, ?)",
    OWNER,
    T0,
  );
  run(
    "INSERT INTO trust_identity (id, public_key, fingerprint, key_ref, created_at) VALUES ('hub', 'pk', 'fp', 'secret://hub/identity', ?)",
    T0,
  );
  const audit = new AuditLog({ db });
  for (const action of ['one', 'two', 'three'])
    await audit.append({ accountId: OWNER, actor: 'user', kind: 'settings', action });
  writeSealedFile(
    dataDir,
    join(dataDir, 'blobs/screenshots/20261001/s1-before.png'),
    'blobs/screenshots/20261001/s1-before.png',
    screenshot,
  );
  writeSealedFile(
    dataDir,
    join(dataDir, 'firmware/snapshots/snap1.json'),
    'firmware-snapshot:snap1',
    snapshot,
  );
  writeSealedFile(dataDir, join(dataDir, 'browser/files/x/odd.bin'), 'mystery-label', mystery);
  mkdirSync(join(dataDir, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(dataDir, 'skills', 'mine', 'SKILL.md'), skill);
  // Never exported: logs, backups and the egress CA.
  mkdirSync(join(dataDir, 'egress'), { recursive: true });
  writeFileSync(join(dataDir, 'egress', 'ca-key.pem'), 'KEY');
  // M8 tables of the other areas and this one travel like the rest (ADR-097).
  run(
    `INSERT INTO extension_install (id, account_id, plugin_id, version, api, signature, digest, manifest_json, installed_at, updated_at)
     VALUES ('x1', ?, 'com.example.ext', '1.0.0', 1, 'verified', 'd', '{"api":1,"entry":"main.js","permissions":{}}', ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  run(
    `INSERT INTO market_install (id, account_id, kind, item_id, name, version, catalog_id, origin, signature, installed_at, updated_at)
     VALUES ('mi1', ?, 'theme', 'calm', 'Calm', '1.0.0', 'sample', 'sample/calm@1.0.0', 'verified', ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  run(
    `INSERT INTO market_rating (id, account_id, kind, item_id, stars, review, created_at, updated_at)
     VALUES ('mr1', ?, 'theme', 'calm', 5, 'lovely', ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  run(
    `INSERT INTO spend_cap (account_id, provider, limit_usd, period, warn_at, hard_stop, created_at, updated_at)
     VALUES (?, 'anthropic', 12.5, 'month', 0.8, 1, ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  run(
    "INSERT INTO retention_sweep (id, kind, started_at, finished_at, result_json) VALUES ('rs1', 'schedule', ?, ?, '{}')",
    T0,
    T0,
  );
  // What runs code or holds trust, which an import turns off (vet.ts).
  const manifest = {
    schemaVersion: 1,
    id: 'com.example.helper',
    name: 'Helper',
    version: '1.0.0',
    permissions: {},
  };
  run(
    `INSERT INTO plugin_install (id, account_id, plugin_id, version, source, origin, manifest_json, install_path, registrations_json, enabled, installed_at, updated_at)
     VALUES ('pl1', ?, 'com.example.helper', '1.0.0', 'local', '/src/helper', ?, ?, '{}', 1, ?, ?)`,
    OWNER,
    JSON.stringify(manifest),
    join(dataDir, 'plugins', 'com.example.helper', '1.0.0'),
    T0,
    T0,
  );
  mkdirSync(join(dataDir, 'plugins', 'com.example.helper', '1.0.0', '.nova-plugin'), {
    recursive: true,
  });
  writeFileSync(
    join(dataDir, 'plugins', 'com.example.helper', '1.0.0', '.nova-plugin', 'plugin.json'),
    JSON.stringify(manifest),
  );
  run(
    `INSERT INTO mcp_server (id, account_id, name, transport, command, env_ref_json, enabled, created_at, updated_at)
     VALUES ('srv1', ?, 'local-tool', 'stdio', 'node', '{"TOKEN":"secret://mcp/srv1/env/TOKEN"}', 1, ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  await secrets.put('secret://mcp/srv1/env/TOKEN', 'mcp-env-token-value');
  run(
    `INSERT INTO hook (id, account_id, hook_key, event, handler_kind, handler_json, source, definition_json, content_hash, trusted_hash, trust_state, trusted_by, trusted_at, created_at, updated_at)
     VALUES ('h1', ?, 'k', 'stop', 'command', '{}', 'user', '{}', 'hash', 'hash', 'trusted', ?, ?, ?, ?)`,
    OWNER,
    OWNER,
    T0,
    T0,
    T0,
  );
  run(
    `INSERT INTO agent_adapter (id, account_id, name, command, permission_routing, enabled, created_at, updated_at)
     VALUES ('ad1', ?, 'helper', '/usr/bin/agent', 'client', 1, ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  run(
    "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES ('old-session', 'session', 'hash-old', ?, ?)",
    OWNER,
    T0,
  );
  run(
    `INSERT INTO push_subscription (id, account_id, endpoint, p256dh, auth_ref, created_at, updated_at)
     VALUES ('ps1', ?, 'https://push.example/1', 'key', 'secret://push/ps1/auth', ?, ?)`,
    OWNER,
    T0,
    T0,
  );
  await secrets.put('secret://push/ps1/auth', 'push-auth-secret');
}

async function exportTo(path: string, passphrase?: string): Promise<ExportManifest> {
  let manifest: ExportManifest | null = null;
  const chunks: Buffer[] = [];
  for await (const c of exportArchive({
    db,
    secrets,
    dataDir,
    hubVersion: '0.8.0-test',
    scrypt: FAST,
    ...(passphrase ? { passphrase } : {}),
    onComplete: (m) => {
      manifest = m;
    },
  }))
    chunks.push(c);
  writeFileSync(path, Buffer.concat(chunks));
  return manifest!;
}

/** The columns an import turns off or revokes (vet.ts), left out of a comparison. */
const RESTORED_OFF: Record<string, string[]> = {
  mcp_server: ['enabled'],
  plugin_install: ['enabled'],
  agent_adapter: ['enabled'],
  hook: ['trust_state', 'trusted_hash', 'trusted_by', 'trusted_at'],
  auth_token: ['revoked_at'],
};

/** A table's lines without the columns an import turns off. */
function comparable(table: string, lines: string[] | undefined): unknown[] {
  const drop = RESTORED_OFF[table] ?? [];
  return (lines ?? []).map((l) => {
    const o = JSON.parse(l) as Record<string, unknown>;
    for (const c of drop) delete o[c];
    return o;
  });
}

/** What an import turned off, checked on the imported Hub. */
function expectRestoredOff(): void {
  const one = (sql: string) => db.raw.prepare(sql).get();
  expect(one("SELECT enabled FROM mcp_server WHERE id = 'srv1'")).toEqual({ enabled: 0 });
  expect(one("SELECT enabled FROM plugin_install WHERE id = 'pl1'")).toEqual({ enabled: 0 });
  expect(one("SELECT enabled FROM agent_adapter WHERE id = 'ad1'")).toEqual({ enabled: 0 });
  expect(one("SELECT trust_state, trusted_hash FROM hook WHERE id = 'h1'")).toEqual({
    trust_state: 'needs_trust',
    trusted_hash: null,
  });
  // Every restored session is revoked but the importing one.
  expect(
    one("SELECT revoked_at IS NOT NULL AS r FROM auth_token WHERE id = 'old-session'"),
  ).toEqual({ r: 1 });
  expect(db.raw.prepare('SELECT revoked_at FROM auth_token WHERE id = ?').get(SESSION)).toEqual({
    revoked_at: null,
  });
}

function dump(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of dataTables(db.raw)) out.set(t.name, [...tableLines(db.raw, t)]);
  return out;
}

function rowCount(): number {
  let n = 0;
  for (const t of dataTables(db.raw))
    n += Number((db.raw.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get() as { n: number }).n);
  return n;
}

async function wipe(): Promise<void> {
  await wipeHub({ db, secrets, dataDir, ownerAccountId: OWNER, keepSessionId: SESSION });
}

async function importFrom(path: string, passphrase?: string): Promise<StagedArchive> {
  const staged = await stageArchive({
    dataDir,
    archivePath: path,
    ...(passphrase ? { passphrase } : {}),
  });
  await applyStaged(staged, { db, secrets, dataDir, keepSessionId: SESSION });
  rmSync(staged.dir, { recursive: true, force: true });
  return staged;
}

/** What delete-all leaves: the bare owner, their owner row and the session. */
function expectWiped(): void {
  expect(rowCount()).toBe(3);
  expect(existsSync(join(dataDir, 'blobs'))).toBe(false);
  expect(existsSync(join(dataDir, 'skills'))).toBe(false);
  expect(existsSync(join(dataDir, 'egress'))).toBe(false);
}

describe('export -> delete-all -> import (J10 step 3)', () => {
  it('round-trips without a passphrase: every table and file, secrets listed to re-enter', async () => {
    const before = dump();
    const archive = join(dir, 'plain.novaexport');
    const m = await exportTo(archive);
    expect(m.encrypted).toBe(false);
    expect(m.toReEnter).toEqual([
      'secret://mcp/srv1/env/TOKEN',
      `secret://provider/${PROVIDER}/api_key`,
    ]);
    // Push subscriptions need their secret: left out with the Hub's keys.
    expect(m.tables.some((t) => t.name === 'push_subscription')).toBe(false);
    expect(m.secrets).toBeNull();
    for (const t of HUB_KEY_TABLES) expect(m.tables.some((x) => x.name === t)).toBe(false);
    expect(m.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'table', ref: 'trust_identity' }),
        expect.objectContaining({ kind: 'file', ref: 'browser/files/x/odd.bin' }),
      ]),
    );
    // Sealed files travel decrypted, with the label to seal them again.
    const shot = m.blobs.find((b) => b.path.startsWith('blobs/screenshots/'))!;
    expect(shot.seal).toBe(shot.path);
    expect(m.blobs.find((b) => b.path === 'firmware/snapshots/snap1.json')!.seal).toBe(
      'firmware-snapshot:snap1',
    );
    expect(m.blobs.some((b) => b.path.startsWith('egress/'))).toBe(false);
    // The archive never holds a secret value.
    const bytes = readFileSync(archive);
    expect(bytes.includes(Buffer.from('sk-test-provider-key'))).toBe(false);

    await wipe();
    expectWiped();
    expect(await secrets.list()).toEqual([]);
    expect(hubEmptiness(db.raw).empty).toBe(true);

    await importFrom(archive);
    const after = dump();
    for (const t of m.tables)
      expect(comparable(t.name, after.get(t.name)), t.name).toEqual(
        comparable(t.name, before.get(t.name)),
      );
    expectRestoredOff();
    // Files back, sealed again with the Hub's key.
    const blob = m.blobs.find((b) => b.path.startsWith('blobs/attachments/'))!;
    expect(readAttachmentBlob(dataDir, blob.path).equals(attachment)).toBe(true);
    expect(readFileSync(join(dataDir, blob.path)).subarray(0, 1)[0]).toBe(0);
    expect(readSealedFile(dataDir, join(dataDir, shot.path), shot.path).equals(screenshot)).toBe(
      true,
    );
    expect(
      readSealedFile(
        dataDir,
        join(dataDir, 'firmware/snapshots/snap1.json'),
        'firmware-snapshot:snap1',
      ).equals(snapshot),
    ).toBe(true);
    expect(readFileSync(join(dataDir, 'skills/mine/SKILL.md')).equals(skill)).toBe(true);
    for (const b of m.blobs) expect(existsSync(join(dataDir, b.path)), b.path).toBe(true);
    // Search works on the imported rows (the index is rebuilt, not copied).
    expect(
      db.raw
        .prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle'")
        .get(),
    ).toEqual({ n: 1 });
    expect(verifyAuditChain(db.raw)).toMatchObject({ ok: true, checked: 3 });
  });

  it('round-trips with a passphrase: secrets and the Hub keys come back sealed', async () => {
    const before = dump();
    const archive = join(dir, 'sealed.novaexport');
    const m = await exportTo(archive, PASS);
    expect(m.encrypted).toBe(true);
    expect(m.secrets?.count).toBe(5);
    expect(m.toReEnter).toEqual([]);
    expect(m.tables.some((t) => t.name === 'trust_identity')).toBe(true);
    expect(m.blobs.find((b) => b.path === 'browser/files/x/odd.bin')).toMatchObject({ raw: true });
    const bytes = readFileSync(archive);
    expect(bytes.includes(Buffer.from('sk-test-provider-key'))).toBe(false);
    expect(bytes.includes(Buffer.from('manifest.json'))).toBe(false);

    await wipe();
    expectWiped();
    // A wrong passphrase writes nothing.
    await expect(importFrom(archive, 'not the passphrase')).rejects.toMatchObject({
      details: { reason: 'wrong_passphrase' },
    });
    await expect(importFrom(archive)).rejects.toMatchObject({
      details: { reason: 'passphrase_required' },
    });
    expectWiped();
    expect(await secrets.list()).toEqual([]);

    await importFrom(archive, PASS);
    const after = dump();
    for (const t of m.tables)
      expect(comparable(t.name, after.get(t.name)), t.name).toEqual(
        comparable(t.name, before.get(t.name)),
      );
    expectRestoredOff();
    expect(await secrets.get(`secret://provider/${PROVIDER}/api_key`)).toBe(
      'sk-test-provider-key-123456',
    );
    expect(await secrets.get('secret://hub/identity')).toBe('identity-private-key');
    expect(await secrets.get(DATA_KEY_REF)).toBe(key.toString('base64'));
    // The file only the old key opens is readable again with the adopted key.
    expect(
      readSealedFile(dataDir, join(dataDir, 'browser/files/x/odd.bin'), 'mystery-label').equals(
        mystery,
      ),
    ).toBe(true);
  });

  it('keeps the importing Hub own keys when the archive has no passphrase', async () => {
    const archive = join(dir, 'plain.novaexport');
    await exportTo(archive);
    await wipe();
    // The importing Hub made its own identity after the wipe.
    db.raw
      .prepare(
        "INSERT INTO trust_identity (id, public_key, fingerprint, key_ref, created_at) VALUES ('hub', 'pk2', 'fp2', 'secret://hub/identity', ?)",
      )
      .run(T0);
    const staged = await stageArchive({ dataDir, archivePath: archive });
    const r = await applyStaged(staged, { db, secrets, dataDir, keepSessionId: SESSION });
    expect(r.keptTables).toEqual(HUB_KEY_TABLES);
    expect(db.raw.prepare('SELECT fingerprint FROM trust_identity').get()).toEqual({
      fingerprint: 'fp2',
    });
  });
});

describe('every table travels', () => {
  /** Tables the migrated schema has (sqlite_master), and those the Drizzle schema declares. */
  function schemaTables(): { stored: string[]; declared: string[] } {
    const declared = (Object.values(schema) as unknown[])
      .filter((v): v is SQLiteTable => typeof v === 'object' && v !== null && 'getSQL' in v)
      .map((t) => getTableConfig(t).name);
    return { stored: storedTables(db.raw).tables, declared };
  }

  it('enumerates the schema: nothing is left out but derived tables (and keys without a passphrase)', async () => {
    const { stored, declared } = schemaTables();
    for (const t of [
      'extension_install',
      'market_install',
      'market_rating',
      'spend_cap',
      'spend_alert',
      'retention_sweep',
      'audit_anchor',
    ])
      expect(stored, t).toContain(t);

    const sealed = await exportTo(join(dir, 'sealed.novaexport'), PASS);
    const carried = new Set(sealed.tables.map((t) => t.name));
    expect(stored.filter((t) => !carried.has(t))).toEqual([...DERIVED_TABLES]);
    // A table the Drizzle schema declares is carried once its migration exists.
    expect(
      declared.filter((t) => stored.includes(t) && !carried.has(t) && !DERIVED_TABLES.includes(t)),
    ).toEqual([]);

    const plain = await exportTo(join(dir, 'plain.novaexport'));
    const left = stored.filter((t) => !plain.tables.some((x) => x.name === t)).sort();
    expect(left).toEqual([...DERIVED_TABLES, ...HUB_KEY_TABLES, ...HUB_KEY_DEPENDENTS].sort());
    for (const t of [...HUB_KEY_TABLES, ...HUB_KEY_DEPENDENTS])
      expect(plain.omitted).toContainEqual(expect.objectContaining({ kind: 'table', ref: t }));

    // Delete-all empties every stored table (but the kept owner rows); the import fills them back.
    const before = dump();
    await wipe();
    for (const t of stored) {
      const n = Number(
        (db.raw.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n,
      );
      const kept = t === 'account' || t === 'team_member' || t === 'auth_token' ? 1 : 0;
      expect(n, t).toBe(kept);
    }
    await importFrom(join(dir, 'sealed.novaexport'), PASS);
    const after = dump();
    for (const t of stored.filter((x) => !DERIVED_TABLES.includes(x)))
      expect(comparable(t, after.get(t)), t).toEqual(comparable(t, before.get(t)));
    expectRestoredOff();
    for (const t of [
      'extension_install',
      'market_install',
      'market_rating',
      'spend_cap',
      'retention_sweep',
    ])
      expect(after.get(t), t).toHaveLength(1);
  });
});

describe('refused archives write nothing', () => {
  /** Rewrite an archive with a changed manifest (the entries' bytes stay). */
  function rewrite(
    src: string,
    dest: string,
    edit: (m: ExportManifest) => void,
    drop?: string,
  ): void {
    const zip = new ZipWriter();
    const out: Buffer[] = [];
    for (const e of listZip(src, { maxEntries: 1e6, maxTotalBytes: 1e10 })) {
      if (e.name === drop) continue;
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
    writeFileSync(dest, Buffer.concat(out));
  }

  async function refused(path: string, reason: string): Promise<void> {
    await expect(importFrom(path)).rejects.toMatchObject({ details: { reason } });
    expectWiped();
    expect(existsSync(join(dataDir, 'datactl', 'staging'))).toBe(true);
    expect(readdirOrEmpty(join(dataDir, 'datactl', 'staging'))).toEqual([]);
  }

  it('refuses damaged, mis-summed, incomplete and newer archives', async () => {
    const archive = join(dir, 'plain.novaexport');
    await exportTo(archive);
    await wipe();

    // One byte changed inside a table's data.
    const damaged = Buffer.from(readFileSync(archive));
    const entry = listZip(archive, { maxEntries: 1e6, maxTotalBytes: 1e10 }).find(
      (e) => e.name === 'tables/thread.jsonl',
    )!;
    const at =
      entry.offset +
      30 +
      damaged.readUInt16LE(entry.offset + 26) +
      damaged.readUInt16LE(entry.offset + 28) +
      2;
    damaged[at] = damaged[at]! ^ 0xff;
    writeFileSync(join(dir, 'damaged'), damaged);
    await expect(importFrom(join(dir, 'damaged'))).rejects.toMatchObject({
      details: { reason: 'archive_damaged' },
    });
    expectWiped();

    rewrite(archive, join(dir, 'sum'), (m) => {
      m.tables[0]!.sha256 = '0'.repeat(64);
    });
    await refused(join(dir, 'sum'), 'checksum_mismatch');

    const current = loadMigrations().at(-1)!.version;
    rewrite(archive, join(dir, 'newer'), (m) => {
      m.schemaVersion = current + 1;
    });
    await refused(join(dir, 'newer'), 'newer_schema');

    rewrite(archive, join(dir, 'format'), (m) => {
      m.format = 2;
    });
    await refused(join(dir, 'format'), 'unsupported_format');

    rewrite(archive, join(dir, 'missing'), () => undefined, 'tables/thread.jsonl');
    await refused(join(dir, 'missing'), 'archive_damaged');

    rewrite(archive, join(dir, 'escape'), (m) => {
      m.blobs.push({ path: '../outside', sha256: '0'.repeat(64), size: 0 });
    });
    await refused(join(dir, 'escape'), 'archive_damaged');
  });
});

function readdirOrEmpty(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

describe('an older archive migrates forward', () => {
  it('imports rows exported at an earlier schema version', async () => {
    const migrations = loadMigrations();
    const older = migrations.filter((m) => m.version <= 40);
    const oldDir = join(dir, 'old');
    const oldDb = openDatabase({ path: join(oldDir, 'nova.db') });
    await migrate(oldDb, { migrations: older });
    oldDb.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Old', ?, ?)",
      )
      .run(OWNER, T0, T0);
    oldDb.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, 'chat', 'Old chat', ?, ?)",
      )
      .run(THREAD, OWNER, T0, T0);
    const chunks: Buffer[] = [];
    let manifest: ExportManifest | null = null;
    for await (const c of exportArchive({
      db: oldDb,
      secrets: new MemorySecretStore(),
      dataDir: oldDir,
      hubVersion: '0.7.5',
      onComplete: (m) => {
        manifest = m;
      },
    }))
      chunks.push(c);
    oldDb.close();
    expect(manifest!.schemaVersion).toBe(40);
    const archive = join(dir, 'old.novaexport');
    writeFileSync(archive, Buffer.concat(chunks));

    await wipe();
    // The bare owner left by the wipe is the same account: the import replaces it.
    const staged = await stageArchive({ dataDir, archivePath: archive });
    expect(staged.migratedFrom).toBe(40);
    await applyStaged(staged, { db, secrets, dataDir, keepSessionId: SESSION });
    expect(db.raw.prepare('SELECT title FROM thread').all()).toEqual([{ title: 'Old chat' }]);
  });
});
