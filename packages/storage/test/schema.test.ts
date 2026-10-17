// The SQL migrations are authoritative; the Drizzle schema must describe the same columns.
import { describe, expect, it } from 'vitest';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate, openDatabase, schema } from '../src/index.ts';

const tables: SQLiteTable[] = (Object.values(schema) as unknown[]).filter(
  (v): v is SQLiteTable => typeof v === 'object' && v !== null && 'getSQL' in v,
);

describe('drizzle schema matches migrations', () => {
  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))('%s', async (name, table) => {
    const db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const cols = db.raw.prepare(`PRAGMA table_info(${name})`).all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const cfg = getTableConfig(table);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(cols.map((c) => c.name).sort());
    for (const c of cfg.columns) {
      const sqlCol = cols.find((x) => x.name === c.name)!;
      const sqlNotNull =
        sqlCol.notnull === 1 || (sqlCol.pk > 0 && cols.filter((x) => x.pk > 0).length > 1);
      expect
        .soft(c.notNull || c.primary, `${name}.${c.name} not-null`)
        .toBe(sqlNotNull || sqlCol.pk === 1);
    }
    db.close();
  });
});
