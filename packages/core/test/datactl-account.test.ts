// One account's export (FR-105, ADR-097 D5): a member's archive holds their rows and files and
// nothing of the owner's or another member's, no secret (references listed to re-enter), cannot
// be sealed, is audited with its scope, and is refused by import.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportManifest } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  AuditLog,
  DATA_KEY_REF,
  DataControls,
  exportArchive,
  listZip,
  readZipEntry,
  stageArchive,
  useBlobKey,
  writeAttachmentBlob,
  type AuditRecord,
} from '../src/index.ts';

const T0 = '2026-10-01T10:00:00.000Z';
const OWNER = '01920000-0000-7000-8000-0000000000a1';
const MEMBER = '01920000-0000-7000-8000-0000000000b2';
const OTHER = '01920000-0000-7000-8000-0000000000c3';

let dir: string;
let dataDir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let audited: AuditRecord[];
let data: DataControls;
const blobs: Record<string, string> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-account-'));
  dataDir = join(dir, 'data');
  db = openDatabase({ path: join(dataDir, 'nova.db') });
  await migrate(db, { backupDir: join(dataDir, 'backups') });
  secrets = new MemorySecretStore();
  const key = randomBytes(32);
  await secrets.put(DATA_KEY_REF, key.toString('base64'));
  useBlobKey(dataDir, key);
  const run = (sql: string, ...args: string[]) => db.raw.prepare(sql).run(...args);
  for (const [id, role] of [
    [OWNER, 'owner'],
    [MEMBER, 'member'],
    [OTHER, 'member'],
  ] as const) {
    run(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)",
      id,
      `name-${id.slice(-2)}`,
      T0,
      T0,
    );
    run('INSERT INTO team_member (account_id, role, joined_at) VALUES (?, ?, ?)', id, role, T0);
    // A chat with a message, a file and a memory each.
    const t = `t-${id.slice(-2)}`;
    run(
      "INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?, ?)",
      t,
      id,
      `chat of ${id.slice(-2)}`,
      T0,
      T0,
    );
    run(
      "INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
      `m-${id.slice(-2)}`,
      t,
      T0,
      T0,
    );
    run(
      "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
      `p-${id.slice(-2)}`,
      `m-${id.slice(-2)}`,
      `words of ${id.slice(-2)}`,
      T0,
    );
    const blob = writeAttachmentBlob(dataDir, Buffer.from(`file of ${id.slice(-2)}`));
    blobs[id] = blob.blobPath;
    run(
      "INSERT INTO attachment (id, message_id, thread_id, name, blob_path, created_at) VALUES (?, ?, ?, 'f.txt', ?, ?)",
      `a-${id.slice(-2)}`,
      `m-${id.slice(-2)}`,
      t,
      blob.blobPath,
      T0,
    );
    run(
      `INSERT INTO memory_item (id, account_id, scope_kind, content, content_key, created_at, updated_at)
       VALUES (?, ?, 'global', ?, ?, ?, ?)`,
      `mem-${id.slice(-2)}`,
      id,
      `memory of ${id.slice(-2)}`,
      `memory of ${id.slice(-2)}`,
      T0,
      T0,
    );
    run(
      'INSERT INTO member_setting (account_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)',
      id,
      'appearance.theme',
      '"dark"',
      T0,
    );
    run(
      `INSERT INTO provider_account (id, account_id, provider, label, auth_kind, secret_ref, created_at, updated_at)
       VALUES (?, ?, 'openai', 'key', 'api_key', ?, ?, ?)`,
      `pa-${id.slice(-2)}`,
      id,
      `secret://provider/pa-${id.slice(-2)}/api_key`,
      T0,
      T0,
    );
    await secrets.put(
      `secret://provider/pa-${id.slice(-2)}/api_key`,
      `sk-secret-of-${id.slice(-2)}`,
    );
    mkdirSync(join(dataDir, 'members', id, 'workspace'), { recursive: true });
    writeFileSync(
      join(dataDir, 'members', id, 'workspace', 'notes.md'),
      `notes of ${id.slice(-2)}`,
    );
  }
  // The member wrote in the owner's shared chat: the chat (and the words) are the owner's.
  run(
    `INSERT INTO thread_share (thread_id, account_id, owner_account_id, shared_by, created_at)
     VALUES ('t-a1', ?, ?, ?, ?)`,
    MEMBER,
    OWNER,
    OWNER,
    T0,
  );
  run(
    "INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES ('m-shared', 't-a1', 'user', ?, ?)",
    T0,
    T0,
  );
  run(
    "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES ('p-shared', 'm-shared', 0, 'text', 'member words in the owner chat', ?)",
    T0,
  );
  run(
    "INSERT INTO shared_message (message_id, thread_id, account_id, created_at) VALUES ('m-shared', 't-a1', ?, ?)",
    MEMBER,
    T0,
  );
  const audit = new AuditLog({ db });
  for (const id of [OWNER, MEMBER, OTHER])
    await audit.append({
      accountId: id,
      actor: 'user',
      kind: 'settings',
      action: `did-${id.slice(-2)}`,
    });
  audited = [];
  data = new DataControls({
    db,
    secrets,
    dataDir,
    hubVersion: '0.8.0',
    hubName: () => Promise.resolve('home-hub'),
    audit: { append: (r) => Promise.resolve(void audited.push(r)) },
  });
});

