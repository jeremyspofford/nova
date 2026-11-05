// Removing a skill reaches Nova's backups and checkpoints the way a memory forget does (owner's
// standing order 4): its playbook is in no nightly backup, encrypted copy or checkpoint after, each
// still passes its integrity check, and nothing restored from one brings the skill back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { restoreInto, takeCheckpoint } from '../src/core/index.ts';
import { scanCheckpoints, verifyCheckpoint } from '../src/core/resilience/checkpoints.ts';

const root = new URL('..', import.meta.url).pathname;
const PLAYBOOK = 'Nova researches; the person buys';
const dir = mkdtempSync(join(tmpdir(), 'nova-skf-'));
const home = join(dir, 'home');
const target = join(dir, 'backups');
const second = join(dir, 'encrypted');
mkdirSync(target);
mkdirSync(second);
const nova = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' }));
await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${nova.server.address().port}`;
after(() => nova.server.close());
const post = (path) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: '{}' });

// Every file under `at` that holds the playbook's words.
function holding(at) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else if (readFileSync(p).includes(PLAYBOOK)) out.push(p);
  };
  if (existsSync(at)) walk(at);
  return out;
}

test('a removed skill leaves no copy in backups or checkpoints, and no restore brings it back', async () => {
  const c = nova.core;
  assert.equal((await post('/api/skills/shopping/install')).status, 200);
  c.mesh.sync.scan();
  c.resilience.setSettings({ target, encrypted_target: second });
  const r = c.resilience.nightly.run();
  takeCheckpoint({ home, db: c.db, kind: 'named', name: 'With the shopping skill', version: '0.1.0' });
  const opened = (name) => { const to = join(dir, name); c.resilience.nightly.decrypt(r.encrypted_path, to); return to; };
  // Before: the playbook is in the backup (its file and the journal), the copy and the checkpoint.
  assert.ok(existsSync(join(r.path, 'files', 'skills', 'shopping', 'SKILL.md')));
  assert.ok(holding(join(r.path, 'nova.db')).length, 'the backup’s journal holds it');
  assert.ok(holding(opened('before')).length);
  assert.ok(holding(join(home, 'checkpoints')).length);

  assert.equal((await post('/api/skills/shopping/remove')).status, 200);

  assert.deepEqual(holding(target), [], 'in no nightly backup');
  assert.deepEqual(holding(join(home, 'checkpoints')), [], 'in no checkpoint');
  assert.deepEqual(holding(join(home, 'backups')), [], 'in no pre-upgrade copy');
  const copy = opened('after');
  assert.deepEqual(holding(copy), [], 'in no encrypted copy');

  // Still Nova's, still whole: sealed, every hash matching.
  assert.ok(c.resilience.nightly.complete().some((b) => b.path === r.path), 'the cleaned backup still counts');
  assert.deepEqual(c.resilience.nightly.strays(), []);
  const cps = scanCheckpoints(home);
  assert.equal(cps.found.length, 1);
  assert.deepEqual(cps.strays, []);
  verifyCheckpoint(cps.found[0]);
  assert.ok(!cps.found[0].manifest.files.some((f) => f.path.startsWith('skills/shopping/')));

  // What a restore brings back has no such skill.
  for (const [from, into] of [[r.path, join(dir, 'restored')], [copy, join(dir, 'restored-copy')]]) {
    restoreInto(from, into);
    assert.equal(existsSync(join(into, 'skills', 'shopping')), false);
    assert.deepEqual(holding(into), []);
  }
  const d = await c.resilience.drill();
  assert.equal(d.ok, true, JSON.stringify(d.checks));
});

test('removed while the backup drive is unplugged: owed, and carried in when it is back', async () => {
  const c = nova.core;
  assert.equal((await post('/api/skills/shopping/install')).status, 200);
  c.resilience.nightly.run();
  renameSync(target, `${target}-unplugged`);
  assert.equal((await post('/api/skills/shopping/remove')).status, 200);
  assert.equal(c.resilience.nightly.owedView().length, 1);
  renameSync(`${target}-unplugged`, target);
  await c.resilience.sweep();
  assert.deepEqual(holding(target), []);
  assert.deepEqual(c.resilience.nightly.owedView(), []);
});
