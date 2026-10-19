// The data controls service (FR-105, ADR-097 D5): owner-only, the typed confirmation, the overview,
// uploads that expire, one replacing operation at a time, and an audit entry for each step.
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { DataControls, MemoryEventSink, dataWorkDir, type AuditRecord } from '../src/index.ts';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const MEMBER = '01920000-0000-7000-8000-0000000000a2';
const SESSION = '01920000-0000-7000-8000-00000000005e';
const T0 = '2026-10-01T10:00:00.000Z';

let dir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let audited: AuditRecord[];
let events: MemoryEventSink;
let now: Date;
let svc: DataControls;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-svc-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  for (const id of [OWNER, MEMBER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, T0, T0);
  db.raw
    .prepare("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?)")
    .run(OWNER, T0);
  db.raw
    .prepare("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'member', ?)")
    .run(MEMBER, T0);
  db.raw
    .prepare(
      "INSERT INTO auth_token (id, kind, token_hash, account_id, created_at) VALUES (?, 'session', 'h', ?, ?)",
    )
    .run(SESSION, OWNER, T0);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES ('t1', ?, 'chat', 'x', ?, ?)",
    )
    .run(OWNER, T0, T0);
  secrets = new MemorySecretStore();
  // secret-scan: fake
  await secrets.put('secret://provider/p/api_key', 'sk-something-secret-1234');
  audited = [];
  events = new MemoryEventSink();
  now = new Date('2026-10-19T08:00:00Z');
  svc = new DataControls({
    db,
    secrets,
    dataDir: join(dir, 'data'),
    hubVersion: '0.8.0',
    hubName: () => Promise.resolve('home-hub'),
    audit: { append: (r) => Promise.resolve(void audited.push(r)) },
    events,
    now: () => now,
    scrypt: { N: 2 ** 10, r: 8, p: 1 },
    maxUploadBytes: 1024 * 1024,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function* bytes(b: Buffer): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield b;
}

async function exportBytes(passphrase?: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await svc.export(
    OWNER,
    passphrase ? { passphrase, confirm: 'home-hub' } : {},
  ))
    chunks.push(c);
  return Buffer.concat(chunks);
}

