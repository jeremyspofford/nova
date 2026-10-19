// Redaction away from the main process (FR-214): jobs go to a worker process; one that does not
// answer in time is killed (it may be stuck in a pattern) and the job fails, so the capture keeps
// no text rather than unredacted text. The next job starts a fresh worker.
import { fork } from 'node:child_process';
import type { RedactJob, RedactResult } from './redact.ts';

/** A worker process as the service sees it (Electron's utilityProcess, or a forked child). */
export interface WorkerChannel {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

export class RedactTimeout extends Error {
  constructor() {
    super('redaction did not finish in time');
    this.name = 'RedactTimeout';
  }
}

interface Pending {
  resolve(r: RedactResult): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  worker: WorkerChannel;
}

export class IsolatedRedactor {
  readonly #spawn: () => WorkerChannel;
  readonly #timeoutMs: number;
  #worker: WorkerChannel | null = null;
  readonly #pending = new Map<number, Pending>();
  #seq = 0;

  constructor(spawn: () => WorkerChannel, opts: { timeoutMs?: number } = {}) {
    this.#spawn = spawn;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** Fail the jobs a worker held (all of them without `worker`). */
  #fail(err: Error, worker?: WorkerChannel): void {
    for (const [id, p] of this.#pending) {
      if (worker && p.worker !== worker) continue;
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  #channel(): WorkerChannel {
    if (this.#worker) return this.#worker;
    const w = this.#spawn();
    w.onMessage((m) => {
      const msg = m as Partial<RedactResult> & { id?: unknown };
      const p = typeof msg.id === 'number' ? this.#pending.get(msg.id) : undefined;
      if (!p || typeof msg.id !== 'number') return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (typeof msg.title !== 'string' || !Array.isArray(msg.redactions))
        return p.reject(new Error('the redaction worker gave no result'));
      p.resolve({
        title: msg.title,
        text: typeof msg.text === 'string' ? msg.text : null,
        redactions: msg.redactions,
      });
    });
    w.onExit(() => {
      if (this.#worker === w) this.#worker = null;
      this.#fail(new Error('the redaction worker stopped'), w);
    });
    this.#worker = w;
    return w;
  }

  redact(job: RedactJob): Promise<RedactResult> {
    const id = ++this.#seq;
    const w = this.#channel();
    return new Promise<RedactResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stuck: stop it, fail everything it held; the next job gets a new worker.
        if (this.#worker === w) this.#worker = null;
        this.#pending.delete(id);
        reject(new RedactTimeout());
        w.kill();
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, worker: w });
      w.post({ id, title: job.title, text: job.text });
    });
  }

  close(): void {
    this.#fail(new Error('the redaction service closed'));
    this.#worker?.kill();
    this.#worker = null;
  }
}

/** The worker as a forked Node process (tests, and anything outside Electron). */
export function forkChannel(modulePath: string): WorkerChannel {
  const child = fork(modulePath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  return {
    post: (m) => {
      child.send(m as object);
    },
    onMessage: (l) => {
      child.on('message', l);
    },
    onExit: (l) => {
      child.once('exit', l);
    },
    kill: () => {
      child.kill('SIGKILL');
    },
  };
}
