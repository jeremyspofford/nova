// One persistent outbound WebSocket to a Relay (FR-137, docs/22 §3.1): authenticates with the
// route token, keeps alive with `ping` every 25 s (the Relay answers each with a `pong`), closes
// after 3 missed pongs and reconnects with exponential backoff and jitter. A `revoked` close or an
// unauthorized route token stops reconnecting. Works with the browser WebSocket API, so the token
// travels as a subprotocol (`bearer.<token>`) rather than a header.
import {
  encodeEnvelope,
  parseEnvelope,
  type RelayCloseReason,
  type RelayEnvelope,
} from './envelope.ts';
import { systemTimers, type Timers } from './timers.ts';

export const RELAY_SUBPROTOCOL = 'nova-relay.v1';
export const PING_INTERVAL_MS = 25_000;
export const MISSED_PONGS = 3;

/** WebSocket close codes the Relay uses next to the `close` frame's reason. */
export const CLOSE_CODES: Record<RelayCloseReason | 'unauthorized' | 'keepalive', number> = {
  normal: 1000,
  too_large: 1009,
  unauthorized: 4001,
  revoked: 4003,
  unknown_route: 4004,
  idle: 4008,
  keepalive: 4009,
};

/** The subset of the WebSocket API used here (browser WebSocket, Node's global, or a fake). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export const defaultWebSocket: WebSocketFactory = (url, protocols) =>
  new globalThis.WebSocket(url, protocols) as unknown as WebSocketLike;

/** `https://relay.example` or `wss://relay.example` → the HTTP(S) URL of an endpoint path. */
export function relayHttpUrl(base: string, path: string): string {
  const u = new URL(base);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported Relay URL');
  u.pathname = `${u.pathname.replace(/\/+$/, '')}${path}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Whether a Relay URL protects the route token and pairing metadata in transit: https/wss, or
 * plain http/ws only to this machine (loopback). The envelopes are sealed either way.
 */
export function isSecureRelayUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The WebSocket URL of `GET /v1/relay/connect`. */
export function relayConnectUrl(base: string): string {
  const u = new URL(relayHttpUrl(base, '/v1/relay/connect'));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export type ConnectionState =
  'idle' | 'connecting' | 'open' | 'closed' | 'revoked' | 'unauthorized' | 'stopped';

export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  /** ± fraction of the delay (default 0.2). */
  jitter?: number;
}

export interface RelayConnectionOptions {
  url: string;
  token: string | (() => Promise<string>);
  onEnvelope: (env: RelayEnvelope) => void;
  onState?: (state: ConnectionState, detail: string | null) => void;
  /** An inbound frame that failed validation. */
  onInvalid?: (error: string) => void;
  webSocket?: WebSocketFactory;
  timers?: Timers;
  pingIntervalMs?: number;
  missedPongs?: number;
  backoff?: BackoffOptions;
  random?: () => number;
  /** The route this side pings as (its own routing id). */
  routeId: string;
}

export class RelayConnection {
  readonly #o: RelayConnectionOptions;
  readonly #t: Timers;
  #ws: WebSocketLike | null = null;
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #retryTimer: unknown = null;
  #pingTimer: unknown = null;
  #awaitingPong = false;
  #missed = 0;
  #pingSentAt = 0;
  #rtt: number | null = null;
  #ending: ConnectionState | null = null;

  constructor(opts: RelayConnectionOptions) {
    this.#o = opts;
    this.#t = opts.timers ?? systemTimers;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Round trip of the last ping, in ms. */
  get rttMs(): number | null {
    return this.#rtt;
  }

  start(): void {
    if (this.#state !== 'idle') return;
    void this.#connect();
  }

  stop(): void {
    this.#setState('stopped', null);
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(CLOSE_CODES.normal, 'normal');
      } catch {
        // already closed
      }
    }
  }

  send(env: RelayEnvelope): boolean {
    if (this.#state !== 'open' || !this.#ws) return false;
    try {
      this.#ws.send(encodeEnvelope(env));
      return true;
    } catch {
      return false;
    }
  }

  #setState(state: ConnectionState, detail: string | null): void {
    if (this.#state === 'stopped') return;
    this.#state = state;
    this.#o.onState?.(state, detail);
  }

  #clearTimers(): void {
    if (this.#retryTimer !== null) this.#t.clearTimeout(this.#retryTimer);
    if (this.#pingTimer !== null) this.#t.clearTimeout(this.#pingTimer);
    this.#retryTimer = this.#pingTimer = null;
  }

  async #connect(): Promise<void> {
    this.#retryTimer = null;
    this.#ending = null;
    this.#setState('connecting', null);
    let token: string;
    try {
      token = typeof this.#o.token === 'string' ? this.#o.token : await this.#o.token();
    } catch (err) {
      this.#scheduleRetry(err instanceof Error ? err.message : 'no route token');
      return;
    }
    if (this.#state !== 'connecting') return;
    let ws: WebSocketLike;
    try {
      ws = (this.#o.webSocket ?? defaultWebSocket)(relayConnectUrl(this.#o.url), [
        RELAY_SUBPROTOCOL,
        `bearer.${token}`,
      ]);
    } catch (err) {
      this.#scheduleRetry(err instanceof Error ? err.message : 'connect failed');
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#attempt = 0;
      this.#awaitingPong = false;
      this.#missed = 0;
      this.#setState('open', null);
      this.#armPing();
    };
    ws.onmessage = (ev) => {
      if (this.#ws !== ws) return;
      if (typeof ev.data !== 'string') {
        this.#o.onInvalid?.('binary frame');
        return;
      }
      const check = parseEnvelope(ev.data);
      if (!check.ok) {
        this.#o.onInvalid?.(check.error);
        return;
      }
      const env = check.envelope;
      if (env.kind === 'pong') {
        this.#awaitingPong = false;
        this.#missed = 0;
        this.#rtt = this.#t.now() - this.#pingSentAt;
        return;
      }
      if (env.kind === 'ping') {
        this.send({ v: 1, kind: 'pong', to: env.from, from: env.to });
        return;
      }
      if (env.kind === 'close' && env.reason === 'revoked') this.#ending = 'revoked';
      this.#o.onEnvelope(env);
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#pingTimer !== null) this.#t.clearTimeout(this.#pingTimer);
      this.#pingTimer = null;
      if (this.#ending === 'revoked' || ev.code === CLOSE_CODES.revoked) {
        this.#setState('revoked', 'the Relay revoked this route');
        return;
      }
      if (ev.code === CLOSE_CODES.unauthorized) {
        this.#setState('unauthorized', 'the Relay refused the route token');
        return;
      }
      this.#scheduleRetry(ev.reason || `closed (${ev.code})`);
    };
  }

  #scheduleRetry(detail: string): void {
    if (this.#state === 'stopped') return;
    this.#setState('closed', detail);
    const b = this.#o.backoff ?? {};
    const initial = b.initialMs ?? 1_000;
    const max = b.maxMs ?? 30_000;
    const factor = b.factor ?? 2;
    const jitter = b.jitter ?? 0.2;
    const base = Math.min(max, initial * Math.pow(factor, this.#attempt));
    const delay = Math.max(
      0,
      Math.round(base * (1 + jitter * (2 * (this.#o.random ?? Math.random)() - 1))),
    );
    this.#attempt++;
    this.#retryTimer = this.#t.setTimeout(() => void this.#connect(), delay);
  }

  #armPing(): void {
    this.#pingTimer = this.#t.setTimeout(
      () => this.#tick(),
      this.#o.pingIntervalMs ?? PING_INTERVAL_MS,
    );
  }

  #tick(): void {
    this.#pingTimer = null;
    const ws = this.#ws;
    if (!ws || this.#state !== 'open') return;
    if (this.#awaitingPong) this.#missed++;
    if (this.#missed >= (this.#o.missedPongs ?? MISSED_PONGS)) {
      // The connection is dead without knowing it: drop it and reconnect.
      this.#ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(CLOSE_CODES.keepalive, 'keepalive');
      } catch {
        // ignore
      }
      this.#scheduleRetry('no pong from the Relay');
      return;
    }
    this.#awaitingPong = true;
    this.#pingSentAt = this.#t.now();
    this.send({ v: 1, kind: 'ping', to: this.#o.routeId, from: this.#o.routeId });
    this.#armPing();
  }
}
