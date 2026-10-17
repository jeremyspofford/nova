// Job scheduling on the node (docs/21 §7: the node enforces its own limits). At most
// `maxConcurrentJobs` run at once; up to `maxQueue` more wait in order; beyond that a job is
// refused (`rate_limited`). Each job's events are buffered until the Hub attaches its stream, so
// the submit and stream calls may race. A cancelled job aborts its backend request.
import { randomUUID } from 'node:crypto';
import type { ChatRequest, StreamEvent } from '@nova/providers';
import { NovaError } from '@nova/shared';

export type RunJob = (req: ChatRequest) => AsyncIterable<StreamEvent>;
export type ChatJobRequest = Omit<ChatRequest, 'signal'>;

export interface JobManagerOptions {
  run: RunJob;
  maxConcurrentJobs?: number;
  maxQueue?: number;
  /** A job nobody streams within this time is cancelled (default 30 s). */
  attachTimeoutMs?: number;
  /** A finished job is forgotten after this time if nobody streamed it (default 60 s). */
  retainMs?: number;
}

type Listener = (e: StreamEvent) => void;

interface Job {
  id: string;
  request: ChatJobRequest;
  state: 'queued' | 'running' | 'done';
  controller: AbortController;
  events: StreamEvent[];
  listener: Listener | null;
  attached: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class JobManager {
  readonly maxConcurrentJobs: number;
  readonly maxQueue: number;
  readonly #run: RunJob;
  readonly #attachMs: number;
  readonly #retainMs: number;
  readonly #jobs = new Map<string, Job>();
  readonly #queue: Job[] = [];
  #running = 0;
  #closed = false;

  constructor(opts: JobManagerOptions) {
    this.#run = opts.run;
    this.maxConcurrentJobs = Math.max(1, opts.maxConcurrentJobs ?? 1);
    this.maxQueue = Math.max(0, opts.maxQueue ?? 4);
    this.#attachMs = opts.attachTimeoutMs ?? 30_000;
    this.#retainMs = opts.retainMs ?? 60_000;
  }

  load(): { running: number; queued: number } {
    return { running: this.#running, queued: this.#queue.length };
  }

  /** Accept a job, or throw `rate_limited` when the node is full. */
  submit(request: ChatJobRequest): string {
    if (this.#closed) throw new NovaError('node_unavailable', 'the node is shutting down');
    if (this.#running >= this.maxConcurrentJobs && this.#queue.length >= this.maxQueue) {
      throw new NovaError('rate_limited', 'the node is busy; try again shortly', {
        details: { ...this.load(), maxConcurrentJobs: this.maxConcurrentJobs },
      });
    }
    const job: Job = {
      id: randomUUID(),
      request,
      state: 'queued',
      controller: new AbortController(),
      events: [],
      listener: null,
      attached: false,
      timer: null,
    };
    this.#jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      if (!job.attached) this.cancel(job.id);
    }, this.#attachMs);
    job.timer.unref();
    if (this.#running < this.maxConcurrentJobs) this.#start(job);
    else this.#queue.push(job);
    return job.id;
  }

  /**
   * Attach the one consumer of a job: buffered events are delivered at once, then live ones until
   * `stop`. Returns a detach function, or null for an unknown or already attached job.
   */
  attach(id: string, listener: Listener): (() => void) | null {
    const job = this.#jobs.get(id);
    if (!job || job.attached) return null;
    job.attached = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    for (const e of job.events) listener(e);
    job.events = [];
    if (job.state === 'done') {
      this.#jobs.delete(id);
      return () => undefined;
    }
    job.listener = listener;
    return () => {
      job.listener = null;
      // The Hub went away before the job finished: stop it (FR-126, ADR-089).
      if (job.state !== 'done') this.cancel(id);
      this.#jobs.delete(id);
    };
  }

  /** Cancel a job; true when it existed and had not finished. */
  cancel(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job || job.state === 'done') return false;
    if (job.state === 'queued') {
      const i = this.#queue.indexOf(job);
      if (i >= 0) this.#queue.splice(i, 1);
      this.#finish(job, { type: 'stop', reason: 'cancelled' });
      return true;
    }
    job.controller.abort();
    return true;
  }

  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  /** Cancel everything and refuse new jobs. */
  close(): void {
    this.#closed = true;
    for (const id of [...this.#jobs.keys()]) this.cancel(id);
  }

  #start(job: Job): void {
    job.state = 'running';
    this.#running++;
    void this.#drive(job).finally(() => {
      this.#running--;
      const next = this.#queue.shift();
      if (next) this.#start(next);
    });
  }

  async #drive(job: Job): Promise<void> {
    let stopped = false;
    try {
      const req: ChatRequest = { ...job.request, signal: job.controller.signal };
      for await (const e of this.#run(req)) {
        if (e.type === 'stop') {
          stopped = true;
          this.#finish(job, e);
          return;
        }
        this.#emit(job, e);
      }
    } catch {
      // The adapter never throws; this guards a misbehaving backend wrapper.
    }
    if (!stopped) {
      this.#finish(
        job,
        job.controller.signal.aborted
          ? { type: 'stop', reason: 'cancelled' }
          : {
              type: 'stop',
              reason: 'error',
              error: {
                code: 'provider_error',
                message: 'The backend ended early',
                retryable: true,
              },
            },
      );
    }
  }

  #emit(job: Job, e: StreamEvent): void {
    if (job.listener) job.listener(e);
    else job.events.push(e);
  }

  #finish(job: Job, stop: StreamEvent): void {
    if (job.state === 'done') return;
    job.state = 'done';
    this.#emit(job, stop);
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (job.attached) {
      this.#jobs.delete(job.id);
    } else {
      job.timer = setTimeout(() => this.#jobs.delete(job.id), this.#retainMs);
      job.timer.unref();
    }
  }
}
