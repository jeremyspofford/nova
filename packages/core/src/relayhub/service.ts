// The Hub's side of the Relay (FR-137, docs/22 §3, contracts/rest-api.md §3, ADR-071, ADR-094).
// It registers with a Relay (the route token and the Hub's X25519 key go to the vault), keeps one
// outbound WebSocket (reconnect with backoff, keepalive), opens pairing slots for Add Device and
// hands claimed clients to the Add Device service for the owner's approval, keeps the registry of
// paired clients, and serves each client's sealed session: a tunneled request is dispatched to the
// Hub's own API (the dispatcher seam) where the client's device session token in the inner
// Authorization header authenticates it exactly like a direct request; the route token never
// authorizes anything. Envelopes from unknown, pending or revoked clients are dropped and logged.
import { NovaError } from '@nova/shared';
import { secretRef, type SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import {
  PAIRING_KDF_ITERATIONS,
  RelayConnection,
  RelaySession,
  StreamGuard,
  StreamIds,
  TunnelServer,
  streamCounter,
  createOffer,
  deriveSessionKeys,
  encodeTunnel,
  exportX25519Private,
  generateX25519,
  importX25519PrivateKey,
  isSecureRelayUrl,
  openClaim,
  pairingSecrets,
  randomId,
  relayHttpUrl,
  type BackoffOptions,
  type ConnectionState,
  type CryptoKey,
  type DropReason,
  type RelayEnvelope,
  type Timers,
  type TunnelMessage,
  type TunnelRequest,
  type TunnelResponse,
  type WebSocketFactory,
} from '@nova/relay';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import { pairingCodeHash } from '../pairing/index.ts';

export const RELAY_STATES = [
  'disabled',
  'unconfigured',
  'registering',
  'connecting',
  'connected',
  'error',
] as const;
export type RelayConnectorState = (typeof RELAY_STATES)[number];

export interface RelayStatus {
  state: RelayConnectorState;
  detail: string | null;
  url: string | null;
  /** The Hub's routing id at the Relay. */
  routeId: string | null;
  since: string;
  /** Round trip of the last keepalive ping. */
  latencyMs: number | null;
}

export interface RelayClientView {
  /** The relay client id. */
  id: string;
  deviceId: string | null;
  requestId: string | null;
  name: string;
  platform: string;
  kind: 'browser' | 'native';
  status: 'pending' | 'active' | 'denied' | 'expired' | 'revoked';
  routeId: string;
  relayUrl: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** The Add Device service's Relay seam (packages/core/src/pairing). */
export interface RelayPairingSeam {
  requestFromRelay(claim: {
    pairingId: string;
    codeHashCheck: string;
    publicKey: string;
    name: string;
    platform: string;
    relayClientId: string;
    kind?: 'browser' | 'native';
    code?: string;
  }): Promise<{ requestId: string; confirmation: string }>;
  onDecided(
    listener: (d: {
      accountId: string;
      requestId: string;
      decision: 'approved' | 'denied' | 'expired';
      deviceId: string | null;
      relayClientId: string | null;
    }) => void | Promise<void>,
  ): () => void;
  /** Add Device's blocklist of revoked device keys (docs/22 §4.5). */
  isKeyRevoked?(publicKey: string): Promise<boolean>;
}

/** The Hub identity (FR-134): signs the Hub's X25519 key in the pairing offer. */
export interface RelayHubIdentity {
  fingerprint: string;
  publicKey: string;
  sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface RelayTunnelClient {
  id: string;
  accountId: string;
  deviceId: string | null;
}

/** Serves one tunneled request against the Hub's own API (the Hub area passes `inject`). */
export type RelayDispatch = (
  req: TunnelRequest & { client: RelayTunnelClient },
  signal: AbortSignal,
) => Promise<TunnelResponse>;

/** The Relay as a transport endpoint for the network area (`useEndpointSource`). */
export interface RelayEndpointCandidate {
  transport: 'relay';
  url: string;
  priority: number;
  health: 'ok' | 'failing' | 'unknown';
  latencyMs: number | null;
  checkedAt: string | null;
  detail: string | null;
}

export interface RelayTestResult {
  ok: boolean;
  url: string | null;
  reachable: boolean;
  latencyMs: number | null;
  version: string | null;
  state: RelayConnectorState;
  detail: string | null;
}

export interface RelaySettings {
  enabled: boolean;
  url: string;
}

export interface RelayHubOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  log?: Logger;
  audit?: AuditSink;
  /** The effective `relay.*` settings. */
  settings: () => Promise<RelaySettings>;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  webSocket?: WebSocketFactory;
  timers?: Timers;
  backoff?: BackoffOptions;
  pingIntervalMs?: number;
  retransmitMs?: number;
  /** PBKDF2 iterations of the pairing code (tests lower it; clients must use the same). */
  kdfIterations?: number;
  /** HTTP calls to the Relay time out after this (default 10 s). */
  httpTimeoutMs?: number;
}

interface RegistrationRow {
  id: string;
  url: string;
  route_id: string;
  token_ref: string;
  x25519_key_ref: string;
  x25519_public_key: string;
  status: 'active' | 'rejected' | 'retired';
}

interface ClientRow {
  id: string;
  account_id: string;
  registration_id: string;
  route_id: string;
  relay_pairing_id: string;
  add_pairing_id: string | null;
  request_id: string | null;
  device_id: string | null;
  name: string;
  platform: string;
  kind: 'browser' | 'native';
  public_key: string;
  x25519_public_key: string;
  status: RelayClientView['status'];
  stream_floor: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface Peer {
  row: ClientRow;
  session: RelaySession | null;
  tunnel: TunnelServer | null;
  ids: StreamIds;
  lastSeenWrite: number;
}

interface OpenPairing {
  addPairingId: string;
  accountId: string;
  claimKey: Uint8Array;
  expiresAt: number;
  claimed: boolean;
  badClaimAudited?: boolean;
}

const LAST_SEEN_EVERY_MS = 30_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RelayHub {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #log: Logger;
  readonly #o: RelayHubOptions;
  readonly #now: () => Date;
  #audit: AuditSink | null;
  #pairing: RelayPairingSeam | null = null;
  #offDecided: (() => void) | null = null;
  #identity: (() => RelayHubIdentity | null) | null = null;
  #dispatch: RelayDispatch | null = null;
  #onRevoked: ((accountId: string, deviceId: string) => Promise<void> | void) | null = null;

  #status: RelayStatus;
  #reg: RegistrationRow | null = null;
  #hubKey: CryptoKey | null = null;
  #conn: RelayConnection | null = null;
  readonly #peers = new Map<string, Peer>();
  readonly #waiting = new Map<string, RelayEnvelope[]>();
  readonly #pairings = new Map<string, OpenPairing>();
  #chain: Promise<void> = Promise.resolve();
  #stopped = false;
  #lastAutoRegister = -Infinity;
  readonly #dropLog = new Map<string, number>();

  constructor(opts: RelayHubOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#events = opts.events;
    this.#log = opts.log ?? new Logger({ module: 'relay', sinks: [] });
    this.#audit = opts.audit ?? null;
    this.#now = opts.now ?? (() => new Date());
    this.#status = {
      state: 'disabled',
      detail: null,
      url: null,
      routeId: null,
      since: this.#now().toISOString(),
      latencyMs: null,
    };
  }

  // ---- seams ---------------------------------------------------------------------------------

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  /** The Add Device service: claims become pending requests; decisions confirm or drop routes. */
  usePairing(seam: RelayPairingSeam): void {
    this.#offDecided?.();
    this.#pairing = seam;
    this.#offDecided = seam.onDecided((d) =>
      this.#onDecided(d).catch((err: unknown) =>
        this.#log.warn('relay pairing decision failed', { err, requestId: d.requestId }),
      ),
    );
  }

  useHubIdentity(fn: () => RelayHubIdentity | null): void {
    this.#identity = fn;
  }

  useDispatch(fn: RelayDispatch): void {
    this.#dispatch = fn;
  }

  /** Called when the owner revokes a paired client, so its device is revoked (and its key blocked). */
  onClientRevoked(fn: (accountId: string, deviceId: string) => Promise<void> | void): void {
    this.#onRevoked = fn;
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  status(): RelayStatus {
    return { ...this.#status, latencyMs: this.#conn?.rttMs ?? null };
  }

  /** Apply the settings now (start, reconnect to a new URL, or stop). */
  start(): Promise<void> {
    return this.reconfigure();
  }

  reconfigure(): Promise<void> {
    const next = this.#chain.then(() => this.#apply());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#offDecided?.();
    this.#offDecided = null;
    await this.#chain;
    this.#disconnect();
  }

  async #apply(): Promise<void> {
    if (this.#stopped) return;
    const s = await this.#o.settings();
    const url = s.url.trim();
    if (!s.enabled) {
      this.#disconnect();
      this.#setStatus('disabled', null, url || null);
      return;
    }
    if (!url) {
      this.#disconnect();
      this.#setStatus('unconfigured', 'set the Relay URL', null);
      return;
    }
    if (!isSecureRelayUrl(url)) {
      // The route token and pairing metadata must not cross a network in clear.
      this.#disconnect();
      this.#setStatus(
        'error',
        'the Relay URL must use https or wss (plain http only to this machine)',
        url,
      );
      return;
    }
    if (this.#reg && this.#reg.url === url && this.#reg.status === 'active' && this.#conn) return;
    this.#disconnect();
    let reg = this.#activeRegistration(url);
    if (!reg) {
      this.#setStatus('registering', null, url);
      try {
        reg = await this.#register(url);
      } catch (err) {
        this.#setStatus('error', `could not register with the Relay: ${errText(err)}`, url);
        return;
      }
    }
    const token = await this.#secrets.get(reg.token_ref);
    const key = await this.#secrets.get(reg.x25519_key_ref);
    if (!token || !key) {
      this.#setStatus('error', 'the Relay credentials are missing from the vault', url);
      return;
    }
    this.#reg = reg;
    // Not extractable: the key never leaves WebCrypto again (its public half is in the row).
    this.#hubKey = await importX25519PrivateKey(key);
    this.#setStatus('connecting', null, url);
    const conn = new RelayConnection({
      url,
      token,
      routeId: reg.route_id,
      ...(this.#o.webSocket ? { webSocket: this.#o.webSocket } : {}),
      ...(this.#o.timers ? { timers: this.#o.timers } : {}),
      ...(this.#o.backoff ? { backoff: this.#o.backoff } : {}),
      ...(this.#o.pingIntervalMs ? { pingIntervalMs: this.#o.pingIntervalMs } : {}),
      onEnvelope: (env) => this.#onEnvelope(env),
      onState: (state, detail) => this.#onConnState(conn, state, detail),
      onInvalid: (error) => this.#log.debug('invalid frame from the Relay', { error }),
    });
    this.#conn = conn;
    conn.start();
  }

  #disconnect(): void {
    this.#conn?.stop();
    this.#conn = null;
    for (const p of this.#peers.values()) this.#closePeer(p);
    this.#peers.clear();
    this.#waiting.clear();
    this.#reg = null;
    this.#hubKey = null;
  }

  #setStatus(state: RelayConnectorState, detail: string | null, url: string | null): void {
    const prev = this.#status;
    if (prev.state === state && prev.detail === detail && prev.url === url) return;
    this.#status = {
      state,
      detail,
      url,
      routeId: this.#reg?.route_id ?? null,
      since: this.#now().toISOString(),
      latencyMs: null,
    };
    if (prev.state !== state) {
      void this.#events
        .emit({ name: 'relay.status.changed', payload: { state, detail, url } })
        .catch(() => undefined);
    }
  }

  #onConnState(conn: RelayConnection, state: ConnectionState, detail: string | null): void {
    if (this.#conn !== conn) return;
    const url = this.#reg?.url ?? null;
    const up = state === 'open';
    for (const p of this.#peers.values()) p.session?.setConnected(up);
    switch (state) {
      case 'open':
        this.#setStatus('connected', null, url);
        void this.#reconcile().catch((err: unknown) =>
          this.#log.warn('relay route reconcile failed', { err }),
        );
        return;
      case 'connecting':
      case 'closed':
        this.#setStatus('connecting', detail, url);
        return;
      case 'unauthorized':
      case 'revoked': {
        // The Relay forgot this Hub (it lost its registrations, or forgot an unused Hub). With
        // no paired clients nothing is lost: register again at once (at most once a minute).
        // With clients the owner decides: turning the Relay off and on registers again, and the
        // clients must pair again.
        const reg = this.#reg;
        if (!reg) return;
        reg.status = 'rejected';
        const paired = this.#db.raw
          .prepare(
            `SELECT 1 FROM relay_client
             WHERE registration_id = ? AND status IN ('active', 'pending') LIMIT 1`,
          )
          .get(reg.id);
        const t = Date.now();
        if (!paired && t - this.#lastAutoRegister >= 60_000) {
          this.#lastAutoRegister = t;
          this.#log.info('the Relay forgot this Hub; registering again (no paired clients)', {
            url,
          });
          void this.#markRegistration(reg.id, 'rejected')
            .then(() => this.reconfigure())
            .catch((err: unknown) => this.#log.warn('registering again failed', { err }));
          return;
        }
        void this.#markRegistration(reg.id, 'rejected').catch(() => undefined);
        this.#setStatus(
          'error',
          'the Relay no longer knows this Hub; turn the Relay off and on to register again (paired clients must pair again)',
          url,
        );
        return;
      }
      case 'idle':
      case 'stopped':
        return;
    }
  }

  // ---- registration --------------------------------------------------------------------------

  #activeRegistration(url: string): RegistrationRow | null {
    return (
      (this.#db.raw
        .prepare(
          `SELECT * FROM relay_registration WHERE url = ? AND status = 'active'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(url) as RegistrationRow | undefined) ?? null
    );
  }

  async #http(
    method: string,
    url: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.#o.httpTimeoutMs ?? 10_000);
    try {
      const res = await (this.#o.fetch ?? globalThis.fetch)(relayHttpUrl(url, path), {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
        redirect: 'error',
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  async #register(url: string): Promise<RegistrationRow> {
    const res = await this.#http('POST', url, '/v1/relay/hubs');
    const routeId = res.json.routeId;
    const routeToken = res.json.routeToken;
    if (res.status !== 201 || typeof routeId !== 'string' || typeof routeToken !== 'string') {
      const err = res.json.error as { message?: string } | undefined;
      throw new Error(err?.message ?? `the Relay answered ${res.status}`);
    }
    const id = randomId();
    const key = await generateX25519();
    const tokenRef = secretRef('relay', id, 'route-token');
    const keyRef = secretRef('relay', id, 'x25519');
    await this.#secrets.put(tokenRef, routeToken);
    await this.#secrets.put(keyRef, await exportX25519Private(key.privateKey));
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE relay_registration SET status = 'retired', updated_at = ? WHERE status = 'active'`,
        )
        .run(now);
      this.#db.raw
        .prepare(
          `INSERT INTO relay_registration
           (id, url, route_id, token_ref, x25519_key_ref, x25519_public_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(id, url, routeId, tokenRef, keyRef, key.publicKey, now, now);
    });
    // Replaced registrations are never used again: their token and key leave the vault.
    const old = this.#db.raw
      .prepare('SELECT token_ref, x25519_key_ref FROM relay_registration WHERE id != ?')
      .all(id) as { token_ref: string; x25519_key_ref: string }[];
    for (const o of old) {
      await this.#secrets.delete(o.token_ref).catch(() => false);
      await this.#secrets.delete(o.x25519_key_ref).catch(() => false);
    }
    this.#log.info('registered with the Relay', { url, routeId });
    return this.#activeRegistration(url)!;
  }

  async #markRegistration(id: string, status: RegistrationRow['status']): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE relay_registration SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, this.#now().toISOString(), id);
    });
  }

  /** Bring the Relay's routes in line with the registry after (re)connecting. */
  async #reconcile(): Promise<void> {
    const reg = this.#reg;
    const token = reg ? await this.#secrets.get(reg.token_ref) : null;
    if (!reg || !token) return;
    const res = await this.#http('GET', reg.url, '/v1/relay/routes', undefined, token);
    if (res.status !== 200 || !Array.isArray(res.json.items)) return;
    const remote = new Map<string, string>();
    for (const r of res.json.items as { routeId?: unknown; status?: unknown }[]) {
      if (typeof r.routeId === 'string' && typeof r.status === 'string')
        remote.set(r.routeId, r.status);
    }
    const rows = this.#db.raw
      .prepare('SELECT * FROM relay_client WHERE registration_id = ?')
      .all(reg.id) as unknown as ClientRow[];
    for (const row of rows) {
      const there = remote.get(row.route_id);
      if ((row.status === 'revoked' || row.status === 'denied') && there) {
        await this.#http('DELETE', reg.url, `/v1/relay/routes/${row.route_id}`, undefined, token);
      } else if (row.status === 'active' && there === 'pending') {
        await this.#http(
          'POST',
          reg.url,
          `/v1/relay/pairings/${row.relay_pairing_id}/confirm`,
          {},
          token,
        );
      } else if (row.status === 'active' && !there) {
        this.#log.warn('the Relay no longer routes a paired client; it must pair again', {
          clientId: row.id,
        });
      }
    }
  }

  // ---- envelopes -----------------------------------------------------------------------------

  #logDrop(
    reason: string,
    clientId: string | undefined,
    extra: Record<string, unknown> = {},
  ): void {
    // At most one log line per client and reason per minute: a flood must not flood the log.
    const key = `${reason}:${clientId ?? ''}`;
    const t = Date.now();
    if ((this.#dropLog.get(key) ?? 0) > t - 60_000) return;
    this.#dropLog.set(key, t);
    if (this.#dropLog.size > 1000) this.#dropLog.clear();
    this.#log.warn('relay envelope dropped', { reason, clientId, ...extra });
  }

  #onEnvelope(env: RelayEnvelope): void {
    if (env.kind === 'close') {
      if (env.reason === 'unknown_route')
        this.#logDrop('unknown_route', undefined, { route: env.from });
      return;
    }
    if (env.kind !== 'data' && env.kind !== 'ack') return;
    if (env.kind === 'data' && env.stream?.startsWith('pair.')) {
      void this.#onClaim(env).catch((err: unknown) =>
        this.#log.warn('relay claim failed', { err }),
      );
      return;
    }
    const id = env.client;
    if (!id) return;
    const peer = this.#peers.get(id);
    if (peer) {
      this.#deliver(peer, env);
      return;
    }
    const queue = this.#waiting.get(id);
    if (queue) {
      if (queue.length < 1024) queue.push(env);
      return;
    }
    const q = [env];
    this.#waiting.set(id, q);
    void this.#loadPeer(id)
      .then((p) => {
        if (this.#waiting.get(id) !== q) return;
        this.#waiting.delete(id);
        for (const e of q) {
          if (p) this.#deliver(p, e);
          else this.#logDrop('unknown_client', id);
        }
      })
      .catch((err: unknown) => {
        this.#waiting.delete(id);
        this.#log.warn('loading a relay client failed', { err, clientId: id });
      });
  }

  #deliver(peer: Peer, env: RelayEnvelope): void {
    if (peer.row.status !== 'active' || !peer.session) {
      this.#logDrop(`${peer.row.status}_client`, peer.row.id);
      return;
    }
    if (env.from !== peer.row.route_id) {
      this.#logDrop('route_mismatch', peer.row.id);
      return;
    }
    peer.session.receive(env);
  }

  /** A frame from the client opened with its session key: only then is it "seen". */
  #touch(peer: Peer): void {
    const t = Date.now();
    if (t - peer.lastSeenWrite <= LAST_SEEN_EVERY_MS) return;
    peer.lastSeenWrite = t;
    const now = this.#now().toISOString();
    peer.row.last_seen_at = now;
    void this.#db
      .transaction(() => {
        this.#db.raw
          .prepare('UPDATE relay_client SET last_seen_at = ? WHERE id = ?')
          .run(now, peer.row.id);
      })
      .catch(() => undefined);
  }

  /**
   * Store a client's stream floor before its new stream runs (docs/22 §9.9): a request is
   * served only once its counter is on disk, so a Relay replaying it after a restart is refused.
   * A failed write refuses the stream.
   */
  async #persistFloor(row: ClientRow, counter: number): Promise<boolean> {
    try {
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('UPDATE relay_client SET stream_floor = MAX(stream_floor, ?) WHERE id = ?')
          .run(counter, row.id);
      });
      row.stream_floor = Math.max(row.stream_floor, counter);
      return true;
    } catch (err) {
      this.#log.error('the stream floor was not stored; the request is refused', {
        err,
        clientId: row.id,
      });
      return false;
    }
  }

  async #loadPeer(id: string): Promise<Peer | null> {
    const reg = this.#reg;
    if (!reg) return null;
    const row = this.#db.raw
      .prepare('SELECT * FROM relay_client WHERE id = ? AND registration_id = ?')
      .get(id, reg.id) as ClientRow | undefined;
    if (!row) return null;
    const existing = this.#peers.get(id);
    if (existing) return existing;
    const peer = await this.#makePeer(row);
    if (this.#reg !== reg) return null;
    this.#peers.set(id, peer);
    return peer;
  }

  async #makePeer(row: ClientRow): Promise<Peer> {
    const peer: Peer = {
      row,
      session: null,
      tunnel: null,
      ids: new StreamIds('h', { now: () => this.#now().getTime() }),
      lastSeenWrite: 0,
    };
    const reg = this.#reg;
    if (row.status !== 'active' || !reg || !this.#hubKey) return peer;
    const keys = await deriveSessionKeys('hub', this.#hubKey, {
      hubRoute: reg.route_id,
      clientRoute: row.route_id,
      clientId: row.id,
      hubX25519: reg.x25519_public_key,
      clientX25519: row.x25519_public_key,
    });
    const guard = new StreamGuard('c', { floor: row.stream_floor });
    const session = new RelaySession({
      clientId: row.id,
      localRoute: reg.route_id,
      remoteRoute: row.route_id,
      keys,
      transmit: (env) => this.#conn?.send(env) ?? false,
      onMessage: (stream, data) => peer.tunnel?.onMessage(stream, data),
      acceptStream: (stream) => {
        if (!guard.accept(stream)) return false;
        return this.#persistFloor(row, streamCounter(stream)!.counter);
      },
      onAuthenticated: () => this.#touch(peer),
      onDrop: (reason, info) => this.#onSessionDrop(peer, guard, reason, info),
      onDrain: (stream) => peer.tunnel?.onDrain(stream),
      onStreamFailed: (stream) => peer.tunnel?.onStreamFailed(stream),
      ...(this.#o.timers ? { timers: this.#o.timers } : {}),
      ...(this.#o.retransmitMs ? { retransmitMs: this.#o.retransmitMs } : {}),
    });
    peer.session = session;
    peer.tunnel = new TunnelServer({
      sink: session,
      handler: (req, signal) => this.#serve(peer, req, signal),
      onError: (stream, err) =>
        this.#log.warn('tunneled request failed', { err, clientId: row.id, stream }),
    });
    session.setConnected(this.#conn?.state === 'open');
    return peer;
  }

  #onSessionDrop(
    peer: Peer,
    guard: StreamGuard,
    reason: DropReason,
    info: { stream?: string; seq?: number },
  ): void {
    if (reason === 'duplicate') return;
    if (reason === 'stale_stream' && info.stream) {
      // Our floor is above the client's counter (its clock went back, or this is a replay):
      // tell it, so a live client continues above the floor.
      this.#notice(peer, { t: 'stale', stream: info.stream, floor: guard.hwm });
    }
    this.#logDrop(reason, peer.row.id, info);
  }

  #notice(peer: Peer, msg: TunnelMessage): void {
    const s = peer.session;
    if (!s) return;
    const stream = peer.ids.next();
    s.send(stream, encodeTunnel(msg));
    s.closeStream(stream);
  }

  async #serve(peer: Peer, req: TunnelRequest, signal: AbortSignal): Promise<TunnelResponse> {
    if (!this.#dispatch) {
      return {
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: [
          new TextEncoder().encode(
            JSON.stringify({
              error: {
                code: 'node_unavailable',
                message: 'this Hub does not serve requests through the Relay yet',
                retryable: true,
              },
            }),
          ),
        ],
      };
    }
    return this.#dispatch(
      {
        ...req,
        client: { id: peer.row.id, accountId: peer.row.account_id, deviceId: peer.row.device_id },
      },
      signal,
    );
  }

  #closePeer(p: Peer): void {
    p.tunnel?.close();
    p.session?.close();
  }

  // ---- pairing -------------------------------------------------------------------------------

  /**
   * Open a Relay pairing slot for an Add Device pairing (`transport: relay`): the Relay gets the
   * code's stretched hash and the Hub's sealed offer, never the code (docs/22 §3.1).
   */
  async openPairing(input: {
    accountId: string;
    pairingId: string;
    expiresAt: string;
    code: string;
  }): Promise<{ relayUrl: string; relayPairingId: string }> {
    await this.#chain;
    const reg = this.#reg;
    const token = reg ? await this.#secrets.get(reg.token_ref) : null;
    if (!reg || !token) {
      throw new NovaError('capability_missing', 'the Relay is not set up on this Hub', {
        details: { reason: 'relay_unavailable' },
        action: 'Set up a Relay in Settings → Network',
      });
    }
    const relayPairingId = randomId();
    const iterations = this.#o.kdfIterations ?? PAIRING_KDF_ITERATIONS;
    const secrets = await pairingSecrets(input.code, relayPairingId, iterations);
    const identity = this.#identity?.() ?? null;
    const offer = await createOffer({
      offerKey: secrets.offerKey,
      relayPairingId,
      hubRoute: reg.route_id,
      x25519: reg.x25519_public_key,
      addPairingId: input.pairingId,
      identity: identity ? { publicKey: identity.publicKey, sign: (b) => identity.sign(b) } : null,
    });
    const res = await this.#http(
      'POST',
      reg.url,
      '/v1/relay/pairings',
      { id: relayPairingId, codeHash: secrets.codeHash, expiresAt: input.expiresAt, offer },
      token,
    );
    if (res.status !== 201) {
      const err = res.json.error as { message?: string } | undefined;
      throw new NovaError('node_unavailable', 'the Relay did not open a pairing slot', {
        details: { reason: 'relay_refused', status: res.status, message: err?.message ?? null },
        retryable: true,
      });
    }
    const expiresAt = Date.parse(input.expiresAt);
    for (const [id, p] of this.#pairings) {
      if (p.expiresAt < Date.now() - 60_000) this.#pairings.delete(id);
    }
    this.#pairings.set(relayPairingId, {
      addPairingId: input.pairingId,
      accountId: input.accountId,
      claimKey: secrets.claimKey,
      expiresAt,
      claimed: false,
    });
    return { relayUrl: reg.url, relayPairingId };
  }

  async #onClaim(env: RelayEnvelope): Promise<void> {
    const relayPairingId = env.stream!.slice('pair.'.length);
    const open = this.#pairings.get(relayPairingId);
    const reg = this.#reg;
    if (!open || !reg || !env.client || !env.ct) {
      this.#logDrop('unknown_pairing', env.client);
      return;
    }
    if (open.claimed) return;
    // A Relay may hold a claim back; a slot past its life takes none (docs/22 §4: 5 minutes).
    if (this.#now().getTime() > open.expiresAt) {
      open.claimed = true;
      open.claimKey.fill(0);
      this.#logDrop('expired_claim', env.client);
      await this.#auditRefusal(open.accountId, relayPairingId, 'expired', { clientId: env.client });
      return;
    }
    const claim = await openClaim(open.claimKey, relayPairingId, env.ct);
    if (!claim) {
      // Only someone who knows the code can seal a claim; the Relay checked a hash of it.
      this.#logDrop('bad_claim', env.client);
      if (!open.badClaimAudited) {
        open.badClaimAudited = true;
        await this.#auditRefusal(open.accountId, relayPairingId, 'bad_claim', {
          clientId: env.client,
        });
      }
      return;
    }
    open.claimed = true;
    open.claimKey.fill(0);
    const now = this.#now().toISOString();
    let inserted = 0;
    await this.#db.transaction(() => {
      inserted = Number(
        this.#db.raw
          .prepare(
            `INSERT OR IGNORE INTO relay_client
             (id, account_id, registration_id, route_id, relay_pairing_id, add_pairing_id, name,
              platform, kind, public_key, x25519_public_key, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            env.client!,
            open.accountId,
            reg.id,
            env.from,
            relayPairingId,
            open.addPairingId,
            claim.name,
            claim.platform,
            claim.kind,
            claim.publicKey,
            claim.x25519,
            now,
            now,
          ).changes,
      );
    });
    if (inserted !== 1) {
      // The Relay chose a client id or route this Hub already knows. The ids are the Relay's,
      // so the claim never touches the client that has them.
      this.#log.warn('relay claim dropped: its client id or route is taken', {
        clientId: env.client,
        route: env.from,
      });
      await this.#auditRefusal(open.accountId, relayPairingId, 'client_conflict', {
        clientId: env.client,
      });
      return;
    }
    const scope = { id: env.client, relayPairingId, accountId: open.accountId };
    const refuse = async (reason: string, detail: Record<string, unknown> = {}) => {
      this.#log.warn('relay pairing refused', { clientId: env.client, reason, ...detail });
      if (await this.#setPendingStatus(scope, 'denied')) {
        await this.#deleteRoute(env.from).catch(() => undefined);
      }
      await this.#auditRefusal(open.accountId, relayPairingId, reason, {
        clientId: env.client,
        name: claim.name,
        platform: claim.platform,
        ...detail,
      });
    };
    if (await this.#keyRevoked(claim.publicKey)) {
      await refuse('revoked_key');
      return;
    }
    if (!this.#pairing) {
      await refuse('add_device_unavailable');
      return;
    }
    try {
      const out = await this.#pairing.requestFromRelay({
        pairingId: open.addPairingId,
        codeHashCheck: pairingCodeHash(open.addPairingId, claim.code),
        code: claim.code,
        publicKey: claim.publicKey,
        name: claim.name,
        platform: claim.platform,
        relayClientId: env.client,
        kind: claim.kind,
      });
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            `UPDATE relay_client SET request_id = ?, updated_at = ?
             WHERE id = ? AND relay_pairing_id = ? AND account_id = ? AND status = 'pending'`,
          )
          .run(
            out.requestId,
            this.#now().toISOString(),
            env.client!,
            relayPairingId,
            open.accountId,
          );
      });
    } catch (err) {
      await refuse('add_device_refused', { message: errText(err) });
    }
  }

  /** Only a revoked key is blocked (docs/22 §4.5): Add Device's list, then this registry's. */
  async #keyRevoked(publicKey: string): Promise<boolean> {
    if (this.#pairing?.isKeyRevoked && (await this.#pairing.isKeyRevoked(publicKey))) return true;
    return (
      this.#db.raw
        .prepare(`SELECT 1 FROM relay_client WHERE public_key = ? AND status = 'revoked' LIMIT 1`)
        .get(publicKey) !== undefined
    );
  }

  async #auditRefusal(
    accountId: string,
    relayPairingId: string,
    reason: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const resource = typeof detail.clientId === 'string' ? detail.clientId : relayPairingId;
    await this.#auditAppend(accountId, 'relay.pair', resource, {
      decision: 'refused',
      actor: 'system',
      detail: { reason, relayPairingId, ...detail },
    });
  }

  /** Move a pending client this claim created; never any other row. True when it changed. */
  async #setPendingStatus(
    scope: { id: string; relayPairingId: string; accountId: string },
    status: 'denied' | 'expired' | 'active',
  ): Promise<boolean> {
    let changed = 0;
    await this.#db.transaction(() => {
      changed = Number(
        this.#db.raw
          .prepare(
            `UPDATE relay_client SET status = ?, updated_at = ?
             WHERE id = ? AND relay_pairing_id = ? AND account_id = ? AND status = 'pending'`,
          )
          .run(status, this.#now().toISOString(), scope.id, scope.relayPairingId, scope.accountId)
          .changes,
      );
    });
    return changed === 1;
  }

  async #onDecided(d: {
    accountId: string;
    requestId: string;
    decision: 'approved' | 'denied' | 'expired';
    deviceId: string | null;
    relayClientId: string | null;
  }): Promise<void> {
    if (!d.relayClientId) return;
    // The decision names the client and the request; both must match the row (and its account).
    const row = this.#db.raw
      .prepare(
        `SELECT * FROM relay_client
         WHERE id = ? AND account_id = ? AND request_id = ? AND status = 'pending'`,
      )
      .get(d.relayClientId, d.accountId, d.requestId) as ClientRow | undefined;
    if (!row) return;
    const scope = { id: row.id, relayPairingId: row.relay_pairing_id, accountId: row.account_id };
    const reg = this.#regById(row.registration_id);
    const token = reg ? await this.#secrets.get(reg.token_ref) : null;
    if (d.decision !== 'approved') {
      if (!(await this.#setPendingStatus(scope, d.decision === 'expired' ? 'expired' : 'denied')))
        return;
      if (reg && token)
        await this.#http(
          'DELETE',
          reg.url,
          `/v1/relay/routes/${row.route_id}`,
          undefined,
          token,
        ).catch(() => undefined);
      await this.#auditAppend(row.account_id, 'relay.pair', row.id, {
        decision: d.decision,
        detail: { requestId: d.requestId, name: row.name, platform: row.platform },
      });
      return;
    }
    // Confirm at the Relay first: only then does it route the client. A failure is retried when
    // the Hub next connects (#reconcile).
    if (reg && token) {
      const res = await this.#http(
        'POST',
        reg.url,
        `/v1/relay/pairings/${row.relay_pairing_id}/confirm`,
        {},
        token,
      ).catch((err: unknown) => ({ status: 0, json: { error: { message: errText(err) } } }));
      if (res.status !== 200)
        this.#log.warn('the Relay did not confirm a pairing yet', {
          status: res.status,
          clientId: row.id,
        });
    }
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE relay_client SET status = 'active', device_id = ?, updated_at = ?
           WHERE id = ? AND account_id = ? AND status = 'pending'`,
        )
        .run(d.deviceId, now, row.id, row.account_id);
      if (d.deviceId) {
        // The device record (0005) has columns for its Relay ids.
        try {
          this.#db.raw
            .prepare('UPDATE device SET relay_client_id = ?, relay_route_id = ? WHERE id = ?')
            .run(row.id, row.route_id, d.deviceId);
        } catch (err) {
          this.#log.warn('could not record the Relay ids on the device', { err });
        }
      }
    });
    await this.#events
      .emit({
        name: 'relay.client.paired',
        actor: 'user',
        accountId: row.account_id,
        payload: { clientId: row.id, deviceId: d.deviceId, name: row.name, platform: row.platform },
      })
      .catch(() => undefined);
    await this.#auditAppend(row.account_id, 'relay.pair', row.id, {
      decision: 'approved',
      detail: {
        requestId: d.requestId,
        deviceId: d.deviceId,
        name: row.name,
        platform: row.platform,
      },
    });
    // Tell the client: it then fetches its grant through the tunnel.
    this.#peers.delete(row.id);
    const peer = await this.#loadPeer(row.id);
    if (peer) this.#notice(peer, { t: 'paired', requestId: d.requestId, deviceId: d.deviceId });
  }

  #regById(id: string): RegistrationRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM relay_registration WHERE id = ?').get(id) as
        RegistrationRow | undefined) ?? null
    );
  }

  async #setClientStatus(
    id: string,
    accountId: string,
    status: ClientRow['status'],
  ): Promise<void> {
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE relay_client SET status = ?, updated_at = ?,
             revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END
           WHERE id = ? AND account_id = ?`,
        )
        .run(status, now, status, now, id, accountId);
    });
    const peer = this.#peers.get(id);
    if (peer) {
      this.#closePeer(peer);
      this.#peers.delete(id);
    }
  }

  async #deleteRoute(routeId: string): Promise<void> {
    const reg = this.#reg;
    const token = reg ? await this.#secrets.get(reg.token_ref) : null;
    if (!reg || !token) return;
    await this.#http('DELETE', reg.url, `/v1/relay/routes/${routeId}`, undefined, token);
  }

  // ---- the registry --------------------------------------------------------------------------

  listClients(accountId: string): RelayClientView[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT c.*, r.url AS relay_url FROM relay_client c
         JOIN relay_registration r ON r.id = c.registration_id
         WHERE c.account_id = ? ORDER BY c.created_at DESC`,
      )
      .all(accountId) as unknown as (ClientRow & { relay_url: string })[];
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      requestId: r.request_id,
      name: r.name,
      platform: r.platform,
      kind: r.kind,
      status: r.status,
      routeId: r.route_id,
      relayUrl: r.relay_url,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      revokedAt: r.revoked_at,
    }));
  }

  /**
   * Revoke a paired client (docs/22 §3.1): the Relay stops routing it (open connections close with
   * `revoked`), its key stays refused for new pairings, and the Hub drops its envelopes. A Relay
   * that cannot be reached now is told when the Hub next connects.
   */
  async revokeClient(
    accountId: string,
    clientId: string,
    opts: { actor?: string; cascade?: boolean } = {},
  ): Promise<RelayClientView> {
    const row = this.#db.raw
      .prepare('SELECT * FROM relay_client WHERE id = ? AND account_id = ?')
      .get(clientId, accountId) as ClientRow | undefined;
    if (!row) throw new NovaError('not_found', 'no such paired client');
    if (row.status !== 'revoked') {
      await this.#setClientStatus(row.id, accountId, 'revoked');
      const reg = this.#regById(row.registration_id);
      const token = reg ? await this.#secrets.get(reg.token_ref) : null;
      let relay = 'unreachable';
      if (reg && token) {
        const res = await this.#http(
          'DELETE',
          reg.url,
          `/v1/relay/routes/${row.route_id}`,
          undefined,
          token,
        ).catch(() => null);
        relay = res
          ? res.status === 200 || res.status === 404
            ? 'removed'
            : `status ${res.status}`
          : relay;
      }
      await this.#events
        .emit({
          name: 'relay.client.revoked',
          actor: opts.actor === 'system' ? 'system' : 'user',
          accountId,
          payload: { clientId: row.id, deviceId: row.device_id },
        })
        .catch(() => undefined);
      await this.#auditAppend(accountId, 'relay.revoke', row.id, {
        actor: opts.actor ?? 'user',
        detail: { deviceId: row.device_id, name: row.name, relay },
      });
      if (opts.cascade !== false && row.device_id && this.#onRevoked) {
        try {
          await this.#onRevoked(accountId, row.device_id);
        } catch (err) {
          this.#log.warn('revoking the paired device failed', { err, deviceId: row.device_id });
        }
      }
    }
    return this.listClients(accountId).find((c) => c.id === clientId)!;
  }

  /** The device was revoked elsewhere (Add Device, Devices): revoke its Relay client too. */
  async revokeDevice(accountId: string, deviceId: string): Promise<void> {
    const rows = this.#db.raw
      .prepare(
        `SELECT id FROM relay_client WHERE account_id = ? AND device_id = ? AND status != 'revoked'`,
      )
      .all(accountId, deviceId) as { id: string }[];
    for (const r of rows)
      await this.revokeClient(accountId, r.id, { actor: 'system', cascade: false });
  }

  /** `POST /api/v1/relay/test`: the Relay's health route and this connection's state. */
  async test(): Promise<RelayTestResult> {
    const s = await this.#o.settings();
    const url = s.url.trim() || null;
    const status = this.status();
    if (!url)
      return {
        ok: false,
        url: null,
        reachable: false,
        latencyMs: null,
        version: null,
        state: status.state,
        detail: 'no Relay URL is set',
      };
    const t0 = Date.now();
    try {
      const res = await this.#http('GET', url, '/v1/relay/health');
      const reachable = res.status === 200 && res.json.status === 'ok';
      return {
        ok: reachable && (!s.enabled || status.state === 'connected'),
        url,
        reachable,
        latencyMs: Date.now() - t0,
        version: typeof res.json.version === 'string' ? res.json.version : null,
        state: status.state,
        detail: reachable ? status.detail : `the Relay answered ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        url,
        reachable: false,
        latencyMs: null,
        version: null,
        state: status.state,
        detail: errText(err),
      };
    }
  }

  /** The Relay as an endpoint candidate (FR-135): healthy while the connection is up. */
  endpointSource(): {
    transport: 'relay';
    list(): Promise<RelayEndpointCandidate[]>;
    check(): Promise<{ ok: boolean; latencyMs: number | null; detail: string | null }>;
  } {
    return {
      transport: 'relay',
      // The Relay is not a Hub: its health is this connector's state, whatever the URL scheme
      // (an http:// Relay must never get the Hub's hello probe).
      check: () => {
        const s = this.status();
        return Promise.resolve(
          s.state === 'connected'
            ? { ok: true, latencyMs: s.latencyMs, detail: null }
            : { ok: false, latencyMs: null, detail: s.detail ?? s.state },
        );
      },
      list: () => {
        const s = this.status();
        if (!s.url || s.state === 'disabled' || s.state === 'unconfigured')
          return Promise.resolve([]);
        return Promise.resolve([
          {
            transport: 'relay',
            url: s.url,
            priority: 3,
            health: s.state === 'connected' ? 'ok' : 'failing',
            latencyMs: s.latencyMs,
            checkedAt: s.since,
            detail: s.detail,
          },
        ]);
      },
    };
  }

  async #auditAppend(
    accountId: string,
    action: string,
    resource: string,
    extra: { decision?: string; actor?: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor: extra.actor ?? 'user',
        kind: 'network',
        action,
        resource,
        ...(extra.decision ? { decision: extra.decision } : {}),
        detail: extra.detail ?? {},
      });
    } catch (err) {
      this.#log.warn('relay audit failed', { err, action });
    }
  }
}
