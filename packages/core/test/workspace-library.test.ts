// The Library (FR-041): artifacts, attachments, images and uploaded sources across the account,
// newest first, filtered by kind, searched by title and paged by cursor; temporary and deleted
// chats, other accounts and project-folder files stay out; every item links into the app.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { LibraryService, hrefOf } from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';
const OTHER = '01920000-0000-7000-8000-0000000000c2';

let db: NovaDatabase;
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

function run(sql: string, ...args: (string | number | null)[]): void {
  db.raw.prepare(sql).run(...args);
}

function thread(account: string, opts: { project?: string; temporary?: boolean } = {}): string {
  const id = uuidv7();
  const now = at();
  run(
    "INSERT INTO thread (id, account_id, project_id, mode, temporary, created_at, updated_at) VALUES (?, ?, ?, 'chat', ?, ?, ?)",
    id,
    account,
    opts.project ?? null,
    opts.temporary ? 1 : 0,
    now,
    now,
  );
  return id;
}

function message(threadId: string): string {
  const id = uuidv7();
  const now = at();
  run(
    "INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
    id,
    threadId,
    now,
    now,
  );
  return id;
}

function artifact(account: string, threadId: string | null, kind: string, title: string): string {
  const id = uuidv7();
  const now = at();
  const msg = threadId ? message(threadId) : null;
  run(
    `INSERT INTO artifact (id, account_id, thread_id, message_id, kind, title, blob_path, mime, sha256, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'b', 'text/markdown', 's', 1, ?, ?)`,
    id,
    account,
    threadId,
    msg,
    kind,
    title,
    now,
    now,
  );
  run(
    "INSERT INTO artifact_version (artifact_id, version, blob_path, mime, sha256, size, created_at) VALUES (?, 1, 'b', 'text/markdown', 's', 42, ?)",
    id,
    now,
  );
  return id;
}

function attachment(threadId: string, name: string, mime: string): { id: string; msg: string } {
  const id = uuidv7();
  const msg = message(threadId);
  run(
    "INSERT INTO attachment (id, message_id, thread_id, name, mime, size, blob_path, created_at) VALUES (?, ?, NULL, ?, ?, 10, 'b', ?)",
    id,
    msg,
    name,
    mime,
    at(),
  );
  return { id, msg };
}

function source(account: string, project: string, name: string): string {
  const id = uuidv7();
  const now = at();
  run(
    `INSERT INTO source (id, account_id, project_id, name, mime, size, sha256, blob_path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text/plain', 5, 's', 'b', 'ready', ?, ?)`,
    id,
    account,
    project,
    name,
    now,
    now,
  );
  return id;
}

let projectId: string;
let chat: string;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  for (const id of [ACCOUNT, OTHER])
    run(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'x', ?, ?)",
      id,
      at(),
      at(),
    );
  projectId = uuidv7();
  run(
    'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    ACCOUNT,
    'P',
    at(),
    at(),
  );
  chat = thread(ACCOUNT, { project: projectId });
});
afterEach(() => db.close());

