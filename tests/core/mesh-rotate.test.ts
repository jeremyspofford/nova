// Replacing the hub's keys after they were exposed in the home's git history: same id, new keys,
// a higher epoch; the computers and the standby that pinned the old key are revoked; phones and
// browsers stay signed in; the "keys exposed" problem stops once the current key isn't in history.
// Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, rotateHubKeys, verifyRoster } from '../../src/core/index.ts';
import { ensureGit, keysInHistory } from '../../src/home.js';
import { enroll, hub } from './mesh-support.ts';

const ROOT = join(import.meta.dirname, '..', '..');

test('replacing the hub’s keys: same id, new keys, a higher epoch, pinning devices revoked, phones kept', async () => {
  const h = await hub();
  const { dev: phone } = await enroll(h, { kind: 'phone', name: 'Test phone' });
  const { dev: pc } = await enroll(h, { kind: 'computer', name: 'Desk computer' });
  const { dev: sb } = await enroll(h, { kind: 'standby', name: 'Standby' });
  const before = JSON.parse(readFileSync(join(h.home, 'mesh', 'identity.json'), 'utf8'));
  // An M4 home: the keys went into history with everything else.
  execFileSync('git', ['-C', h.home, 'init', '-q']);
  writeFileSync(join(h.home, '.gitignore'), 'nova.db*\nlogs/\nbackups/\n');
  execFileSync('git', ['-C', h.home, 'add', '-A']);
  execFileSync('git', ['-C', h.home, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old']);
  const problems: string[] = [];
  await ensureGit(h.home, { problem: (m: string) => problems.push(m) });
  assert.equal(problems.length, 1, 'the exposure is said');
  await h.stop();

  const r = await rotateHubKeys(h.home);
  const after = JSON.parse(readFileSync(join(h.home, 'mesh', 'identity.json'), 'utf8'));
  assert.equal(after.id, before.id, 'the same node');
  assert.notEqual(after.ed25519.private, before.ed25519.private);
  assert.notEqual(after.x25519.private, before.x25519.private);
  assert.equal(r.epoch, 2);
  assert.deepEqual(r.revoked.map((d) => d.kind).sort(), ['computer', 'standby']);

  const core = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => true });
  try {
    const d = core.mesh.devices;
    assert.equal(d.get(after.id).public_key, after.ed25519.public);
    assert.equal(d.get(phone.deviceId).trust, 'trusted', 'a phone never pinned the hub’s key');
    assert.equal(d.get(pc.deviceId).trust, 'revoked');
    assert.equal(d.get(sb.deviceId).trust, 'revoked');
    const roster = d.roster();
    assert.equal(roster.roster.epoch, 2);
    assert.ok(verifyRoster(roster, [after.ed25519.public]));
    assert.equal(verifyRoster(roster, [before.ed25519.public]), false, 'the old key signs nothing now');
    assert.equal(roster.roster.standby, undefined);
  } finally {
    await core.close();
  }

  // The old keys are still in history, but the current one isn't: the problem stops.
  assert.equal(await keysInHistory(h.home), false);
  await ensureGit(h.home, { problem: (m: string) => problems.push(m) });
  assert.equal(problems.length, 1);
});

test('the rotation script says what changed and which devices to add again', async () => {
  const h = await hub();
  await enroll(h, { kind: 'computer', name: 'Desk computer' });
  await h.stop();
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts/rotate-hub-keys.js'), h.home], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /has new keys/);
  assert.match(out.stdout, /Desk computer \(computer\)/);
  // A mistyped home: nothing is made there.
  const missing = spawnSync(process.execPath, [join(ROOT, 'scripts/rotate-hub-keys.js'), join(h.home, 'nowhere')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /weren’t replaced: .*no keys/);
  assert.equal(existsSync(join(h.home, 'nowhere')), false);
});
