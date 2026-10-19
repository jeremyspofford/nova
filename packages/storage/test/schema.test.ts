// The SQL migrations are authoritative; the Drizzle schema must describe the same columns.
import { describe, expect, it } from 'vitest';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate, openDatabase, schema } from '../src/index.ts';
import * as sync from '../src/schema/sync.ts';
import * as runner from '../src/schema/runner.ts';
import * as channelsM7 from '../src/schema/channels_m7.ts';
import * as codeM7 from '../src/schema/code_m7.ts';
import * as team from '../src/schema/team.ts';
import * as flagged from '../src/schema/flagged.ts';
import * as firmware from '../src/schema/firmware.ts';
import * as boot from '../src/schema/boot.ts';
import * as oob from '../src/schema/oob.ts';
import * as sdk from '../src/schema/sdk.ts';
import * as market from '../src/schema/market.ts';
import * as teamM8 from '../src/schema/team_m8.ts';
import * as appauth from '../src/schema/appauth.ts';
import * as managed from '../src/schema/managed.ts';
import * as datactl from '../src/schema/datactl.ts';
import * as channelsM8 from '../src/schema/channels_m8.ts';

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

// The M7 and M7.5 schema files also declare every index their migration creates by name (older files
// predate this check). An inline UNIQUE constraint makes an unnamed autoindex and is not counted.
const m7Tables: SQLiteTable[] = [
  sync,
  runner,
  channelsM7,
  codeM7,
  team,
  flagged,
  firmware,
  boot,
  oob,
  sdk,
  market,
  teamM8,
  appauth,
  managed,
  datactl,
  channelsM8,
]
  .flatMap<unknown>((m) => Object.values(m))
  .filter((v): v is SQLiteTable => typeof v === 'object' && v !== null && 'getSQL' in v);

describe("M7 drizzle schema declares the migrations' indexes", () => {
  it.each(m7Tables.map((t) => [getTableConfig(t).name, t] as const))('%s', async (name, table) => {
    const db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const created = (
      db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
        )
        .all(name) as { name: string }[]
    ).map((r) => r.name);
    const declared = getTableConfig(table).indexes.map((i) => i.config.name);
    expect(created.filter((n) => !declared.includes(n))).toEqual([]);
    db.close();
  });
});
