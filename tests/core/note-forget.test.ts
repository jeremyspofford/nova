// Forgetting a day note goes through the same lifecycle as forgetting a memory (owner's standing
// order 4): every nightly backup, encrypted copy and checkpoint is cleaned, a folder that isn't there
// owes it until it is back, and a restore of an older copy can't bring it back. What the home keeps
// of the forget is an id and a hash, never the words. A memory's reworded twins in the day notes go
// from the backups too; the drill finds a forgotten note left in a backup's files; capture never
// says "deleted everywhere" while a backup folder still owes the forget. Throwaway homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { restoreInto, type Core } from '../../src/core/index.ts';
import { carryOver } from '../../src/core/resilience/restore.ts';
import { scrubWords } from '../../src/core/forgotten-notes.ts';
import { Vault } from '../../src/core/vault.ts';
import { Memory } from '../../src/memory.js';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { open, world } from './resilience-support.ts';

const NOTE = 'The spare key is under the blue flowerpot by the shed';
const has = (path: string, text: string) => readFileSync(path).includes(Buffer.from(text));
const DAY = '2026-10-30';

// What these tests use of src/memory.js (its types are inferred from JavaScript, so too strict here).
interface Files {
  note(o: { text: string }, now?: Date): { id?: string; day?: string };
  remember(o: { kind: string; text: string }): { id?: string };
  forget(id: string): { text: string }[];
  restore(items: unknown[]): void;
  read(): { days: { entries: { id: string; text: string }[] }[] };
}

// src/memory.js as the server makes it (server.js: notes), on a core.
function files(c: Core, home: string): Files {
  const Made = Memory as unknown as new (home: string, tz: string, o: object) => Files;
  return new Made(home, 'UTC', {
    records: c.memory,
    onNoteForget: (n: { id: string; text: string }[], by: string) => c.memory.forgetNotes(n, by),
    onNoteRestore: (n: { id: string; text: string }[], by: string) => c.memory.notesRestored(n, by),
  });
}

// A note Nova wrote (it has an id of its own), or one the person typed into the day file by hand.
function addNote(m: Files, home: string, kind: 'note' | 'hand'): string {
  if (kind === 'note') return m.note({ text: NOTE }, new Date(`${DAY}T09:00:00Z`)).id!;
  mkdirSync(join(home, 'memory'), { recursive: true });
  writeFileSync(join(home, 'memory', `${DAY}.md`), `# ${DAY}\n\n- ${NOTE}\n- Water the ferns on Thursday.\n`);
  return m.read().days[0]!.entries.find((e: { text: string }) => e.text === NOTE)!.id;
}

// Every table, as text: the words must be in none of them.
function inDb(c: Core, words: string): string[] {
  return c.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name)
    .filter((t) => JSON.stringify(c.db.all(`SELECT * FROM "${t}"`)).includes(words));
}

