// The companion's state machine (FR-012): thread status drives thinking and waiting, run and
// turn outcomes give a short reaction, Keep still always rests. Time is passed in.
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@nova/shared';
import {
  REACTION_MS,
  initialPet,
  petEventOf,
  petReducer,
  petState,
  type PetEvent,
  type PetModel,
} from '../src/pets/state.ts';

const run = (events: PetEvent[], from: PetModel = initialPet) => events.reduce(petReducer, from);
const status = (ref: string, s: 'running' | 'needs_input' | 'ready' | 'blocked', at = 0) =>
  ({ type: 'status', ref, status: s, at }) as const;

function env(name: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    id: 'e1',
    name,
    schemaVersion: 1,
    ts: '2026-10-01T12:00:00.000Z',
    actor: 'system',
    payload,
  };
}

describe('petReducer and petState', () => {
  it('thinks while any thread runs, waits when one needs input, else rests', () => {
    let m = run([status('a', 'needs_input')]);
    expect(petState(m, false)).toBe('waiting');
    m = run([status('b', 'running')], m);
    expect(petState(m, false)).toBe('thinking');
    m = run([status('b', 'ready')], m);
    expect(petState(m, false)).toBe('waiting');
    m = run([status('a', 'blocked')], m);
    expect(petState(m, false)).toBe('idle');
    expect(m.busy).toEqual({});
  });

  it('reacts to an outcome for a while, then returns to what it was doing', () => {
    const t = 1_000;
    let m = run([status('a', 'running', t), { type: 'outcome', ok: true, at: t + 10 }]);
    expect(petState(m, false)).toBe('success');
    // Before the end, a tick changes nothing (and keeps the same model).
    const before = m;
    m = petReducer(m, { type: 'tick', at: t + 10 + REACTION_MS - 1 });
    expect(m).toBe(before);
    expect(petState(m, false)).toBe('success');
    m = petReducer(m, { type: 'tick', at: t + 10 + REACTION_MS });
    expect(petState(m, false)).toBe('thinking');
    m = petReducer(m, { type: 'outcome', ok: false, at: t + 5_000 });
    expect(petState(m, false)).toBe('error');
    // Any later event past the end clears it too.
    m = petReducer(m, status('a', 'ready', t + 5_000 + REACTION_MS + 1));
    expect(petState(m, false)).toBe('idle');
  });

  it('always rests when muted', () => {
    const m = run([status('a', 'running'), { type: 'outcome', ok: false, at: 0 }]);
    expect(petState(m, true)).toBe('idle');
  });
});

describe('petEventOf', () => {
  it('reads thread status, run and turn outcomes', () => {
    expect(
      petEventOf(
        env('thread.status.changed', { ref: { kind: 'run', id: 'r1' }, status: 'running' }),
        5,
      ),
    ).toEqual({ type: 'status', ref: 'run:r1', status: 'running', at: 5 });
    expect(petEventOf(env('run.completed', { runId: 'r1', status: 'done' }), 5)).toEqual({
      type: 'outcome',
      ok: true,
      at: 5,
    });
    expect(petEventOf(env('run.completed', { status: 'output_missing' }), 5)).toMatchObject({
      ok: false,
    });
    expect(petEventOf(env('run.completed', { status: 'failed' }), 5)).toMatchObject({ ok: false });
    expect(petEventOf(env('turn.completed', { status: 'failed' }), 5)).toMatchObject({ ok: false });
  });

  it('ignores what does not change the mood', () => {
    expect(petEventOf(env('run.completed', { status: 'cancelled' }), 1)).toBeNull();
    expect(petEventOf(env('turn.completed', { status: 'completed' }), 1)).toBeNull();
    expect(petEventOf(env('thread.status.changed', { ref: {}, status: 'running' }), 1)).toBeNull();
    expect(
      petEventOf(
        env('thread.status.changed', { ref: { kind: 'chat', id: 't' }, status: 'odd' }),
        1,
      ),
    ).toBeNull();
    expect(petEventOf(env('run.created', {}), 1)).toBeNull();
  });
});
