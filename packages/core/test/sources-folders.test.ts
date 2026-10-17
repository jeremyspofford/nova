// Files indexed from a project folder are sources too, but they are managed through the folder
// (FR-035): the project's own source list and count leave them out, and they cannot be
// re-indexed or removed one by one.
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('folder-backed sources', () => {
  it('are left out of the list and count and refuse per-file reindex and removal', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Garden' });
    const pasted = await env.sources.add(ACCOUNT, p.id, {
      kind: 'text',
      name: 'notes.md',
      text: 'Tomatoes in May.',
    });
    const now = new Date().toISOString();
    const folderId = uuidv7();
    const fileSource = uuidv7();
    env.db.raw
      .prepare(
        `INSERT INTO project_folder (id, project_id, path, access, index_status, file_count, created_at, updated_at)
         VALUES (?, ?, '/srv/garden', 'read', 'ready', 1, ?, ?)`,
      )
      .run(folderId, p.id, now, now);
    env.db.raw
      .prepare(
        `INSERT INTO source (id, account_id, project_id, name, mime, size, sha256, blob_path, status,
         chunk_count, created_at, updated_at) VALUES (?, ?, ?, 'plan.md', 'text/markdown', 5, 'x',
         'folder:x/plan.md', 'ready', 1, ?, ?)`,
      )
      .run(fileSource, ACCOUNT, p.id, now, now);
    env.db.raw
      .prepare(
        `INSERT INTO project_folder_file (folder_id, rel_path, source_id, size, mtime_ms, sha256)
         VALUES (?, 'plan.md', ?, 5, 0, 'x')`,
      )
      .run(folderId, fileSource);

    expect((await env.sources.list(ACCOUNT, p.id)).map((s) => s.id)).toEqual([pasted.id]);
    expect((await env.projects.get(ACCOUNT, p.id)).sourceCount).toBe(1);
    await expect(env.sources.reindex(ACCOUNT, fileSource)).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'folder_file' },
    });
    await expect(env.sources.remove(ACCOUNT, fileSource)).rejects.toMatchObject({
      code: 'validation',
    });
    // An uploaded source still works as before.
    await env.sources.remove(ACCOUNT, pasted.id);
    expect(await env.sources.list(ACCOUNT, p.id)).toEqual([]);
  });
});
