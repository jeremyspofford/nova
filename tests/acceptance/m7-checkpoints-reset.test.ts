// The M7 amendment end to end on one real server process (plan §3, Acceptance): take a named
// checkpoint, change things, restore it with no manual restart (the same process, the same port),
// export, factory reset (again no manual restart), first-run setup, and the export opens with the
// recovery key it was shown with. The egress tripwire stays empty throughout. A throwaway home and
// folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openEncrypted } from '../../src/core/index.ts';
import { blank, sleep, stop, until } from './support.ts';

const KEEP = 'The plants get water on Sundays.';
const LATER = 'Added during the experiment.';

test('M7 amendment: checkpoint, change, restore, export, factory reset, first run, the export opens — no manual restart, nothing leaves the machine', { timeout: 150_000 }, async () => {
  const m = blank('nova-m7-cpr-');
  const nova = await m.start({ NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network' });
  const port = nova.port;
  const ready = () => (nova.out.join('').match(/Nova is ready at/g) ?? []).length;
  const memories = async () => ((await m.get('/api/v1/memory')) as { content: string }[]).map((x) => x.content).sort();
  const egress = () => readFileSync(m.egress, 'utf8');
  const out = join(m.dir, 'export-here');
  mkdirSync(out, { mode: 0o700 });
  try {
    // 1. A named checkpoint.
    assert.equal((await m.send('POST', '/api/v1/memory', { kind: 'fact', content: KEEP })).status, 201);
    const cp = await m.send('POST', '/api/v1/resilience/checkpoints', { name: 'Before the experiment' });
    assert.equal(cp.status, 201, JSON.stringify(cp.body));
    // 2. Change things.
    assert.equal((await m.send('POST', '/api/v1/memory', { kind: 'fact', content: LATER })).status, 201);
    assert.deepEqual(await memories(), [LATER, KEEP]);
    assert.equal(egress(), '');

    // 3. Restore, and Nova comes back by itself: the same process, the same port.
    const r = await m.send('POST', `/api/v1/resilience/checkpoints/${cp.body.id}/restore`, { confirm: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await until(async () => ready(), (n) => n >= 2, 400);
    assert.equal(ready(), 2, `ready again:\n${nova.out.join('')}`);
    assert.equal(nova.proc.exitCode, null, 'the process the person started is still the one running');
    const back = await until(async () => { try { return await memories(); } catch { return null; } }, (x) => !!x && x.length === 1, 400);
    assert.deepEqual(back, [KEEP]);
    assert.match(nova.out.join(''), new RegExp(`Nova is ready at http://localhost:${port}`));
    assert.equal(egress(), '');

    // 4. Export first: the recovery key is in this reply only.
    const e = await m.send('POST', '/api/v1/reset/export', { folder: out });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.match(e.body.said, /Your saved passwords and keys aren’t in the export; you’ll add them again\./);
    const key = e.body.recovery_key as string;

    // 5. Factory reset, confirmed; Nova restarts by itself again.
    const preview = await m.get('/api/v1/reset');
    assert.match(preview.keeps.releases, /code releases stay/);
    assert.equal(preview.keeps.export, e.body.folder);
    assert.equal((await m.send('POST', '/api/v1/reset', {})).status, 400, 'never without confirming');
    const reset = await m.send('POST', '/api/v1/reset', { confirm: true });
    assert.equal(reset.status, 202, JSON.stringify(reset.body));
    assert.equal(reset.body.restart, 'in-place');
    await until(async () => ready(), (n) => n >= 3, 600);
    assert.equal(ready(), 3, `ready a third time:\n${nova.out.join('')}`);
    assert.equal(nova.proc.exitCode, null, 'still the same process');

    // 6. First-run setup, with the reset's result for that screen.
    const report = await until(async () => { try { return await m.get('/api/v1/reset/report'); } catch { return null; } }, (x) => !!x?.id, 400);
    assert.equal(report.id, reset.body.id);
    assert.match(report.said, /Nova was erased on this machine and started over\./);
    assert.equal((await m.get('/api/v1/setup')).done, false);
    assert.deepEqual(await memories(), [], 'nothing remembered');
    assert.deepEqual((await m.get('/api/v1/resilience/checkpoints')).checkpoints, [], 'the checkpoints went too');
    assert.ok(!existsSync(join(m.home, 'factory-reset.json')));
    assert.equal(report.left.export, e.body.folder, 'the export was left alone');

    // 7. The export opens with the recovery key alone, and holds what was there before the reset.
    const opened = join(m.dir, 'opened');
    const manifest = openEncrypted(e.body.file, key, opened);
    assert.ok(!manifest.files.some((f) => f.path.startsWith('vault/') || f.path.startsWith('mesh/')));
    const db = new DatabaseSync(join(opened, 'nova.db'), { readOnly: true });
    try {
      assert.deepEqual((db.prepare('SELECT content FROM memory').all() as { content: string }[]).map((x) => x.content), [KEEP]);
    } finally {
      db.close();
    }
    assert.ok(readdirSync(e.body.folder).includes('memory.md'));
    await sleep(100);
    assert.equal(egress(), '', 'nothing left this machine, throughout');
  } finally {
    await stop(nova);
  }
});
