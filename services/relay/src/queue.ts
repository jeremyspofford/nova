// The Relay's delivery queue (FR-137, contracts/rest-api.md §3.2): ciphertext waiting for an
// offline route, bounded per route (frames and bytes), per Hub (everything to it and its clients)
// and in total, and by age. The oldest frames go first at every level; senders retransmit.

export interface QueueLimits {
  routeMaxFrames: number;
  routeMaxBytes: number;
  hubMaxBytes: number;
  totalMaxBytes: number;
  maxAgeMs: number;
}

interface Entry {
  routeId: string;
  hubId: string;
  text: string;
  bytes: number;
  at: number;
  gone: boolean;
}

/** First in, first out, with lazy removal and occasional compaction. */
class Fifo {
  items: Entry[] = [];
  head = 0;
  push(e: Entry): void {
    this.items.push(e);
  }
  /** The oldest entry still queued. */
  oldest(): Entry | null {
    while (this.head < this.items.length && this.items[this.head]!.gone) this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return this.items[this.head] ?? null;
  }
  get empty(): boolean {
    return this.oldest() === null;
  }
}

interface Totals {
  frames: number;
  bytes: number;
}

export class DeliveryQueue {
  readonly #l: QueueLimits;
  readonly #now: () => number;
  readonly #routes = new Map<string, Fifo>();
  readonly #routeTotals = new Map<string, Totals>();
  readonly #hubs = new Map<string, Fifo>();
  readonly #hubBytes = new Map<string, number>();
  readonly #all = new Fifo();
  #bytes = 0;
  /** Frames dropped for a bound or for age. */
  evicted = 0;

  constructor(limits: QueueLimits, now: () => number) {
    this.#l = limits;
    this.#now = now;
  }

  get totalBytes(): number {
    return this.#bytes;
  }

  hubBytes(hubId: string): number {
    return this.#hubBytes.get(hubId) ?? 0;
  }

  /** Frames waiting for a route (after expiry). */
  count(routeId: string): number {
    this.#expire(routeId);
    return this.#routeTotals.get(routeId)?.frames ?? 0;
  }

  push(routeId: string, hubId: string, text: string): void {
    const e: Entry = { routeId, hubId, text, bytes: text.length, at: this.#now(), gone: false };
    let route = this.#routes.get(routeId);
    if (!route) this.#routes.set(routeId, (route = new Fifo()));
    let hub = this.#hubs.get(hubId);
    if (!hub) this.#hubs.set(hubId, (hub = new Fifo()));
    route.push(e);
    hub.push(e);
    this.#all.push(e);
    const t = this.#routeTotals.get(routeId) ?? { frames: 0, bytes: 0 };
    t.frames++;
    t.bytes += e.bytes;
    this.#routeTotals.set(routeId, t);
    this.#hubBytes.set(hubId, (this.#hubBytes.get(hubId) ?? 0) + e.bytes);
    this.#bytes += e.bytes;
    while (t.frames > this.#l.routeMaxFrames || t.bytes > this.#l.routeMaxBytes)
      this.#evict(route.oldest()!);
    while ((this.#hubBytes.get(hubId) ?? 0) > this.#l.hubMaxBytes) this.#evict(hub.oldest()!);
    while (this.#bytes > this.#l.totalMaxBytes) this.#evict(this.#all.oldest()!);
  }

  /** Everything still queued for a route, oldest first; the queue forgets it. */
  take(routeId: string): string[] {
    this.#expire(routeId);
    const route = this.#routes.get(routeId);
    if (!route) return [];
    const out: string[] = [];
    for (let e = route.oldest(); e; e = route.oldest()) {
      out.push(e.text);
      this.#remove(e);
    }
    this.#forget(routeId);
    return out;
  }

  /** Drop a route's frames (it was revoked). */
  dropRoute(routeId: string): void {
    const route = this.#routes.get(routeId);
    if (!route) return;
    for (let e = route.oldest(); e; e = route.oldest()) this.#remove(e);
    this.#forget(routeId);
  }

  /** Drop every frame to a Hub or its clients (the Hub expired). */
  dropHub(hubId: string): void {
    const hub = this.#hubs.get(hubId);
    if (!hub) return;
    for (let e = hub.oldest(); e; e = hub.oldest()) this.#remove(e);
    this.#hubs.delete(hubId);
    this.#hubBytes.delete(hubId);
  }

  /** Drop frames past their age everywhere. */
  expireAll(): void {
    const cutoff = this.#now() - this.#l.maxAgeMs;
    for (let e = this.#all.oldest(); e && e.at <= cutoff; e = this.#all.oldest()) this.#evict(e);
    for (const id of [...this.#routes.keys()]) if (this.#routes.get(id)!.empty) this.#forget(id);
    for (const [id, fifo] of [...this.#hubs]) {
      if (fifo.empty) {
        this.#hubs.delete(id);
        this.#hubBytes.delete(id);
      }
    }
  }

  #expire(routeId: string): void {
    const route = this.#routes.get(routeId);
    if (!route) return;
    const cutoff = this.#now() - this.#l.maxAgeMs;
    for (let e = route.oldest(); e && e.at <= cutoff; e = route.oldest()) this.#evict(e);
    if (route.empty) this.#forget(routeId);
  }

  #forget(routeId: string): void {
    this.#routes.delete(routeId);
    this.#routeTotals.delete(routeId);
  }

  #evict(e: Entry): void {
    this.#remove(e);
    this.evicted++;
  }

  #remove(e: Entry): void {
    if (e.gone) return;
    e.gone = true;
    const t = this.#routeTotals.get(e.routeId);
    if (t) {
      t.frames--;
      t.bytes -= e.bytes;
    }
    this.#hubBytes.set(e.hubId, (this.#hubBytes.get(e.hubId) ?? 0) - e.bytes);
    this.#bytes -= e.bytes;
  }
}
