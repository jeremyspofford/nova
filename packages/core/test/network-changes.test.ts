// The network change log (docs/22 §9.5, §6 step 8): record with a serializable undo, last applied
// change, rollback through the kind's handler (newest first), and its failures.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type NetworkChangeView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { NetworkChangeLog } from '../src/index.ts';
import { ACCOUNT, networkDb } from './network-env.ts';

let db: NovaDatabase;
let log: NetworkChangeLog;
let clock: { now: number };
let seen: NetworkChangeView[];

beforeEach(async () => {
  db = await networkDb();
  clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  log = new NetworkChangeLog({ db, now: () => new Date((clock.now += 1_000)) });
  seen = [];
  log.onChange((c) => seen.push(c));
});

afterEach(() => db.close());

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err.code;
    throw err;
  }
  return 'ok';
}

describe('the network change log', () => {
  it('records changes and rolls back the newest applied one with its handler', async () => {
    const state: Record<string, unknown> = { mdns: false, url: 'https://hub.example' };
    const undone: unknown[] = [];
    log.registerUndo('network.settings', (undo) => {
      undone.push(undo);
      Object.assign(state, undo.settings as Record<string, unknown>);
      return Promise.resolve();
    });
    expect(await log.last()).toBeNull();
    const a = await log.record({
      kind: 'network.settings',
      summary: 'Turned mDNS off',
      undo: { settings: { mdns: true } },
      accountId: ACCOUNT,
    });
    const b = await log.record({
      kind: 'network.settings',
      summary: 'Set the public URL',
      undo: { settings: { url: null } },
      actor: 'agent:x',
    });
    expect(a).toMatchObject({
      kind: 'network.settings',
      status: 'applied',
      actor: 'user',
      error: null,
    });
    expect(b.actor).toBe('agent:x');
    expect((await log.last())?.id).toBe(b.id);
    expect((await log.list()).map((c) => c.id)).toEqual([b.id, a.id]);
    const r = await log.rollback(b.id);
    expect(r).toMatchObject({ id: b.id, status: 'rolled_back' });
    expect(r.rolledBackAt).not.toBeNull();
    expect(state.url).toBeNull();
    // The next rollback reverts the one before.
    expect((await log.last())?.id).toBe(a.id);
    await log.rollback(a.id);
    expect(state.mdns).toBe(true);
    expect(await log.last()).toBeNull();
    expect(undone).toEqual([{ settings: { url: null } }, { settings: { mdns: true } }]);
    expect(seen.map((c) => [c.summary, c.status])).toEqual([
      ['Turned mDNS off', 'applied'],
      ['Set the public URL', 'applied'],
      ['Set the public URL', 'rolled_back'],
      ['Turned mDNS off', 'rolled_back'],
    ]);
    expect((await log.get(a.id))?.status).toBe('rolled_back');
    expect(await log.get('nope')).toBeNull();
  });

  it('refuses unknown, already rolled back and unhandled changes; keeps a failed undo applied', async () => {
    expect(await code(log.rollback('nope'))).toBe('not_found');
    const c = await log.record({
      kind: 'setup.step',
      summary: 'Joined the mesh',
      undo: { step: 1 },
    });
    expect(await code(log.rollback(c.id))).toBe('capability_missing');
    let fail = true;
    const off = log.registerUndo('setup.step', () =>
      fail ? Promise.reject(new Error('the mesh CLI failed')) : Promise.resolve(),
    );
    await expect(log.rollback(c.id)).rejects.toThrow(/mesh CLI/);
    expect(await log.get(c.id)).toMatchObject({ status: 'applied', error: 'the mesh CLI failed' });
    fail = false;
    expect((await log.rollback(c.id)).error).toBeNull();
    expect(await code(log.rollback(c.id))).toBe('conflict');
    off();
    const d = await log.record({ kind: 'setup.step', summary: 'Again', undo: {} });
    expect(await code(log.rollback(d.id))).toBe('capability_missing');
    // A listener that throws never breaks a change.
    log.onChange(() => {
      throw new Error('listener');
    });
    await log.record({ kind: 'k', summary: 's', undo: {} });
    expect(await code(log.record({ kind: '', summary: 's', undo: {} }))).toBe('validation');
    expect(
      await code(log.record({ kind: 'k', summary: 's', undo: { big: 'x'.repeat(70_000) } })),
    ).toBe('validation');
    // A corrupt descriptor reaches the handler as an empty one.
    db.raw.prepare("UPDATE network_change SET undo_json = '{' WHERE id = ?").run(d.id);
    const got: unknown[] = [];
    log.registerUndo('setup.step', (u) => (got.push(u), Promise.resolve()));
    await log.rollback(d.id);
    expect(got).toEqual([{}]);
  });
});

describe('rollback in progress', () => {
  it('refuses a second rollback while one runs, then allows the next', async () => {
    let release: () => void = () => undefined;
    log.registerUndo('slow', () => new Promise<void>((r) => (release = r)));
    const a = await log.record({ kind: 'slow', summary: 'a', undo: {} });
    const b = await log.record({ kind: 'slow', summary: 'b', undo: {} });
    const first = log.rollback(b.id);
    await Promise.resolve();
    const err = await log.rollback(a.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NovaError);
    expect((err as NovaError).code).toBe('conflict');
    expect((err as NovaError).details).toMatchObject({ reason: 'rollback_in_progress' });
    release();
    expect((await first).status).toBe('rolled_back');
    const next = log.rollback(a.id);
    release();
    expect((await next).status).toBe('rolled_back');
  });
});
