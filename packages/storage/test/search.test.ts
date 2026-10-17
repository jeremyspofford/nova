// The chat search index (docs/06 §4) follows message_part through triggers: text parts only,
// empty text is not indexed, edits re-index, deletes drop the row.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '../src/index.ts';

let db: NovaDatabase;
const T = '2026-10-17T00:00:00.000Z';

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  db.raw.exec(
    `INSERT INTO account (id, kind, created_at, updated_at) VALUES ('a', 'local', '${T}', '${T}')`,
  );
  db.raw.exec(
    `INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES ('t', 'a', 'chat', '${T}', '${T}')`,
  );
  db.raw.exec(
    `INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES ('m', 't', 'user', '${T}', '${T}')`,
  );
});
afterEach(() => db.close());

const part = (id: string, type: string, content: string | null) =>
  db.raw
    .prepare(
      'INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, ?, ?, ?)',
    )
    .run(id, 'm', type, content, T);
const match = (q: string) =>
  (
    db.raw
      .prepare(
        'SELECT s.part_id AS id FROM message_fts JOIN message_search s ON s.seq = message_fts.rowid WHERE message_fts MATCH ?',
      )
      .all(q) as { id: string }[]
  ).map((r) => r.id);

describe('message search index', () => {
  it('indexes text parts and ignores other part types and empty text', () => {
    part('p1', 'text', 'The quick brown fox');
    part('p2', 'reasoning', 'quick thoughts');
    part('p3', 'text', '');
    part('p4', 'error', '{"code":"quick"}');
    expect(match('quick')).toEqual(['p1']);
    expect(db.raw.prepare('SELECT count(*) AS n FROM message_search').get()).toEqual({ n: 1 });
  });

  it('re-indexes on update, including a part that started empty (streaming)', () => {
    part('p1', 'text', '');
    db.raw.prepare("UPDATE message_part SET content = 'partial answ' WHERE id = 'p1'").run();
    expect(match('"answ"*')).toEqual(['p1']);
    db.raw.prepare("UPDATE message_part SET content = 'final answer' WHERE id = 'p1'").run();
    expect(match('partial')).toEqual([]);
    expect(match('final')).toEqual(['p1']);
    db.raw.prepare("UPDATE message_part SET content = '' WHERE id = 'p1'").run();
    expect(match('final')).toEqual([]);
  });

  it('drops the row when a part is deleted, and the index stays consistent', () => {
    part('p1', 'text', 'remove me');
    db.raw.prepare("DELETE FROM message_part WHERE id = 'p1'").run();
    expect(match('remove')).toEqual([]);
    expect(() =>
      db.raw.exec("INSERT INTO message_fts (message_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it('refuses a credential in provider_account.secret_ref (only secret:// refs)', () => {
    const insert = (ref: string) =>
      db.raw
        .prepare(
          `INSERT INTO provider_account (id, account_id, provider, label, auth_kind, secret_ref, created_at, updated_at)
           VALUES (?, 'a', 'openai', 'x', 'api_key', ?, ?, ?)`,
        )
        .run(ref, ref, T, T);
    expect(() => insert('sk-live-1234567890')).toThrow(/CHECK/);
    expect(() => insert('secret://provider/x/api_key')).not.toThrow();
  });
});
