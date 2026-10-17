// Node-side scheduling (docs/21 §7): concurrency limit, bounded queue, cancellation and the
// buffer between job submission and stream attachment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, StreamEvent } from '@nova/providers';
import { JobManager, type ChatJobRequest } from '../src/index.ts';

const REQ: ChatJobRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

/** A run function whose jobs finish only when released (or aborted). */
function gated() {
  const gates: { release: () => void; signal: AbortSignal }[] = [];
  const run = async function* (req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'start', messageId: 'x', model: req.model };
    await new Promise<void>((resolve) => {
      gates.push({ release: resolve, signal: req.signal });
      req.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'stop', reason: 'end' };
  };
  return { run, gates };
}

function collectInto(jobs: JobManager, id: string): StreamEvent[] {
  const out: StreamEvent[] = [];
  const detach = jobs.attach(id, (e) => out.push(e));
  expect(detach).not.toBeNull();
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  vi.useRealTimers();
});

describe('JobManager', () => {
  it('runs up to the limit, queues the rest in order and refuses beyond the queue', async () => {
    const { run, gates } = gated();
    const jobs = new JobManager({ run, maxConcurrentJobs: 1, maxQueue: 1 });
    const a = jobs.submit(REQ);
    const b = jobs.submit(REQ);
    expect(jobs.load()).toEqual({ running: 1, queued: 1 });
    expect(() => jobs.submit(REQ)).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    const ea = collectInto(jobs, a);
    const eb = collectInto(jobs, b);
    await tick();
    gates[0]!.release();
    await tick();
    expect(ea.map((e) => e.type)).toEqual(['start', 'text_delta', 'stop']);
    expect(jobs.load()).toEqual({ running: 1, queued: 0 });
    gates[1]!.release();
    await tick();
    expect(eb.at(-1)).toEqual({ type: 'stop', reason: 'end' });
    expect(jobs.load()).toEqual({ running: 0, queued: 0 });
    expect(jobs.has(a)).toBe(false);
  });

  it('buffers events until the stream attaches, then delivers them', async () => {
    const { run, gates } = gated();
    const jobs = new JobManager({ run });
    const id = jobs.submit(REQ);
    await tick();
    gates[0]!.release();
    await tick();
    const out = collectInto(jobs, id);
    expect(out.map((e) => e.type)).toEqual(['start', 'text_delta', 'stop']);
    expect(jobs.attach(id, () => undefined)).toBeNull();
  });

  it('cancels a running job by aborting its backend request', async () => {
    const { run, gates } = gated();
    const jobs = new JobManager({ run });
    const id = jobs.submit(REQ);
    const out = collectInto(jobs, id);
    await tick();
    expect(jobs.cancel(id)).toBe(true);
    await tick();
    expect(gates[0]!.signal.aborted).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
    expect(jobs.cancel(id)).toBe(false);
  });

  it('cancels a queued job without running it', () => {
    const { run } = gated();
    const jobs = new JobManager({ run, maxQueue: 2 });
    jobs.submit(REQ);
    const queued = jobs.submit(REQ);
    expect(jobs.cancel(queued)).toBe(true);
    expect(jobs.load()).toEqual({ running: 1, queued: 0 });
    expect(collectInto(jobs, queued)).toEqual([{ type: 'stop', reason: 'cancelled' }]);
  });

  it('cancels a job when its consumer detaches before the end', async () => {
    const { run, gates } = gated();
    const jobs = new JobManager({ run });
    const id = jobs.submit(REQ);
    const detach = jobs.attach(id, () => undefined)!;
    await tick();
    detach();
    await tick();
    expect(gates[0]!.signal.aborted).toBe(true);
    expect(jobs.load().running).toBe(0);
  });

  it('cancels a job nobody streams in time', async () => {
    vi.useFakeTimers();
    const { run, gates } = gated();
    const jobs = new JobManager({ run, attachTimeoutMs: 1_000, retainMs: 1_000 });
    const id = jobs.submit(REQ);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gates[0]!.signal.aborted).toBe(true);
    // The finished job is kept briefly for a late stream, then forgotten.
    expect(jobs.has(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(jobs.has(id)).toBe(false);
  });

  it('reports a backend that ends without stop, and refuses jobs after close', async () => {
    const run = async function* (): AsyncIterable<StreamEvent> {
      await Promise.resolve();
      yield { type: 'text_delta', text: 'partial' };
    };
    const jobs = new JobManager({ run });
    const id = jobs.submit(REQ);
    const out = collectInto(jobs, id);
    await tick();
    expect(out.at(-1)).toMatchObject({ type: 'stop', reason: 'error' });
    jobs.close();
    expect(() => jobs.submit(REQ)).toThrow(expect.objectContaining({ code: 'node_unavailable' }));
  });
});
