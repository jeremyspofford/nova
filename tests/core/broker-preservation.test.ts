// Narrowed final review: normal public-fixture behavior only. No held-value reads or output uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker, stopBroker } from '../../src/broker/spawn.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { Person } from '../support/broker-support.ts';
import { createCore, ensureMark, Vault } from '../../src/core/index.ts';
import { supervisorResetPending } from '../../src/core/resilience/reset.ts';
import { finishStaged, writeStaged, dropStaged } from '../../src/core/resilience/checkpoints.ts';
import { NightlyBackups } from '../../src/core/resilience/backup.ts';

const fixture = () => mkdtempSync(join(tmpdir(), 'nova-final-functional-'));
const publicValue = 'PUBLIC-FUNCTIONAL-FIXTURE-NOT-A-CREDENTIAL';
const coreAt = (home: string) => { ensureMark(home); return createCore({ home, version: '0.1.0', trustedOrigin: () => true, sandbox: true, vault: { mode: 'file', keychain: null } }); };

test('F02 normal binding narrowing advances the revocation generation', async () => {
  const root = fixture(), dir = join(root, 'broker');
  const b = await startBroker(dir, { keyMode: 'file', pipe: true });
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  try {
    const p = new Person((m, f = {}) => client.call(m, f)); await p.setup();
    const target = { kind: 'http', origin: 'https://example.test' };
    const binding = { target, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' } };
    const made = await p.approve('create', { meta: { name: 'test/PUBLIC', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [binding] }, { seal: publicValue, sealAt: (f, sealed) => ({ ...f, source: { sealed } }) });
    assert.equal(made.ok, true);
    // Observe only non-secret generation metadata. No old files are restored or opened.
    const generation = () => JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')).gen as number;
    const before = generation();
    const changed = await p.approve('bind', { ref: made.ref, add: { ...binding, scope: { methods: ['GET'], paths: ['/public'] } } });
    assert.equal(changed.ok, true); assert.deepEqual(changed.bindings[0].scope.paths, ['/public']);
    const after = generation();
    assert.equal((await client.bind(made.ref, { remove: { target } })).ok, true);
    const removed = generation();
    assert.equal(removed, after + 1, 'positive control: normal removal does advance generation');
    console.log(JSON.stringify({ control: 'F02', before, narrowed: after, removed, narrowingApplied: true }));
    assert.equal(after, before + 1, 'normal narrowing must rotate under C7');
  } finally { client.close(); await stopBroker(b); rmSync(root, { recursive: true, force: true }); }
});

test('F03 standby reset preserves broker ownership until supervisor cleanup', async () => {
  const root = fixture(), home = join(root, 'home'), c = coreAt(home);
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file', pipe: true });
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  try {
    assert.equal((await client.listRefs()).ok, true, 'positive control: actual broker ready');
    writeFileSync(join(home, 'person-file.txt'), 'PUBLIC PERSON FILE');
    const before = existsSync(join(home, 'broker/device.json'));
    await c.reset.standbyWipe({ id: 'public-functional-reset', said: 'PUBLIC RESET NOTICE' });
    const after = existsSync(join(home, 'broker/device.json'));
    const alive = b.child.exitCode === null && b.child.signalCode === null;
    const pending = supervisorResetPending(home);
    assert.equal(readFileSync(join(home, 'person-file.txt'), 'utf8'), 'PUBLIC PERSON FILE');
    console.log(JSON.stringify({ control: 'F03', recordBefore: before, recordAfter: after, brokerStillRunning: alive, pendingReset: !!pending, pendingBrokerCleanup: pending?.broker }));
    assert.equal(pending?.broker, true, 'supervisor must still see its pending exact-account cleanup');
    assert.equal(after, true, 'device identity must survive until its owner stops and removes exact keys');
  } finally { client.close(); await stopBroker(b); await c.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const interrupted of [false, true]) test(`F04 ${interrupted ? 'resumed' : 'normal'} cold restore preserves local broker storage`, async () => {
  const root = fixture(), home = join(root, 'home'), target = join(root, 'backups'); mkdirSync(target, { mode: 0o700 });
  const c = coreAt(home);
  let closed = false;
  try {
    // Entirely public marker files; no credential or key bytes are read by this control.
    mkdirSync(join(home, 'broker/items'), { recursive: true });
    writeFileSync(join(home, 'broker/public-local-marker'), 'PUBLIC LOCAL STORE');
    writeFileSync(join(home, 'broker/items/public-fixture.json'), 'PUBLIC BACKUP ITEM');
    const backup = new NightlyBackups({ db: c.db, log: c.log, home, version: '0.1.0', settings: () => ({ target, keep: 2, encrypted_target: null }), key: () => Buffer.alloc(32, 1), seal: () => Buffer.alloc(32, 2) }).run();
    assert.ok(backup.manifest.files.some(f => f.path === 'broker/items/public-fixture.json'));
    assert.ok(!backup.manifest.files.some(f => f.path === 'broker/public-local-marker'));
    c.restarter.attach(async () => ({}), { exec: () => { throw new Error('control never requests process replacement'); } });
    c.checkpoints.stageCold(backup.path!, { node: 'public-node', floor: 2, promotion: 'public-promotion', backup: { id: backup.id, seq: backup.seq, at: backup.at, path: backup.path! }, by: 'public-review' });
    await c.close(); closed = true;
    if (interrupted) assert.throws(() => finishStaged(home, { vaultAt: h => new Vault({ home: h, mode: 'file', keychain: null }), interrupt: (_step, what) => { if (what === 'in') throw new Error('public fixture interruption'); } }), /public fixture interruption/);
    const finished = finishStaged(home, { vaultAt: h => new Vault({ home: h, mode: 'file', keychain: null }) });
    assert.ok(finished.restored, 'positive control: ordinary cold restore completes');
    const localKept = existsSync(join(home, 'broker/public-local-marker'));
    const backupItem = existsSync(join(home, 'broker/items/public-fixture.json'));
    console.log(JSON.stringify({ control: 'F04', restoreCompleted: true, incomingNamesContainBroker: finished.restored.names.includes('broker'), localKept, backupItem, problems: finished.problems }));
    assert.equal(localKept, true, 'broker is STAYS and must retain its local identity/storage');
  } finally { if (!closed) await c.close(); rmSync(root, { recursive: true, force: true }); }
});

// Public legacy staging fixtures exercise the entry-selection boundary on restart, not broker
// adoption. writeStaged computes the real file hashes; only the crash-progress state is supplied.
for (const progress of ['carried', 'swapping', 'old-preserved', 'old-no-marker']) test(`FR3 legacy ${progress} staging never overwrites or discards preserved storage`, async () => {
  const root = fixture(), home = join(root, 'home'), c = coreAt(home);
  let closed = false;
  const staging = join(home, 'checkpoints/.restore'), neu = join(staging, 'new');
  try {
    mkdirSync(join(home, 'broker'), { recursive: true });
    writeFileSync(join(home, 'broker/public-local'), 'PUBLIC LOCAL');
    mkdirSync(join(neu, 'broker'), { recursive: true });
    writeFileSync(join(neu, 'broker/public-incoming'), 'PUBLIC INCOMING');
    mkdirSync(join(neu, 'workspace'), { recursive: true });
    writeFileSync(join(neu, 'workspace/public-restored'), 'PUBLIC RESTORED');
    const marker = writeStaged(home, { id: 'public-legacy-restore', at: new Date().toISOString(), checkpoint: { id: 'public-checkpoint', label: 'Public legacy fixture', at: new Date().toISOString(), kind: 'auto' }, before: 'public-before', verified: { db: 'public', files: 2, bytes: 1, seal: '' } });
    Object.assign(marker, { state: progress === 'carried' ? 'carried' : 'swapping', ready: marker.files, had: [] });
    writeFileSync(join(staging, 'marker.json'), JSON.stringify(marker));
    await c.close(); closed = true;
    if (progress.startsWith('old-')) {
      mkdirSync(join(staging, 'old/broker'), { recursive: true });
      writeFileSync(join(staging, 'old/broker/public-retained'), 'PUBLIC RETAINED');
      if (progress === 'old-no-marker') rmSync(join(staging, 'marker.json'));
      assert.throws(() => dropStaged(home), /preserved.*recovery/i);
      assert.throws(() => finishStaged(home), /preserved.*recovery/i);
      assert.equal(readFileSync(join(staging, 'old/broker/public-retained'), 'utf8'), 'PUBLIC RETAINED');
      assert.equal(existsSync(join(staging, 'marker.json')), progress !== 'old-no-marker');
    } else {
      assert.ok(finishStaged(home).restored);
      assert.equal(readFileSync(join(home, 'workspace/public-restored'), 'utf8'), 'PUBLIC RESTORED');
    }
    assert.equal(readFileSync(join(home, 'broker/public-local'), 'utf8'), 'PUBLIC LOCAL');
    assert.equal(existsSync(join(home, 'broker/public-incoming')), false);
  } finally { if (!closed) await c.close(); rmSync(root, { recursive: true, force: true }); }
});
