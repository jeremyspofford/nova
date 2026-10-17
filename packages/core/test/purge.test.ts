// Purging a thread never removes a blob something else still uses (blobs are content-addressed,
// so an attachment, a source and an artifact can share one).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { purgeThreadRows, removeUnreferencedBlobs, writeAttachmentBlob } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const now = () => new Date().toISOString();

function addArtifact(e: Env, threadId: string, blobPath: string, sha256: string) {
  const id = uuidv7();
  e.db.raw
    .prepare(
      `INSERT INTO artifact (id, account_id, thread_id, kind, title, blob_path, mime, sha256,
       created_at, updated_at) VALUES (?, ?, ?, 'markdown', 'Notes', ?, 'text/markdown', ?, ?, ?)`,
    )
    .run(id, ACCOUNT, threadId, blobPath, sha256, now(), now());
  e.db.raw
    .prepare(
      `INSERT INTO artifact_version (artifact_id, version, blob_path, mime, sha256, size, created_at)
       VALUES (?, 1, ?, 'text/markdown', ?, 5, ?)`,
    )
    .run(id, blobPath, sha256, now());
  return id;
}

describe('purge (FR-027) and shared blobs', () => {
  it('keeps a blob an artifact in another thread still uses, and removes it once nothing does', async () => {
    env = await makeEnv();
    const dataDir = join(env.dir, 'data');
    const keep = await env.threads.create(ACCOUNT, {});
    const gone = await env.threads.create(ACCOUNT, {});
    const blob = writeAttachmentBlob(dataDir, Buffer.from('notes'));
    addArtifact(env, keep.id, blob.blobPath, blob.sha256);
    addArtifact(env, gone.id, blob.blobPath, blob.sha256);

    const first = await env.db.transaction(() => purgeThreadRows(env!.db, [gone.id]));
    expect(first).toContain(blob.blobPath);
    expect(removeUnreferencedBlobs(env.db, dataDir, first)).toBe(0);
    expect(existsSync(join(dataDir, blob.blobPath))).toBe(true);
    expect(
      env.db.raw.prepare('SELECT COUNT(*) AS n FROM artifact WHERE thread_id = ?').get(gone.id),
    ).toEqual({ n: 0 });

    const second = await env.db.transaction(() => purgeThreadRows(env!.db, [keep.id]));
    expect(removeUnreferencedBlobs(env.db, dataDir, second)).toBe(1);
    expect(existsSync(join(dataDir, blob.blobPath))).toBe(false);
  });
});
