// This device's offline copy (FR-109, FR-129, ADR-036): the client clock in the Hub's format; records
// sealed at rest under a non-extractable key (a wiped key wipes the copy); the first load by
// snapshot pages, then changes from the cursor, live on `sync.changed`; a reset (event, 409
// `replica_reset` or `cursor_ahead`) loads it again; revocation, a refused grant or a 401 wipe it;
// a session without the grant keeps none; a copy survives a restart.
import { afterEach, describe, expect, it } from 'vitest';
import { HLC_PATTERN } from '@nova/shared';
import { HybridClock, compareHlc, formatHlc, hlcMs, parseHlc } from '../src/replica/hlc.ts';
import { SyncEngine } from '../src/replica/engine.ts';
import { Replica } from '../src/replica/replica.ts';
import { SealedStore, Vault, indexedDbBackend, type Sealed } from '../src/replica/vault.ts';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import { FakeSyncHub, THIS_DEVICE, memoryKv, offlineSetup, settle } from './fakes-m7-sync.ts';

afterEach(() => {
  FakeEventSource.reset();
});

const session = (hub: FakeSyncHub) => ({
  accountId: hub.accountId,
  displayName: 'Sam',
  deviceId: hub.deviceId,
  scopes: hub.scopes,
});

/** Every sealed record's bytes, decoded as text (what someone reading the disk would see). */
function diskText(raw: ReturnType<typeof memoryKv>['raw']): string {
  const out: string[] = [];
  for (const [store, m] of raw)
    for (const v of m.values()) {
      if (store === 'keys') continue;
      const s = v as Sealed;
      out.push(new TextDecoder().decode(new Uint8Array(s.data)));
    }
  return out.join('\n');
}

async function loaded(hub = new FakeSyncHub().seed()) {
  const env = offlineSetup(hub);
  await env.runtime.engine.start(session(hub), true);
  return env;
}

describe('the client clock', () => {
  it('writes the Hub format, only moves forward and takes in other clocks', () => {
    let now = 1_760_000_000_000;
    const clock = new HybridClock({ node: THIS_DEVICE, now: () => now });
    const a = clock.tick();
    expect(a).toMatch(HLC_PATTERN);
    expect(a).toBe(`001760000000000-0000-${THIS_DEVICE}`);
    const b = clock.tick();
    expect(compareHlc(b, a)).toBe(1);
    expect(parseHlc(b)).toEqual({ pt: now, c: 1, node: THIS_DEVICE });
    now -= 5000; // the wall clock goes back: the clock does not
    expect(compareHlc(clock.tick(), b)).toBe(1);
    const remote = formatHlc({ pt: now + 60_000, c: 3, node: 'hub' });
    clock.receive(remote);
    expect(parseHlc(clock.tick())!.pt).toBe(now + 60_000);
    expect(hlcMs(remote)).toBe(now + 60_000);
    expect(hlcMs('nonsense')).toBeNull();
    const restarted = new HybridClock({ node: THIS_DEVICE, initial: clock.last(), now: () => 0 });
    expect(compareHlc(restarted.tick(), clock.last())).toBe(1);
  });
});

describe('sealed storage', () => {
  it('never stores plaintext, binds each record to its name, and wipes what a lost key sealed', async () => {
    const { kv, raw } = memoryKv();
    const vault = await Vault.create(kv, 'replica');
    const key = raw.get('keys')!.get('replica') as CryptoKey;
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
    const store = new SealedStore(kv, 'replica', vault);
    await store.put([['a', { secret: 'Trip planning' }]]);
    expect(diskText(raw)).not.toContain('Trip planning');
    expect(await store.get('a')).toEqual({ secret: 'Trip planning' });
    expect(store.bytes()).toBeGreaterThan(0);
    // A sealed record moved under another name does not open.
    raw.get('replica')!.set('b', raw.get('replica')!.get('a'));
    expect(await store.get('b')).toBeUndefined();
    expect([...(await store.all()).keys()]).toEqual(['a']);
    expect(raw.get('replica')!.has('b')).toBe(false);
    // Without its key, nothing opens: opening the copy wipes what is left.
    await kv.delete('keys', ['replica']);
    expect(await Replica.open(kv, false)).toBeNull();
    expect(raw.get('replica')!.size).toBe(0);
  });

  it('offers no store where the browser has no IndexedDB', () => {
    expect(indexedDbBackend()).toBeNull();
  });
});

