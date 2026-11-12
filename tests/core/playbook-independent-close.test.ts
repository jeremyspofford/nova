// A repair may not close its own problem (owner's order, 2026-11-11: "closure requires a
// verification independent of the repair action. Regression test: a playbook reporting success
// leaves the problem open until the independent check passes"). Before this, a repair that
// returned { ok: true, resolved: true } closed its problem on its own word
// (src/core/resilience/playbooks.ts, attempt()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, world } from './resilience-support.ts';

const isOpen = (c: ReturnType<typeof open>, id: number) => c.log.problems({ open: true }).some((x) => x.id === id);

test('a repair reporting success (ok and resolved) leaves the problem open until the independent check passes; then it closes', async () => {
  const w = world('nova-pb-close-');
  let t = Date.parse('2026-11-11T10:00:00Z');
  const c = open(w.home, { now: () => new Date(t) });
  try {
    const pb = c.resilience.playbooks;
    let repaired = 0;
    // The repair says it fixed it, as loudly as a repair can.
    pb.repair('reconnect', () => { repaired++; return { ok: true, said: 'Mail is connected again.', resolved: true }; });
    // The independent check: what the detector sees, which the repair doesn't control.
    let listening = false;
    pb.check('connector-down', 'Nova’s connection watch sees it connected and listening', () => ({ holds: listening, said: listening ? 'Mail is connected and listening again.' : 'Mail isn’t listening yet.' }));

    const p = pb.open('connectors', 'Mail lost its connection and hasn’t come back yet.', 'connector-down', { subject: 'mail' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(repaired, 1, 'Nova made its automatic repair');

    // Repaired, and said it worked: the problem is still open, its repair waiting on the check.
    assert.equal(isOpen(c, p.id), true, 'a repair’s own word must not close its problem');
    let v = pb.view(p.id)!;
    assert.equal(v.repairs.length, 1);
    assert.equal(v.repairs[0]!.ok, true);
    assert.equal(v.repairs[0]!.verified, null, 'repaired, checking');
    assert.equal(v.check, 'Nova’s connection watch sees it connected and listening');

    // A person asking again changes nothing about that either.
    const asked = await pb.attempt(p.id, 'person');
    assert.equal(asked.ok, true);
    assert.equal(asked.checking, true);
    assert.equal(isOpen(c, p.id), true);

    // The check looks and sees the invariant still broken: it stays open.
    await pb.verify();
    assert.equal(isOpen(c, p.id), true);

    // The check sees it hold: now it closes, and the repairs show they held.
    listening = true;
    t += 1000;
    await pb.verify();
    assert.equal(isOpen(c, p.id), false, 'closed once the independent check passed');
    v = pb.view(p.id)!;
    assert.ok(v.repairs.filter((r) => r.name === 'reconnect').every((r) => r.verified !== null), JSON.stringify(v.repairs));
    assert.equal(v.repairs.at(-1)!.name, 'watch');
    assert.equal(v.repairs.at(-1)!.said, 'Mail is connected and listening again.');
  } finally {
    await c.close();
  }
});

test('a "successful" repair whose independent check fails keeps the problem open, and shows the repair as not having held', async () => {
  const w = world('nova-pb-held-');
  let t = Date.parse('2026-11-11T10:00:00Z');
  const c = open(w.home, { now: () => new Date(t) });
  try {
    const pb = c.resilience.playbooks;
    pb.repair('reconnect', () => ({ ok: true, said: 'Mail is connected again.', resolved: true }));
    pb.check('connector-down', 'Nova’s connection watch sees it connected and listening', () => ({ holds: false, said: 'Mail isn’t listening yet.' }));
    const p = pb.open('connectors', 'Mail lost its connection and hasn’t come back yet.', 'connector-down', { subject: 'mail' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(pb.view(p.id)!.repairs[0]!.verified, null);

    // The heartbeat's sweep runs the check: it fails, so the repair didn't hold.
    t += 1000;
    await pb.sweep();
    assert.equal(isOpen(c, p.id), true, 'still open: the check failed');
    const r = pb.view(p.id)!.repairs[0]!;
    assert.equal(r.verified, false);
    assert.equal(r.checked, 'Mail isn’t listening yet.');
  } finally {
    await c.close();
  }
});

test('a playbook with no independent check stays open after a repair that says it worked: closing it is the person’s', async () => {
  const w = world('nova-pb-none-');
  const c = open(w.home);
  try {
    const pb = c.resilience.playbooks;
    // free-scratch (disk-full) has no check: nothing re-reads the disk after it.
    pb.repair('free-scratch', () => ({ ok: true, said: 'Deleted 2 of Nova’s own leftover scratch folders.', resolved: true }));
    const p = pb.open('backups', 'A disk is full: ENOSPC.', 'disk-full', { subject: 'backup' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await pb.verify();
    assert.equal(isOpen(c, p.id), true);
    const v = pb.view(p.id)!;
    assert.equal(v.check, null);
    assert.equal(v.repairs[0]!.ok, true);
    assert.equal(v.repairs[0]!.verified, undefined, 'nothing checks it, so it isn’t shown as checking');
  } finally {
    await c.close();
  }
});
