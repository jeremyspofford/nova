// Spend caps and provider limits (FR-116, FR-115; ADR-097 D5): the warning fires once at the
// threshold, a reached cap stops the next model call before it is made with a clear error (a
// fallback on another provider still runs), the hard stop is configurable, clearing usage keeps
// the cap's spend, and limits a provider reports are recorded on its account.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRequest } from '@nova/providers';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  SpendCaps,
  providerImageGenerator,
  spendCapHref,
  spendPeriod,
  withSpendCaps,
  type ModelRoute,
  type ModelRouter,
  type NotificationInput,
  type RouteTarget,
  type RoutedEvent,
} from '../src/index.ts';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const ANTHROPIC = '01920000-0000-7000-8000-0000000000d1';
const OPENAI = '01920000-0000-7000-8000-0000000000d2';
const OLLAMA = '01920000-0000-7000-8000-0000000000d3';

let db: NovaDatabase;
let now: Date;
let events: MemoryEventSink;
let notes: NotificationInput[];
let caps: SpendCaps;
let calls: string[];
let reply: RoutedEvent[];

function target(id: string, kind: string): RouteTarget {
  return {
    ref: `${id}/m`,
    provider: {} as RouteTarget['provider'],
    providerKind: kind,
    providerAccountId: id,
    modelId: 'm',
    vision: false,
    reasoning: false,
    location: { kind: 'hub' },
    local: false,
  };
}

/** A router that records which targets it was asked to stream. */
const inner: ModelRouter = {
  listModels: () => Promise.resolve([]),
  firstModel: () => Promise.resolve(null),
  usable: () => Promise.resolve(true),
  route: () => Promise.reject(new Error('unused')),
  pricing: () => Promise.resolve(null),
  async *stream(route) {
    calls.push(...route.targets.map((t) => t.providerKind));
    await Promise.resolve();
    yield { type: 'route', target: route.targets[0]!, attempt: 1 };
    for (const e of reply) yield e;
  },
};

const req = { messages: [], signal: new AbortController().signal } as unknown as Omit<
  ChatRequest,
  'model'
>;

async function collect(route: ModelRoute): Promise<RoutedEvent[]> {
  const out: RoutedEvent[] = [];
  for await (const e of withSpendCaps(inner, caps).stream(route, req, { requestId: 'r' }))
    out.push(e);
  return out;
}

function spend(provider: string, usd: number, at = now): void {
  db.raw
    .prepare(
      'INSERT INTO usage_event (id, account_id, provider, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`u${Math.random()}`, OWNER, provider, 'm', usd, at.toISOString());
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  now = new Date('2026-10-15T12:00:00.000Z');
  const t = '2026-10-01T00:00:00.000Z';
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, t, t);
  for (const [id, kind, url] of [
    [ANTHROPIC, 'anthropic', null],
    [OPENAI, 'openai', null],
    [OLLAMA, 'ollama', 'http://127.0.0.1:11434'],
  ] as const)
    db.raw
      .prepare(
        "INSERT INTO provider_account (id, account_id, provider, label, auth_kind, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, 'none', ?, ?, ?)",
      )
      .run(id, OWNER, kind, kind, url, t, t);
  events = new MemoryEventSink();
  notes = [];
  caps = new SpendCaps({
    db,
    events,
    notifier: { notify: (n) => Promise.resolve(void notes.push(n)) },
    now: () => now,
  });
  calls = [];
  reply = [
    { type: 'text_delta', text: 'hi' },
    { type: 'stop', reason: 'end' },
  ];
});
afterEach(() => db.close());

const route = (...targets: RouteTarget[]): ModelRoute => ({ requested: 'x', targets });

