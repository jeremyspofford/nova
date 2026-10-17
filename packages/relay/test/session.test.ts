// The reliable sealed session (FR-137, docs/22 §3.1, contracts/rest-api.md §3.2): segmenting at
// 64 KiB, the 16 MiB and 256-segment caps, reassembly timeout, cumulative acks, duplicate and
// out-of-window drops, retransmit after 5 s, resume after reconnect from the last acked seq, and
// the replay guards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  SEGMENT_BYTES,
  associatedData,
  equalBytes,
  seal,
  type RelayEnvelope,
} from '../src/index.ts';
import { CLIENT, CLIENT_ID, HUB, bytes, link } from './helpers.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function forged(
  key: Uint8Array,
  over: Partial<RelayEnvelope> & { seq: number },
  payload = new Uint8Array([1]),
): RelayEnvelope {
  const seg = over.seg ?? { i: 0, n: 1 };
  const stream = over.stream ?? 'c1';
  const env: RelayEnvelope = {
    v: 1,
    kind: 'data',
    to: HUB,
    from: CLIENT,
    client: CLIENT_ID,
    stream,
    seg,
    ct: seal(key, payload, associatedData({ client: CLIENT_ID, stream, seq: over.seq, seg })),
    ...over,
  };
  return env;
}

describe('messages and segments', () => {
  it('delivers a message, acks it after a short delay and drains', async () => {
    const l = await link();
    l.client.session.send('c1', new TextEncoder().encode('hello'));
    expect(l.hub.received.map((m) => new TextDecoder().decode(m.data))).toEqual(['hello']);
    expect(l.client.session.pending('c1')).toBe(5);
    await vi.advanceTimersByTimeAsync(20);
    expect(l.hub.sent.at(-1)).toMatchObject({
      kind: 'ack',
      stream: 'c1',
      ack: 1,
      to: CLIENT,
      from: HUB,
    });
    expect(l.client.session.pending('c1')).toBe(0);
    expect(l.client.drained).toEqual(['c1']);
  });

  it('splits at 64 KiB boundaries and reassembles', async () => {
    const l = await link();
    l.client.session.send('c1', bytes(SEGMENT_BYTES));
    expect(l.client.sent.filter((e) => e.kind === 'data').map((e) => e.seg)).toEqual([
      { i: 0, n: 1 },
    ]);
    l.client.session.send('c1', bytes(SEGMENT_BYTES + 1, 2));
    expect(l.client.sent.filter((e) => e.seq === 2).map((e) => e.seg)).toEqual([
      { i: 0, n: 2 },
      { i: 1, n: 2 },
    ]);
    l.client.session.send('c1', new Uint8Array(0));
    expect(l.hub.received.map((m) => m.data.length)).toEqual([SEGMENT_BYTES, SEGMENT_BYTES + 1, 0]);
    expect(l.hub.received[1]!.data).toEqual(bytes(SEGMENT_BYTES + 1, 2));
  });

  it('carries the largest message (16 MiB, 256 segments) and refuses a larger one', async () => {
    const l = await link();
    const big = bytes(MAX_MESSAGE_BYTES, 3);
    l.client.session.send('c1', big);
    const segs = l.client.sent.filter((e) => e.kind === 'data');
    expect(segs).toHaveLength(256);
    expect(segs.at(-1)!.seg).toEqual({ i: 255, n: 256 });
    expect(l.hub.received).toHaveLength(1);
    expect(equalBytes(l.hub.received[0]!.data, big)).toBe(true);
    expect(() => l.client.session.send('c1', new Uint8Array(MAX_MESSAGE_BYTES + 1))).toThrow(
      RangeError,
    );
  }, 30_000);

  it('refuses a segment count above 256 and a segment above 64 KiB', async () => {
    const l = await link();
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, seg: { i: 0, n: 257 } }));
    l.hub.session.receive(
      forged(l.keys.client.send, { seq: 1 }, new Uint8Array(SEGMENT_BYTES + 1)),
    );
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['bad_segment', 'bad_segment']);
    expect(l.hub.received).toHaveLength(0);
  });

  it('discards an incomplete message after 60 s', async () => {
    const l = await link({ retransmitMs: 3_600_000, streamTimeoutMs: 7_200_000 });
    l.lose = (e) => e.kind === 'data' && e.seg?.i === 1;
    l.client.session.send('c1', bytes(SEGMENT_BYTES * 2));
    expect(l.hub.received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(l.hub.drops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(l.hub.drops).toEqual([{ reason: 'reassembly_timeout', stream: 'c1', seq: 1 }]);
    // The second half alone does not complete it any more.
    l.lose = null;
    const second = l.client.sent.find((e) => e.seg?.i === 1)!;
    l.hub.session.receive(second);
    expect(l.hub.received).toHaveLength(0);
  });

  it('rejects a segment whose count disagrees with its message', async () => {
    const l = await link();
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, seg: { i: 0, n: 3 } }));
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, seg: { i: 1, n: 2 } }));
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['bad_segment']);
  });
});

