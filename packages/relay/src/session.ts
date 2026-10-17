// The reliable, sealed session between the Hub and one paired client (FR-137, docs/22 §3.1,
// contracts/rest-api.md §3.2). Per stream: messages up to 16 MiB split into 64 KiB segments, each
// sealed with client, stream, seq and seg as associated data; in-order delivery; cumulative acks
// (standalone or riding on data frames); a bounded send window of unacked segments; retransmit
// after 5 s without an ack; on reconnect, resending everything after the last acked seq;
// duplicates and sequence numbers outside the receive window dropped; incomplete messages
// discarded after 60 s.
//
// Acks travel outside the seal (the schema gives ack frames no ct). A forged ack can only make the
// sender stop resending, which a Relay could achieve anyway by dropping frames: it never lets
// altered or replayed data through.
import { concatBytes } from './bytes.ts';
import { open, seal, type SessionKeys } from './crypto.ts';
import {
  MAX_MESSAGE_BYTES,
  MAX_SEGMENTS,
  SEGMENT_BYTES,
  associatedData,
  type RelayEnvelope,
} from './envelope.ts';
import { systemTimers, type Timers } from './timers.ts';

export type DropReason =
  | 'route_mismatch'
  | 'duplicate'
  | 'out_of_window'
  | 'bad_seal'
  | 'bad_segment'
  | 'stale_stream'
  | 'too_many_streams'
  | 'refused_stream'
  | 'buffer_full'
  | 'closed_stream'
  | 'reassembly_timeout';

export interface RelaySessionOptions {
  clientId: string;
  localRoute: string;
  remoteRoute: string;
  keys: SessionKeys;
  /** Hand one envelope to the connection; false while it is down (the session resends later). */
  transmit: (env: RelayEnvelope) => boolean;
  /** One whole message, in order per stream. */
  onMessage: (stream: string, data: Uint8Array) => void;
  /**
   * A stream the peer opened: false refuses it (the replay guard, streams.ts). A promise holds
   * back delivery (and acks) until it settles, so the Hub can store its replay floor before a
   * request runs; false or a rejection refuses the stream.
   */
  acceptStream?: (stream: string) => boolean | Promise<boolean>;
  /** A data frame opened with the session key: the peer is really there (last-seen times). */
  onAuthenticated?: (stream: string) => void;
  onDrop?: (reason: DropReason, info: { stream?: string; seq?: number }) => void;
  /** A stream whose sends saw no ack for `streamTimeoutMs` while connected. */
  onStreamFailed?: (stream: string, reason: 'timeout') => void;
  /** The stream's send queue emptied (everything sent was acked). */
  onDrain?: (stream: string) => void;
  timers?: Timers;
  /** Unacked segments per stream, and the receive window in seqs (default 256). */
  window?: number;
  retransmitMs?: number;
  reassemblyTimeoutMs?: number;
  /** A standalone ack waits this long for a data frame to ride on (default 20 ms). */
  ackDelayMs?: number;
  /** Give up on a stream after this long without ack progress while connected (default 120 s). */
  streamTimeoutMs?: number;
  /** Closed streams remembered to re-ack stragglers (default 1024). */
  tombstones?: number;
  /** Open streams at once; a peer opening more is refused (default 512). */
  maxStreams?: number;
  /**
   * Received bytes held for reassembly or in-order delivery across all streams (default
   * 32 MiB, plus one message in order); a segment beyond it is dropped and comes again with the
   * sender's retransmit.
   */
  maxBufferedBytes?: number;
}

export const DEFAULT_WINDOW = 256;
export const RETRANSMIT_MS = 5_000;
export const REASSEMBLY_TIMEOUT_MS = 60_000;

interface OutSegment {
  env: RelayEnvelope;
  seq: number;
  bytes: number;
}

interface Partial {
  n: number;
  parts: (Uint8Array | undefined)[];
  have: number;
  bytes: number;
  timer: unknown;
  complete: Uint8Array | null;
}

interface StreamState {
  id: string;
  nextSeq: number;
  acked: number;
  inflight: OutSegment[];
  queued: OutSegment[];
  pendingBytes: number;
  retransmitTimer: unknown;
  lastProgress: number;
  closing: boolean;
  delivered: number;
  partial: Map<number, Partial>;
  ackTimer: unknown;
  ackDue: boolean;
  /** Set while the stream waits for `acceptStream`'s verdict. */
  gate: Promise<boolean> | null;
}

export class RelaySession {
  readonly clientId: string;
  readonly #o: Required<
    Omit<
      RelaySessionOptions,
      'acceptStream' | 'onDrop' | 'onStreamFailed' | 'onDrain' | 'onAuthenticated' | 'keys'
    >
  > &
    Pick<
      RelaySessionOptions,
      'acceptStream' | 'onDrop' | 'onStreamFailed' | 'onDrain' | 'onAuthenticated'
    >;
  readonly #keys: SessionKeys;
  readonly #streams = new Map<string, StreamState>();
  readonly #tombstones = new Map<string, number>();
  #connected = false;
  #closed = false;
  #buffered = 0;

