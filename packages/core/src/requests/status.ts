// The derived thread status (FR-215, docs/09 §9 "Thread status", docs/06: derived, never
// stored). One status per thread, in precedence order:
//   1. needs_input: an approval, a handed-off step or a server-to-client request is pending for
//      the thread or any child thread;
//   2. blocked: a mode's status source says so (budget reached, goal blocked, environment down,
//      stopped by auto-review) or the thread's last turn failed;
//   3. running: a turn is in progress for the thread or any child thread;
//   4. ready.
// Child threads (sub-agents) come from the registered sources. The service recomputes a thread
// when an approval, request, turn, run, goal or Code event names it (and its parent thread), and
// emits `thread.status.changed` when the status changed.
import type { DerivedStatus, EventEnvelope, EventHandler, StatusView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ThreadStatusSource } from '../runtime/types.ts';

/** Events after which a thread's status may have changed. */
export const STATUS_EVENTS = [
  'approval.*',
  'request.*',
  'turn.*',
  'run.*',
  'goal.*',
  'code.*',
  'review.breaker.tripped',
] as const;

const MAX_THREADS = 500;
const MAX_DEPTH = 3;
const MAX_CACHED = 5000;

export interface StatusEventSource {
  subscribe(pattern: string, handler: EventHandler): () => void;
}

