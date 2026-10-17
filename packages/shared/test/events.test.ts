import { describe, expect, it, vi } from 'vitest';
import { EventBus, eventEnvelopeSchema, makeEvent, matches } from '../src/events.ts';
import { NovaError, httpStatusFor } from '../src/errors.ts';

describe('event envelope', () => {
  it('builds a valid envelope with defaults', () => {
    const e = makeEvent({ name: 'run.completed', payload: { runId: 'r1' } });
    expect(eventEnvelopeSchema.safeParse(e).success).toBe(true);
    expect(e.actor).toBe('system');
    expect(e.schemaVersion).toBe(1);
  });

  it('rejects bad names, actors and unknown fields', () => {
    const base = makeEvent({ name: 'chat.delta', payload: {} });
    expect(eventEnvelopeSchema.safeParse({ ...base, name: 'nodots' }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...base, actor: 'robot' }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...base, actor: 'agent:abc' }).success).toBe(true);
  });
});

describe('EventBus', () => {
  it('delivers by exact name, prefix and wildcard', () => {
    const bus = new EventBus();
    const exact = vi.fn();
    const prefix = vi.fn();
    const all = vi.fn();
    bus.subscribe('run.completed', exact);
    bus.subscribe('run.*', prefix);
    bus.subscribe('*', all);
    bus.publish(makeEvent({ name: 'run.completed', payload: {} }));
    bus.publish(makeEvent({ name: 'run.step.started', payload: {} }));
    bus.publish(makeEvent({ name: 'chat.delta', payload: {} }));
    expect(exact).toHaveBeenCalledTimes(1);
    expect(prefix).toHaveBeenCalledTimes(2);
    expect(all).toHaveBeenCalledTimes(3);
  });

  it('isolates a throwing handler and supports unsubscribe', () => {
    const errors: unknown[] = [];
    const bus = new EventBus((err) => errors.push(err));
    const good = vi.fn();
    bus.subscribe('x.y', () => {
      throw new Error('boom');
    });
    const off = bus.subscribe('x.y', good);
    bus.publish(makeEvent({ name: 'x.y', payload: {} }));
    expect(good).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    off();
    bus.publish(makeEvent({ name: 'x.y', payload: {} }));
    expect(good).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(1);
  });

  it('matches patterns precisely', () => {
    expect(matches('run.*', 'runner.x')).toBe(false);
    expect(matches('run.*', 'run.x')).toBe(true);
  });
});

describe('NovaError', () => {
  it('serializes to the wire shape and maps HTTP status', () => {
    const e = new NovaError('rate_limited', 'slow down', { details: { retryAfter: 3 } });
    expect(e.toJSON()).toEqual({
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
      details: { retryAfter: 3 },
    });
    expect(httpStatusFor('not_found')).toBe(404);
    expect(httpStatusFor('timeout')).toBe(500);
    expect(new NovaError('validation', 'bad').retryable).toBe(false);
  });
});
