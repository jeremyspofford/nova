import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  currentVersion,
  loadMigrations,
  migrate,
  openDatabase,
  restoreBackup,
  schema,
  type Migration,
} from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-storage-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const extra = (version: number, sql: string): Migration => ({
  version,
  name: `extra_${version}`,
  sql,
  checksum: `sum-${version}-${sql.length}`,
});

describe('migrations', () => {
  it('applies all migrations to a fresh database without a backup', async () => {
    const db = openDatabase({ path: join(dir, 'nova.db') });
    const r = await migrate(db, { backupDir: join(dir, 'backups') });
    expect(r.from).toBe(0);
    expect(r.to).toBe(loadMigrations().length);
    expect(r.backupPath).toBeNull();
    expect(currentVersion(db)).toBe(r.to);
    db.close();
  });

  it('is idempotent', async () => {
    const db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    db.close();
  });

  it('backs up before upgrading and restores to roll back', async () => {
    const path = join(dir, 'nova.db');
    const base = loadMigrations();
    let db = openDatabase({ path });
    await migrate(db, { migrations: base, backupDir: join(dir, 'backups') });
    await db.orm.insert(schema.featureFlag).values({
      key: 'demo',
      stage: 'beta',
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    const next = [...base, extra(base.length + 1, 'CREATE TABLE later (id TEXT PRIMARY KEY);')];
    const r = await migrate(db, { migrations: next, backupDir: join(dir, 'backups') });
    expect(r.applied).toEqual([base.length + 1]);
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true);
    db.close();

    restoreBackup(path, r.backupPath!);
    db = openDatabase({ path });
    expect(currentVersion(db)).toBe(base.length);
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'later'").all();
    expect(tables).toEqual([]);
    const flag = await db.orm
      .select()
      .from(schema.featureFlag)
      .where(eq(schema.featureFlag.key, 'demo'));
    expect(flag[0]?.enabled).toBe(true);
    db.close();
  });

  it('rolls back a failing migration and leaves the version unchanged', async () => {
    const db = openDatabase({ path: ':memory:' });
    const base = loadMigrations();
    await migrate(db, { migrations: base });
    const bad = [...base, extra(base.length + 1, 'CREATE TABLE ok1 (id TEXT); THIS IS NOT SQL;')];
    await expect(migrate(db, { migrations: bad })).rejects.toThrow();
    expect(currentVersion(db)).toBe(base.length);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'ok1'").all()).toEqual([]);
    db.close();
  });

  it('refuses a database newer than the build, or an edited migration', async () => {
    const db = openDatabase({ path: ':memory:' });
    const base = loadMigrations();
    await migrate(db, { migrations: [...base, extra(base.length + 1, 'SELECT 1;')] });
    await expect(migrate(db, { migrations: base })).rejects.toThrow(/newer than this build/);
    const edited = [...base, { ...extra(base.length + 1, 'SELECT 1;'), checksum: 'different' }];
    await expect(migrate(db, { migrations: edited })).rejects.toThrow(
      /edited after it was applied/,
    );
    db.close();
  });

  it('requires migration files without gaps', () => {
    const mdir = join(dir, 'm');
    mkdirSync(mdir);
    writeFileSync(join(mdir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(mdir, '0003_c.sql'), 'SELECT 1;');
    expect(() => loadMigrations(mdir)).toThrow(/without gaps/);
  });

  it('requires a backup directory to upgrade an existing file database', async () => {
    const db = openDatabase({ path: join(dir, 'x.db') });
    const base = loadMigrations();
    await migrate(db, { migrations: base });
    await expect(
      migrate(db, { migrations: [...base, extra(base.length + 1, 'SELECT 1;')] }),
    ).rejects.toThrow(/backupDir is required/);
    db.close();
  });
});

describe('transactions', () => {
  it('serializes concurrent transactions and rolls back on error', async () => {
    const db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const now = new Date().toISOString();
    const order: string[] = [];
    const slow = db.transaction(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      db.raw.prepare('INSERT INTO feature_flag VALUES (?, ?, ?, ?)').run('a', 'beta', 0, now);
      order.push('a-end');
    });
    const fast = db.transaction(() => {
      order.push('b');
      db.raw.prepare('INSERT INTO feature_flag VALUES (?, ?, ?, ?)').run('b', 'beta', 0, now);
    });
    const failing = db.transaction(() => {
      db.raw.prepare('INSERT INTO feature_flag VALUES (?, ?, ?, ?)').run('c', 'beta', 0, now);
      throw new Error('nope');
    });
    await Promise.all([slow, fast, failing.catch(() => undefined)]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    const keys = (
      db.raw.prepare('SELECT key FROM feature_flag ORDER BY key').all() as { key: string }[]
    ).map((r) => r.key);
    expect(keys).toEqual(['a', 'b']);
    db.close();
  });

  it('joins a nested transaction', async () => {
    const db = openDatabase({ path: ':memory:' });
    await migrate(db);
    await db.transaction(() =>
      db.transaction(() => {
        db.raw.prepare("INSERT INTO feature_flag VALUES ('n', 'beta', 1, 'x')").run();
      }),
    );
    expect(db.raw.prepare('SELECT count(*) AS n FROM feature_flag').get()).toEqual({ n: 1 });
    db.close();
  });
});