describe('data controls service', () => {
  it('is the owner only', async () => {
    await expect(svc.export(MEMBER, {})).rejects.toThrow(/only the owner/);
    await expect(svc.deleteAll(MEMBER, null, 'home-hub')).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    await expect(svc.upload(MEMBER, bytes(Buffer.from('x')))).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    await expect(svc.check(MEMBER, 'x')).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    await expect(svc.import(MEMBER, null, 'x')).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    expect(svc.owner()).toBe(OWNER);
  });

  it('needs the Hub name typed for a sealed export, and never from a paired device', async () => {
    const pass = { passphrase: 'a long export passphrase' };
    await expect(svc.export(OWNER, pass)).rejects.toMatchObject({
      details: { reason: 'confirmation_mismatch' },
    });
    await expect(svc.export(OWNER, { ...pass, confirm: 'other' })).rejects.toMatchObject({
      details: { reason: 'confirmation_mismatch' },
    });
    await expect(
      svc.export(OWNER, { ...pass, confirm: 'home-hub' }, { deviceSession: true }),
    ).rejects.toMatchObject({ details: { reason: 'hub_only' } });
    // An export without a passphrase carries no secret: no confirmation needed.
    expect(await svc.export(OWNER, {}, { deviceSession: true })).toBeDefined();
    expect(audited).toEqual([]);
  });

  it('shows what an export holds and whether the Hub is empty', async () => {
    const o = await svc.overview();
    expect(o).toMatchObject({ hubName: 'home-hub', empty: false, secrets: { count: 1 } });
    expect(o.blockingTables).toEqual(expect.arrayContaining(['team_member', 'thread']));
    expect(o.rows).toBeGreaterThan(4);
  });

  it('exports, deletes with the typed name, imports, and audits each', async () => {
    const archive = await exportBytes();
    expect(audited.map((a) => [a.action, a.result])).toEqual([['data.export', 'ok']]);
    expect(events.events.map((e) => e.name)).toEqual(['data.exported']);

    await expect(svc.deleteAll(OWNER, SESSION, 'other')).rejects.toMatchObject({
      details: { reason: 'confirmation_mismatch' },
    });
    const del = await svc.deleteAll(OWNER, SESSION, ' Home-Hub ');
    expect(del).toMatchObject({ restartRequired: true });
    expect(del.rows).toBeGreaterThan(0);
    expect(del.secrets).toBe(1);
    // A new data key replaced the deleted one.
    expect(await secrets.list()).toEqual(['secret://hub/data-key']);
    expect((await svc.overview()).empty).toBe(true);

    const up = await svc.upload(OWNER, bytes(archive));
    expect(up).toMatchObject({ bytes: archive.length, encrypted: false });
    const check = await svc.check(OWNER, up.uploadId);
    expect(check).toMatchObject({ hubEmpty: true, toReEnter: ['secret://provider/p/api_key'] });
    const imp = await svc.import(OWNER, SESSION, up.uploadId);
    expect(imp).toMatchObject({ verified: true, restartRequired: true });
    expect(db.raw.prepare('SELECT title FROM thread').all()).toEqual([{ title: 'x' }]);
    expect(audited.map((a) => a.action)).toEqual(['data.export', 'data.delete_all', 'data.import']);
    expect(audited.at(-1)!.detail).toMatchObject({
      previousLog: [],
      encrypted: false,
      keptTables: expect.any(Array),
    });
    // The upload is consumed.
    await expect(svc.check(OWNER, up.uploadId)).rejects.toMatchObject({ code: 'not_found' });
    // A second import into the now full Hub is refused.
    const again = await svc.upload(OWNER, bytes(archive));
    await expect(svc.import(OWNER, SESSION, again.uploadId)).rejects.toMatchObject({
      details: { reason: 'hub_not_empty' },
    });
  });

  it('refuses empty, oversized and unknown uploads, and sweeps old ones', async () => {
    await expect(svc.upload(OWNER, bytes(Buffer.alloc(0)))).rejects.toMatchObject({
      details: { reason: 'empty' },
    });
    await expect(svc.upload(OWNER, bytes(Buffer.alloc(2 * 1024 * 1024)))).rejects.toMatchObject({
      details: { reason: 'too_large' },
    });
    await expect(svc.check(OWNER, '../../etc/passwd')).rejects.toMatchObject({ code: 'not_found' });
    const up = await svc.upload(OWNER, bytes(Buffer.from('not a zip at all')));
    await expect(svc.check(OWNER, up.uploadId)).rejects.toMatchObject({
      details: { reason: 'archive_damaged' },
    });
    const uploads = join(dataWorkDir(join(dir, 'data')), 'uploads');
    expect(readdirSync(uploads)).toHaveLength(1);
    const old = new Date(now.getTime() - 2 * 3_600_000);
    utimesSync(join(uploads, `${up.uploadId}.novaexport`), old, old);
    expect(svc.sweepUploads()).toBe(1);
    expect(readdirSync(uploads)).toEqual([]);
    const other = await svc.upload(OWNER, bytes(Buffer.from('x')));
    svc.removeUpload(OWNER, other.uploadId);
    expect(readdirSync(uploads)).toEqual([]);
  });

  it('records a failed or refused import', async () => {
    await svc.deleteAll(OWNER, SESSION, 'home-hub');
    audited = [];
    const sealed = await exportBytes('a long export passphrase');
    const up = await svc.upload(OWNER, bytes(sealed));
    await expect(svc.import(OWNER, SESSION, up.uploadId)).rejects.toMatchObject({
      details: { reason: 'passphrase_required' },
    });
    expect(audited.map((a) => [a.action, a.result, a.detail])).toEqual([
      ['data.export', 'ok', expect.objectContaining({ encrypted: true })],
      ['data.import', 'refused', { reason: 'passphrase_required' }],
    ]);
  });
});
