// Client-side endpoint selection (docs/22 §2, FR-135): happy eyeballs over the advertised
// candidates with fake probes and a fake clock, plus the network request schemas and settings.
import { describe, expect, it } from 'vitest';
import {
  endpointCandidateSchema,
  networkRollbackSchema,
  selectEndpoint,
  updateNetworkSchema,
  type EndpointCandidate,
  type EndpointProbeOutcome,
  type NetworkTransport,
} from '../src/index.ts';
import { SETTINGS, checkSettingWrite } from '../src/settings.ts';

/** Timers on a manual clock: `advance` runs what falls due, letting promises settle between. */
class Clock {
  now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): number => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (h: unknown): void => {
    this.#timers.delete(h as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await flush();
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function c(
  transport: NetworkTransport,
  priority: number,
  url = `${transport}://hub`,
): EndpointCandidate {
  return { transport, url, priority, health: 'ok', latencyMs: null, checkedAt: null, detail: null };
}

const LAN = c('lan', 10, 'http://192.168.1.10:7419');
const MESH = c('mesh', 20, 'http://100.100.1.2:7419');
const RELAY = c('relay', 30, 'wss://relay.example/hub');

/** Probes the test settles by hand; records aborts. */
function probes() {
  const pending = new Map<string, (r: boolean | EndpointProbeOutcome) => void>();
  const failers = new Map<string, (e: Error) => void>();
  const aborted: string[] = [];
  const started: string[] = [];
  const probe = (cand: EndpointCandidate, signal: AbortSignal) => {
    started.push(cand.url);
    signal.addEventListener('abort', () => aborted.push(cand.url));
    return new Promise<boolean | EndpointProbeOutcome>((resolve, reject) => {
      pending.set(cand.url, resolve);
      failers.set(cand.url, reject);
    });
  };
  return {
    probe,
    started,
    aborted,
    answer: (url: string, r: boolean | EndpointProbeOutcome) => pending.get(url)?.(r),
    throws: (url: string, e: Error) => failers.get(url)?.(e),
  };
}

function run(clock: Clock, list: EndpointCandidate[], p: ReturnType<typeof probes>, extra = {}) {
  return selectEndpoint(list, p.probe, {
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    ...extra,
  });
}

describe('selectEndpoint', () => {
  it('takes the first candidate that answers within its budget', async () => {
    const clock = new Clock();
    const p = probes();
    const sel = run(clock, [RELAY, MESH, LAN], p);
    await clock.advance(50);
    p.answer(LAN.url, { ok: true, latencyMs: 12 });
    const r = await sel;
    expect(r.winner).toBe(LAN);
    expect(r.latencyMs).toBe(12);
    expect(p.started).toEqual([LAN.url]);
    expect(r.attempts).toEqual([
      {
        transport: 'lan',
        url: LAN.url,
        startedAtMs: 0,
        endedAtMs: 50,
        outcome: 'ok',
        latencyMs: 12,
        detail: null,
      },
    ]);
  });

  it('starts the next candidate after the budget and cancels the slower one when it wins', async () => {
    const clock = new Clock();
    const p = probes();
    const sel = run(clock, [LAN, MESH, RELAY], p);
    await clock.advance(299);
    expect(p.started).toEqual([LAN.url]);
    await clock.advance(1);
    expect(p.started).toEqual([LAN.url, MESH.url]);
    await clock.advance(50);
    p.answer(MESH.url, true);
    const r = await sel;
    expect(r.winner).toBe(MESH);
    expect(r.attempts.map((a) => [a.transport, a.outcome, a.startedAtMs, a.endedAtMs])).toEqual([
      ['lan', 'cancelled', 0, 350],
      ['mesh', 'ok', 300, 350],
    ]);
    expect(r.latencyMs).toBe(50);
    expect(p.aborted).toEqual([LAN.url]);
  });

  it('falls back at once when one fails: LAN dead → Mesh dead → Relay', async () => {
    const clock = new Clock();
    const p = probes();
    const sel = run(clock, [LAN, MESH, RELAY], p);
    await clock.advance(10);
    p.answer(LAN.url, { ok: false, detail: 'connection refused' });
    await clock.advance(5);
    expect(p.started).toEqual([LAN.url, MESH.url]);
    p.throws(MESH.url, new Error('no route'));
    await clock.advance(5);
    p.answer(RELAY.url, true);
    const r = await sel;
    expect(r.winner).toBe(RELAY);
    expect(r.attempts.map((a) => [a.transport, a.outcome, a.startedAtMs, a.detail])).toEqual([
      ['lan', 'failed', 0, 'connection refused'],
      ['mesh', 'failed', 10, 'no route'],
      ['relay', 'ok', 15, null],
    ]);
  });

  it('has no winner when every candidate fails or times out', async () => {
    const clock = new Clock();
    const p = probes();
    const sel = run(clock, [LAN, MESH], p, { timeoutMs: 1_000 });
    await clock.advance(1_400);
    const r = await sel;
    expect(r.winner).toBeNull();
    expect(r.attempts.map((a) => [a.outcome, a.endedAtMs])).toEqual([
      ['timeout', 1_000],
      ['timeout', 1_300],
    ]);
    const q = probes();
    const sel2 = run(clock, [LAN], q);
    await clock.advance(1);
    q.answer(LAN.url, false);
    expect((await sel2).winner).toBeNull();
    expect(await selectEndpoint([], q.probe)).toEqual({
      winner: null,
      latencyMs: null,
      attempts: [],
    });
  });

  it('keeps the given order among equal priorities and stops when the caller aborts', async () => {
    const clock = new Clock();
    const p = probes();
    const a = c('lan', 10, 'http://a');
    const b = c('lan', 10, 'http://b');
    const ctl = new AbortController();
    const sel = run(clock, [b, a], p, { signal: ctl.signal });
    await clock.advance(300);
    expect(p.started).toEqual(['http://b', 'http://a']);
    ctl.abort();
    const r = await sel;
    expect(r.winner).toBeNull();
    expect(r.attempts.every((x) => x.outcome === 'cancelled')).toBe(true);
    // Already aborted: nothing starts.
    const q = probes();
    expect((await run(clock, [a], q, { signal: ctl.signal })).attempts).toEqual([]);
    expect(q.started).toEqual([]);
  });

  it('works with the real clock and timers', async () => {
    const r = await selectEndpoint(
      [LAN, MESH],
      (cand) => Promise.resolve(cand.transport === 'mesh'),
      {
        budgetMs: 5,
      },
    );
    expect(r.winner).toBe(MESH);
  });
});

describe('network schemas and settings', () => {
  it('validates candidates, the PATCH body and rollback', () => {
    expect(endpointCandidateSchema.safeParse(LAN).success).toBe(true);
    expect(endpointCandidateSchema.safeParse({ ...LAN, transport: 'carrier-pigeon' }).success).toBe(
      false,
    );
    expect(
      updateNetworkSchema.parse({
        transports: { lan: false },
        lan: { mdns: false, mdnsName: 'study' },
        directPublic: { url: 'https://hub.example.com' },
        wakeHelpers: ['d1'],
        healthCheckSeconds: 30,
      }),
    ).toMatchObject({ transports: { lan: false } });
    for (const bad of [
      { transports: { carrier: true } },
      { lan: { mdnsName: 'Not A Label' } },
      { directPublic: { url: 'https://user:pw@hub.example.com' } },
      { directPublic: { url: 'ftp://hub.example.com' } },
      { directPublic: { url: 'https://hub.example.com/?x=1' } },
      { healthCheckSeconds: 1 },
      { extra: 1 },
    ])
      expect(updateNetworkSchema.safeParse(bad).success).toBe(false);
    expect(networkRollbackSchema.parse({})).toEqual({});
    expect(networkRollbackSchema.safeParse({ changeId: '' }).success).toBe(false);
  });

  it('defines the network settings with safe defaults', () => {
    expect(SETTINGS['network.transports'].default).toEqual({
      lan: true,
      mesh: true,
      relay: true,
      directPublic: false,
    });
    expect(SETTINGS['network.lan.mdns'].default).toBe(true);
    expect(SETTINGS['network.directPublic.url'].default).toBeNull();
    expect(SETTINGS['network.wakeHelpers'].default).toEqual([]);
    // Security-relevant: never settable per project.
    expect(checkSettingWrite('network.lan.mdns', false, 'project', {}).ok).toBe(false);
    expect(
      checkSettingWrite('network.directPublic.url', 'https://hub.example.com', 'global', {}).ok,
    ).toBe(true);
    expect(checkSettingWrite('network.directPublic.url', 'javascript:x', 'global', {}).ok).toBe(
      false,
    );
  });
});
