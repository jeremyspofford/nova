// The device's offline queue (M4 plan §2): events, task requests, memory notes and config changes
// made on this computer, kept in <device home>/state/queue/ until the hub has answered each one.
// Every item has an idempotency key, so sending it again (the reply was lost, the agent restarted)
// can't make it happen twice: the hub takes each key in exactly once. Items go out in the order
// they were made. Part of the runtime agent; the boot agent's `queue` command writes here too.
//
// Plain JSON files, one per item, not SQLite: node:sqlite ignores Node's permission model (it can
// open, ATTACH or VACUUM INTO any path), so the runtime is started without it (ADR-3). The layout:
//   pending/<key>.json  waiting: {seq, key, kind, body, created_at}
//   done/<key>.json     answered: the same without the body, plus the answer
//   tmp/                where a file is written in full before it is put in place
// A file appears in pending/ only complete (written, flushed, then hard-linked in, which also fails
// if the key is already there), and is answered by writing done/ first and then removing it from
// pending/, so a crash at any point leaves the item either waiting or answered, never half of each.
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const QUEUE_KINDS = ['event', 'task_request', 'memory_note', 'config_change'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export interface QueueItem { seq: number; key: string; kind: QueueKind; body: Record<string, unknown>; created_at: string }
export interface QueueResult { key: string; status: 'accepted' | 'refused' | 'rejected'; duplicate?: boolean; reason?: string; ref?: string }
export interface SettledItem { seq: number; key: string; kind: QueueKind; created_at: string; delivered_at: string; status: string; reason: string | null; ref: string | null; local?: boolean }

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
// How many answered items are kept (newest), for `status` and so a repeated key is recognised.
// Older ones go: the hub still recognises their keys, so re-adding one is answered as a duplicate.
const KEEP_SETTLED = 1000;

export class Queue {
  readonly dir: string;
  #pending: string;
  #done: string;
  #tmp: string;

  constructor(dir: string) {
    this.dir = dir;
    this.#pending = join(dir, 'pending');
    this.#done = join(dir, 'done');
    this.#tmp = join(dir, 'tmp');
    for (const d of [dir, this.#pending, this.#done, this.#tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  // Keeps an item to send. A key the caller gives makes adding it again a no-op.
  add(kind: QueueKind, body: Record<string, unknown>, key: string = `q-${randomUUID()}`): { key: string; seq: number; added: boolean } {
    if (!QUEUE_KINDS.includes(kind)) throw new Error(`kind must be one of ${QUEUE_KINDS.join(', ')}.`);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('body must be an object.');
    if (!KEY.test(key)) throw new Error('key must be 8–100 letters, digits or ._:-');
    const known = this.#read(join(this.#pending, `${key}.json`)) ?? this.#read(join(this.#done, `${key}.json`));
    if (known) return { key, seq: Number(known.seq), added: false };
    // After everything already waiting, in the order made, even if the clock stepped back.
    const last = this.#all(this.#pending).reduce((m, i) => Math.max(m, Number(i.seq) || 0), 0);
    const seq = Math.max(Date.now() * 1000, last + 1);
    const item: QueueItem = { seq, key, kind, body, created_at: new Date().toISOString() };
    const tmp = this.#write(item);
    try {
      linkSync(tmp, join(this.#pending, `${key}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return { key, seq: Number(this.#read(join(this.#pending, `${key}.json`))?.seq ?? seq), added: false };
    } finally {
      rmSync(tmp, { force: true });
    }
    this.#syncDir(this.#pending);
    return { key, seq, added: true };
  }

  // The oldest items not yet answered, in the order they were made.
  pending(limit = 50): QueueItem[] {
    return (this.#all(this.#pending) as unknown as QueueItem[]).sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key)).slice(0, limit);
  }

  // The hub answered: the item is done, however it was answered. Its body is dropped, so words
  // the hub may later be asked to forget don't linger here; the key and the answer stay.
  settle(results: QueueResult[], o: { local?: boolean } = {}): void {
    const at = new Date().toISOString();
    for (const r of results) {
      if (!KEY.test(r.key)) continue;
      const file = join(this.#pending, `${r.key}.json`);
      const item = this.#read(file);
      if (!item) continue;
      if (!existsSync(join(this.#done, `${r.key}.json`))) {
        const done: SettledItem = {
          seq: Number(item.seq), key: r.key, kind: item.kind as QueueKind, created_at: String(item.created_at), delivered_at: at,
          status: r.status, reason: r.reason ?? null, ref: r.ref ?? null, ...(o.local ? { local: true } : {}),
        };
        const tmp = this.#write(done);
        renameSync(tmp, join(this.#done, `${r.key}.json`));
        this.#syncDir(this.#done);
      }
      rmSync(file, { force: true });
    }
    this.#syncDir(this.#pending);
    this.#prune();
  }

  settled(limit = 50): SettledItem[] {
    return (this.#all(this.#done) as unknown as SettledItem[]).sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  counts(): { pending: number; delivered: number; refused: number } {
    const done = this.#all(this.#done);
    return { pending: this.#names(this.#pending).length, delivered: done.length, refused: done.filter((d) => d.status === 'refused' || d.status === 'rejected').length };
  }

  // Nothing is held open; kept so callers can say they are finished with it.
  close(): void {}

  #names(dir: string): string[] {
    try { return readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  }

  #all(dir: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const n of this.#names(dir)) {
      const r = this.#read(join(dir, n));
      if (r) out.push(r);
    }
    return out;
  }

  #read(file: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
  }

  // Written in full and flushed to disk before anything points at it.
  #write(data: unknown): string {
    const tmp = join(this.#tmp, `${process.pid}-${randomUUID()}.json`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(data)}\n`);
      flush(fd);
    } finally {
      closeSync(fd);
    }
    return tmp;
  }

  // So a rename or a new name in the folder survives a power cut, not only the file's contents.
  #syncDir(dir: string): void {
    try {
      const fd = openSync(dir, 'r');
      try { flush(fd); } finally { closeSync(fd); }
    } catch { /* not every system lets a folder be flushed; the rename is still atomic */ }
  }

  #prune(): void {
    const names = this.#names(this.#done);
    if (names.length <= KEEP_SETTLED) return;
    const old = (this.#all(this.#done) as unknown as SettledItem[]).sort((a, b) => a.seq - b.seq).slice(0, names.length - KEEP_SETTLED);
    for (const s of old) rmSync(join(this.#done, `${s.key}.json`), { force: true });
  }
}

// Node's permission model refuses fsync, so inside the runtime this is a no-op. That is safe for
// what the runtime writes (answers): an answer lost to a power cut leaves the item waiting, it is
// sent again, and the hub answers it as the duplicate it is. Items are added by the boot agent's
// queue command, outside the sandbox, where they are flushed before they count as queued.
function flush(fd: number): void {
  try { fsyncSync(fd); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ERR_ACCESS_DENIED') throw e; }
}