  constructor(opts: RelaySessionOptions) {
    this.clientId = opts.clientId;
    this.#keys = opts.keys;
    this.#o = {
      clientId: opts.clientId,
      localRoute: opts.localRoute,
      remoteRoute: opts.remoteRoute,
      transmit: opts.transmit,
      onMessage: opts.onMessage,
      acceptStream: opts.acceptStream,
      onDrop: opts.onDrop,
      onStreamFailed: opts.onStreamFailed,
      onDrain: opts.onDrain,
      onAuthenticated: opts.onAuthenticated,
      timers: opts.timers ?? systemTimers,
      window: opts.window ?? DEFAULT_WINDOW,
      retransmitMs: opts.retransmitMs ?? RETRANSMIT_MS,
      reassemblyTimeoutMs: opts.reassemblyTimeoutMs ?? REASSEMBLY_TIMEOUT_MS,
      ackDelayMs: opts.ackDelayMs ?? 20,
      streamTimeoutMs: opts.streamTimeoutMs ?? 120_000,
      tombstones: opts.tombstones ?? 1024,
      maxStreams: opts.maxStreams ?? 512,
      maxBufferedBytes: opts.maxBufferedBytes ?? 32 * 1024 * 1024,
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Streams with state (open or draining). */
  get streams(): string[] {
    return [...this.#streams.keys()];
  }

  /** Bytes queued or unacked on a stream (backpressure for producers). */
  pending(stream: string): number {
    return this.#streams.get(stream)?.pendingBytes ?? 0;
  }

  /** Received bytes held for reassembly or delivery. */
  get buffered(): number {
    return this.#buffered;
  }

  hasStream(stream: string): boolean {
    return this.#streams.has(stream);
  }

  /** Open a stream this side starts (so the peer's replies are accepted). */
  openStream(stream: string): void {
    if (!this.#streams.has(stream)) this.#streams.set(stream, this.#newStream(stream));
  }

  /** Queue one message; it is segmented, sealed and sent as the window allows. */
  send(stream: string, data: Uint8Array): void {
    if (this.#closed) throw new Error('session closed');
    if (data.length > MAX_MESSAGE_BYTES) throw new RangeError('message larger than 16 MiB');
    let st = this.#streams.get(stream);
    if (!st) {
      st = this.#newStream(stream);
      this.#streams.set(stream, st);
    }
    if (st.closing) throw new Error('stream is closing');
    const n = Math.max(1, Math.ceil(data.length / SEGMENT_BYTES));
    const seq = st.nextSeq++;
    for (let i = 0; i < n; i++) {
      const part = data.subarray(i * SEGMENT_BYTES, (i + 1) * SEGMENT_BYTES);
      const seg = { i, n };
      const env: RelayEnvelope = {
        v: 1,
        kind: 'data',
        to: this.#o.remoteRoute,
        from: this.#o.localRoute,
        client: this.clientId,
        stream,
        seq,
        seg,
        ct: seal(
          this.#keys.send,
          part,
          associatedData({ client: this.clientId, stream, seq, seg }),
        ),
      };
      st.queued.push({ env, seq, bytes: part.length });
      st.pendingBytes += part.length;
    }
    this.#pump(st);
  }

  /** Feed one envelope addressed to this client's session (data or ack). */
  receive(env: RelayEnvelope): void {
    if (this.#closed) return;
    if (
      env.client !== this.clientId ||
      env.from !== this.#o.remoteRoute ||
      env.to !== this.#o.localRoute
    ) {
      this.#drop('route_mismatch', env);
      return;
    }
    const stream = env.stream;
    if (stream === undefined) return;
    if (env.kind === 'ack') {
      const st = this.#streams.get(stream);
      if (st && env.ack !== undefined) this.#onAck(st, env.ack);
      return;
    }
    if (env.kind !== 'data' || env.seq === undefined || env.ct === undefined) return;
    this.#onData(stream, env, env.seq, env.ct);
  }

  /** The connection is up again: resend everything after the last ack, and our own acks. */
  setConnected(up: boolean): void {
    if (this.#closed || this.#connected === up) return;
    this.#connected = up;
    const t = this.#o.timers;
    for (const st of this.#streams.values()) {
      if (st.retransmitTimer !== null) t.clearTimeout(st.retransmitTimer);
      st.retransmitTimer = null;
      if (!up) continue;
      st.lastProgress = t.now();
      if (st.delivered > 0) this.#sendAck(st);
      for (const s of st.inflight) this.#transmit(st, s);
      this.#pump(st);
      this.#armRetransmit(st);
    }
  }

  /** Close a stream once everything sent on it is acked; late frames are then re-acked and dropped. */
  closeStream(stream: string): void {
    const st = this.#streams.get(stream);
    if (!st) return;
    st.closing = true;
    if (st.inflight.length === 0 && st.queued.length === 0) this.#finish(st);
  }

  /** Drop a stream now, sent or not (a cancelled request). */
  abortStream(stream: string): void {
    const st = this.#streams.get(stream);
    if (st) this.#finish(st);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const st of [...this.#streams.values()]) this.#finish(st);
    this.#tombstones.clear();
  }

  // ---- internals ----------------------------------------------------------------------------

  #newStream(id: string): StreamState {
    return {
      id,
      nextSeq: 1,
      acked: 0,
      inflight: [],
      queued: [],
      pendingBytes: 0,
      retransmitTimer: null,
      lastProgress: this.#o.timers.now(),
      closing: false,
      delivered: 0,
      partial: new Map(),
      ackTimer: null,
      ackDue: false,
      gate: null,
    };
  }

  #drop(reason: DropReason, env: { stream?: string | undefined; seq?: number | undefined }): void {
    const info: { stream?: string; seq?: number } = {};
    if (env.stream !== undefined) info.stream = env.stream;
    if (env.seq !== undefined) info.seq = env.seq;
    this.#o.onDrop?.(reason, info);
  }

  #transmit(st: StreamState, s: OutSegment): void {
    if (!this.#connected) return;
    // Our cumulative ack rides along, replacing a pending standalone ack.
    if (st.delivered > 0) {
      s.env.ack = st.delivered;
      st.ackDue = false;
    } else delete s.env.ack;
    this.#o.transmit(s.env);
  }

  #pump(st: StreamState): void {
    let sent = false;
    while (st.inflight.length < this.#o.window && st.queued.length > 0) {
      const s = st.queued.shift()!;
      st.inflight.push(s);
      this.#transmit(st, s);
      sent = true;
    }
    if (sent) this.#armRetransmit(st);
  }

  #armRetransmit(st: StreamState): void {
    if (!this.#connected || st.inflight.length === 0 || st.retransmitTimer !== null) return;
    st.retransmitTimer = this.#o.timers.setTimeout(
      () => this.#retransmit(st),
      this.#o.retransmitMs,
    );
  }

  #retransmit(st: StreamState): void {
    st.retransmitTimer = null;
    if (!this.#connected || st.inflight.length === 0 || this.#streams.get(st.id) !== st) return;
    if (this.#o.timers.now() - st.lastProgress >= this.#o.streamTimeoutMs) {
      this.#finish(st);
      this.#o.onStreamFailed?.(st.id, 'timeout');
      return;
    }
    for (const s of st.inflight) this.#transmit(st, s);
    this.#armRetransmit(st);
  }

  #onAck(st: StreamState, ack: number): void {
    // An ack for a seq never sent is bogus.
    if (ack <= st.acked || ack >= st.nextSeq) return;
    st.acked = ack;
    st.lastProgress = this.#o.timers.now();
    const keep: OutSegment[] = [];
    for (const s of st.inflight) {
      if (s.seq <= ack) st.pendingBytes -= s.bytes;
      else keep.push(s);
    }
    st.inflight = keep;
    if (st.retransmitTimer !== null) this.#o.timers.clearTimeout(st.retransmitTimer);
    st.retransmitTimer = null;
    this.#pump(st);
    this.#armRetransmit(st);
    if (st.inflight.length === 0 && st.queued.length === 0) {
      if (st.closing) this.#finish(st);
      this.#o.onDrain?.(st.id);
    }
  }

  #onData(stream: string, env: RelayEnvelope, seq: number, ct: string): void {
    const seg = env.seg ?? { i: 0, n: 1 };
    let st = this.#streams.get(stream);
    if (!st) {
      const tomb = this.#tombstones.get(stream);
      if (tomb !== undefined) {
        // A closed stream: re-ack what it delivered so the sender stops resending.
        if (seq <= tomb) this.#sendAckFrame(stream, tomb);
        this.#drop(seq <= tomb ? 'duplicate' : 'closed_stream', env);
        return;
      }
    }
    const delivered = st?.delivered ?? 0;
    if (seq <= delivered) {
      if (st) this.#scheduleAck(st);
      this.#drop('duplicate', env);
      return;
    }
    if (seq > delivered + this.#o.window) {
      this.#drop('out_of_window', env);
      return;
    }
    const part = open(
      this.#keys.recv,
      ct,
      associatedData({ client: this.clientId, stream, seq, seg }),
    );
    if (!part) {
      this.#drop('bad_seal', env);
      return;
    }
    if (part.length > SEGMENT_BYTES || seg.n > MAX_SEGMENTS || seg.i >= seg.n) {
      this.#drop('bad_segment', env);
      return;
    }
    this.#o.onAuthenticated?.(stream);
    // Out-of-order data counts against the cap; the next in-order message may go one message
    // beyond it, so a full buffer can always drain.
    const next = seq === (st?.delivered ?? 0) + 1;
    const limit = this.#o.maxBufferedBytes + (next ? MAX_MESSAGE_BYTES : 0);
    if (this.#buffered + part.length > limit) {
      this.#drop('buffer_full', env);
      return;
    }
    if (!st) {
      if (this.#streams.size >= this.#o.maxStreams) {
        this.#drop('too_many_streams', env);
        return;
      }
      // Only an authenticated frame may open a stream, and only once (streams.ts).
      const verdict = this.#o.acceptStream ? this.#o.acceptStream(stream) : true;
      if (verdict === false) {
        this.#drop('stale_stream', env);
        return;
      }
      const s = this.#newStream(stream);
      st = s;
      this.#streams.set(stream, s);
      if (verdict !== true) {
        s.gate = verdict;
        verdict.then(
          (ok) => this.#ungate(s, ok),
          () => this.#ungate(s, false),
        );
      }
    }
    if (env.ack !== undefined) this.#onAck(st, env.ack);
    let p = st.partial.get(seq);
    if (p) {
      if (p.n !== seg.n) {
        this.#drop('bad_segment', env);
        return;
      }
      if (p.complete || p.parts[seg.i]) {
        this.#drop('duplicate', env);
        return;
      }
    } else {
      const s = st;
      p = {
        n: seg.n,
        parts: new Array<Uint8Array | undefined>(seg.n),
        have: 0,
        bytes: 0,
        timer: null,
        complete: null,
      };
      const entry = p;
      p.timer = this.#o.timers.setTimeout(() => {
        if (s.partial.get(seq) === entry && !entry.complete) {
          s.partial.delete(seq);
          this.#buffered -= entry.bytes;
          this.#drop('reassembly_timeout', { stream, seq });
        }
      }, this.#o.reassemblyTimeoutMs);
      st.partial.set(seq, p);
    }
    p.parts[seg.i] = part;
    p.have++;
    p.bytes += part.length;
    this.#buffered += part.length;
    if (p.have === p.n) {
      this.#o.timers.clearTimeout(p.timer);
      p.complete = concatBytes(...(p.parts as Uint8Array[]));
      p.parts = [];
    }
    this.#deliver(st);
  }

  #ungate(st: StreamState, ok: boolean): void {
    if (this.#streams.get(st.id) !== st) return;
    st.gate = null;
    if (ok) {
      this.#deliver(st);
      return;
    }
    this.#drop('refused_stream', { stream: st.id });
    this.#finish(st);
  }

  #deliver(st: StreamState): void {
    if (st.gate) return;
    let progressed = false;
    for (;;) {
      const p = st.partial.get(st.delivered + 1);
      if (!p?.complete) break;
      st.partial.delete(st.delivered + 1);
      st.delivered++;
      this.#buffered -= p.bytes;
      progressed = true;
      try {
        this.#o.onMessage(st.id, p.complete);
      } catch {
        // A consumer's failure must not stall the stream.
      }
      if (this.#streams.get(st.id) !== st) return;
    }
    if (progressed) this.#scheduleAck(st);
  }

  #scheduleAck(st: StreamState): void {
    st.ackDue = true;
    if (st.ackTimer !== null) return;
    st.ackTimer = this.#o.timers.setTimeout(() => {
      st.ackTimer = null;
      if (st.ackDue && this.#streams.get(st.id) === st) this.#sendAck(st);
    }, this.#o.ackDelayMs);
  }

  #sendAck(st: StreamState): void {
    st.ackDue = false;
    this.#sendAckFrame(st.id, st.delivered);
  }

  #sendAckFrame(stream: string, ack: number): void {
    if (!this.#connected) return;
    this.#o.transmit({
      v: 1,
      kind: 'ack',
      to: this.#o.remoteRoute,
      from: this.#o.localRoute,
      client: this.clientId,
      stream,
      ack,
    });
  }

  #finish(st: StreamState): void {
    const t = this.#o.timers;
    if (st.retransmitTimer !== null) t.clearTimeout(st.retransmitTimer);
    if (st.ackTimer !== null) t.clearTimeout(st.ackTimer);
    // A final ack so the peer's last segments do not wait for a retransmit.
    if (st.ackDue) this.#sendAck(st);
    for (const p of st.partial.values()) {
      t.clearTimeout(p.timer);
      this.#buffered -= p.bytes;
    }
    st.partial.clear();
    this.#streams.delete(st.id);
    this.#tombstones.set(st.id, st.delivered);
    if (this.#tombstones.size > this.#o.tombstones) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest !== undefined) this.#tombstones.delete(oldest);
    }
  }
}