describe('spend caps', () => {
  it('passes calls through without a cap', async () => {
    spend('anthropic', 1000);
    const out = await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(calls).toEqual(['anthropic']);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('warns once at the threshold, then stops the next call at the cap before it is made', async () => {
    const view = await caps.set(OWNER, 'anthropic', {
      limitUsd: 1,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    expect(view).toMatchObject({
      state: 'ok',
      spentUsd: 0,
      periodStart: '2026-10-01T00:00:00.000Z',
    });
    spend('anthropic', 0.5);
    await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(notes).toEqual([]);

    spend('anthropic', 0.35);
    await collect(route(target(ANTHROPIC, 'anthropic')));
    await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(calls).toEqual(['anthropic', 'anthropic', 'anthropic']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'anthropic spend at 85% of its cap',
      kind: 'attention',
    });
    expect(events.events.map((e) => e.name)).toEqual(['spend.cap.warning']);

    spend('anthropic', 0.2);
    calls = [];
    const out = await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(calls).toEqual([]);
    expect(out).toEqual([
      {
        type: 'stop',
        reason: 'error',
        error: expect.objectContaining({
          code: 'over_budget',
          retryable: false,
          message: expect.stringContaining(
            'anthropic spend cap of $1.00 a month is reached ($1.05 spent)',
          ),
        }),
      },
    ]);
    expect(events.events.map((e) => e.name)).toEqual(['spend.cap.warning', 'spend.cap.reached']);
    await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(notes).toHaveLength(2);
    expect(caps.get(OWNER, 'anthropic')).toMatchObject({ state: 'reached', spentUsd: 1.05 });
  });

  it('falls back to an uncapped provider, and only warns when the hard stop is off', async () => {
    await caps.set(OWNER, 'anthropic', {
      limitUsd: 1,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    spend('anthropic', 2);
    await collect(route(target(ANTHROPIC, 'anthropic'), target(OPENAI, 'openai')));
    expect(calls).toEqual(['openai']);

    await caps.set(OWNER, 'anthropic', {
      limitUsd: 1,
      period: 'month',
      warnAt: 0.8,
      hardStop: false,
    });
    calls = [];
    await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(calls).toEqual(['anthropic']);
  });

  it('counts the current day or month only', async () => {
    await caps.set(OWNER, 'openai', { limitUsd: 1, period: 'day', warnAt: 0.5, hardStop: true });
    spend('openai', 5, new Date('2026-10-14T23:59:00.000Z'));
    expect(caps.get(OWNER, 'openai')).toMatchObject({ spentUsd: 0, state: 'ok' });
    expect(spendPeriod('month', new Date('2026-12-31T23:00:00Z')).end.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(await caps.remove(OWNER, 'openai')).toBe(true);
    expect(await caps.remove(OWNER, 'openai')).toBe(false);
  });

  it('clearing usage keeps the cap spend and the rows an active run still counts', async () => {
    await caps.set(OWNER, 'anthropic', {
      limitUsd: 1,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    spend('anthropic', 1.5);
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES ('t', ?, 'work', ?, ?)",
      )
      .run(OWNER, now.toISOString(), now.toISOString());
    db.raw
      .prepare(
        `INSERT INTO run (id, account_id, thread_id, title, objective, status, created_at, updated_at)
         VALUES ('run1', ?, 't', 't', 'o', 'running', ?, ?)`,
      )
      .run(OWNER, now.toISOString(), now.toISOString());
    db.raw
      .prepare(
        "INSERT INTO usage_event (id, account_id, provider, run_id, cost_usd, created_at) VALUES ('kept', ?, 'openai', 'run1', 0.1, ?)",
      )
      .run(OWNER, now.toISOString());
    expect(await caps.clearUsage(OWNER)).toEqual({ removed: 1 });
    expect(db.raw.prepare('SELECT id FROM usage_event').all()).toEqual([{ id: 'kept' }]);
    expect(caps.get(OWNER, 'anthropic')).toMatchObject({ spentUsd: 1.5, state: 'reached' });
    // Next month the carried spend no longer counts.
    now = new Date('2026-11-02T00:00:00.000Z');
    expect(caps.get(OWNER, 'anthropic')).toMatchObject({ spentUsd: 0, state: 'ok' });
  });

  it('records the limits a provider reports and lists every account with its spend and cap', async () => {
    reply = [
      {
        type: 'stop',
        reason: 'error',
        error: { code: 'over_budget', message: 'credit balance too low', retryable: false },
      },
    ];
    await collect(route(target(ANTHROPIC, 'anthropic')));
    await caps.set(OWNER, 'anthropic', {
      limitUsd: 10,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    spend('anthropic', 2);
    const limits = caps.limits(OWNER);
    expect(limits.map((l) => [l.provider, l.active, l.local])).toEqual([
      ['anthropic', true, false],
      ['openai', true, false],
      ['ollama', true, true],
    ]);
    expect(limits[0]).toMatchObject({
      lastReported: {
        code: 'over_budget',
        message: 'credit balance too low',
        at: now.toISOString(),
      },
      spentThisMonthUsd: 2,
      spendCap: { limitUsd: 10, spentUsd: 2, state: 'ok' },
      entitlements: null,
    });
    expect(limits[1]).toMatchObject({ lastReported: null, spendCap: null });
  });

  it('marks a cap stop for clients and links to the caps on Profile & usage', async () => {
    await caps.set(OWNER, 'anthropic', {
      limitUsd: 1,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    spend('anthropic', 2);
    const out = await collect(route(target(ANTHROPIC, 'anthropic')));
    expect(out[0]).toMatchObject({
      type: 'stop',
      error: {
        code: 'over_budget',
        action: 'Raise the cap in Settings → Profile & usage',
        details: { reason: 'spend_cap', provider: 'anthropic' },
      },
    });
    expect(notes[0]!.href).toBe('/settings/profile?cap=anthropic#spend-caps');
    expect(spendCapHref('open ai')).toBe('/settings/profile?cap=open%20ai#spend-caps');
  });

  it('holds in-flight calls against a hard stop: concurrent calls cannot all pass the cap', async () => {
    await caps.set(OWNER, 'anthropic', {
      limitUsd: 1,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    // Last month's calls cost 0.5 each: that is what a call is likely to cost.
    spend('anthropic', 0.5, new Date('2026-09-20T00:00:00Z'));
    spend('anthropic', 0.5, new Date('2026-09-21T00:00:00Z'));
    spend('anthropic', 0.7);
    // 0.7 spent; a call likely costs 0.5. The first call holds it (0.7 + 0.5 >= 1): the second,
    // made while the first runs, stops; once the first ends the next one may go.
    const first = await caps.reserve(OWNER, 'anthropic');
    expect(first.allowed).toBe(true);
    const second = await caps.reserve(OWNER, 'anthropic');
    expect(second.allowed).toBe(false);
    second.release();
    first.release();
    first.release();
    expect((await caps.reserve(OWNER, 'anthropic')).allowed).toBe(true);
  });

  it('applies managed provider limits and caps to image generation, and records its usage', async () => {
    const generated: string[] = [];
    const imageProvider = {
      capabilities: { imageGeneration: true },
      generateImage: (r: { model: string }) => {
        generated.push(r.model);
        return Promise.resolve({ model: r.model, images: [{ data: 'aGk=' }], costUsd: 0.04 });
      },
    };
    const model = (kind: string) => ({
      view: { ref: `${kind}/img`, label: 'img' },
      info: { id: 'img-1', capabilities: { imageGeneration: true } },
      account: { id: kind === 'openai' ? OPENAI : ANTHROPIC, provider: kind },
      local: false,
      active: true,
    });
    let allowed = ['openai'];
    const gen = providerImageGenerator({
      registry: {
        accountModels: () => Promise.resolve([model('openai')] as never),
        provider: () => imageProvider as never,
      },
      providerRefusal: (kind) =>
        Promise.resolve(
          allowed.includes(kind) ? null : `Models from ${kind} providers are not allowed`,
        ),
      spend: (accountId, kind) => caps.gate(accountId, kind),
      recordUsage: (u) => caps.recordUsage(u),
    });
    const req = { prompt: 'a cat', size: '512x512' as const, signal: new AbortController().signal };
    await gen.generate(OWNER, req);
    expect(generated).toEqual(['img-1']);
    expect(
      db.raw
        .prepare("SELECT provider, model, cost_usd FROM usage_event WHERE model = 'img-1'")
        .all(),
    ).toEqual([{ provider: 'openai', model: 'img-1', cost_usd: 0.04 }]);
    // A cap reached stops the next image before the call.
    await caps.set(OWNER, 'openai', {
      limitUsd: 0.04,
      period: 'month',
      warnAt: 0.5,
      hardStop: true,
    });
    await expect(gen.generate(OWNER, req)).rejects.toMatchObject({
      code: 'over_budget',
      details: { reason: 'spend_cap', provider: 'openai' },
    });
    // Managed policy that does not allow the provider: refused, and the tool is not offered.
    await caps.remove(OWNER, 'openai');
    allowed = ['anthropic'];
    await expect(gen.generate(OWNER, req)).rejects.toMatchObject({ code: 'policy_denied' });
    expect(await gen.model(OWNER)).toBeNull();
    expect(generated).toEqual(['img-1']);
  });
});