describe('acks, duplicates and windows', () => {
  it('acks cumulatively and lets acks ride on data frames', async () => {
    const l = await link();
    l.auto = false;
    for (let i = 0; i < 3; i++) l.client.session.send('c1', bytes(10, i));
    l.flush();
    expect(l.hub.received).toHaveLength(3);
    // The Hub answers on the same stream before the ack timer: the ack rides along.
    l.hub.session.send('c1', bytes(5));
    expect(l.hub.sent.at(-1)).toMatchObject({ kind: 'data', ack: 3 });
    l.flush();
    expect(l.client.session.pending('c1')).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    l.flush();
    // No standalone ack from the Hub: its pending ack went out on the data frame.
    expect(l.hub.sent.filter((e) => e.kind === 'ack')).toHaveLength(0);
    expect(l.client.sent.filter((e) => e.kind === 'ack').at(-1)).toMatchObject({ ack: 1 });
  });

  it('drops duplicates and re-acks them', async () => {
    const l = await link();
    l.client.session.send('c1', bytes(10));
    const frame = l.client.sent[0]!;
    await vi.advanceTimersByTimeAsync(20);
    const acks = l.hub.sent.filter((e) => e.kind === 'ack').length;
    l.hub.session.receive(structuredClone(frame));
    expect(l.hub.received).toHaveLength(1);
    expect(l.hub.drops).toEqual([{ reason: 'duplicate', stream: 'c1', seq: 1 }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(l.hub.sent.filter((e) => e.kind === 'ack').length).toBe(acks + 1);
  });

  it('drops a duplicate segment of a message still being assembled', async () => {
    const l = await link();
    l.auto = false;
    l.client.session.send('c1', bytes(SEGMENT_BYTES + 10));
    const first = l.toHub[0]!;
    l.hub.session.receive(structuredClone(first));
    l.hub.session.receive(structuredClone(first));
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['duplicate']);
  });

  it('drops a seq beyond the receive window', async () => {
    const l = await link();
    l.hub.session.receive(forged(l.keys.client.send, { seq: 257 }));
    expect(l.hub.drops).toEqual([{ reason: 'out_of_window', stream: 'c1', seq: 257 }]);
    l.hub.session.receive(forged(l.keys.client.send, { seq: 256 }));
    expect(l.hub.drops).toHaveLength(1);
    // In-order delivery waits for the gap.
    expect(l.hub.received).toHaveLength(0);
  });

  it('delivers in order when frames arrive out of order', async () => {
    const l = await link();
    l.auto = false;
    for (let i = 0; i < 3; i++) l.client.session.send('c1', bytes(4, i));
    const frames = l.toHub.splice(0);
    for (const f of [frames[2]!, frames[0]!, frames[1]!]) l.hub.session.receive(f);
    expect(l.hub.received.map((m) => m.data)).toEqual([bytes(4, 0), bytes(4, 1), bytes(4, 2)]);
  });

  it('keeps at most `window` segments unacked', async () => {
    const l = await link({ window: 4 });
    l.auto = false;
    for (let i = 0; i < 10; i++) l.client.session.send('c1', bytes(1, i));
    expect(l.toHub).toHaveLength(4);
    l.flush();
    await vi.advanceTimersByTimeAsync(20);
    l.flush();
    expect(l.hub.received).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(20);
    l.flush();
    expect(l.hub.received).toHaveLength(10);
  });

  it('ignores an ack for a seq never sent', async () => {
    const l = await link();
    l.auto = false;
    l.client.session.send('c1', bytes(3));
    l.client.session.receive({
      v: 1,
      kind: 'ack',
      to: CLIENT,
      from: HUB,
      client: CLIENT_ID,
      stream: 'c1',
      ack: 9,
    });
    expect(l.client.session.pending('c1')).toBe(3);
  });

  it('drops frames for another client or route, and tampered frames', async () => {
    const l = await link();
    const f = forged(l.keys.client.send, { seq: 1 });
    l.hub.session.receive({ ...f, client: 'client-2' });
    l.hub.session.receive({ ...f, from: 'SOMEONEELSE00000' });
    l.hub.session.receive({ ...f, seq: 2 });
    l.hub.session.receive(forged(l.keys.hub.send, { seq: 1 }));
    expect(l.hub.drops.map((d) => d.reason)).toEqual([
      'route_mismatch',
      'route_mismatch',
      'bad_seal',
      'bad_seal',
    ]);
    expect(l.hub.received).toHaveLength(0);
    expect(l.hub.session.streams).toEqual([]);
  });
});

describe('retransmit and reconnect', () => {
  it('retransmits after 5 s without an ack', async () => {
    const l = await link();
    let lost = 0;
    l.lose = (e) => e.kind === 'data' && lost++ === 0;
    l.client.session.send('c1', bytes(10));
    expect(l.hub.received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(l.hub.received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(l.hub.received).toHaveLength(1);
    expect(l.client.sent.filter((e) => e.kind === 'data')).toHaveLength(2);
  });

  it('resumes after a reconnect from the last acked seq', async () => {
    const l = await link();
    l.client.session.send('c1', bytes(1, 1));
    l.client.session.send('c1', bytes(1, 2));
    await vi.advanceTimersByTimeAsync(20);
    expect(l.client.session.pending('c1')).toBe(0);
    l.client.session.setConnected(false);
    l.client.session.send('c1', bytes(1, 3));
    l.client.session.send('c1', bytes(1, 4));
    const before = l.client.sent.length;
    expect(l.hub.received).toHaveLength(2);
    // Nothing goes out while down, and no retransmit timer runs.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(l.client.sent.length).toBe(before);
    l.client.session.setConnected(true);
    const resent = l.client.sent
      .slice(before)
      .filter((e) => e.kind === 'data')
      .map((e) => e.seq);
    expect(resent).toEqual([3, 4]);
    expect(l.hub.received.map((m) => m.data)).toEqual([
      bytes(1, 1),
      bytes(1, 2),
      bytes(1, 3),
      bytes(1, 4),
    ]);
  });

  it('resends unacked frames on reconnect, and the receiver re-acks what it has', async () => {
    const l = await link();
    l.lose = (e) => e.kind === 'ack';
    l.client.session.send('c1', bytes(1));
    await vi.advanceTimersByTimeAsync(20);
    expect(l.client.session.pending('c1')).toBe(1);
    l.lose = null;
    l.client.session.setConnected(false);
    l.hub.session.setConnected(false);
    l.hub.session.setConnected(true);
    // The Hub's own ack on reconnect clears the client's window.
    expect(l.client.session.pending('c1')).toBe(0);
    l.client.session.setConnected(true);
    expect(l.hub.received).toHaveLength(1);
  });

  it('fails a stream after two minutes without ack progress while connected', async () => {
    const l = await link();
    l.lose = () => true;
    l.client.session.send('c1', bytes(1));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(l.client.failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(l.client.failed).toEqual(['c1']);
    expect(l.client.session.streams).toEqual([]);
  });
});

describe('streams', () => {
  it('re-acks stragglers on a closed stream and refuses new data on it', async () => {
    const l = await link();
    l.client.session.send('c1', bytes(1));
    await vi.advanceTimersByTimeAsync(20);
    l.hub.session.closeStream('c1');
    expect(l.hub.session.streams).toEqual([]);
    const acks = l.hub.sent.filter((e) => e.kind === 'ack').length;
    l.hub.session.receive(structuredClone(l.client.sent[0]!));
    expect(l.hub.sent.filter((e) => e.kind === 'ack').length).toBe(acks + 1);
    l.hub.session.receive(forged(l.keys.client.send, { seq: 2 }));
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['duplicate', 'closed_stream']);
  });

  it('closes a stream only once its sends are acked', async () => {
    const l = await link();
    l.auto = false;
    l.hub.session.openStream('c1');
    l.hub.session.send('c1', bytes(1));
    l.hub.session.closeStream('c1');
    expect(l.hub.session.hasStream('c1')).toBe(true);
    expect(() => l.hub.session.send('c1', bytes(1))).toThrow('closing');
    l.flush();
    await vi.advanceTimersByTimeAsync(20);
    l.flush();
    expect(l.hub.session.hasStream('c1')).toBe(false);
  });

  it('opens a peer stream only when the guard accepts it, and caps open streams', async () => {
    const l = await link({ acceptStream: (s) => s !== 'c2', maxStreams: 2 });
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, stream: 'c2' }));
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['stale_stream']);
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, stream: 'c3' }));
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, stream: 'c4' }));
    l.hub.session.receive(forged(l.keys.client.send, { seq: 1, stream: 'c5' }));
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['stale_stream', 'too_many_streams']);
    l.hub.session.abortStream('c3');
    expect(l.hub.session.streams).toEqual(['c4']);
  });

  it('stops everything on close', async () => {
    const l = await link();
    l.lose = () => true;
    l.client.session.send('c1', bytes(1));
    l.client.session.close();
    expect(() => l.client.session.send('c1', bytes(1))).toThrow('closed');
    l.client.session.receive(forged(l.keys.hub.send, { seq: 1 }));
    expect(l.client.received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(l.client.sent.filter((e) => e.kind === 'data')).toHaveLength(1);
  });

  it('survives a consumer that throws', async () => {
    const l = await link({
      onMessage: () => {
        throw new Error('boom');
      },
    });
    l.client.session.send('c1', bytes(1));
    l.client.session.send('c1', bytes(1));
    await vi.advanceTimersByTimeAsync(20);
    expect(l.client.session.pending('c1')).toBe(0);
  });
});

