// A client of the Hub through a Relay (FR-137, docs/22 §3.1): pairing by QR or code, then a
// `fetch` that tunnels Hub API requests over the sealed session, with streamed responses (the
// event stream works through it). Runs in browsers (the PWA) and in Node.
import { fromBase64, fromBase64Url, randomId, toBase64, toBase64Url } from './bytes.ts';
import {
  PAIRING_KDF_ITERATIONS,
  deriveSessionKeys,
  generateX25519,
  pairingSecrets,
  type Ed25519Signer,
} from './crypto.ts';
import {
  RelayConnection,
  relayHttpUrl,
  type BackoffOptions,
  type ConnectionState,
  type WebSocketFactory,
} from './connection.ts';
import type { RelayEnvelope } from './envelope.ts';
import { confirmationCode, createClaim, openOffer, type RelayClientKind } from './pairing.ts';
import { RelaySession, type DropReason } from './session.ts';
import { StreamGuard, StreamIds, streamCounter } from './streams.ts';
import { systemTimers, type Timers } from './timers.ts';
import { decodeTunnel, encodeTunnel, type TunnelMessage } from './tunnel.ts';

/** What a paired client keeps (secret: store it like a session token). */
export interface PairedClient {
  v: 1;
  relayUrl: string;
  hubRoute: string;
  clientRoute: string;
  clientId: string;
  routeToken: string;
  /** Session keys, base64url: the client seals with `sendKey` and opens with `recvKey`. */
  sendKey: string;
  recvKey: string;
}

export class RelayError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

export interface PairWithRelayInput {
  relayUrl: string;
  relayPairingId: string;
  code: string;
  /** The device identity (Add Device's Ed25519 key). */
  device: Ed25519Signer;
  name: string;
  platform: string;
  kind?: RelayClientKind;
  /** The Hub fingerprint from the QR payload, when it carries one. */
  pin?: string | null;
  fetch?: typeof globalThis.fetch;
  kdfIterations?: number;
}

export interface PairWithRelayResult {
  paired: PairedClient;
  /** The Add Device pairing this joined (for the status poll). */
  addPairingId: string;
  hubFingerprint: string | null;
  /** Show this; the owner approves on the Hub when both screens match. */
  confirmation: string;
}

/** Claim a Relay pairing slot with the code; the Hub still has to approve (docs/22 §9.4). */
export async function pairWithRelay(input: PairWithRelayInput): Promise<PairWithRelayResult> {
  const doFetch = input.fetch ?? globalThis.fetch;
  const secrets = await pairingSecrets(
    input.code,
    input.relayPairingId,
    input.kdfIterations ?? PAIRING_KDF_ITERATIONS,
  );
  const x = await generateX25519();
  const blob = await createClaim({
    claimKey: secrets.claimKey,
    relayPairingId: input.relayPairingId,
    code: input.code,
    device: input.device,
    x25519: x.publicKey,
    name: input.name,
    platform: input.platform,
    kind: input.kind ?? 'browser',
  });
  const url = relayHttpUrl(
    input.relayUrl,
    `/v1/relay/pairings/${encodeURIComponent(input.relayPairingId)}/claim`,
  );
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeHash: secrets.codeHash, blob }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { code?: string; message?: string };
    throw new RelayError(
      err.code ?? 'pairing_failed',
      err.message ?? 'the Relay refused the claim',
      res.status,
    );
  }
  const s = (k: string): string => {
    const v = json[k];
    if (typeof v !== 'string')
      throw new RelayError('pairing_failed', `the Relay answer has no ${k}`);
    return v;
  };
  const hubRoute = s('hubRouteId');
  const offer = await openOffer({
    offerKey: secrets.offerKey,
    relayPairingId: input.relayPairingId,
    sealed: s('offer'),
    hubRoute,
    pin: input.pin ?? null,
  });
  const clientRoute = s('routeId');
  const clientId = s('clientId');
  const keys = await deriveSessionKeys('client', x.privateKey, {
    hubRoute,
    clientRoute,
    clientId,
    hubX25519: offer.x25519,
    clientX25519: x.publicKey,
  });
  return {
    paired: {
      v: 1,
      relayUrl: input.relayUrl,
      hubRoute,
      clientRoute,
      clientId,
      routeToken: s('routeToken'),
      sendKey: toBase64Url(keys.send),
      recvKey: toBase64Url(keys.recv),
    },
    addPairingId: offer.addPairingId,
    hubFingerprint: offer.fingerprint,
    confirmation: await confirmationCode({
      hubFingerprint: offer.fingerprint,
      pairingId: offer.addPairingId,
      publicKey: input.device.publicKey,
      code: input.code,
    }),
  };
}

