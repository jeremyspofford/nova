// Forgetting holds in every backup, even one Nova can't reach when the forget happens (owner's
// standing order 4): a forget made while the backup drive is unplugged, or after the backup folder
// was changed, is owed to that folder and carried in as soon as it is back, before any backup,
// prune or drill touches it; a problem says so meanwhile. The drill checks every kept backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { open, world } from './resilience-support.ts';

const SECRET = 'The spare key is under the blue flowerpot';
const has = (path: string, text: string) => readFileSync(path).includes(Buffer.from(text));

test('a forget while the backup drive is unplugged is owed to it, said plainly, and carried in when it is back', async () => {
  const w = world('nova-owed-');
  const c = open(w.home);
  try {
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    mkdirSync(join(w.home, 'memory'), { recursive: true });
    c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
    const r = c.resilience.nightly.run();
    assert.ok(has(join(r.path!, 'nova.db'), SECRET));

    renameSync(w.target, `${w.target}-unplugged`);
    renameSync(w.second, `${w.second}-unplugged`);
    c.memory.forget(m.id);

    // Said plainly, once per folder: the backups there still hold it until the folder is back.
    const owed = c.log.problems({ open: true }).filter((p) => /forget/i.test(p.message) && /isn’t there/.test(p.message));
    assert.equal(owed.length, 2, JSON.stringify(c.log.problems({ open: true }).map((p) => p.message)));
    assert.ok(owed.some((p) => p.message.includes(w.target)) && owed.some((p) => p.message.includes(w.second)));
    // What is owed is kept out of every backup and copy of the home, and not in plain words.
    const ownFile = join(w.home, 'kept', '.nova', 'forgets-owed.json');
    assert.ok(existsSync(ownFile));
    assert.equal(has(ownFile, SECRET), false, 'the forgotten words are sealed');

    // Plugged back in: the heartbeat's sweep carries the forget in before anything else.
    renameSync(`${w.target}-unplugged`, w.target);
    renameSync(`${w.second}-unplugged`, w.second);
    await c.resilience.sweep();
    assert.equal(has(join(r.path!, 'nova.db'), SECRET), false, 'gone from the replugged backup');
    const opened = join(w.dir, 'opened');
    c.resilience.nightly.decrypt(r.encrypted_path!, opened);
    assert.equal(has(join(opened, 'nova.db'), SECRET), false, 'gone from the replugged encrypted copy');
    assert.equal(c.log.problems({ open: true }).filter((p) => /forget/i.test(p.message)).length, 0, 'the problems close');
    assert.equal(has(ownFile, SECRET), false);
    assert.deepEqual(JSON.parse(readFileSync(ownFile, 'utf8')).owed, [], 'nothing is owed any more');

    const d = await c.resilience.drill();
    assert.equal(d.checks.find((x) => x.name === 'forgotten')?.ok, true, JSON.stringify(d.checks));
  } finally {
    await c.close();
  }
});

test('an owed forget is carried in before a backup run or a prune touches the folder', async () => {
  const w = world('nova-owed-run-');
  const c = open(w.home);
  try {
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target, keep: 5 });
    const r = c.resilience.nightly.run();
    renameSync(w.target, `${w.target}-unplugged`);
    c.memory.forget(m.id);
    renameSync(`${w.target}-unplugged`, w.target);
    // No sweep in between: the backup run itself carries it in first.
    c.resilience.nightly.run();
    assert.equal(has(join(r.path!, 'nova.db'), SECRET), false);

    // And a prune on its own, too.
    const m2 = c.memory.remember({ kind: 'fact', content: `${SECRET} again`, recorded_by: 'person' });
    const r2 = c.resilience.nightly.run();
    renameSync(w.target, `${w.target}-unplugged`);
    c.memory.forget(m2.id);
    renameSync(`${w.target}-unplugged`, w.target);
    c.resilience.nightly.prune();
    assert.equal(has(join(r2.path!, 'nova.db'), `${SECRET} again`), false);
  } finally {
    await c.close();
  }
});

test('a forget reaches the backups in a folder that is no longer the setting', async () => {
  const w = world('nova-owed-moved-');
  const c = open(w.home);
  try {
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target });
    const r = c.resilience.nightly.run();
    const other = join(w.dir, 'other');
    mkdirSync(other);
    c.resilience.setSettings({ target: other });
    c.memory.forget(m.id);
    assert.equal(has(join(r.path!, 'nova.db'), SECRET), false, 'the old folder’s backup was cleaned too');
  } finally {
    await c.close();
  }
});

test('the drill checks every kept backup for forgotten things, not only the newest', async () => {
  const w = world('nova-owed-drill-');
  const c = open(w.home);
  try {
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    c.resilience.setSettings({ target: w.target, keep: 5 });
    const old = c.resilience.nightly.run();
    // A copy of the old backup's database as it was, before the forget cleaned it.
    const before = join(w.dir, 'before.db');
    cpSync(join(old.path!, 'nova.db'), before);
    c.memory.forget(m.id);
    c.resilience.nightly.run();
    // Something put the uncleaned database back into the older backup (a sync tool, a restore).
    rmSync(join(old.path!, 'nova.db'));
    cpSync(before, join(old.path!, 'nova.db'));
    assert.equal(readdirSync(w.target).filter((x) => x.startsWith('nova-backup-')).length, 2);

    const d = await c.resilience.drill();
    assert.equal(d.ok, false, JSON.stringify(d.checks));
    const f = d.checks.find((x) => x.name === 'forgotten-everywhere');
    assert.ok(f && !f.ok, JSON.stringify(d.checks));
    assert.match(f.said, /nova-backup-000001/);
  } finally {
    await c.close();
  }
});