describe('library', () => {
  it('lists every kind newest first with links into the app', async () => {
    const art = artifact(ACCOUNT, chat, 'markdown', 'Quarterly report');
    const file = artifact(ACCOUNT, chat, 'file', '');
    const img = attachment(chat, 'photo.png', 'image/png');
    const doc = attachment(chat, 'notes.pdf', 'application/pdf');
    const src = source(ACCOUNT, projectId, 'handbook.md');
    const lib = new LibraryService({ db });
    const page = await lib.list(ACCOUNT);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => [i.kind, i.title])).toEqual([
      ['source', 'handbook.md'],
      ['attachment', 'notes.pdf'],
      ['image', 'photo.png'],
      ['file', 'file'],
      ['artifact', 'Quarterly report'],
    ]);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(src)).toMatchObject({
      projectId,
      threadId: null,
      href: `/projects/${projectId}?source=${src}`,
    });
    expect(byId.get(img.id)).toMatchObject({
      threadId: chat,
      projectId,
      mime: 'image/png',
      size: 10,
      href: `/chat/${chat}?m=${img.msg}`,
    });
    expect(byId.get(doc.id)?.kind).toBe('attachment');
    expect(byId.get(art)).toMatchObject({ size: 42, mime: 'text/markdown' });
    expect(byId.get(art)?.href).toMatch(new RegExp(`^/chat/${chat}\\?m=.+&artifact=${art}$`));
    expect(byId.get(file)?.kind).toBe('file');
  });

  it('filters by kind, searches titles literally and pages with a cursor', async () => {
    for (let i = 0; i < 5; i++) artifact(ACCOUNT, chat, 'markdown', `Draft ${i}`);
    artifact(ACCOUNT, chat, 'markdown', '100%_done');
    attachment(chat, 'draft-photo.jpg', 'image/jpeg');
    const lib = new LibraryService({ db });
    expect((await lib.list(ACCOUNT, { kind: 'image' })).items.map((i) => i.title)).toEqual([
      'draft-photo.jpg',
    ]);
    expect((await lib.list(ACCOUNT, { q: 'DRAFT' })).items).toHaveLength(6);
    expect((await lib.list(ACCOUNT, { q: '%_' })).items.map((i) => i.title)).toEqual(['100%_done']);
    const first = await lib.list(ACCOUNT, { kind: 'artifact', limit: 4 });
    expect(first.items.map((i) => i.title)).toEqual(['100%_done', 'Draft 4', 'Draft 3', 'Draft 2']);
    const second = await lib.list(ACCOUNT, {
      kind: 'artifact',
      limit: 4,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.title)).toEqual(['Draft 1', 'Draft 0']);
    expect(second.nextCursor).toBeNull();
    await expect(lib.list(ACCOUNT, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('leaves out other accounts, temporary and deleted chats, and project-folder files', async () => {
    const theirs = thread(OTHER);
    artifact(OTHER, theirs, 'markdown', 'Not mine');
    const temp = thread(ACCOUNT, { temporary: true });
    artifact(ACCOUNT, temp, 'markdown', 'Temporary');
    attachment(temp, 'temp.png', 'image/png');
    const gone = thread(ACCOUNT);
    attachment(gone, 'gone.txt', 'text/plain');
    run('UPDATE thread SET deleted_at = ? WHERE id = ?', at(), gone);
    const folderSource = source(ACCOUNT, projectId, 'repo/src/index.ts');
    const folderId = uuidv7();
    run(
      "INSERT INTO project_folder (id, project_id, path, created_at, updated_at) VALUES (?, ?, '/x', ?, ?)",
      folderId,
      projectId,
      at(),
      at(),
    );
    run(
      "INSERT INTO project_folder_file (folder_id, rel_path, source_id, size, mtime_ms, sha256) VALUES (?, 'src/index.ts', ?, 5, 1, 's')",
      folderId,
      folderSource,
    );
    const deletedSource = source(ACCOUNT, projectId, 'old.md');
    run('UPDATE source SET deleted_at = ? WHERE id = ?', at(), deletedSource);
    const loose = artifact(ACCOUNT, null, 'html', 'Loose page');
    const lib = new LibraryService({ db });
    const items = (await lib.list(ACCOUNT)).items;
    expect(items.map((i) => i.title)).toEqual(['Loose page']);
    expect(items[0]?.href).toBe(`/library?artifact=${loose}`);
  });

  it('builds links for items without a message', () => {
    expect(
      hrefOf({ kind: 'attachment', id: 'a', threadId: 't', projectId: null, messageId: null }),
    ).toBe('/chat/t');
    expect(
      hrefOf({ kind: 'artifact', id: 'a b', threadId: 't', projectId: null, messageId: null }),
    ).toBe('/chat/t?artifact=a%20b');
  });
});