afterEach(() => {
  db.close();
  useBlobKey(dataDir, null);
  rmSync(dir, { recursive: true, force: true });
});

async function memberArchive(): Promise<{ path: string; text: string; manifest: ExportManifest }> {
  const out = await data.exportAccount(OWNER, MEMBER);
  expect(out.fileName).toMatch(
    new RegExp(`^nova-account-${MEMBER}-\\d{4}-\\d{2}-\\d{2}\\.novaexport$`),
  );
  const chunks: Buffer[] = [];
  for await (const c of out.body) chunks.push(c);
  const path = join(dir, 'member.novaexport');
  writeFileSync(path, Buffer.concat(chunks));
  let text = '';
  let manifest: ExportManifest | null = null;
  for (const e of listZip(path, { maxEntries: 1e6, maxTotalBytes: 1e10 })) {
    const parts: Buffer[] = [];
    readZipEntry(path, e, (c) => parts.push(Buffer.from(c)));
    const body = Buffer.concat(parts).toString('utf8');
    if (e.name === 'manifest.json') manifest = JSON.parse(body) as ExportManifest;
    text += `\n${e.name}\n${body}`;
  }
  return { path, text, manifest: manifest! };
}

describe("an account's export", () => {
  it("holds the member's rows and files and nothing of anyone else's", async () => {
    const { text, manifest } = await memberArchive();
    expect(manifest.accountScope).toEqual({ accountId: MEMBER });
    expect(manifest.encrypted).toBe(false);
    expect(manifest.ownerAccountId).toBeNull();
    for (const mine of [
      'chat of b2',
      'words of b2',
      'file of b2',
      'memory of b2',
      'notes of b2',
      'did-b2',
      'name-b2',
    ])
      expect(text, mine).toContain(mine);
    for (const theirs of ['a1', 'c3'])
      for (const what of [
        `chat of ${theirs}`,
        `words of ${theirs}`,
        `file of ${theirs}`,
        `memory of ${theirs}`,
        `notes of ${theirs}`,
        `did-${theirs}`,
        `name-${theirs}`,
      ])
        expect(text, what).not.toContain(what);
    expect(text).not.toContain('member words in the owner chat');
    expect(text).not.toContain('sk-secret-of');
    const tables = new Map(manifest.tables.map((t) => [t.name, t.rows]));
    expect(tables.get('account')).toBe(1);
    expect(tables.get('thread')).toBe(1);
    expect(tables.get('message')).toBe(1);
    expect(tables.get('attachment')).toBe(1);
    expect(tables.get('member_setting')).toBe(1);
    // Their authorship record and their access to the owner's chat are theirs.
    expect(tables.get('shared_message')).toBe(1);
    expect(tables.get('thread_share')).toBe(1);
    expect(tables.get('member_purge') ?? 0).toBe(0);
    expect(manifest.blobs.map((b) => b.path).sort()).toEqual(
      [blobs[MEMBER]!, `members/${MEMBER}/workspace/notes.md`].sort(),
    );
    expect(manifest.toReEnter).toEqual(['secret://provider/pa-b2/api_key']);
    expect(audited).toEqual([
      expect.objectContaining({
        accountId: OWNER,
        action: 'data.export',
        result: 'ok',
        detail: expect.objectContaining({ scope: { accountId: MEMBER }, encrypted: false }),
      }),
    ]);
  });

  it('is the owner only, needs an account, cannot be sealed, and is never imported', async () => {
    await expect(data.exportAccount(MEMBER, MEMBER)).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    await expect(data.exportAccount(OWNER, 'nobody')).rejects.toMatchObject({ code: 'not_found' });
    const sealed = exportArchive({
      db,
      secrets,
      dataDir,
      hubVersion: 't',
      account: MEMBER,
      passphrase: 'a long export passphrase',
    });
    await expect(sealed.next()).rejects.toMatchObject({ details: { reason: 'account_scope' } });
    const { path } = await memberArchive();
    await expect(stageArchive({ dataDir, archivePath: path })).rejects.toMatchObject({
      details: { reason: 'account_scope' },
    });
    // The Hub itself is untouched by the export (it worked on a copy).
    expect(db.raw.prepare('SELECT count(*) AS n FROM thread').get()).toEqual({ n: 3 });
    expect(readFileSync(join(dataDir, 'members', OWNER, 'workspace', 'notes.md'), 'utf8')).toBe(
      'notes of a1',
    );
  });
});
