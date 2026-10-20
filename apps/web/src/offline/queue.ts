// The outbound queue (FR-112, FR-128, docs/13 §2.3): changes made on this device while the Hub
// was unreachable, each with a visible status (queued, sending, failed with a reason, done). They
// are sealed at rest under their own key (src/replica/vault.ts), so a removed offline copy does
// not take the user's unsent work with it. They go out in order, each with its own
// Idempotency-Key, which a resend reuses, so the Hub applies a change once however often it is
// sent. A change the Hub refuses stays as failed until it is retried or discarded; nothing is
// dropped silently. A retryable failure waits with exponential backoff and jitter.
import { defineMessages } from '@nova/i18n';
import { uuidv7, type SyncOp } from '@nova/shared';
import { SealedStore, Vault, type KvBackend } from '../replica/vault.ts';

export type QueueStatus = 'queued' | 'sending' | 'failed' | 'done';

/** What a change is: a message, a new chat, a chat's title or state, a project, a page, an answer. */
export type QueueKind = 'message' | 'chat' | 'chat_edit' | 'project' | 'space' | 'page' | 'answer';

/**
 * What a change does and to what, kept as data so its label is worded in the active locale when
 * shown (`itemLabel` in offline/format.ts): "Message in “Trip planning”".
 */
export interface QueueSubject {
  action:
    | 'newChat'
    | 'message'
    | 'renameChat'
    | 'archiveChat'
    | 'restoreChat'
    | 'pinChat'
    | 'unpinChat'
    | 'moveChat'
    | 'projectInstructions'
    | 'renameProject'
    | 'renameSpace'
    | 'editPage'
    | 'answer';
  /** The chat's, project's, space's or page's name, when it has one. */
  name: string | null;
  /** The new name, for a rename. */
  to?: string | null;
}

/**
 * Why a change failed or waits, as a code `problemText` words when shown; `rejected`: the Hub
 * refused it for the reason in `errorCode`.
 */
export type QueueProblem =
  | 'rejected'
  | 'no_replica'
  | 'signed_out'
  | 'sync_disabled'
  | 'loading'
  | 'in_flight'
  | 'not_yet'
  | 'answer_not_yet'
  | 'send_failed';

/** What became of a change once sent, as a code `noteText` words when shown. */
export const QUEUE_NOTES = [
  /** A newer change made elsewhere won; this one went to the merge log. */
  'overwritten',
  /** What came of asking the Hub to answer a message written offline. */
  'requested',
  'answered',
  'not_last',
  'turn_in_progress',
  'shared_thread',
  'not_user_message',
  'answer_failed',
] as const;
export type QueueNote = (typeof QUEUE_NOTES)[number];

export interface QueueItem {
  id: string;
  kind: QueueKind;
  /** What it is (worded when shown). */
  subject: QueueSubject;
  /** The chat it belongs to, for messages, answers and chat changes. */
  threadId: string | null;
  /** The entity it changes (the new message's id for a message). */
  entityId: string;
  /** The words of a message or an answer, kept so they are never lost. */
  text: string | null;
  /** The local model that wrote an answer (FR-128). */
  model: string | null;
  /** The device the changes are clocked for; another device's session stamps them again. */
  deviceId: string;
  ops: SyncOp[];
  idempotencyKey: string;
  status: QueueStatus;
  attempts: number;
  /** When a retryable failure is tried again. */
  nextAttemptAt: string | null;
  /** The Hub's own words for why it failed or waits (English, D9), when it gave some. */
  error: string | null;
  /** Our code for why it failed or waits, worded when shown; null when `error` says it. */
  problem: QueueProblem | null;
  errorCode: string | null;
  /** What happened once sent (a newer change won, so this one went to the merge log). */
  note: QueueNote | null;
  createdAt: string;
  updatedAt: string;
}

export type NewQueueItem = Pick<
  QueueItem,
  'kind' | 'subject' | 'threadId' | 'entityId' | 'text' | 'model' | 'deviceId' | 'ops'
>;

/** Why, for an outcome that did not send: our code, or the Hub's own words. */
interface Why {
  problem: QueueProblem | null;
  error?: string | null;
}

/** How one send went. */
export type SendOutcome =
  | { kind: 'done'; note?: QueueNote | null }
  /** Refused for good: kept as failed until retried or discarded; the next item goes on. */
  | ({ kind: 'failed'; code: string } & Why)
  /** The Hub is unreachable: everything waits for it to come back. */
  | { kind: 'unreachable' }
  /** Worth trying again (busy, a server error): it waits with backoff, and so does what follows. */
  | ({ kind: 'later' } & Why)
  /** Nothing can go until the user acts (signed out): it stays queued with the reason. */
  | ({ kind: 'blocked' } & Why);

