// PR 1 of the knowledge-graph ADR (docs/plans/knowledge-graph-adr-2026-11-10.md, "Migration"; F-057's
// acceptance criterion): no migration may create a graph table unless the ADR is accepted and its stage 2
// is opened. Stage 2 (stored graph_node / graph_edge tables) starts only on its three conditions: F-058's
// thread id, a measured miss of the read-time projection, and the owner's acceptance. A test can't
// measure the first two, so the owner opens stage 2 by changing one line of the ADR, and this guard reads it.
// It applies the migrations to an in-memory database and reads the schema, so no spelling of
// CREATE TABLE / VIRTUAL TABLE / VIEW / INDEX / ALTER ... RENAME gets past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, loadMigrations, type Migration } from '../../src/core/db.ts';

const ADR = join(import.meta.dirname, '..', '..', 'docs', 'plans', 'knowledge-graph-adr-2026-11-10.md');

// Every schema object a graph would add: a name that starts with graph_, of any type.
export function graphObjects(migrations: Migration[]): string[] {
  const db = new Db(':memory:');
  try {
    db.migrate({ migrations });
    return db.all<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE lower(name) LIKE 'graph\\_%' ESCAPE '\\' ORDER BY name")
      .map((r) => `${r.type} ${r.name}`);
  } finally {
    db.raw.close();
  }
}

// What the ADR allows: graph tables only when it is accepted and its stage 2 line says opened.
export function gate(adr: string | null): { accepted: boolean; stage2: boolean } {
  if (adr == null) return { accepted: false, stage2: false };
  return {
    accepted: /^\*\*Status:\*\* Accepted\b/m.test(adr),
    stage2: /^\*\*Stage 2:\*\* Opened \d{4}-\d{2}-\d{2} \(owner\)/m.test(adr),
  };
}

export function violations(migrations: Migration[], adr: string | null): string[] {
  const found = graphObjects(migrations);
  if (!found.length) return [];
  const g = gate(adr);
  if (g.accepted && g.stage2) return [];
  const why = !g.accepted ? 'the knowledge-graph ADR is missing or not accepted' : 'its stage 2 is not opened';
  return found.map((o) => `${o}: a migration creates a graph object while ${why}`);
}

const realAdr = () => (existsSync(ADR) ? readFileSync(ADR, 'utf8') : null);
const standIn = (sql: string): Migration[] => {
  const all = loadMigrations();
  return [...all, { version: all.length + 1, name: 'stand_in', sql, checksum: 'stand-in' }];
};

test('no migration in the repository creates a graph object unless the ADR has opened stage 2', () => {
  assert.deepEqual(violations(loadMigrations(), realAdr()), []);
});

test('the ADR is accepted, and stage 2 is not opened yet', () => {
  const g = gate(realAdr());
  assert.equal(g.accepted, true, 'docs/plans/knowledge-graph-adr-2026-11-10.md reads **Status:** Accepted');
  assert.equal(g.stage2, false, 'stage 2 is opened only by the owner, once its three conditions hold');
});

test('a stand-in migration that creates a graph table is refused, however it is spelled', () => {
  const adr = realAdr();
  for (const sql of [
    'CREATE TABLE graph_node (id TEXT PRIMARY KEY);',
    'create table if not exists "graph_edge" (id INTEGER PRIMARY KEY);',
    'CREATE VIRTUAL TABLE graph_text USING fts5(x);',
    'CREATE TABLE g (id TEXT); ALTER TABLE g RENAME TO GRAPH_NODES;',
    'CREATE VIEW graph_view AS SELECT 1 AS one;',
    'CREATE INDEX graph_idx ON memory (kind);',
  ]) {
    const v = violations(standIn(sql), adr);
    assert.ok(v.length > 0, `refused: ${sql}`);
    assert.match(v[0]!, /stage 2 is not opened/);
  }
});

test('the guard refuses a graph table when the ADR is missing or only proposed', () => {
  const m = standIn('CREATE TABLE graph_node (id TEXT PRIMARY KEY);');
  assert.match(violations(m, null)[0]!, /missing or not accepted/);
  assert.match(violations(m, '**Status:** Proposed: awaiting owner ruling.\n**Stage 2:** Opened 2026-12-01 (owner).')[0]!, /missing or not accepted/);
});

test('once accepted and opened by the owner, a graph table passes', () => {
  const m = standIn('CREATE TABLE graph_node (id TEXT PRIMARY KEY);');
  assert.deepEqual(violations(m, '**Status:** Accepted 2026-11-10 (owner).\n**Stage 2:** Opened 2026-12-01 (owner).'), []);
});

test('a table that only has graph in its name elsewhere is not a graph object', () => {
  assert.deepEqual(violations(standIn('CREATE TABLE photograph_note (id TEXT PRIMARY KEY);'), realAdr()), []);
});