for (const kind of ['note', 'hand'] as const) {
  test(`a ${kind === 'note' ? 'note-only' : 'hand-written day-note'} forget reaches the nightly backup, its encrypted copy and every checkpoint`, async () => {
    const w = world(`nova-nf-${kind}-`);
    const c = open(w.home);
    try {
      const m = files(c, w.home);
      const id = addNote(m, w.home, kind);
      const day = join('memory', `${DAY}.md`);
      c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
      const r = c.resilience.nightly.run();
      const cp = c.checkpoints.take({ kind: 'named', name: 'Before the forget' });
      const cpDir = join(w.home, 'checkpoints', cp.id);
      assert.ok(has(join(r.path!, 'files', day), NOTE) && has(join(cpDir, 'files', day), NOTE), 'the copies hold it first');

      const removed = m.forget(id);
      assert.equal(removed.length, 1);

      assert.equal(has(join(r.path!, 'files', day), NOTE), false, 'gone from the nightly backup');
      if (kind === 'hand') assert.ok(has(join(r.path!, 'files', day), 'Water the ferns'), 'the rest of the note stays');
      const opened = join(w.dir, 'opened');
      c.resilience.nightly.decrypt(r.encrypted_path!, opened);
      assert.equal(has(join(opened, 'files', day), NOTE), false, 'gone from the encrypted copy');
      assert.equal(has(join(cpDir, 'files', day), NOTE), false, 'gone from the checkpoint');
      assert.ok(c.checkpoints.list().some((x) => x.id === cp.id), 'the checkpoint is still sealed and listed');
      // What the home keeps of the forget: a content-free note, never the words.
      const ev = c.db.all<{ kind: string; memory_id: string }>("SELECT kind, memory_id FROM memory_event WHERE kind = 'note-forgotten'");
      assert.equal(ev.length, 1);
      assert.match(ev[0]!.memory_id, new RegExp(`^note:${id}:[0-9a-f]{64}$`));
      assert.deepEqual(inDb(c, 'blue flowerpot'), [], 'no table holds the words');
      assert.equal(c.log.problems({ open: true }).length, 0, JSON.stringify(c.log.problems({ open: true })));
    } finally {
      await c.close();
    }
  });

  test(`a ${kind === 'note' ? 'note-only' : 'hand-written day-note'} forget while the backup drive is unplugged is owed, sealed, and carried in when it is back`, async () => {
    const w = world(`nova-nf-owed-${kind}-`);
    const c = open(w.home);
    try {
      const m = files(c, w.home);
      const id = addNote(m, w.home, kind);
      const day = join('memory', `${DAY}.md`);
      c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
      const r = c.resilience.nightly.run();
      renameSync(w.target, `${w.target}-unplugged`);
      renameSync(w.second, `${w.second}-unplugged`);
      m.forget(id);

      const owedFile = join(w.home, 'kept', '.nova', 'forgets-owed.json');
      assert.ok(existsSync(owedFile), 'the forget is owed to the folders that aren’t there');
      assert.equal(JSON.parse(readFileSync(owedFile, 'utf8')).owed.length, 2);
      assert.equal(has(owedFile, 'blue flowerpot'), false, 'the owed words are sealed');

      renameSync(`${w.target}-unplugged`, w.target);
      renameSync(`${w.second}-unplugged`, w.second);
      await c.resilience.sweep();
      assert.equal(has(join(r.path!, 'files', day), NOTE), false, 'gone from the replugged backup');
      const opened = join(w.dir, 'opened');
      c.resilience.nightly.decrypt(r.encrypted_path!, opened);
      assert.equal(has(join(opened, 'files', day), NOTE), false, 'gone from the replugged encrypted copy');
      assert.deepEqual(JSON.parse(readFileSync(owedFile, 'utf8')).owed, [], 'nothing is owed any more');
    } finally {
      await c.close();
    }
  });
}

