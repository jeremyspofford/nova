// Shared harness for the scheduler tests: a simulated clock with timers, a fake RunStarter whose
// runs finish when the test says so, and a database with an owner account.
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  NotificationService,
  ScheduleService,
  type AuditRecord,
  type CreateRunInput,
  type RunFinish,
  type RunStarter,
  type ScheduleServiceOptions,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';

export class FakeClock {
  t: number;
  #seq = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];

  constructor(start: string) {
    this.t = Date.parse(start);
  }

  now = (): Date => new Date(this.t);

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };

  /** Move time forward, firing each timer at its moment and letting the service settle. */
  async advanceTo(target: string | number, svc: ScheduleService): Promise<void> {
    const end = typeof target === 'number' ? target : Date.parse(target);
    for (;;) {
      await svc.idle();
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = Math.max(this.t, end);
    await svc.idle();
  }

  /** Jump without running timers in between (the machine slept), then let late timers fire. */
  async sleepUntil(target: string, svc: ScheduleService): Promise<void> {
    this.t = Date.parse(target);
    await this.advanceTo(this.t, svc);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeRuns implements RunStarter {
  created: CreateRunInput[] = [];
  watched: string[] = [];
  failWith: Error | null = null;
  readonly #finishes = new Map<string, Deferred<RunFinish>>();

  createRun(input: CreateRunInput): Promise<{ runId: string; threadId: string }> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.created.push(input);
    const n = this.created.length;
    return Promise.resolve({ runId: `run-${n}`, threadId: `thread-${n}` });
  }

  whenFinished(_accountId: string, runId: string): Promise<RunFinish> {
    this.watched.push(runId);
    return this.#get(runId).promise;
  }

  finish(
    runId: string,
    status: RunFinish['status'] = 'done',
    summary: string | null = 'All good',
  ): void {
    this.#get(runId).resolve({ runId, status, summary, artifactIds: [] });
  }

  crash(runId: string, err: Error): void {
    this.#get(runId).reject(err);
  }

  #get(runId: string): Deferred<RunFinish> {
    let d = this.#finishes.get(runId);
    if (!d) {
      d = deferred<RunFinish>();
      // An unfinished run must not be an unhandled rejection when a test ends.
      d.promise.catch(() => undefined);
      this.#finishes.set(runId, d);
    }
    return d;
  }
}

export interface Harness {
  db: NovaDatabase;
  clock: FakeClock;
  runs: FakeRuns;
  events: MemoryEventSink;
  secrets: MemorySecretStore;
  audit: AuditRecord[];
  notifications: NotificationService;
  svc: ScheduleService;
  /** A second service on the same database (a restart). */
  restart: (over?: Partial<ScheduleServiceOptions>) => Promise<ScheduleService>;
  close: () => Promise<void>;
}

export async function makeHarness(
  start: string,
  over: Partial<ScheduleServiceOptions> = {},
): Promise<Harness> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, start, start);
  const clock = new FakeClock(start);
  const runs = new FakeRuns();
  const events = new MemoryEventSink();
  const secrets = new MemorySecretStore();
  const audit: AuditRecord[] = [];
  const notifications = new NotificationService({ db, now: clock.now });
  const services: ScheduleService[] = [];
  const build = (o: Partial<ScheduleServiceOptions>) => {
    const svc = new ScheduleService({
      db,
      events,
      secrets,
      audit: { append: (r) => (audit.push(r as AuditRecord), Promise.resolve()) },
      notifier: notifications,
      now: clock.now,
      timers: clock,
      ...over,
      ...o,
    });
    services.push(svc);
    return svc;
  };
  const svc = build({});
  svc.useRuns(runs);
  await svc.start();
  return {
    db,
    clock,
    runs,
    events,
    secrets,
    audit,
    notifications,
    svc,
    restart: async (o = {}) => {
      const next = build(o);
      next.useRuns(runs);
      await next.start();
      return next;
    },
    close: async () => {
      for (const s of services) await s.stop();
      db.close();
    },
  };
}
