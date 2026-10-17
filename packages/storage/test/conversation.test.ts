// 0004_conversation: the message-tree backfill of M1 rows (FR-020), the source chunk and memory
// FTS5 indexes kept in step by triggers (FR-040, FR-032), and the new CHECK constraints.
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, openDatabase, type NovaDatabase } from '../src/index.ts';

let db: NovaDatabase;
afterEach(() => db.close());

const T = (s: number) => `2026-10-17T00:00:${String(s).padStart(2, '0')}.000Z`;

function seedAccount(): void {
  db.raw.exec(
    `INSERT INTO account (id, kind, created_at, updated_at) VALUES ('a', 'local', '${T(0)}', '${T(0)}')`,
  );
}

describe('message tree backfill', () => {
  it('links each M1 message to the previous one and sets the active leaf', async () => {
    db = openDatabase({ path: ':memory:' });
    const all = loadMigrations();
    await migrate(db, { migrations: all.filter((m) => m.version < 4) });
    seedAccount();
    db.raw.exec(`INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES
      ('t1', 'a', 'chat', '${T(0)}', '${T(0)}'),
      ('t2', 'a', 'chat', '${T(0)}', '${T(0)}'),
      ('t3', 'a', 'chat', '${T(0)}', '${T(0)}')`);
    const msg = (id: string, thread: string, at: string, deleted = false) =>
      db.raw
        .prepare(
          'INSERT INTO message (id, thread_id, role, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, thread, 'user', at, at, deleted ? at : null);
    // Same timestamp for a user message and its reply (M1 wrote both at once): id order wins.
    msg('m1', 't1', T(1));
    msg('m2', 't1', T(1));
    msg('m3', 't1', T(2));
    msg('n1', 't2', T(1));
    msg('n2', 't2', T(3), true);
    await migrate(db, { migrations: all });
    const parents = db.raw.prepare('SELECT id, parent_id AS p FROM message ORDER BY id').all();
    expect(parents).toEqual([
      { id: 'm1', p: null },
      { id: 'm2', p: 'm1' },
      { id: 'm3', p: 'm2' },
      { id: 'n1', p: null },
      { id: 'n2', p: 'n1' },
    ]);
    const leaves = db.raw
      .prepare('SELECT id, active_leaf_id AS leaf FROM thread ORDER BY id')
      .all();
    expect(leaves).toEqual([
      { id: 't1', leaf: 'm3' },
      { id: 't2', leaf: 'n1' },
      { id: 't3', leaf: null },
    ]);
  });
});

describe('conversation tables', () => {
  async function fresh(): Promise<void> {
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    seedAccount();
    db.raw.exec(
      `INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES ('p', 'a', 'P', '${T(0)}', '${T(0)}')`,
    );
    db.raw
      .exec(`INSERT INTO source (id, account_id, project_id, name, mime, size, sha256, blob_path, created_at, updated_at)
      VALUES ('s', 'a', 'p', 'n.md', 'text/markdown', 1, 'x', 'blobs/attachments/x', '${T(0)}', '${T(0)}')`);
  }
  const chunkMatch = (q: string) =>
    (
      db.raw
        .prepare(
          'SELECT c.idx FROM source_chunk_fts JOIN source_chunk c ON c.seq = source_chunk_fts.rowid WHERE source_chunk_fts MATCH ? ORDER BY c.idx',
        )
        .all(q) as { idx: number }[]
    ).map((r) => r.idx);
  const memoryMatch = (q: string) =>
    (
      db.raw.prepare('SELECT item_id AS id FROM memory_fts WHERE memory_fts MATCH ?').all(q) as {
        id: string;
      }[]
    ).map((r) => r.id);

  it('indexes source chunks and drops them on delete', async () => {
    await fresh();
    const add = (idx: number, text: string) =>
      db.raw
        .prepare('INSERT INTO source_chunk (source_id, idx, text, created_at) VALUES (?, ?, ?, ?)')
        .run('s', idx, text, T(1));
    add(0, 'Tomatoes need full sun');
    add(1, 'Basil likes warmth');
    expect(chunkMatch('tomatoes')).toEqual([0]);
    db.raw.prepare("UPDATE source_chunk SET text = 'Peppers too' WHERE idx = 0").run();
    expect(chunkMatch('tomatoes')).toEqual([]);
    expect(chunkMatch('peppers')).toEqual([0]);
    db.raw.prepare("DELETE FROM source_chunk WHERE source_id = 's'").run();
    expect(chunkMatch('basil')).toEqual([]);
    expect(() =>
      db.raw.exec("INSERT INTO source_chunk_fts (source_chunk_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it('keeps the memory index in step with content edits and deletes', async () => {
    await fresh();
    const add = (id: string, content: string) =>
      db.raw
        .prepare(
          `INSERT INTO memory_item (id, account_id, scope_kind, content, content_key, created_at, updated_at)
           VALUES (?, 'a', 'global', ?, ?, ?, ?)`,
        )
        .run(id, content, content.toLowerCase(), T(1), T(1));
    add('i1', 'Prefers green tea');
    add('i2', 'Lives near the coast');
    expect(memoryMatch('tea')).toEqual(['i1']);
    db.raw.prepare("UPDATE memory_item SET pinned = 1 WHERE id = 'i1'").run();
    expect(memoryMatch('tea')).toEqual(['i1']);
    db.raw.prepare("UPDATE memory_item SET content = 'Prefers coffee' WHERE id = 'i1'").run();
    expect(memoryMatch('tea')).toEqual([]);
    expect(memoryMatch('coffee')).toEqual(['i1']);
    db.raw.prepare("DELETE FROM memory_item WHERE id = 'i2'").run();
    expect(memoryMatch('coast')).toEqual([]);
  });

  it('enforces the status and kind constraints', async () => {
    await fresh();
    db.raw.exec(
      `INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES ('t', 'a', 'chat', '${T(0)}', '${T(0)}')`,
    );
    const queued = (status: string) =>
      db.raw
        .prepare(
          `INSERT INTO queued_input (id, thread_id, account_id, text, status, created_at, updated_at)
           VALUES (?, 't', 'a', 'x', ?, ?, ?)`,
        )
        .run(`q-${status}`, status, T(1), T(1));
    expect(() => queued('pending')).not.toThrow();
    expect(() => queued('done')).toThrow(/CHECK/);
    expect(() => db.raw.exec("UPDATE source SET status = 'weird' WHERE id = 's'")).toThrow(/CHECK/);
    expect(() =>
      db.raw.exec(
        `INSERT INTO message (id, thread_id, role, delivery, created_at, updated_at) VALUES ('m', 't', 'user', 'pasted', '${T(1)}', '${T(1)}')`,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.raw.exec(
        `INSERT INTO memory_item (id, account_id, scope_kind, content, content_key, source_kind, created_at, updated_at)
         VALUES ('x', 'a', 'global', 'c', 'c', 'gossip', '${T(1)}', '${T(1)}')`,
      ),
    ).toThrow(/CHECK/);
  });
});