export interface RelayClientOptions {
  paired: PairedClient;
  webSocket?: WebSocketFactory;
  timers?: Timers;
  backoff?: BackoffOptions;
  pingIntervalMs?: number;
  retransmitMs?: number;
  /** A request with no response head after this long fails (default 60 s). */
  requestTimeoutMs?: number;
  /** The highest Hub stream counter seen before a restart (store it with `onHubFloor`). */
  hubStreamFloor?: number;
  onHubFloor?: (floor: number) => void;
  onState?: (state: ConnectionState, detail: string | null) => void;
  onDrop?: (reason: DropReason, info: { stream?: string; seq?: number }) => void;
}

export interface TunnelFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

interface Exchange {
  req: Extract<TunnelMessage, { t: 'req' }>;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  headTimer: unknown;
  head: boolean;
  retried: boolean;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A paired client's connection to its Hub through the Relay. */
export class RelayClient {
  readonly paired: PairedClient;
  readonly #t: Timers;
  readonly #o: RelayClientOptions;
  readonly #conn: RelayConnection;
  readonly #session: RelaySession;
  readonly #ids: StreamIds;
  readonly #exchanges = new Map<string, Exchange>();
  readonly #pairedWaiters: ((v: { requestId: string | null; deviceId: string | null }) => void)[] =
    [];
  #pairedInfo: { requestId: string | null; deviceId: string | null } | null = null;
  #revoked = false;

