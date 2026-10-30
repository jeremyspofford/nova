// Restoring a checkpoint (M7 amendment §1): tier 3, from the hub's own screen only, confirmed every
// time. The person's data goes back; revocations, forgets, problems and the mesh epoch don't; a
// checkpoint of now is taken first; the restore is staged and applied at the next start, before the
// database opens, finishing after a crash part-way; and it is a ledger task with evidence. The
// restart itself is in tests/acceptance/m7-checkpoints.test.ts (a real process) and
// tests/supervisor (under the supervisor). Neutral placeholders; throwaway homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, finishStaged, stagedPending, type Core } from '../../src/core/index.ts';
import { enroll, hub, PUBLIC_URL } from './mesh-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

// The same home started again, as the next start would (the staged restore applies first).
function reopen(home: string, clock: { t: number }): Core {
  return createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock.t), mesh: { publicUrl: PUBLIC_URL, transport: 'network' } });
}

const memories = (c: Core) => c.memory.list({}).map((m) => m.content).sort();

test('a restore round trip: the data goes back; revocations, the epoch, problems and forgets stay; devices paired since are dropped; a checkpoint of now first; a ledger task with evidence', async () => {
  const h = await hub();
  let again: Core | null = null;
  let stopped = false;
  try {
    const kept = await enroll(h, { name: 'Kept phone' });
    const later = await enroll(h, { name: 'Phone revoked later' });
    h.core.memory.remember({ kind: 'fact', content: 'The plants get water on Sundays.', recorded_by: 'person' });
    const gone = h.core.memory.remember({ kind: 'fact', content: 'The spare key is under the blue flowerpot.', recorded_by: 'person' });
    mkdirSync(join(h.home, 'workspace'), { recursive: true });
    writeFileSync(join(h.home, 'workspace', 'notes.md'), 'As it was then.\n');
    const early = h.core.log.problem('test', 'A placeholder problem from before.');
    const identity = { id: h.core.mesh.identity.id, fingerprint: h.core.mesh.identity.fingerprint };
    const cp = (await h.c('POST', '/resilience/checkpoints', { name: 'Before the trip' })).body;

    // Since then: more data, a device revoked, one paired, a problem opened and one resolved, a forget.
    h.tick(3_600_000);
    h.core.memory.remember({ kind: 'fact', content: 'Added after the checkpoint.', recorded_by: 'person' });
    writeFileSync(join(h.home, 'workspace', 'notes.md'), 'Changed since.\n');
    assert.equal((await h.c('POST', `/mesh/devices/${later.dev.deviceId}/revoke`, { confirm: true })).status, 200);
    const since = await enroll(h, { name: 'Phone paired since' });
    h.core.log.problem('test', 'A placeholder problem opened since.');
    h.core.log.resolve(early.id);
    h.core.memory.forget(gone.id);
    const epochNow = h.core.mesh.devices.state().epoch;
    // The forget cleaned the checkpoint too: its manifest names the cleaned database now.
    const manifest = JSON.parse(readFileSync(join(h.home, 'checkpoints', cp.id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.cleaned.length, 1);

    const preview = await h.c('GET', `/resilience/checkpoints/${cp.id}/restore`);
    assert.equal(preview.status, 200);
    const said = preview.body.said.join(' ');
    assert.match(said, new RegExp(cp.at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the checkpoint’s date');
    assert.match(said, /Everything since then is undone: tasks, memories, settings and changes/);
    assert.match(said, /takes a checkpoint of now first/);
    assert.match(said, /“Phone paired since” was paired since then and will need pairing again/);

    const r = await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, { confirm: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.restart.how, 'next-start', 'a bare core can’t restart itself; the server can (tests/acceptance)');
    assert.deepEqual(r.body.carried.dropped.map((d: { name: string }) => d.name), ['Phone paired since']);
    assert.deepEqual(r.body.carried.revoked.map((d: { name: string }) => d.name), ['Phone revoked later']);
    assert.equal(r.body.verified.db, manifest.db.sha256, 'the hashes it verified are the manifest’s');
    assert.ok(stagedPending(h.home));
    assert.match(r.body.before.reason, /^Before restoring to “Before the trip”/);
    assert.ok(h.core.checkpoints.list().some((c) => c.id === r.body.before.id), 'a checkpoint of now, so the restore can be undone');
    stopped = true;
    await h.stop();

    // The next start: applied before the database opens.
    again = reopen(h.home, h.clock);
    again.start();
    assert.equal(stagedPending(h.home), false);
    assert.equal(existsSync(join(h.home, 'checkpoints', '.restore')), false, 'nothing staged is left behind');
    assert.deepEqual(memories(again), ['The plants get water on Sundays.'], 'the data as it was; the forgotten one stays forgotten');
    assert.equal(readFileSync(join(h.home, 'workspace', 'notes.md'), 'utf8'), 'As it was then.\n');
    assert.equal(again.mesh.identity.id, identity.id, 'the same identity');
    assert.equal(again.mesh.identity.fingerprint, identity.fingerprint);
    const devices = again.mesh.devices;
    assert.equal(devices.find(kept.dev.deviceId)?.trust, 'trusted');
    assert.equal(devices.find(later.dev.deviceId)?.trust, 'revoked', 'a device revoked since stays revoked');
    assert.equal(devices.find(since.dev.deviceId), null, 'a device paired since is dropped');
    assert.ok(devices.state().epoch > epochNow, `the epoch went up: ${devices.state().epoch} > ${epochNow}`);
    assert.equal(devices.state().epoch, Math.max(epochNow, 1) + 1);
    const problems = again.log.problems({});
    assert.ok(problems.some((p) => p.message === 'A placeholder problem opened since.' && !p.resolved_at), 'a problem opened since is carried over');
    assert.ok(problems.find((p) => p.message === 'A placeholder problem from before.')?.resolved_at, 'one resolved since stays resolved');

    // The ledger task, with what was verified and what was carried, checked by Nova itself.
    const task = await until(() => again!.ledger.list({ limit: 50 }).find((t) => t.owner === 'checkpoints'), (t) => !!t && ['done', 'failed'].includes(t.state));
    assert.ok(task, 'the restore is a ledger task');
    assert.equal(task!.state, 'done', task!.reason ?? '');
    assert.equal(task!.title, 'Restore to “Before the trip”');
    assert.equal(task!.verification?.ok, true, JSON.stringify(task!.verification));
    const inputs = task!.brief.inputs as { checkpoint: { id: string }; verified: { db: string; files: number }; carried: { epoch: { restored: number } } };
    assert.equal(inputs.checkpoint.id, cp.id);
    assert.equal(inputs.verified.db, manifest.db.sha256);
    assert.equal(inputs.verified.files, manifest.files.length);
    assert.equal(inputs.carried.epoch.restored, devices.state().epoch);
    assert.match(task!.report!.summary, /stays revoked/);
    assert.match(task!.report!.summary, /“Phone paired since” needs pairing again/);
    // Recorded once: another start doesn't add another.
    await again.close();
    again = reopen(h.home, h.clock);
    again.start();
    assert.equal(again.ledger.list({ limit: 50 }).filter((t) => t.owner === 'checkpoints').length, 1);
  } finally {
    if (!stopped) await h.stop();
    await again?.close();
  }
});

test('restoring is the hub’s own screen’s only, confirmed every time; a damaged checkpoint isn’t restored', async () => {
  const h = await hub();
  try {
    const cp = (await h.c('POST', '/resilience/checkpoints', { name: 'Example' })).body;
    const { token } = await enroll(h, { name: 'Approving phone' });
    await h.c('PATCH', `/mesh/devices/${h.core.mesh.devices.list().find((d) => d.name === 'Approving phone')!.id}`, { can_approve: true, confirm: true });
    const phone = await fetch(`${h.mesh}/api/v1/resilience/checkpoints/${cp.id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1', authorization: `Bearer ${token}` }, body: JSON.stringify({ confirm: true }) });
    assert.equal(phone.status, 403, 'not from a paired device, even one that may approve');
    assert.match((await phone.json()).error, /hub’s own screen/);
    const bare = await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, {});
    assert.equal(bare.status, 400, 'not without the confirmation');
    assert.match(bare.body.error, /confirmation every time/);
    assert.equal(stagedPending(h.home), false, 'nothing staged');
    // A checkpoint whose files no longer match their hashes is refused, and nothing is staged.
    writeFileSync(join(h.home, 'checkpoints', cp.id, 'files', 'mesh', 'identity.json'), '{}');
    const damaged = await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, { confirm: true });
    assert.equal(damaged.status, 409);
    assert.match(damaged.body.error, /damaged/);
    assert.equal(stagedPending(h.home), false);
  } finally {
    await h.stop();
  }
});

test('a crash in the middle of a restore: the next start finishes it; Nova never opens a mix', async () => {
  const h = await hub();
  let again: Core | null = null;
  try {
    h.core.memory.remember({ kind: 'fact', content: 'From before the checkpoint.', recorded_by: 'person' });
    mkdirSync(join(h.home, 'workspace'), { recursive: true });
    writeFileSync(join(h.home, 'workspace', 'notes.md'), 'then\n');
    const cp = (await h.c('POST', '/resilience/checkpoints', { name: 'Crash test' })).body;
    h.core.memory.remember({ kind: 'fact', content: 'From after it.', recorded_by: 'person' });
    writeFileSync(join(h.home, 'workspace', 'notes.md'), 'now\n');
    mkdirSync(join(h.home, 'skills'), { recursive: true });
    writeFileSync(join(h.home, 'skills', 'only-now.md'), 'made since\n');
    assert.equal((await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, { confirm: true })).status, 202);
    await h.stop();

    // Stopped part-way through the swap: some entries moved in, some not.
    let moved = 0;
    assert.throws(() => finishStaged(h.home, { interrupt: (_, what) => { if (what === 'in' && ++moved === 2) throw new Error('power cut'); } }), /power cut/);
    assert.ok(stagedPending(h.home), 'the marker is still there');
    assert.ok(readdirSync(join(h.home, 'checkpoints', '.restore', 'old')).length > 0, 'it was part-way');

    again = reopen(h.home, h.clock);
    assert.equal(stagedPending(h.home), false);
    assert.deepEqual(memories(again), ['From before the checkpoint.']);
    assert.equal(readFileSync(join(h.home, 'workspace', 'notes.md'), 'utf8'), 'then\n');
    assert.equal(existsSync(join(h.home, 'skills', 'only-now.md')), false, 'what Nova made since is undone (and kept in the “before” checkpoint)');
    const before = again.checkpoints.list().find((c) => /^Before restoring/.test(c.label))!;
    assert.ok(readFileSync(join(h.home, 'checkpoints', before.id, 'files', 'skills', 'only-now.md'), 'utf8').includes('made since'));
  } finally {
    await again?.close();
  }
});

test('files in the home that aren’t Nova’s are never in a checkpoint, and a restore leaves them exactly as they are, made before it or after', async () => {
  const h = await hub();
  let again: Core | null = null;
  let stopped = false;
  try {
    h.core.memory.remember({ kind: 'fact', content: 'Nova’s, from before.', recorded_by: 'person' });
    writeFileSync(join(h.home, 'proxy.js'), '// the person’s proxy, as it was\n');
    mkdirSync(join(h.home, 'notes-of-mine'));
    writeFileSync(join(h.home, 'notes-of-mine', 'a.txt'), 'mine, from before\n');
    const cp = (await h.c('POST', '/resilience/checkpoints', { name: 'With foreign files around' })).body;
    const manifest = JSON.parse(readFileSync(join(h.home, 'checkpoints', cp.id, 'manifest.json'), 'utf8'));
    for (const f of manifest.files) assert.ok(!/^(proxy\.js|notes-of-mine)(\/|$)/.test(f.path), `${f.path} isn’t Nova’s, so it isn’t in the checkpoint`);

    // Since: Nova's data changes, and so do the person's own files.
    h.core.memory.remember({ kind: 'fact', content: 'Nova’s, from after.', recorded_by: 'person' });
    writeFileSync(join(h.home, 'proxy.js'), '// the person’s proxy, edited since\n');
    writeFileSync(join(h.home, 'notes-of-mine', 'b.txt'), 'mine, from after\n');
    writeFileSync(join(h.home, 'later.txt'), 'mine, made after the checkpoint\n');
    const preview = await h.c('GET', `/resilience/checkpoints/${cp.id}/restore`);
    assert.ok(preview.body.said.includes('Files in this folder that aren’t Nova’s are left as they are.'), preview.body.said.join('\n'));
    assert.equal((await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, { confirm: true })).status, 202);
    stopped = true;
    await h.stop();
    again = reopen(h.home, h.clock);

    assert.deepEqual(memories(again), ['Nova’s, from before.'], 'Nova’s own data went back');
    assert.equal(readFileSync(join(h.home, 'proxy.js'), 'utf8'), '// the person’s proxy, edited since\n');
    assert.equal(readFileSync(join(h.home, 'notes-of-mine', 'a.txt'), 'utf8'), 'mine, from before\n');
    assert.equal(readFileSync(join(h.home, 'notes-of-mine', 'b.txt'), 'utf8'), 'mine, from after\n');
    assert.equal(readFileSync(join(h.home, 'later.txt'), 'utf8'), 'mine, made after the checkpoint\n');
    // Nor in the checkpoint of how things were just before.
    const before = again.checkpoints.list().find((c) => /^Before restoring/.test(c.label))!;
    const bm = JSON.parse(readFileSync(join(h.home, 'checkpoints', before.id, 'manifest.json'), 'utf8'));
    assert.deepEqual(bm.files.filter((f: { path: string }) => /^(proxy\.js|later\.txt|notes-of-mine)/.test(f.path)), []);
  } finally {
    if (!stopped) await h.stop();
    await again?.close();
  }
});

test('a staging that stopped before it was sealed is dropped: Nova starts on the home as it was', async () => {
  const h = await hub();
  let again: Core | null = null;
  try {
    h.core.memory.remember({ kind: 'fact', content: 'Still here.', recorded_by: 'person' });
    const cp = (await h.c('POST', '/resilience/checkpoints', { name: 'Unsealed' })).body;
    h.core.memory.remember({ kind: 'fact', content: 'Also still here.', recorded_by: 'person' });
    assert.equal((await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, { confirm: true })).status, 202);
    await h.stop();
    // As if it stopped while copying: the staged copy is there, its marker isn't.
    const marker = join(h.home, 'checkpoints', '.restore', 'marker.json');
    writeFileSync(marker, '');
    const { rmSync } = await import('node:fs');
    rmSync(marker);
    again = reopen(h.home, h.clock);
    assert.deepEqual(memories(again), ['Also still here.', 'Still here.']);
    assert.equal(existsSync(join(h.home, 'checkpoints', '.restore')), false);
  } finally {
    await again?.close();
  }
});