export interface ThreadStatusServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  sources?: ThreadStatusSource[];
  log?: Logger;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export class ThreadStatusService {
  readonly #o: ThreadStatusServiceOptions;
  readonly #sources: ThreadStatusSource[] = [];
  readonly #known = new Map<string, DerivedStatus>();
  #chain: Promise<void> = Promise.resolve();
  #offs: (() => void)[] = [];

  constructor(opts: ThreadStatusServiceOptions) {
    this.#o = opts;
    this.#sources.push(...(opts.sources ?? []));
  }

  /** Register what modes know about blocked work and child threads (runs, Code sessions). */
  useSources(...sources: ThreadStatusSource[]): void {
    this.#sources.push(...sources);
  }

  /** The status of each thread (of this account); threads it does not know are `ready`. */
  async statusOf(
    accountId: string,
    threadIds: readonly string[],
  ): Promise<Map<string, StatusView>> {
    const ids = [...new Set(threadIds)].slice(0, MAX_THREADS);
    const out = new Map<string, StatusView>();
    if (!ids.length) return out;
    const descendants = await this.#descendants(accountId, ids);
    const all = [...new Set([...ids, ...[...descendants.values()].flat()])];
    const [waiting, running, failed, blocked] = await Promise.all([
      Promise.resolve(this.#waiting(accountId, all)),
      Promise.resolve(this.#running(all)),
      Promise.resolve(this.#lastTurnFailed(ids)),
      this.#blocked(accountId, ids),
    ]);
    for (const id of ids) {
      const kids = descendants.get(id) ?? [];
      const own = waiting.get(id);
      const child = kids.find((k) => waiting.has(k));
      let view: StatusView;
      if (own) view = { status: 'needs_input', reason: own };
      else if (child) view = { status: 'needs_input', reason: 'A sub-agent needs you' };
      else if (blocked.has(id)) view = { status: 'blocked', reason: blocked.get(id) ?? null };
      else if (failed.has(id)) view = { status: 'blocked', reason: 'Last turn failed' };
      else if (running.has(id) || kids.some((k) => running.has(k)))
        view = { status: 'running', reason: null };
      else view = { status: 'ready', reason: null };
      out.set(id, view);
    }
    return out;
  }

  /** Children of each thread from the sources, a few levels down (children cannot spawn). */
  async #descendants(accountId: string, ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!this.#sources.length) return out;
    for (const id of ids) {
      const seen = new Set<string>([id]);
      let frontier = [id];
      for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
        const next: string[] = [];
        for (const parent of frontier) {
          for (const source of this.#sources) {
            let kids: string[] = [];
            try {
              kids = await source.children(accountId, parent);
            } catch (err) {
              this.#o.log?.warn('thread status source failed', { err, threadId: parent });
            }
            for (const k of kids)
              if (!seen.has(k)) {
                seen.add(k);
                next.push(k);
              }
          }
        }
        frontier = next;
      }
      seen.delete(id);
      if (seen.size) out.set(id, [...seen]);
    }
    return out;
  }

  /** Threads with a pending approval, handed-off step or request: why they need input. */
  #waiting(accountId: string, ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    const raw = this.#o.db.raw;
    const approvals = raw
      .prepare(
        `SELECT thread_id, decision FROM approval
         WHERE account_id = ? AND status = 'pending' AND thread_id IN (${placeholders(ids.length)})
         ORDER BY created_at`,
      )
      .all(accountId, ...ids) as { thread_id: string; decision: string | null }[];
    for (const a of approvals)
      if (!out.has(a.thread_id))
        out.set(a.thread_id, a.decision === 'handoff' ? 'Your turn' : 'Approval needed');
    let requests: { thread_id: string; kind: string }[] = [];
    try {
      requests = raw
        .prepare(
          `SELECT thread_id, kind FROM server_request
           WHERE account_id = ? AND status = 'pending' AND thread_id IN (${placeholders(ids.length)})
           ORDER BY created_at`,
        )
        .all(accountId, ...ids) as { thread_id: string; kind: string }[];
    } catch (err) {
      // Before migration 0019 there are no requests to wait for.
      this.#o.log?.debug('server requests unavailable for the status', { err });
    }
    for (const r of requests)
      if (!out.has(r.thread_id))
        out.set(r.thread_id, r.kind === 'user_input' ? 'Question for you' : 'Waiting for you');
    return out;
  }

  #running(ids: readonly string[]): Set<string> {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT DISTINCT thread_id FROM turn
         WHERE status = 'in_progress' AND thread_id IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as { thread_id: string }[];
    return new Set(rows.map((r) => r.thread_id));
  }

  #lastTurnFailed(ids: readonly string[]): Set<string> {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT t.thread_id AS thread_id FROM turn t
         WHERE t.thread_id IN (${placeholders(ids.length)}) AND t.status = 'failed'
           AND t.idx = (SELECT MAX(u.idx) FROM turn u WHERE u.thread_id = t.thread_id)`,
      )
      .all(...ids) as { thread_id: string }[];
    return new Set(rows.map((r) => r.thread_id));
  }

  async #blocked(accountId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const source of this.#sources) {
      try {
        for (const [id, reason] of await source.blocked(accountId, [...ids]))
          if (!out.has(id)) out.set(id, reason);
      } catch (err) {
        // A failing source hides what it knows; the status never blocks on it.
        this.#o.log?.warn('thread status source failed', { err });
      }
    }
    return out;
  }

  // ---- change events ----------------------------------------------------------------------

  /** Recompute on the events that can change a status; returns the unsubscribe. */
  start(bus: StatusEventSource): () => void {
    this.#offs.push(
      ...STATUS_EVENTS.map((p) =>
        bus.subscribe(p, (e) => {
          this.#chain = this.#chain
            .then(() => this.#onEvent(e))
            .catch((err: unknown) =>
              this.#o.log?.warn('thread status update failed', { err, event: e.name }),
            );
        }),
      ),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
  }

  /** Resolves when every event received so far has been handled (tests). */
  idle(): Promise<void> {
    return this.#chain;
  }

  async #onEvent(e: EventEnvelope): Promise<void> {
    const accountId = e.accountId;
    if (!accountId) return;
    const threadId = this.#threadOf(e);
    if (!threadId) return;
    const parent = this.#parentOf(threadId);
    await this.refresh(accountId, parent ? [threadId, parent] : [threadId]);
  }

  /**
   * Recompute threads and emit `thread.status.changed` for each whose status changed. A thread
   * seen for the first time is taken to have been `ready`.
   */
  async refresh(accountId: string, threadIds: readonly string[]): Promise<void> {
    const views = await this.statusOf(accountId, threadIds);
    for (const [id, view] of views) {
      const from = this.#known.get(id) ?? 'ready';
      this.#known.delete(id);
      this.#known.set(id, view.status);
      if (this.#known.size > MAX_CACHED) {
        const oldest = this.#known.keys().next().value;
        if (oldest !== undefined) this.#known.delete(oldest);
      }
      if (from === view.status) continue;
      await this.#o.events.emit({
        name: 'thread.status.changed',
        accountId,
        actor: 'system',
        correlation: { threadId: id },
        payload: { ref: { kind: 'thread', id }, from, status: view.status, reason: view.reason },
      });
    }
  }

  /** The thread an event is about: its correlation, its payload, or its run's or goal's thread. */
  #threadOf(e: EventEnvelope): string | null {
    const c = e.correlation as { threadId?: unknown } | undefined;
    if (typeof c?.threadId === 'string' && c.threadId) return c.threadId;
    const p = e.payload;
    if (typeof p.threadId === 'string' && p.threadId) return p.threadId;
    const lookup = (sql: string, id: unknown): string | null => {
      if (typeof id !== 'string' || !id) return null;
      try {
        const row = this.#o.db.raw.prepare(sql).get(id) as { thread_id: string | null } | undefined;
        return row?.thread_id ?? null;
      } catch {
        return null;
      }
    };
    return (
      lookup('SELECT thread_id FROM run WHERE id = ?', p.runId) ??
      lookup('SELECT thread_id FROM goal WHERE id = ?', p.goalId)
    );
  }

  #parentOf(threadId: string): string | null {
    const row = this.#o.db.raw
      .prepare('SELECT parent_thread_id FROM thread WHERE id = ?')
      .get(threadId) as { parent_thread_id: string | null } | undefined;
    return row?.parent_thread_id ?? null;
  }
}