test('a note forget through the server reaches the backups: Memory is wired to the core', async () => {
  const w = world('nova-nf-server-');
  const config = { ...loadConfig({ NOVA_HOME: w.home, NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0 };
  const nova = createNova(config);
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
    const { id, day } = (nova.runner.memory as unknown as Files).note({ text: NOTE });
    nova.core.resilience.setSettings({ target: w.target });
    const r = nova.core.resilience.nightly.run();
    const file = join(r.path!, 'files', 'memory', `${day}.md`);
    assert.ok(has(file, NOTE));
    const res = await fetch(`${base}/api/memory/${id}/forget`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(has(file, NOTE), false, 'gone from the nightly backup');
    assert.equal(nova.core.db.all("SELECT 1 FROM memory_event WHERE kind = 'note-forgotten'").length, 1);
  } finally {
    nova.server.close();
    await nova.core.close();
  }
});

test('a restore of a backup taken before a note forget doesn’t bring the note back; one put back by undo stays', async () => {
  const w = world('nova-nf-restore-');
  const c = open(w.home);
  try {
    const m = files(c, w.home);
    const gone = m.note({ text: NOTE }, new Date(`${DAY}T09:00:00Z`));
    const undone = m.note({ text: 'Lunch with the neighbours on Saturday at noon' }, new Date(`${DAY}T10:00:00Z`));
    c.resilience.setSettings({ target: w.target });
    const r = c.resilience.nightly.run();
    // A copy of that backup as it was, before the forget cleaned it (a drive kept elsewhere).
    const before = join(w.dir, 'before');
    cpSync(r.path!, before, { recursive: true });

    m.forget(gone.id!);
    const back = m.forget(undone.id!);
    m.restore(back); // undo
    const staged = join(w.dir, 'staged');
    restoreInto(before, staged);
    assert.ok(has(join(staged, 'memory', `${DAY}.md`), NOTE), 'the old copy holds it');

    const carried = carryOver({
      home: w.home, staged, live: c.db, hubId: c.mesh.identity.id, now: new Date(),
      vault: c.vault, vaultAt: (h) => new Vault({ home: h, mode: 'file', keychain: null }),
    });
    const text = readFileSync(join(staged, 'memory', `${DAY}.md`), 'utf8');
    assert.equal(text.includes(NOTE), false, 'the forgotten note stays forgotten');
    assert.ok(text.includes('Lunch with the neighbours'), 'the note put back by undo stays');
    assert.equal(carried.forgotten.notes, 1);
    const d = new DatabaseSync(join(staged, 'nova.db'), { readOnly: true });
    try {
      assert.equal((d.prepare("SELECT COUNT(*) AS n FROM memory_event WHERE kind = 'note-forgotten'").get() as { n: number }).n, 2, 'the notes of the forgets come along');
      assert.equal((d.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'file' AND pk LIKE 'memory/%'").get() as { n: number }).n, 0, 'the old sync log’s copies of the day notes go');
    } finally {
      d.close();
    }
  } finally {
    await c.close();
  }
});

test('forgetting a memory takes its reworded day-note twin out of the backups too', async () => {
  const w = world('nova-nf-twin-');
  const c = open(w.home);
  try {
    const m = files(c, w.home);
    const rec = m.remember({ kind: 'fact', text: 'Maverick is allergic to penicillin' });
    const twin = 'Doctor said Maverick allergic to penicillin, carry the card';
    const { day } = m.note({ text: twin });
    m.note({ text: 'Bins go out on the first weekday of the month' });
    c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
    const r = c.resilience.nightly.run();
    const file = join(r.path!, 'files', 'memory', `${day}.md`);
    assert.ok(has(file, twin));

    const removed = m.forget(rec.id!);
    assert.deepEqual(removed.map((x: { text: string }) => x.text), ['Maverick is allergic to penicillin', twin], 'the twin is forgotten live');
    assert.equal(has(file, twin), false, 'the reworded twin is gone from the backup copy');
    assert.ok(has(file, 'Bins go out'), 'the rest stays');
    const opened = join(w.dir, 'opened');
    c.resilience.nightly.decrypt(r.encrypted_path!, opened);
    assert.equal(has(join(opened, 'files', 'memory', `${day}.md`), 'penicillin'), false, 'and from the encrypted copy');
  } finally {
    await c.close();
  }
});

test('a forgotten word is found in a file however it is spaced or wrapped', () => {
  const raw = Buffer.from('# Notes\n\n- Takes  coffee\tblack in the morning\n- Water the ferns\n- Said again: Takes coffee\n  black too\nkeep\n');
  const out = scrubWords(raw, ['Takes coffee black'])!;
  assert.equal(out.toLowerCase().includes('coffee'), false, out);
  assert.ok(out.includes('Water the ferns') && out.includes('keep'));
  assert.equal(scrubWords(Buffer.from('nothing here\n'), ['Takes coffee black']), null);
});

test('the drill finds a forgotten note left in an older backup’s files', async () => {
  const w = world('nova-nf-drill-');
  const c = open(w.home);
  try {
    const m = files(c, w.home);
    const n = m.note({ text: NOTE }, new Date(`${DAY}T09:00:00Z`));
    c.resilience.setSettings({ target: w.target, keep: 5 });
    const old = c.resilience.nightly.run();
    const day = join(old.path!, 'files', 'memory', `${DAY}.md`);
    const before = readFileSync(day);
    m.forget(n.id!);
    c.resilience.nightly.run();
    assert.equal(has(day, NOTE), false);
    // Something put the uncleaned day note back into the older backup (a sync tool, a restore).
    writeFileSync(day, before);
    assert.equal(readdirSync(w.target).filter((x) => x.startsWith('nova-backup-')).length, 2);

    const d = await c.resilience.drill();
    const f = d.checks.find((x) => x.name === 'forgotten-everywhere');
    assert.ok(f && !f.ok, JSON.stringify(d.checks));
    assert.match(f.said, /nova-backup-000001 holds 1 forgotten item/);
    assert.equal(d.ok, false);
  } finally {
    await c.close();
  }
});

test('capture doesn’t say "deleted everywhere" while a backup folder still owes the forget, and names the folder', async () => {
  const w = world('nova-nf-capture-');
  const c = open(w.home);
  try {
    const at = new Date().toISOString();
    const event = (id: string) => c.db.run(`INSERT INTO capture_event (id, source_id, device_id, adapter, kind, at, received_at, app, text, via, consent_at)
      VALUES (?, 'screenpipe:hub', 'hub', 'screenpipe', 'screen', ?, ?, 'Notes', 'placeholder captured words', 'pull', ?)`, id, at, at, at);
    event('e1');
    event('e2');
    c.resilience.setSettings({ target: w.target });
    c.resilience.nightly.run();
    renameSync(w.target, `${w.target}-unplugged`);
    const f = c.capture.forget(['e1'], 'person');
    assert.equal(f.everywhere, false);
    assert.doesNotMatch(f.said, /Deleted everywhere/);
    assert.ok(f.said.includes(w.target), f.said);

    renameSync(`${w.target}-unplugged`, w.target);
    await c.resilience.sweep();
    const g = c.capture.forget(['e2'], 'person');
    assert.equal(g.everywhere, true, g.said);
    assert.equal(g.said, 'Deleted everywhere.');
  } finally {
    await c.close();
  }
});