describe('loading and following the copy', () => {
  it('loads every kind by snapshot pages, then follows the change feed from its cursor', async () => {
    const hub = new FakeSyncHub().seed();
    const env = offlineSetup(hub);
    await env.runtime.engine.start(session(hub), true);
    const { engine } = env.runtime;
    const r = engine.replica!;
    expect(engine.state()).toMatchObject({ phase: 'ready', granted: true, deviceId: THIS_DEVICE });
    expect(r.value('thread', 't1', 'title')).toBe('Trip planning');
    expect(r.list('message')).toHaveLength(2);
    expect(r.meta?.cursor).toBe(hub.cursor);
    expect(engine.state().counts).toMatchObject({ thread: 2, message: 2, project: 1, page: 1 });
    expect(engine.state().bytes).toBeGreaterThan(0);
    const pages = hub.requests.filter((q) => q.path.startsWith('/api/v1/sync/snapshot'));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.path).not.toContain('cursor');
    // Nothing on disk is readable.
    expect(diskText(env.kv.raw)).not.toMatch(/Trip planning|Where should we go|Boots/);

    hub.write('thread', 't1', { title: 'Lisbon trip' });
    hub.remove('page', 'pg1');
    await engine.pull();
    expect(r.value('thread', 't1', 'title')).toBe('Lisbon trip');
    expect(r.entity('page', 'pg1')).toBeNull();
    expect(r.meta?.cursor).toBe(hub.cursor);
    const since = hub.requests.filter((q) => q.path.startsWith('/api/v1/sync/changes')).at(-1);
    expect(since?.path).toMatch(/since=\d+/);
  });

  it('pulls on sync.changed from the event stream, and loads again on a reset', async () => {
    const hub = new FakeSyncHub().seed();
    const env = offlineSetup(hub);
    await env.api.session();
    const stop = env.runtime.start({ eventSource: fakeEventSource });
    await settle(() => env.runtime.engine.state().phase === 'ready');
    hub.onEvent = (name, payload) =>
      FakeEventSource.for('/api/v1/events/stream').emit(name, payload);
    hub.write('project', 'p1', { instructions: 'Answer in French.' });
    await settle(
      () =>
        env.runtime.engine.replica?.value('project', 'p1', 'instructions') === 'Answer in French.',
    );

    const snapshots = () =>
      hub.requests.filter((q) => q.path.startsWith('/api/v1/sync/snapshot')).length;
    const before = snapshots();
    hub.resetDevice(THIS_DEVICE);
    await settle(() => snapshots() > before && env.runtime.engine.state().phase === 'ready');
    expect(env.runtime.engine.replica?.value('thread', 't1', 'title')).toBe('Trip planning');
    stop();
  });

  it('loads again when the Hub refuses the cursor (replica_reset, cursor_ahead)', async () => {
    const env = await loaded();
    const { engine } = env.runtime;
    const hub = env.hub;
    hub.devices.get(THIS_DEVICE)!.resetAt = hub.iso();
    const count = () =>
      hub.requests.filter((q) => q.path.startsWith('/api/v1/sync/snapshot')).length;
    let before = count();
    await engine.pull();
    expect(count()).toBeGreaterThan(before);
    expect(engine.state().phase).toBe('ready');

    await engine.replica!.updateMeta({ cursor: hub.cursor + 50 });
    before = count();
    await engine.pull();
    expect(count()).toBeGreaterThan(before);
    expect(engine.replica!.meta?.cursor).toBe(hub.cursor);
  });
});