export interface QueueDeps {
  kv: () => KvBackend | null;
  send: (item: QueueItem) => Promise<SendOutcome>;
  online: () => boolean;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  backoff?: { baseMs: number; maxMs: number };
  /** Sent items kept in the list (newest), so the user sees them go. */
  keepDone?: number;
}

const STORAGE_TEXT = defineMessages('offline.storage', {
  none: 'This browser cannot keep changes to send later: it needs IndexedDB and WebCrypto.',
});

/** The wait before attempt `attempts + 1`: exponential, capped, with "equal jitter". */
export function backoffMs(
  attempts: number,
  random: number,
  opts: { baseMs: number; maxMs: number } = { baseMs: 1000, maxMs: 60_000 },
): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp / 2 + (exp / 2) * Math.min(1, Math.max(0, random)));
}

/** The message an answer from this computer's model replies to (FR-128). */
export function answerParent(item: QueueItem): string | null {
  if (item.kind !== 'answer') return null;
  const v = item.ops[0]?.value as { parentId?: unknown } | undefined;
  return typeof v?.parentId === 'string' ? v.parentId : null;
}

function isItem(v: unknown): v is QueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const i = v as Partial<QueueItem>;
  return typeof i.id === 'string' && Array.isArray(i.ops) && typeof i.idempotencyKey === 'string';
}

export class OutboundQueue {
  readonly #deps: QueueDeps;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  readonly #listeners = new Set<() => void>();
  #store: SealedStore | null = null;
  #loading: Promise<void> | null = null;
  #items: readonly QueueItem[] = [];
  #draining: Promise<void> | null = null;
  #again = false;
  #cancelTimer: (() => void) | null = null;

