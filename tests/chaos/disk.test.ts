// Chaos pass, the disk (M7 plan §3): full while writing the database, the vault and a backup, and
// the backup folder missing. A full disk is made without root and without filling a real one:
// SQLite's own limit on the database's size (PRAGMA max_page_count gives "database or disk is
// full", exactly as a full disk does), and ENOSPC injected into Node's fs for the files under one
// folder this test owns. Nothing already saved is lost or damaged; each failure is a problem with
// its playbook, and the only automatic repair is deleting Nova's own scratch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { open, world } from '../core/resilience-support.ts';
import type { Core } from '../../src/core/index.ts';
import { problemWith, repairs, settle } from './support.ts';

const enospc = (what: string) => Object.assign(new Error(`ENOSPC: no space left on device, ${what}`), { code: 'ENOSPC', errno: -28, syscall: what });

// Writes under `prefix` fail as a full disk does, until the returned function is called.
function fullDisk(prefix: string): () => void {
  const saved = { writeFileSync: fs.writeFileSync, copyFileSync: fs.copyFileSync };
  fs.writeFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => { if (String(p).startsWith(prefix)) throw enospc('write'); return (saved.writeFileSync as (...a: unknown[]) => void)(p, ...rest); }) as typeof fs.writeFileSync;
  fs.copyFileSync = ((src: fs.PathLike, dst: fs.PathLike, mode?: number) => { if (String(dst).startsWith(prefix)) throw enospc('copyfile'); return saved.copyFileSync(src, dst, mode); }) as typeof fs.copyFileSync;
  syncBuiltinESMExports();
  return () => { Object.assign(fs, saved); syncBuiltinESMExports(); };
}

async function console(core: Core) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, 'console');
    if (!p) return;
    if (!(await core.handle(req, res, url, p, 'console'))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return {
    call: async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

test('the database fills up: the write is refused, nothing saved is lost, the problem is still shown (from memory), and writing works once there is room', async () => {
  const w = world('nova-chaos-dbfull-');
  const core = open(w.home);
  const c = await console(core);
  try {
    const kept = await c.call('POST', '/memory', { kind: 'fact', content: 'Saved before the disk filled.' });
    assert.equal(kept.status, 201);
    const pages = core.db.get<{ page_count: number }>('PRAGMA page_count')!.page_count;
    core.db.raw.exec(`PRAGMA max_page_count = ${pages}`);
    // Filled to the brim, not just past one page: smaller writes until they are refused too, then a
    // few more refusals, each of which tries to save its problem. How full the last pages of each
    // table happen to be (which depends on everything else in the database) then can't leave room
    // for the problem.
    let refused: { status: number } | null = null;
    for (const size of [400, 40, 4]) {
      for (let i = 0; i < 200; i++) {
        const r = await c.call('POST', '/memory', { kind: 'fact', content: `Filler ${size}.${i} `.repeat(size) });
        if (r.status !== 201) { refused ??= r; break; }
      }
    }
    for (let i = 0; i < 10; i++) await c.call('POST', '/memory', { kind: 'fact', content: `Filler more ${i} `.repeat(40) });
    assert.ok(refused, 'a write was refused once the database was full');
    assert.equal(refused!.status, 500);
    // The problem couldn't go into the full database; it is shown anyway, with its playbook.
    const p = await problemWith(core, 'disk-full');
    assert.ok(p.id < -1_000_000, 'kept in memory');
    assert.match(p.detail ?? '', /disk is full/);
    const r = await repairs(core, p.id);
    assert.equal(r[0]!.name, 'free-scratch');
    assert.equal(r[0]!.ok, true);
    // What was saved is intact.
    assert.equal(core.db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
    assert.equal((await c.call('GET', '/memory')).body.some((m: { content: string }) => m.content === 'Saved before the disk filled.'), true);
    // Room again: writes work.
    core.db.raw.exec('PRAGMA max_page_count = 1073741823');
    assert.equal((await c.call('POST', '/memory', { kind: 'fact', content: 'Saved after there was room.' })).status, 201);
  } finally {
    c.close();
    await core.close();
  }
});

test('the disk fills while saving a secret: refused in plain words, the vault still holds what it had, a problem with its playbook', async () => {
  const w = world('nova-chaos-vaultfull-');
  const core = open(w.home);
  const c = await console(core);
  let restore = () => {};
  try {
    assert.equal((await c.call('PUT', '/vault/FIRST_KEY', { value: 'placeholder-value-0001' })).status, 200);
    restore = fullDisk(`${w.home}/vault`);
    const r = await c.call('PUT', '/vault/SECOND_KEY', { value: 'placeholder-value-0002' });
    restore();
    assert.equal(r.status, 409);
    assert.match(r.body.error, /the disk is full\. Nothing was changed/);
    assert.deepEqual(core.vault.list(), ['provider/FIRST_KEY'], 'nothing half-saved in memory');
    assert.equal(core.vault.get('provider/FIRST_KEY'), 'placeholder-value-0001');
    assert.equal(readdirSync(`${w.home}/vault`).some((f) => f.endsWith('.tmp')), false, 'no partial file left');
    await problemWith(core, 'disk-full', { subject: 'vault' });
    // Room again: it saves.
    assert.equal((await c.call('PUT', '/vault/SECOND_KEY', { value: 'placeholder-value-0002' })).status, 200);
  } finally {
    restore();
    c.close();
    await core.close();
  }
});

test('the disk fills while writing a backup: it stops cleanly, the earlier backups are untouched, a problem with its playbook; the backup folder missing is refused, never created', async () => {
  const w = world('nova-chaos-bkfull-');
  const core = open(w.home);
  let restore = () => {};
  try {
    core.memory.remember({ kind: 'fact', content: 'Something worth keeping.', recorded_by: 'person' });
    mkdirSync(`${w.home}/notes`, { recursive: true });
    fs.writeFileSync(`${w.home}/notes/a.md`, 'A note.\n');
    core.resilience.setSettings({ target: w.target });
    const first = core.resilience.nightly.run();
    restore = fullDisk(w.target);
    const t = await settle(core, core.resilience.request('backup').id);
    restore();
    assert.equal(t.state, 'failed');
    assert.match(t.reason!, /disk the backup folder is on is full/);
    assert.deepEqual(readdirSync(w.target), [first.id], 'only the earlier backup; nothing half-written left');
    await problemWith(core, 'disk-full', { subject: 'backup' });

    // The folder gone (a drive unplugged): refused, and not made.
    rmSync(w.target, { recursive: true });
    const gone = await settle(core, core.resilience.request('backup').id);
    assert.equal(gone.state, 'failed');
    assert.equal(existsSync(w.target), false);
    await problemWith(core, 'backup-target-missing');
  } finally {
    restore();
    await core.close();
  }
});