describe('ending the copy', () => {
  it('wipes the copy and its key when the Hub revokes this device', async () => {
    const env = await loaded();
    const stop = env.runtime.start({ eventSource: fakeEventSource });
    env.hub.onEvent = (name, payload) =>
      FakeEventSource.for('/api/v1/events/stream').emit(name, payload);
    env.hub.revoke(THIS_DEVICE, 'revoked');
    await settle(() => env.runtime.engine.state().phase === 'removed');
    expect(env.runtime.engine.state().reason).toMatch(/revoked this device/);
    expect(env.runtime.engine.replica).toBeNull();
    expect(env.kv.raw.get('keys')!.has('replica')).toBe(false);
    expect(env.kv.raw.get('replica')!.size).toBe(0);
    expect(env.kv.raw.get('meta')!.size).toBe(0);
    stop();
  });

  it('wipes it on a 401 and when the grant is taken away; pauses while sync is off', async () => {
    let env = await loaded();
    env.hub.signedIn = false;
    await env.runtime.engine.pull();
    expect(env.runtime.engine.state()).toMatchObject({ phase: 'removed', removal: 'signed_out' });
    expect(env.kv.raw.get('replica')!.size).toBe(0);

    env = await loaded();
    env.hub.scopes = ['local-runtime'];
    await env.runtime.engine.pull();
    expect(env.runtime.engine.state()).toMatchObject({
      phase: 'removed',
      removal: 'scope_removed',
    });

    env = await loaded();
    env.hub.syncEnabled = false;
    await env.runtime.engine.pull();
    expect(env.runtime.engine.state()).toMatchObject({ phase: 'paused' });
    expect(env.runtime.engine.replica).not.toBeNull();
  });

  it('keeps no copy for a session without the grant, and drops one left from before', async () => {
    const hub = new FakeSyncHub().seed();
    const env = offlineSetup(hub);
    await env.runtime.engine.start({ ...session(hub), deviceId: null, scopes: null }, true);
    expect(env.runtime.engine.state()).toMatchObject({ phase: 'off', granted: false });
    expect(env.kv.raw.get('keys')?.has('replica') ?? false).toBe(false);
    expect(hub.requests.some((q) => q.path.startsWith('/api/v1/sync/'))).toBe(false);

    await env.runtime.engine.start(session(hub), true);
    expect(env.runtime.engine.replica).not.toBeNull();
    await env.runtime.engine.start({ ...session(hub), scopes: ['local-runtime'] }, true);
    expect(env.runtime.engine.state().phase).toBe('off');
    expect(env.kv.raw.get('keys')!.has('replica')).toBe(false);
  });

  it('starts over for another device, and says when the browser cannot keep a copy', async () => {
    const env = await loaded();
    await env.runtime.engine.start({ ...session(env.hub), deviceId: 'another-device' }, false);
    expect(env.runtime.engine.state()).toMatchObject({ phase: 'loading' });
    expect(env.runtime.engine.replica).toBeNull();

    const hub = new FakeSyncHub().seed();
    const bare = new SyncEngine({
      kv: () => null,
      client: {
        syncSnapshot: hub.api.syncSnapshot,
        syncChanges: hub.api.syncChanges,
        syncPush: hub.api.syncPush,
      },
    });
    await bare.start(session(hub), true);
    expect(bare.state()).toMatchObject({ phase: 'unsupported' });
    expect(bare.state().reason).toMatch(/IndexedDB and WebCrypto/);
  });
});

describe('a copy across restarts', () => {
  it('opens the copy kept on this device without the Hub', async () => {
    const first = await loaded();
    const hub = first.hub;
    hub.down = true;
    const second = offlineSetup(hub, first.kv);
    const replica = await second.runtime.engine.restore();
    expect(replica?.value('thread', 't1', 'title')).toBe('Trip planning');
    expect(second.runtime.engine.state()).toMatchObject({ phase: 'ready', granted: true });
  });
});

describe('a grant that changes while the app is open', () => {
  it('loads the copy when the owner grants it, and keeps the removal notice when it goes', async () => {
    const hub = new FakeSyncHub().seed();
    hub.scopes = ['local-runtime'];
    const env = offlineSetup(hub);
    await env.api.session();
    const stop = env.runtime.start({ eventSource: fakeEventSource });
    await settle(() => env.runtime.engine.state().granted === false);
    hub.onEvent = (name, payload) =>
      FakeEventSource.for('/api/v1/events/stream').emit(name, payload);
    hub.scopes = ['local-runtime', 'offline-replica'];
    FakeEventSource.for('/api/v1/events/stream').emit('device.scopes.changed', {
      deviceId: THIS_DEVICE,
      scopes: hub.scopes,
    });
    await settle(() => env.runtime.engine.state().phase === 'ready');
    expect(env.runtime.engine.replica?.value('thread', 't1', 'title')).toBe('Trip planning');

    hub.revoke(THIS_DEVICE, 'scope_removed');
    FakeEventSource.for('/api/v1/events/stream').emit('device.scopes.changed', {
      deviceId: THIS_DEVICE,
      scopes: hub.scopes,
    });
    await settle(() => env.runtime.engine.state().phase === 'removed');
    await env.runtime.engine.start(
      { accountId: hub.accountId, displayName: 'Sam', deviceId: THIS_DEVICE, scopes: hub.scopes },
      true,
    );
    expect(env.runtime.engine.state()).toMatchObject({
      phase: 'removed',
      removal: 'scope_removed',
    });
    expect(env.kv.raw.get('replica')!.size).toBe(0);
    stop();
  });
});