  constructor(deps: QueueDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  items(): readonly QueueItem[] {
    return this.#items;
  }

  /** Items not yet on the Hub (queued, sending or failed), oldest first. */
  pending(): QueueItem[] {
    return this.#items.filter((i) => i.status !== 'done');
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Reads what was waiting before this page loaded (once). */
  load(): Promise<void> {
    this.#loading ??= (async () => {
      const kv = this.#deps.kv();
      if (!kv) return;
      const vault = await Vault.load(kv, 'queue');
      if (!vault) {
        // Without its key nothing waiting could be read: clear what cannot be opened.
        await kv.clear('queue');
        return;
      }
      this.#store = new SealedStore(kv, 'queue', vault);
      const saved = [...(await this.#store.all()).values()].filter(isItem);
      saved.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      // A send cut short by a closed page goes again (the Hub answers a repeat once).
      const loaded = saved.map((i) =>
        i.status === 'sending' ? { ...i, status: 'queued' as const } : i,
      );
      const added = this.#items.filter((i) => !loaded.some((l) => l.id === i.id));
      this.#items = [...loaded, ...added];
      this.#emit();
    })().catch(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #storeOrCreate(): Promise<SealedStore> {
    await this.load();
    if (this.#store) return this.#store;
    const kv = this.#deps.kv();
    if (!kv) throw new Error(STORAGE_TEXT.none);
    this.#store = new SealedStore(kv, 'queue', await Vault.create(kv, 'queue'));
    return this.#store;
  }

  /** Keep a change to send; resolves once it is saved on this device. */
  async add(input: NewQueueItem): Promise<QueueItem> {
    const store = await this.#storeOrCreate();
    const at = new Date(this.#now()).toISOString();
    const item: QueueItem = {
      ...input,
      id: uuidv7(),
      idempotencyKey: `nova-q-${uuidv7()}`,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      error: null,
      problem: null,
      errorCode: null,
      note: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.put([[item.id, item]]);
    this.#items = [...this.#items, item];
    this.#emit();
    return item;
  }

  /** Try a failed (or waiting) item again now. */
  async retry(id: string): Promise<void> {
    const item = this.#items.find((i) => i.id === id);
    if (!item || item.status === 'sending' || item.status === 'done') return;
    // The code stays until the next outcome: a change refused for its clock is stamped again.
    await this.#update(id, {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      error: null,
      problem: null,
    });
    await this.drain();
  }

  /** Drop an item that is not on its way; it never reaches the Hub. */
  async discard(id: string): Promise<boolean> {
    const item = this.#items.find((i) => i.id === id);
    if (!item || item.status === 'sending') return false;
    if (item.status !== 'done') await this.#store?.delete([id]);
    this.#items = this.#items.filter((i) => i.id !== id);
    this.#emit();
    return true;
  }

  /** Change an item that waits (a stamp for another device; a new key for a new body). */
  async revise(id: string, patch: Partial<Pick<QueueItem, 'ops' | 'idempotencyKey' | 'deviceId'>>) {
    await this.#update(id, patch);
  }

  clearDone(): void {
    this.#items = this.#items.filter((i) => i.status !== 'done');
    this.#emit();
  }

  /** Remove everything (the user's own choice, e.g. signing this device out). */
  async wipe(): Promise<void> {
    this.#items = [];
    await this.#store?.clear();
    this.#emit();
  }

  /** Resolves once the send under way (if any) is over. */
  idle(): Promise<void> {
    return this.#draining ?? Promise.resolve();
  }

  /** Send what waits, in order, while the Hub answers. */
  drain(): Promise<void> {
    if (this.#draining) {
      this.#again = true;
      return this.#draining;
    }
    this.#draining = (async () => {
      try {
        do {
          this.#again = false;
          await this.#drainOnce();
        } while (this.#again);
      } finally {
        this.#draining = null;
      }
    })();
    return this.#draining;
  }

  async #drainOnce(): Promise<void> {
    await this.load();
    for (const item of [...this.#items]) {
      const current = this.#items.find((i) => i.id === item.id);
      if (!current || current.status === 'done' || current.status === 'failed') continue;
      if (!this.#deps.online()) return;
      const wait = current.nextAttemptAt ? Date.parse(current.nextAttemptAt) - this.#now() : 0;
      if (wait > 0) {
        this.#schedule(wait);
        return;
      }
      await this.#update(current.id, { status: 'sending' });
      let outcome: SendOutcome;
      try {
        outcome = await this.#deps.send(this.#items.find((i) => i.id === current.id) ?? current);
      } catch (err) {
        const said = err instanceof Error && err.message ? err.message : null;
        outcome = { kind: 'later', problem: said ? null : 'send_failed', error: said };
      }
      if (outcome.kind === 'done') {
        await this.#store?.delete([current.id]);
        this.#items = this.#keepDone(
          this.#items.map((i) =>
            i.id === current.id
              ? {
                  ...i,
                  status: 'done' as const,
                  error: null,
                  problem: null,
                  errorCode: null,
                  nextAttemptAt: null,
                  note: outcome.note ?? null,
                  updatedAt: new Date(this.#now()).toISOString(),
                }
              : i,
          ),
        );
        this.#emit();
        continue;
      }
      if (outcome.kind === 'failed') {
        await this.#update(current.id, {
          status: 'failed',
          error: outcome.error ?? null,
          problem: outcome.problem,
          errorCode: outcome.code,
          nextAttemptAt: null,
        });
        continue;
      }
      if (outcome.kind === 'unreachable') {
        await this.#update(current.id, { status: 'queued' });
        return;
      }
      if (outcome.kind === 'blocked') {
        await this.#update(current.id, {
          status: 'queued',
          error: outcome.error ?? null,
          problem: outcome.problem,
        });
        return;
      }
      const attempts = current.attempts + 1;
      const delay = backoffMs(attempts, this.#random(), this.#deps.backoff);
      await this.#update(current.id, {
        status: 'queued',
        attempts,
        error: outcome.error ?? null,
        problem: outcome.problem,
        nextAttemptAt: new Date(this.#now() + delay).toISOString(),
      });
      this.#schedule(delay);
      return;
    }
  }

  #schedule(ms: number): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#setTimer(() => {
      this.#cancelTimer = null;
      void this.drain();
    }, ms);
  }

  #keepDone(items: readonly QueueItem[]): QueueItem[] {
    const keep = this.#deps.keepDone ?? 20;
    const done = items.filter((i) => i.status === 'done');
    const drop = new Set(done.slice(0, Math.max(0, done.length - keep)).map((i) => i.id));
    return items.filter((i) => !drop.has(i.id));
  }

  async #update(id: string, patch: Partial<QueueItem>): Promise<void> {
    const cur = this.#items.find((i) => i.id === id);
    if (!cur) return;
    const next: QueueItem = { ...cur, ...patch, updatedAt: new Date(this.#now()).toISOString() };
    this.#items = this.#items.map((i) => (i.id === id ? next : i));
    this.#emit();
    if (this.#store) await this.#store.put([[id, next]]);
  }

  #emit(): void {
    for (const fn of [...this.#listeners]) fn();
  }
}
