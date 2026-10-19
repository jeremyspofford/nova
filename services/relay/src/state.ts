// What a Relay remembers (FR-137, docs/22 §3, contracts/rest-api.md §3): routing registrations
// only. Hubs and client routes (with route tokens stored as SHA-256 hashes), revoked routes (so a
// revoked token stays refused), push registrations, open pairing slots (memory only, 5 minutes)
// and the bounded delivery queue (memory only). Routing registrations may persist to one JSON
// file (mode 0600); ciphertext never does.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ROUTE_TOKEN_PREFIX = 'nvr_';

export function newRouteToken(): string {
  return ROUTE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function newId(): string {
  return randomBytes(16).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update('nova-relay-route\0').update(token, 'utf8').digest('hex');
}

export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface HubRecord {
  routeId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PushRegistration {
  platform: 'apns' | 'fcm';
  token: string;
  topic: string | null;
  registeredAt: string;
}

export interface ClientRoute {
  routeId: string;
  clientId: string;
  hubRouteId: string;
  tokenHash: string;
  status: 'pending' | 'active';
  /** The pairing that created it, until confirmed. */
  pairingId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  push: PushRegistration | null;
}

export interface RevokedRoute {
  routeId: string;
  tokenHash: string;
  revokedAt: string;
}

export interface Pairing {
  id: string;
  hubRouteId: string;
  codeHash: string;
  offer: string;
  expiresAt: number;
  attempts: number;
  status: 'open' | 'claimed';
  /** The claim's route and sealed blob, re-sent to the Hub on reconnect until confirmed. */
  claim: { routeId: string; clientId: string; blob: string; claimedAt: number } | null;
}

interface StateFile {
  v: 1;
  hubs: HubRecord[];
  routes: ClientRoute[];
  revoked: RevokedRoute[];
}

export type Principal =
  | { kind: 'hub'; hub: HubRecord }
  | { kind: 'client'; route: ClientRoute }
  | { kind: 'revoked'; routeId: string };

/** Revoked routes are remembered this long (their tokens stay refused). */
const REVOKED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export class RelayState {
  readonly hubs = new Map<string, HubRecord>();
  readonly routes = new Map<string, ClientRoute>();
  readonly revoked = new Map<string, RevokedRoute>();
  readonly pairings = new Map<string, Pairing>();
  readonly #byToken = new Map<string, Principal>();
  readonly #file: string | null;
  readonly #debounceMs: number;
  #dirty = false;
  /** Only last-seen times changed: written at most once a minute (`saveTouched`). */
  #touched = false;
  #savedAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> | null = null;
  /** A failed write, for the log (`onWriteError`). */
  onWriteError: ((err: unknown) => void) | null = null;

  constructor(opts: { dataDir?: string | null; saveDebounceMs?: number } = {}) {
    this.#file = opts.dataDir ? join(opts.dataDir, 'relay-state.json') : null;
    this.#debounceMs = opts.saveDebounceMs ?? 1_000;
    if (opts.dataDir) {
      mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
      this.#load();
    }
  }

  get persistent(): boolean {
    return this.#file !== null;
  }

  #load(): void {
    if (!this.#file || !existsSync(this.#file)) return;
    const data = JSON.parse(readFileSync(this.#file, 'utf8')) as StateFile;
    if (data.v !== 1) throw new Error(`unknown Relay state version ${String(data.v)}`);
    const cutoff = new Date(Date.now() - REVOKED_KEEP_MS).toISOString();
    for (const h of data.hubs) this.addHub(h, false);
    for (const r of data.routes) {
      // A pairing never survives a restart, so neither does its unconfirmed route.
      if (r.status === 'pending') continue;
      this.addRoute(r, false);
    }
    for (const r of data.revoked) if (r.revokedAt > cutoff) this.addRevoked(r, false);
  }

  /**
   * Write the registrations soon: changes within the debounce interval share one write, and
   * writes are asynchronous and one at a time (atomic: a temporary file, then a rename).
   */
  save(): void {
    if (!this.#file || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#write();
    }, this.#debounceMs);
    this.#timer.unref?.();
  }

  /** Write pending changes now and wait for every write to finish (shutdown, tests). */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#writing) await this.#writing;
    if (this.#dirty || this.#touched) await this.#write();
  }

  /** Pending registration changes soon, and last-seen times at most once a minute. */
  saveTouched(now = Date.now()): void {
    if (this.#dirty || (this.#touched && now - this.#savedAt >= 60_000)) this.save();
  }

  async #write(): Promise<void> {
    if (!this.#file) return;
    while (this.#writing) await this.#writing;
    if (!this.#dirty && !this.#touched) return;
    const file = this.#file;
    const data: StateFile = {
      v: 1,
      hubs: [...this.hubs.values()],
      routes: [...this.routes.values()].filter((r) => r.status === 'active'),
      revoked: [...this.revoked.values()],
    };
    this.#dirty = false;
    this.#touched = false;
    const run = (async () => {
      const tmp = `${file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, file);
        this.#savedAt = Date.now();
      } catch (err) {
        // Try again with the next change; say so meanwhile.
        this.#dirty = true;
        this.onWriteError?.(err);
      }
    })();
    this.#writing = run;
    try {
      await run;
    } finally {
      this.#writing = null;
    }
  }

  #changed(persist: boolean): void {
    this.#dirty = true;
    if (persist) this.save();
  }

  principal(token: string): Principal | null {
    if (!token.startsWith(ROUTE_TOKEN_PREFIX) || token.length > 200) return null;
    return this.#byToken.get(tokenHash(token)) ?? null;
  }

  addHub(h: HubRecord, persist = true): void {
    this.hubs.set(h.routeId, h);
    this.#byToken.set(h.tokenHash, { kind: 'hub', hub: h });
    this.#changed(persist);
  }

  addRoute(r: ClientRoute, persist = true): void {
    this.routes.set(r.routeId, r);
    this.#byToken.set(r.tokenHash, { kind: 'client', route: r });
    this.#changed(persist && r.status === 'active');
  }

  addRevoked(r: RevokedRoute, persist = true): void {
    this.revoked.set(r.routeId, r);
    this.#byToken.set(r.tokenHash, { kind: 'revoked', routeId: r.routeId });
    this.#changed(persist);
  }

  activate(route: ClientRoute): void {
    route.status = 'active';
    route.pairingId = null;
    this.#changed(true);
  }

  /** Remove a client route; `revoke` keeps its token refused. */
  removeRoute(route: ClientRoute, revoke: boolean, now: string): void {
    this.routes.delete(route.routeId);
    this.#byToken.delete(route.tokenHash);
    if (revoke)
      this.addRevoked(
        { routeId: route.routeId, tokenHash: route.tokenHash, revokedAt: now },
        false,
      );
    this.#changed(true);
  }

  setPush(route: ClientRoute, push: PushRegistration): void {
    route.push = push;
    this.#changed(true);
  }

  /** Drop a registration the push service refused as unknown (M7). */
  clearPush(route: ClientRoute): void {
    route.push = null;
    this.#changed(true);
  }

  touch(route: { lastSeenAt: string | null }, now: string): void {
    route.lastSeenAt = now;
    this.#touched = true;
  }

  /** Forget a Hub, its client routes and its pairing slots (it expired). */
  removeHub(hub: HubRecord): ClientRoute[] {
    const routes = this.clientRoutesOf(hub.routeId);
    for (const r of routes) {
      this.routes.delete(r.routeId);
      this.#byToken.delete(r.tokenHash);
    }
    for (const p of [...this.pairings.values()])
      if (p.hubRouteId === hub.routeId) this.pairings.delete(p.id);
    this.hubs.delete(hub.routeId);
    this.#byToken.delete(hub.tokenHash);
    this.#changed(true);
    return routes;
  }

  clientRoutesOf(hubRouteId: string): ClientRoute[] {
    return [...this.routes.values()].filter((r) => r.hubRouteId === hubRouteId);
  }
}
