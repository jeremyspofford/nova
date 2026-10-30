// What a browser task leaves on the machine, and what it may look up (M5 review, minor 8). A
// profile left behind by a browser that never closed may hold the person's cookies from a
// takeover: Nova removes such profiles at start, and keeps any a live process still uses. And
// Chromium resolves no name but the task's declared hosts. What needs Chromium (declared names
// still work) is in tests/ui/m5-browser-hub.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolverRules, sweepProfiles } from '../../src/core/browser/chromium.ts';
import { createCore } from '../../src/core/index.ts';

// A process id that is certainly gone: a child that has already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();

function profiles() {
  const dir = mkdtempSync(join(tmpdir(), 'nova-sweep-'));
  const make = (name: string, o: { owner?: string; lock?: string; hoursOld?: number } = {}) => {
    const p = join(dir, name);
    mkdirSync(p);
    writeFileSync(join(p, 'Cookies'), 'example cookie jar');
    if (o.owner) writeFileSync(join(p, '.nova-owner'), o.owner);
    if (o.lock) symlinkSync(o.lock, join(p, 'SingletonLock'));
    if (o.hoursOld) { const t = new Date(Date.now() - o.hoursOld * 3600_000); utimesSync(p, t, t); }
    return p;
  };
  return { dir, make };
}

test('sweep: profiles whose process is gone are removed; ones in use, other folders and fresh unmarked ones stay', () => {
  const { dir, make } = profiles();
  const gone = make('nova-browser-gone', { owner: deadPid() });
  const lockedGone = make('nova-browser-lockgone', { lock: `example-host-${deadPid()}` });
  const old = make('nova-browser-old', { hoursOld: 3 });
  const inUse = make('nova-browser-inuse', { owner: String(process.ppid) });
  const lockedInUse = make('nova-browser-lockinuse', { lock: `example-host-${process.ppid}` });
  const fresh = make('nova-browser-fresh');
  const other = make('someone-else', { owner: deadPid() });
  const removed = sweepProfiles(dir);
  assert.deepEqual(removed.sort(), [gone, lockedGone, old].sort());
  for (const p of [gone, lockedGone, old]) assert.equal(existsSync(p), false, p);
  for (const p of [inUse, lockedInUse, fresh, other]) assert.equal(existsSync(p), true, p);
});

test('sweep: Nova does it when it starts', async () => {
  const { dir, make } = profiles();
  const gone = make('nova-browser-left', { owner: deadPid() });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const core = createCore({ home: mkdtempSync(join(saved ?? tmpdir(), 'nova-sweep-home-')), version: '0.1.0', trustedOrigin: () => true });
  try {
    assert.equal(existsSync(gone), true);
    core.start();
    assert.equal(existsSync(gone), false, 'removed at start');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    await core.close();
  }
});

test('resolver: every name maps to nothing except the declared hosts, without their ports', () => {
  assert.equal(resolverRules(['127.0.0.1:4321', 'Example.test', '*.example.org:8443', '[::1]:8080', 'example.test:80']),
    'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE example.test, EXCLUDE *.example.org, EXCLUDE ::1');
});