  constructor(opts: RelayClientOptions) {
    this.paired = opts.paired;
    this.#o = opts;
    this.#t = opts.timers ?? systemTimers;
    this.#ids = new StreamIds('c', { now: () => this.#t.now() });
    const guard = new StreamGuard('h', {
      floor: opts.hubStreamFloor ?? 0,
      ...(opts.onHubFloor ? { persist: opts.onHubFloor } : {}),
    });
    const p = opts.paired;
    this.#session = new RelaySession({
      clientId: p.clientId,
      localRoute: p.clientRoute,
      remoteRoute: p.hubRoute,
      keys: { send: fromBase64Url(p.sendKey), recv: fromBase64Url(p.recvKey) },
      transmit: (env) => this.#conn.send(env),
      onMessage: (stream, data) => this.#onMessage(stream, data),
      acceptStream: (stream) => guard.accept(stream),
      onStreamFailed: (stream) =>
        this.#fail(stream, new RelayError('timeout', 'the Hub did not answer')),
      timers: this.#t,
      ...(opts.retransmitMs ? { retransmitMs: opts.retransmitMs } : {}),
      ...(opts.onDrop ? { onDrop: opts.onDrop } : {}),
    });
    this.#conn = new RelayConnection({
      url: p.relayUrl,
      token: p.routeToken,
      routeId: p.clientRoute,
      timers: this.#t,
      ...(opts.webSocket ? { webSocket: opts.webSocket } : {}),
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
      ...(opts.pingIntervalMs ? { pingIntervalMs: opts.pingIntervalMs } : {}),
      onEnvelope: (env) => this.#onEnvelope(env),
      onState: (state, detail) => {
        this.#session.setConnected(state === 'open');
        if (state === 'revoked' || state === 'unauthorized') {
          this.#revoked = true;
          for (const stream of [...this.#exchanges.keys()])
            this.#fail(stream, new RelayError('revoked', 'this device was removed from the Relay'));
        }
        opts.onState?.(state, detail);
      },
    });
  }

  get state(): ConnectionState {
    return this.#conn.state;
  }

  start(): void {
    this.#conn.start();
  }

  stop(): void {
    for (const stream of [...this.#exchanges.keys()])
      this.#fail(stream, new RelayError('closed', 'the Relay client stopped'));
    this.#conn.stop();
    this.#session.close();
  }

  /** Resolves when the Hub reports the owner's approval of this pairing. */
  waitForPaired(): Promise<{ requestId: string | null; deviceId: string | null }> {
    if (this.#pairedInfo) return Promise.resolve(this.#pairedInfo);
    return new Promise((resolve) => this.#pairedWaiters.push(resolve));
  }

  /** A Hub API request through the tunnel; `path` starts with `/api/v1/`. */
  fetch(path: string, init: TunnelFetchInit = {}): Promise<Response> {
    if (this.#revoked)
      return Promise.reject(new RelayError('revoked', 'this device was removed from the Relay'));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const body =
      init.body === undefined
        ? undefined
        : toBase64(typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body);
    const req: Exchange['req'] = {
      t: 'req',
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      headers,
      ...(body !== undefined ? { body } : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      if (init.signal?.aborted) {
        reject(new RelayError('aborted', 'the request was aborted'));
        return;
      }
      this.#begin({
        req,
        resolve,
        reject,
        controller: null,
        headTimer: null,
        head: false,
        retried: false,
        signal: init.signal,
        onAbort: null,
      });
    });
  }

  #begin(ex: Exchange): void {
    const stream = this.#ids.next();
    // A fresh id per attempt: the Hub echoes it, so an answer can only belong to this request.
    ex.req = { ...ex.req, id: randomId() };
    this.#exchanges.set(stream, ex);
    ex.headTimer = this.#t.setTimeout(
      () => this.#fail(stream, new RelayError('timeout', 'the Hub did not answer in time')),
      this.#o.requestTimeoutMs ?? 60_000,
    );
    if (ex.signal) {
      ex.onAbort = () => {
        this.#cancel(stream);
        this.#fail(stream, new RelayError('aborted', 'the request was aborted'));
      };
      ex.signal.addEventListener('abort', ex.onAbort, { once: true });
    }
    this.#session.openStream(stream);
    this.#session.send(stream, encodeTunnel(ex.req));
  }

  #cancel(stream: string): void {
    if (!this.#session.hasStream(stream)) return;
    try {
      this.#session.send(stream, encodeTunnel({ t: 'cancel' }));
      this.#session.closeStream(stream);
    } catch {
      this.#session.abortStream(stream);
    }
  }

  #settle(stream: string, ex: Exchange): void {
    this.#exchanges.delete(stream);
    this.#t.clearTimeout(ex.headTimer);
    if (ex.signal && ex.onAbort) ex.signal.removeEventListener('abort', ex.onAbort);
  }

  #fail(stream: string, err: Error): void {
    const ex = this.#exchanges.get(stream);
    if (!ex) return;
    this.#settle(stream, ex);
    if (!ex.head) ex.reject(err);
    else {
      try {
        ex.controller?.error(err);
      } catch {
        // already closed
      }
    }
    this.#session.abortStream(stream);
  }

  #onEnvelope(env: RelayEnvelope): void {
    if (env.kind === 'data' || env.kind === 'ack') this.#session.receive(env);
  }

  #onMessage(stream: string, data: Uint8Array): void {
    const msg = decodeTunnel(data);
    if (stream.startsWith('h')) {
      // A Hub-opened stream carries one notice.
      this.#session.closeStream(stream);
      if (msg?.t === 'paired') {
        this.#pairedInfo = { requestId: msg.requestId, deviceId: msg.deviceId };
        for (const fn of this.#pairedWaiters.splice(0)) fn(this.#pairedInfo);
      } else if (msg?.t === 'stale') {
        this.#ids.skipPast(msg.floor);
        this.#retryStale(msg.stream);
      }
      return;
    }
    const ex = this.#exchanges.get(stream);
    if (!ex || !msg) return;
    switch (msg.t) {
      case 'head': {
        if (ex.head) return;
        if (msg.id !== ex.req.id) {
          this.#fail(stream, new RelayError('bad_response', 'the answer is not for this request'));
          return;
        }
        ex.head = true;
        this.#t.clearTimeout(ex.headTimer);
        const nullBody = NULL_BODY.has(msg.status) || ex.req.method === 'HEAD';
        const body = nullBody
          ? null
          : new ReadableStream<Uint8Array>({
              start: (c) => {
                ex.controller = c;
              },
              cancel: () => {
                const live = this.#exchanges.get(stream);
                if (live) this.#settle(stream, live);
                this.#cancel(stream);
              },
            });
        ex.resolve(new Response(body, { status: msg.status, headers: msg.headers }));
        return;
      }
      case 'body':
        try {
          ex.controller?.enqueue(fromBase64(msg.data));
        } catch {
          this.#fail(stream, new RelayError('bad_body', 'the Hub sent a malformed body chunk'));
        }
        return;
      case 'end':
        this.#settle(stream, ex);
        try {
          ex.controller?.close();
        } catch {
          // the reader cancelled
        }
        this.#session.closeStream(stream);
        return;
      case 'error':
        if (msg.id !== undefined && msg.id !== ex.req.id) {
          this.#fail(stream, new RelayError('bad_response', 'the answer is not for this request'));
          return;
        }
        this.#fail(stream, new RelayError(msg.code, msg.message));
        return;
      default:
        return;
    }
  }

  /** The Hub refused a request stream as stale: send it again once on a fresh stream. */
  #retryStale(stream: string): void {
    const ex = this.#exchanges.get(stream);
    if (!ex || ex.head) return;
    const id = streamCounter(stream);
    if (!id) return;
    this.#settle(stream, ex);
    this.#session.abortStream(stream);
    // Only a read is sent again: a write may have run before the Hub restarted.
    const idempotent = ex.req.method === 'GET' || ex.req.method === 'HEAD';
    if (ex.retried || !idempotent) {
      ex.reject(new RelayError('stale_stream', 'the Hub refused the request as a replay'));
      return;
    }
    ex.retried = true;
    this.#begin(ex);
  }
}