describe('stream admission and buffering', () => {
  it('holds back delivery and acks until the stream is admitted', async () => {
    let admit: ((ok: boolean) => void) | null = null;
    const l = await link({ acceptStream: () => new Promise<boolean>((r) => (admit = r)) });
    l.client.session.send('c1', bytes(4, 1));
    l.client.session.send('c1', bytes(4, 2));
    await vi.advanceTimersByTimeAsync(100);
    expect(l.hub.received).toHaveLength(0);
    expect(l.hub.sent.filter((e) => e.kind === 'ack')).toHaveLength(0);
    admit!(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(l.hub.received.map((m) => m.data)).toEqual([bytes(4, 1), bytes(4, 2)]);
    expect(l.client.session.pending('c1')).toBe(0);
  });

  it('refuses a stream whose admission fails, without delivering or acking it', async () => {
    const l = await link({
      acceptStream: (s) =>
        s === 'c1' ? Promise.reject(new Error('disk full')) : Promise.resolve(false),
    });
    l.client.session.send('c1', bytes(4));
    l.client.session.send('c2', bytes(4));
    await vi.advanceTimersByTimeAsync(100);
    expect(l.hub.received).toHaveLength(0);
    expect(l.hub.sent.filter((e) => e.kind === 'ack')).toHaveLength(0);
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['refused_stream', 'refused_stream']);
    expect(l.hub.session.streams).toEqual([]);
    expect(l.hub.session.buffered).toBe(0);
  });

  it('caps the bytes held for out-of-order delivery', async () => {
    const l = await link({ maxBufferedBytes: 1024 });
    l.auto = false;
    for (let i = 0; i < 4; i++) l.client.session.send('c1', bytes(400, i));
    const frames = l.toHub.splice(0);
    // Hold back the first message: the others wait in the buffer, the fourth does not fit.
    for (const f of frames.slice(1)) l.hub.session.receive(f);
    expect(l.hub.drops.map((d) => d.reason)).toEqual(['buffer_full']);
    expect(l.hub.session.buffered).toBe(800);
    l.hub.session.receive(frames[0]!);
    expect(l.hub.received).toHaveLength(3);
    expect(l.hub.session.buffered).toBe(0);
    // The dropped one comes again with the retransmit.
    l.auto = true;
    l.flush();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(l.hub.received).toHaveLength(4);
  });

  it('releases buffered bytes on reassembly timeout and on close', async () => {
    const l = await link({ retransmitMs: 3_600_000, streamTimeoutMs: 7_200_000 });
    l.lose = (e) => e.kind === 'data' && e.seg?.i === 1;
    l.client.session.send('c1', bytes(SEGMENT_BYTES + 10));
    expect(l.hub.session.buffered).toBe(SEGMENT_BYTES);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.hub.session.buffered).toBe(0);
    l.client.session.send('c1', bytes(SEGMENT_BYTES + 10));
    expect(l.hub.session.buffered).toBe(SEGMENT_BYTES);
    l.hub.session.close();
    expect(l.hub.session.buffered).toBe(0);
  });

  it('reports only authenticated frames as signs of life', async () => {
    const seen: string[] = [];
    const l = await link({ onAuthenticated: (s) => seen.push(s) });
    l.hub.session.receive(forged(l.keys.hub.send, { seq: 1 }));
    expect(seen).toEqual([]);
    l.client.session.send('c1', bytes(1));
    expect(seen).toEqual(['c1']);
  });
});
