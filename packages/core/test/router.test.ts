// Router (FR-023, FR-127, FR-221; docs/07 §8-§9, docs/21 §5): listing with presets, routing
// order across local places, preset strategies and filters, retries with Retry-After, fallback
// only before output, the circuit breaker, and the chat engine running through it.
import { afterEach, describe, expect, it } from 'vitest';
import {
  NovaError,
  ROUTING_STEPS,
  nodeModelRef,
  parseAnyModelRef,
  type ModelView,
  type Preset,
} from '@nova/shared';
import type {
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  StreamEvent,
} from '@nova/providers';
import {
  Router,
  breakerKey,
  requestFor,
  type ModelSource,
  type RoutedEvent,
  type RouteTarget,
  type RoutingSettings,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

const CAPS: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  vision: false,
  audioIn: false,
  audioOut: false,
  realtime: false,
  reasoning: false,
  promptCache: 'none',
  structuredOutput: false,
  imageGeneration: false,
  maxContextTokens: 8_000,
  maxOutputTokens: 1_000,
};

type Step = StreamEvent[] | Error | 'silent';

/** A provider that plays one scripted step per call (default: a short complete reply). */
class Scripted implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly calls: ChatRequest[] = [];
  plan: Step[] = [];
  models: ModelInfo[];
  failList = false;
  constructor(id: string, models: ModelInfo[], caps: Partial<ProviderCapabilities> = {}) {
    this.id = id;
    this.models = models;
    this.capabilities = { ...CAPS, ...caps };
  }
  listModels(): Promise<ModelInfo[]> {
    return this.failList ? Promise.reject(new Error('unreachable')) : Promise.resolve(this.models);
  }
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls.push(req);
    const step = this.plan.shift() ?? ok(this.id);
    await Promise.resolve();
    if (step instanceof Error) throw step;
    if (step === 'silent') return;
    for (const e of step) {
      if (req.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      yield e;
    }
  }
}

const ok = (who: string): StreamEvent[] => [
  { type: 'start', messageId: 'm', model: who },
  { type: 'text_delta', text: `hi from ${who}` },
  { type: 'stop', reason: 'end' },
];
const fail = (
  code: string,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): StreamEvent[] => [
  { type: 'start', messageId: 'm', model: 'x' },
  { type: 'usage', inputTokens: 1 },
  { type: 'stop', reason: 'error', error: { code, message: code, retryable, ...extra } as never },
];
const model = (id: string, caps: Partial<ProviderCapabilities> = {}, cost?: number): ModelInfo => ({
  id,
  label: id,
  capabilities: caps,
  ...(cost === undefined ? {} : { costIn: cost, costOut: 0 }),
});

interface FakeNode {
  id: string;
  models: string[];
  provider: Provider;
  load: { running: number; queued: number } | null;
  vision?: boolean;
}

function fakeSource(nodes: FakeNode[], opts: { fail?: boolean } = {}): ModelSource {
  const target = (n: FakeNode, modelId: string): RouteTarget => ({
    ref: nodeModelRef(n.id, modelId),
    provider: n.provider,
    providerKind: 'node',
    providerAccountId: null,
    modelId,
    vision: n.vision ?? false,
    reasoning: false,
    location: { kind: 'node', nodeId: n.id },
    local: true,
  });
  const check = () => {
    if (opts.fail) throw new Error('source down');
  };
  return {
    listModels: async () => {
      await Promise.resolve();
      check();
      return nodes.flatMap((n) =>
        n.models.map((m): ModelView => ({
          ref: nodeModelRef(n.id, m),
          kind: 'model',
          providerAccountId: '',
          provider: 'node',
          modelId: m,
          label: m,
          reasoning: false,
          source: 'node',
          nodeId: n.id,
        })),
      );
    },
    targets: async (_a, ref) => {
      await Promise.resolve();
      check();
      const p = parseAnyModelRef(ref);
      if (p?.kind !== 'node') return [];
      const n = nodes.find((x) => x.id === p.nodeId);
      return n?.models.includes(p.modelId) ? [target(n, p.modelId)] : [];
    },
    targetsForModel: async (_a, modelId) => {
      await Promise.resolve();
      check();
      return nodes.filter((n) => n.models.includes(modelId)).map((n) => target(n, modelId));
    },
    load: (id) => nodes.find((n) => n.id === id)?.load ?? null,
  };
}

interface Setup {
  env: Env;
  router: Router;
  providers: Map<string, Scripted>;
  ids: Record<string, string>;
  settings: RoutingSettings;
  sleeps: number[];
  clock: { now: number };
}

let current: Env | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A Hub with the offline mock plus the named accounts, a Router and controllable time. */
async function setup(
  accounts: {
    label: string;
    kind: 'ollama' | 'llamacpp' | 'openai' | 'anthropic' | 'openrouter';
    provider: Scripted;
  }[] = [],
  opts: { sources?: ModelSource[]; settings?: Partial<RoutingSettings>; sleep?: boolean } = {},
): Promise<Setup> {
  const providers = new Map(accounts.map((a) => [a.label, a.provider]));
  const env = await makeEnv({ factory: ({ row }) => providers.get(row.label) });
  current = env;
  const ids: Record<string, string> = { mock: env.mockAccountId };
  for (const a of accounts) {
    const cloud = a.kind === 'openai' || a.kind === 'anthropic' || a.kind === 'openrouter';
    ids[a.label] = (
      await env.registry.create(ACCOUNT, {
        provider: a.kind,
        label: a.label,
        ...(cloud ? { apiKey: 'sk-test-0123456789' } : {}),
      })
    ).id;
  }
  const settings: RoutingSettings = {
    presets: [],
    order: [...ROUTING_STEPS],
    allowCloud: true,
    ...opts.settings,
  };
  const sleeps: number[] = [];
  const clock = { now: 1_000_000 };
  const router = new Router({
    registry: env.registry,
    sources: opts.sources ?? [],
    settings: () => Promise.resolve(settings),
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return Promise.resolve(!signal.aborted);
    },
    random: () => 0,
    now: () => clock.now,
  });
  return { env, router, providers, ids, settings, sleeps, clock };
}

const req = (over: Partial<ChatRequest> = {}): Omit<ChatRequest, 'model'> => ({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  signal: new AbortController().signal,
  ...over,
});

async function run(
  router: Router,
  accountRef: string,
  r: Omit<ChatRequest, 'model'> = req(),
  needsVision = false,
): Promise<RoutedEvent[]> {
  const route = await router.route(ACCOUNT, accountRef, { needsVision });
  const out: RoutedEvent[] = [];
  for await (const e of router.stream(route, r, { requestId: 't' })) out.push(e);
  return out;
}

const routes = (ev: RoutedEvent[]) =>
  ev.flatMap((e) => (e.type === 'route' ? [[e.target.ref, e.attempt, e.reason ?? null]] : []));
const text = (ev: RoutedEvent[]) =>
  ev.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');

const preset = (p: Partial<Preset> & Pick<Preset, 'id' | 'targets'>): Preset => ({
  label: p.id,
  strategy: 'fallback',
  rank: 1,
  ...p,
});

// ---- listing ------------------------------------------------------------------------------

describe('Router.listModels', () => {
  it('lists the built-in presets first, generated from the offline mock (FR-221)', async () => {
    const s = await setup();
    const list = await s.router.listModels(ACCOUNT);
    expect(list.map((m) => [m.ref, m.kind, m.source])).toEqual([
      ['preset:faster', 'preset', 'preset'],
      ['preset:balanced', 'preset', 'preset'],
      ['preset:smarter', 'preset', 'preset'],
      [`${s.ids.mock}/mock-fast`, 'model', 'account'],
      [`${s.ids.mock}/mock-smart`, 'model', 'account'],
    ]);
    expect(list[0]).toEqual({
      ref: 'preset:faster',
      kind: 'preset',
      providerAccountId: '',
      provider: 'preset',
      modelId: 'faster',
      label: 'Faster',
      reasoning: false,
      source: 'preset',
    });
    expect(await s.router.builtInPresets(ACCOUNT)).toEqual([
      {
        id: 'faster',
        label: 'Faster',
        strategy: 'single',
        targets: [`${s.ids.mock}/mock-fast`],
        rank: 1,
      },
      {
        id: 'balanced',
        label: 'Balanced',
        strategy: 'single',
        targets: [`${s.ids.mock}/mock-fast`],
        rank: 2,
      },
      {
        id: 'smarter',
        label: 'Smarter',
        strategy: 'single',
        targets: [`${s.ids.mock}/mock-smart`],
        reasoningLevel: 'high',
        rank: 3,
      },
    ]);
  });

  it('lists saved presets by rank, marks unavailable ones, then account and node models', async () => {
    const cloud = new Scripted('cloud', [model('gpt-5')]);
    const down = new Scripted('down', [model('llama3')]);
    down.failList = true;
    const node = new Scripted('node', []);
    const s = await setup(
      [
        { label: 'cloud', kind: 'openai', provider: cloud },
        { label: 'down', kind: 'ollama', provider: down },
      ],
      {
        sources: [
          fakeSource([{ id: 'n1', models: ['qwen3:8b'], provider: node, load: null }]),
          fakeSource([], { fail: true }),
        ],
      },
    );
    s.settings.presets = [
      preset({ id: 'second', targets: [`${s.ids.mock}/mock-fast`], rank: 5 }),
      preset({ id: 'gone', targets: ['nope/model', `${s.ids.down}/llama3`], rank: 2 }),
      preset({ id: 'cloudy', targets: [`${s.ids.cloud}/gpt-5`], rank: 1 }),
      preset({ id: 'node', targets: [nodeModelRef('n1', 'qwen3:8b')], rank: 3 }),
    ];
    const list = await s.router.listModels(ACCOUNT);
    expect(list.map((m) => [m.ref, m.disabledReason ?? null])).toEqual([
      ['preset:cloudy', null],
      ['preset:gone', 'None of its models are available right now'],
      ['preset:node', null],
      ['preset:second', null],
      [`${s.ids.mock}/mock-fast`, null],
      [`${s.ids.mock}/mock-smart`, null],
      [`${s.ids.cloud}/gpt-5`, null],
      ['node:n1/qwen3:8b', null],
    ]);
    s.settings.allowCloud = false;
    const local = await s.router.listModels(ACCOUNT);
    expect(local.find((m) => m.ref === 'preset:cloudy')?.disabledReason).toBe(
      'It uses only cloud models, and cloud models are turned off',
    );
  });

  it('generates presets from local models only when cloud is off, with a fallback owner', async () => {
    const llama = new Scripted('llama', [model('llama3.1:70b'), model('qwen3:4b')]);
    const cloud = new Scripted('cloud', [model('claude-opus-4-8', { reasoning: 'levels' })]);
    const s = await setup([
      { label: 'llama', kind: 'llamacpp', provider: llama },
      { label: 'cloud', kind: 'anthropic', provider: cloud },
    ]);
    const all = await s.router.builtInPresets(ACCOUNT);
    expect(all.find((p) => p.id === 'smarter')).toMatchObject({
      strategy: 'fallback',
      targets: [`${s.ids.cloud}/claude-opus-4-8`, `${s.ids.llama}/llama3.1:70b`],
      reasoningLevel: 'high',
    });
    s.settings.allowCloud = false;
    const local = await s.router.builtInPresets(ACCOUNT);
    expect(local.flatMap((p) => p.targets).some((t) => t.startsWith(s.ids.cloud!))).toBe(false);
  });
});

// ---- routing ------------------------------------------------------------------------------

describe('Router.route', () => {
  it('routes an account ref to its model and rejects unknown refs', async () => {
    const s = await setup();
    const route = await s.router.route(ACCOUNT, `${s.ids.mock}/mock-fast`);
    expect(route.targets.map((t) => [t.ref, t.local, t.providerKind])).toEqual([
      [`${s.ids.mock}/mock-fast`, true, 'mock'],
    ]);
    await expect(s.router.route(ACCOUNT, 'nonsense')).rejects.toMatchObject({
      details: { reason: 'unknown_model' },
    });
    await expect(s.router.route(ACCOUNT, 'gone/model')).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(s.router.route(ACCOUNT, 'node:n9/x')).rejects.toMatchObject({
      details: { reason: 'unknown_model' },
    });
    await expect(s.router.route(ACCOUNT, 'preset:nope')).rejects.toMatchObject({
      details: { reason: 'unknown_model' },
    });
  });

  it('gathers every local place serving a local model and orders them by routing.order (FR-127)', async () => {
    const ollama = new Scripted('ollama', [model('qwen3:8b')]);
    const llama = new Scripted('llama', [model('qwen3:8b')]);
    const nodeA = new Scripted('nodeA', []);
    const nodeB = new Scripted('nodeB', []);
    const nodes: FakeNode[] = [
      { id: 'a', models: ['qwen3:8b'], provider: nodeA, load: { running: 3, queued: 2 } },
      { id: 'b', models: ['qwen3:8b'], provider: nodeB, load: { running: 1, queued: 0 } },
    ];
    const s = await setup(
      [
        { label: 'ollama', kind: 'ollama', provider: ollama },
        { label: 'llama', kind: 'llamacpp', provider: llama },
      ],
      { sources: [fakeSource(nodes)] },
    );
    await s.router.listModels(ACCOUNT); // warm the model lists
    const refs = async (ref: string) =>
      (await s.router.route(ACCOUNT, ref)).targets.map((t) => t.ref);
    // Default order: the Hub's own servers first, then the least-loaded node.
    expect(await refs(nodeModelRef('a', 'qwen3:8b'))).toEqual([
      `${s.ids.ollama}/qwen3:8b`,
      `${s.ids.llama}/qwen3:8b`,
      'node:b/qwen3:8b',
      'node:a/qwen3:8b',
    ]);
    s.settings.order = ['least_loaded', 'same_device'];
    nodes[1]!.load = null; // unknown load counts what this router has open (none)
    expect(await refs(nodeModelRef('a', 'qwen3:8b'))).toEqual([
      `${s.ids.ollama}/qwen3:8b`,
      `${s.ids.llama}/qwen3:8b`,
      'node:b/qwen3:8b',
      'node:a/qwen3:8b',
    ]);
    s.settings.order = ['cloud'];
    expect((await refs(`${s.ids.llama}/qwen3:8b`))[0]).toBe(`${s.ids.llama}/qwen3:8b`);
    // The mock and cloud models are never spread across places.
    expect(await refs(`${s.ids.mock}/mock-fast`)).toEqual([`${s.ids.mock}/mock-fast`]);
  });

  it('prefers vision-capable places for images but keeps an explicitly chosen model', async () => {
    const plain = new Scripted('plain', [model('llava', { vision: false })]);
    const node = new Scripted('node', []);
    const s = await setup([{ label: 'plain', kind: 'ollama', provider: plain }], {
      sources: [
        fakeSource([{ id: 'v', models: ['llava'], provider: node, load: null, vision: true }]),
      ],
      settings: { order: ['capability', 'same_device'] },
    });
    await s.router.listModels(ACCOUNT);
    const route = await s.router.route(ACCOUNT, `${s.ids.plain}/llava`, { needsVision: true });
    expect(route.targets.map((t) => t.ref)).toEqual(['node:v/llava', `${s.ids.plain}/llava`]);
    const mock = await s.router.route(ACCOUNT, `${s.ids.mock}/mock-fast`, { needsVision: true });
    expect(mock.targets).toHaveLength(1);
  });

  it('drops cloud targets when routing.allowCloud is off and fails closed', async () => {
    const cloud = new Scripted('cloud', [model('gpt-5')]);
    const s = await setup([{ label: 'cloud', kind: 'openai', provider: cloud }], {
      settings: { allowCloud: false },
    });
    await expect(s.router.route(ACCOUNT, `${s.ids.cloud}/gpt-5`)).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'cloud_disabled' },
    });
    s.settings.presets = [
      preset({ id: 'mixed', targets: [`${s.ids.cloud}/gpt-5`, `${s.ids.mock}/mock-smart`] }),
      preset({ id: 'cloudy', targets: [`${s.ids.cloud}/gpt-5`] }),
    ];
    const mixed = await s.router.route(ACCOUNT, 'preset:mixed');
    expect(mixed.targets.map((t) => t.ref)).toEqual([`${s.ids.mock}/mock-smart`]);
    await expect(s.router.route(ACCOUNT, 'preset:cloudy')).rejects.toMatchObject({
      details: { reason: 'cloud_disabled', preset: 'cloudy' },
    });
  });

  it('applies preset strategies, skipping unusable targets and never picking another preset', async () => {
    const cloud = new Scripted('cloud', [model('gpt-5'), model('gpt-4.1')]);
    const router = new Scripted('router', [model('vendor/cheap', {}, 0.5)]);
    const s = await setup([
      { label: 'cloud', kind: 'openai', provider: cloud },
      { label: 'router', kind: 'openrouter', provider: router },
    ]);
    const now = new Date().toISOString();
    s.env.db.raw
      .prepare(
        `INSERT INTO model_pref (id, account_id, provider, model_id, cost_in, cost_out, created_at, updated_at)
         VALUES ('mp1', ?, 'openai', 'gpt-4.1', 2, 8, ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    await s.router.listModels(ACCOUNT);
    const targets = [
      'gone/model',
      `${s.ids.cloud}/gpt-retired`, // no longer listed by its provider
      `${s.ids.cloud}/gpt-5`, // no known price
      `${s.ids.cloud}/gpt-4.1`, // user price 10
      `${s.ids.router}/vendor/cheap`, // provider price 0.5
      `${s.ids.mock}/mock-fast`, // local: 0
      'preset:faster', // presets never nest
    ];
    const refs = async (strategy: Preset['strategy']) => {
      s.settings.presets = [preset({ id: 'p', strategy, targets })];
      return (await s.router.route(ACCOUNT, 'preset:p')).targets.map((t) => t.ref);
    };
    expect(await refs('single')).toEqual([`${s.ids.cloud}/gpt-5`]);
    const usable = [
      `${s.ids.cloud}/gpt-5`,
      `${s.ids.cloud}/gpt-4.1`,
      `${s.ids.router}/vendor/cheap`,
      `${s.ids.mock}/mock-fast`,
    ];
    expect(await refs('fallback')).toEqual(usable);
    expect(await refs('best')).toEqual(usable);
    expect(await refs('cheapest')).toEqual([
      `${s.ids.mock}/mock-fast`,
      `${s.ids.router}/vendor/cheap`,
      `${s.ids.cloud}/gpt-4.1`,
      `${s.ids.cloud}/gpt-5`,
    ]);
    s.settings.presets = [preset({ id: 'empty', targets: ['gone/a', 'node:x/y'] })];
    await expect(s.router.route(ACCOUNT, 'preset:empty')).rejects.toMatchObject({
      details: { reason: 'preset_unavailable' },
    });
  });

  it('drops non-vision preset targets for images, failing closed when none can see', async () => {
    const eyes = new Scripted('eyes', [model('gpt-4o', { vision: true })]);
    const s = await setup([{ label: 'eyes', kind: 'openai', provider: eyes }]);
    await s.router.listModels(ACCOUNT);
    s.settings.presets = [
      preset({ id: 'v', targets: [`${s.ids.mock}/mock-fast`, `${s.ids.eyes}/gpt-4o`] }),
      preset({ id: 'blind', targets: [`${s.ids.mock}/mock-fast`] }),
    ];
    const v = await s.router.route(ACCOUNT, 'preset:v', { needsVision: true });
    expect(v.targets.map((t) => t.ref)).toEqual([`${s.ids.eyes}/gpt-4o`]);
    await expect(
      s.router.route(ACCOUNT, 'preset:blind', { needsVision: true }),
    ).rejects.toMatchObject({ details: { reason: 'vision_required' } });
  });

  it('routes built-in presets, preferring real models to the offline mock, and node refs', async () => {
    const s = await setup();
    const smarter = await s.router.route(ACCOUNT, 'preset:smarter');
    expect(smarter.targets.map((t) => [t.ref, t.reasoningLevel])).toEqual([
      [`${s.ids.mock}/mock-smart`, 'high'],
    ]);
    const node = new Scripted('node', []);
    const withNode = await setup([], {
      sources: [fakeSource([{ id: 'n1', models: ['m1'], provider: node, load: null }])],
    });
    const built = await withNode.router.builtInPresets(ACCOUNT);
    expect(built.map((p) => p.targets)).toEqual([['node:n1/m1'], ['node:n1/m1'], ['node:n1/m1']]);
    const n = await withNode.router.route(ACCOUNT, 'node:n1/m1');
    expect(n.targets.map((t) => [t.ref, t.location])).toEqual([
      ['node:n1/m1', { kind: 'node', nodeId: 'n1' }],
    ]);
  });
});

describe('Router.usable, firstModel and pricing', () => {
  it('answers usable for every ref kind without throwing', async () => {
    const node = new Scripted('node', []);
    const s = await setup([], {
      sources: [fakeSource([{ id: 'n1', models: ['m1'], provider: node, load: null }])],
    });
    expect(await s.router.usable(ACCOUNT, `${s.ids.mock}/mock-fast`)).toBe(true);
    expect(await s.router.usable(ACCOUNT, 'gone/x')).toBe(false);
    expect(await s.router.usable(ACCOUNT, 'node:n1/m1')).toBe(true);
    expect(await s.router.usable(ACCOUNT, 'node:n1/other')).toBe(false);
    expect(await s.router.usable(ACCOUNT, 'preset:balanced')).toBe(true);
    expect(await s.router.usable(ACCOUNT, 'preset:custom')).toBe(false);
    expect(await s.router.usable(ACCOUNT, 'garbage')).toBe(false);
    s.settings.presets = [preset({ id: 'custom', targets: ['x/y'] })];
    expect(await s.router.usable(ACCOUNT, 'preset:custom')).toBe(true);
    expect(await s.router.usable(ACCOUNT, 'preset:balanced')).toBe(false);
    const broken = new Router({
      registry: s.env.registry,
      settings: () => Promise.reject(new Error('db gone')),
    });
    expect(await broken.usable(ACCOUNT, 'preset:balanced')).toBe(false);
  });

  it('picks the first account model, else the first node model, else nothing', async () => {
    const node = new Scripted('node', []);
    const s = await setup([], {
      sources: [fakeSource([{ id: 'n1', models: ['m1'], provider: node, load: null }])],
    });
    expect(await s.router.firstModel(ACCOUNT)).toBe(`${s.ids.mock}/mock-fast`);
    await s.env.registry.remove(ACCOUNT, s.ids.mock!);
    expect(await s.router.firstModel(ACCOUNT)).toBe('node:n1/m1');
    const bare = new Router({
      registry: s.env.registry,
      settings: () => Promise.resolve(s.settings),
    });
    expect(await bare.firstModel(ACCOUNT)).toBeNull();
    expect(await bare.pricing(ACCOUNT, 'mock', 'mock-fast')).toBeNull();
  });
});

// ---- streaming ----------------------------------------------------------------------------

describe('Router.stream', () => {
  async function twoTargets(settings: Partial<RoutingSettings> = {}) {
    const a = new Scripted('a', [model('m')]);
    const b = new Scripted('b', [model('m')]);
    const s = await setup(
      [
        { label: 'a', kind: 'openai', provider: a },
        { label: 'b', kind: 'anthropic', provider: b },
      ],
      { settings },
    );
    await s.router.listModels(ACCOUNT);
    s.settings.presets = [preset({ id: 'ab', targets: [`${s.ids.a}/m`, `${s.ids.b}/m`] })];
    return { ...s, a, b };
  }

  it('marks the route, retries transient failures with backoff, then falls back before output', async () => {
    const s = await twoTargets();
    s.a.plan = [fail('rate_limited', true), fail('network', true), fail('provider_error', true)];
    const ev = await run(s.router, 'preset:ab');
    expect(routes(ev)).toEqual([
      [`${s.ids.a}/m`, 1, null],
      [`${s.ids.a}/m`, 2, 'retry after rate_limited'],
      [`${s.ids.a}/m`, 3, 'retry after network'],
      [`${s.ids.b}/m`, 1, 'fallback after provider_error'],
    ]);
    expect(s.sleeps).toEqual([500, 1000]);
    expect(text(ev)).toBe('hi from b');
    expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'end' });
    // The route marker carries the same target objects as the route, so callers can compare.
    const first = ev[0] as Extract<RoutedEvent, { type: 'route' }>;
    expect(first.target.providerAccountId).toBe(s.ids.a);
  });

  it('honours Retry-After up to the cap, and moves on when asked to wait longer', async () => {
    const s = await twoTargets();
    s.a.plan = [fail('rate_limited', true, { retryAfterMs: 3_000 }), ok('a')];
    expect(text(await run(s.router, 'preset:ab'))).toBe('hi from a');
    expect(s.sleeps).toEqual([3_000]);
    s.sleeps.length = 0;
    s.a.plan = [fail('rate_limited', true, { retryAfterMs: 60_000 })];
    const ev = await run(s.router, 'preset:ab');
    expect(s.sleeps).toEqual([]);
    expect(routes(ev).map((r) => r[0])).toEqual([`${s.ids.a}/m`, `${s.ids.b}/m`]);
  });

  it('never falls back once content has streamed', async () => {
    const s = await twoTargets();
    s.a.plan = [
      [
        { type: 'text_delta', text: 'partial' },
        {
          type: 'stop',
          reason: 'error',
          error: { code: 'network', message: 'lost', retryable: true },
        },
      ],
    ];
    const ev = await run(s.router, 'preset:ab');
    expect(text(ev)).toBe('partial');
    expect(ev.at(-1)).toMatchObject({ type: 'stop', reason: 'error', error: { code: 'network' } });
    expect(s.b.calls).toHaveLength(0);
  });

  it('ends the turn on a non-transient error without retrying or falling back', async () => {
    const s = await twoTargets();
    for (const code of ['auth_expired', 'invalid_request', 'context_length', 'content_filter']) {
      s.a.plan = [fail(code, false)];
      const ev = await run(s.router, 'preset:ab');
      expect(ev.at(-1)).toMatchObject({ type: 'stop', error: { code } });
      expect(routes(ev)).toHaveLength(1);
    }
    expect(s.b.calls).toHaveLength(0);
    expect(s.sleeps).toEqual([]);
  });

  it('treats thrown network errors and silent endings as transient; thrown auth errors are final', async () => {
    const s = await twoTargets();
    s.a.plan = [new TypeError('fetch failed'), 'silent', new TypeError('fetch failed')];
    const ev = await run(s.router, 'preset:ab');
    expect(routes(ev).map((r) => r[0])).toEqual([
      `${s.ids.a}/m`,
      `${s.ids.a}/m`,
      `${s.ids.a}/m`,
      `${s.ids.b}/m`,
    ]);
    expect(text(ev)).toBe('hi from b');
    // A has failed three times in a row, so its circuit is open; probe it after the cooldown.
    s.clock.now += 30_000;
    s.a.plan = [new NovaError('auth_expired', 'key rejected')];
    const auth = await run(s.router, 'preset:ab');
    expect(auth.at(-1)).toMatchObject({ error: { code: 'auth_expired', message: 'key rejected' } });
    // Every target failing silently ends with the engine's "ended unexpectedly" error.
    s.a.plan = ['silent', 'silent', 'silent'];
    s.b.plan = ['silent', 'silent', 'silent'];
    const none = await run(s.router, 'preset:ab');
    expect(none.at(-1)).toMatchObject({
      type: 'stop',
      reason: 'error',
      error: { code: 'provider_error', message: 'The response ended unexpectedly' },
    });
  });

  it('opens the circuit after 3 failures, probes after 30 s and closes on success', async () => {
    const s = await twoTargets();
    s.a.plan = [fail('network', true), fail('network', true), fail('network', true)];
    expect(text(await run(s.router, 'preset:ab'))).toBe('hi from b');
    // Open: the next turn skips A entirely.
    const skipped = await run(s.router, 'preset:ab');
    expect(routes(skipped)).toEqual([[`${s.ids.b}/m`, 1, null]]);
    expect(s.a.calls).toHaveLength(3);
    // Half-open after the cooldown: one probe; it fails, so the circuit opens again.
    s.clock.now += 30_000;
    s.a.plan = [fail('timeout', true)];
    const probe = await run(s.router, 'preset:ab');
    expect(routes(probe).map((r) => r[0])).toEqual([`${s.ids.a}/m`, `${s.ids.b}/m`]);
    expect(routes(await run(s.router, 'preset:ab')).map((r) => r[0])).toEqual([`${s.ids.b}/m`]);
    // The next probe succeeds and closes it.
    s.clock.now += 30_000;
    expect(text(await run(s.router, 'preset:ab'))).toBe('hi from a');
    expect(text(await run(s.router, 'preset:ab'))).toBe('hi from a');
  });

  it('reports every circuit open as one retryable error', async () => {
    const s = await twoTargets();
    s.a.plan = Array.from({ length: 3 }, () => fail('network', true));
    s.b.plan = Array.from({ length: 3 }, () => fail('network', true));
    const ev = await run(s.router, 'preset:ab');
    expect(ev.at(-1)).toMatchObject({ error: { code: 'network' } });
    const open = await run(s.router, 'preset:ab');
    expect(routes(open)).toEqual([]);
    expect(open.at(-1)).toMatchObject({
      type: 'stop',
      reason: 'error',
      error: { code: 'provider_error', retryable: true },
    });
  });

  it('counts an answered request error as the provider being up', async () => {
    const s = await twoTargets();
    s.a.plan = [fail('network', true), fail('network', true), fail('invalid_request', false)];
    await run(s.router, 'preset:ab');
    s.a.plan = [fail('network', true), fail('network', true), ok('a')];
    expect(text(await run(s.router, 'preset:ab'))).toBe('hi from a');
  });

  it('applies a preset reasoning level and speed, and strips reasoning a model lacks', async () => {
    const think = new Scripted('think', [model('o3', { reasoning: 'levels' })]);
    const s = await setup([{ label: 'think', kind: 'openai', provider: think }]);
    await s.router.listModels(ACCOUNT);
    s.settings.presets = [
      preset({
        id: 'deep',
        targets: [`${s.ids.think}/o3`],
        reasoningLevel: 'xhigh',
        speed: 'fast',
      }),
    ];
    await run(s.router, 'preset:deep', req({ reasoning: { level: 'low' } }));
    expect(think.calls[0]).toMatchObject({
      model: 'o3',
      reasoning: { level: 'xhigh' },
      speed: 'fast',
    });
    await run(s.router, `${s.ids.mock}/mock-fast`, req({ reasoning: { level: 'high' } }));
    expect(s.env.mock.requests.at(-1)!.reasoning).toBeUndefined();
    await run(s.router, `${s.ids.mock}/mock-smart`, req({ reasoning: { level: 'high' } }));
    expect(s.env.mock.requests.at(-1)!.reasoning).toEqual({ level: 'high' });
  });

  it('stops on cancellation during a retry wait and passes a provider cancel through', async () => {
    const s = await twoTargets();
    const ac = new AbortController();
    s.a.plan = [fail('rate_limited', true)];
    const route = await s.router.route(ACCOUNT, 'preset:ab');
    const out: RoutedEvent[] = [];
    for await (const e of s.router.stream(route, req({ signal: ac.signal }), { requestId: 'c' })) {
      out.push(e);
      if (e.type === 'usage') ac.abort();
    }
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
    expect(s.b.calls).toHaveLength(0);
    await expect(
      (async () => {
        for await (const _ of s.router.stream({ requested: 'x', targets: [] }, req(), {
          requestId: 'e',
        }))
          void _;
      })(),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('keys circuits by provider account or node', () => {
    const base = {
      provider: new Scripted('x', []),
      providerKind: 'node',
      modelId: 'm',
      vision: false,
      reasoning: false,
      local: true,
    };
    expect(
      breakerKey({
        ...base,
        ref: 'node:n/m',
        providerAccountId: null,
        location: { kind: 'node', nodeId: 'n' },
      }),
    ).toBe('node:n');
    expect(
      breakerKey({ ...base, ref: 'p/m', providerAccountId: 'p', location: { kind: 'hub' } }),
    ).toBe('account:p');
    expect(
      requestFor(
        {
          ...base,
          ref: 'p/m',
          providerAccountId: 'p',
          location: { kind: 'hub' },
          reasoning: true,
          reasoningLevel: 'max',
        },
        req(),
      ),
    ).toMatchObject({ model: 'm', reasoning: { level: 'max' } });
  });
});

// ---- with the chat engine -----------------------------------------------------------------

describe('ChatService through the Router', () => {
  it('records the fallback target as the turn location and answers from it (FR-127)', async () => {
    const node = new Scripted('node', []);
    const flaky = new Scripted('flaky', [model('qwen3:8b')]);
    flaky.plan = [fail('rate_limited', true)];
    const providers = new Map([['flaky', flaky]]);
    const settings: RoutingSettings = { presets: [], order: [...ROUTING_STEPS], allowCloud: true };
    const env = await makeEnv({
      factory: ({ row }) => providers.get(row.label),
      router: (registry) =>
        new Router({
          registry,
          sources: [fakeSource([{ id: 'n1', models: ['qwen3:8b'], provider: node, load: null }])],
          settings: () => Promise.resolve(settings),
          retry: { maxRetries: 0 },
        }),
    });
    current = env;
    const acc = await env.registry.create(ACCOUNT, { provider: 'ollama', label: 'flaky' });
    await env.router.listModels(ACCOUNT);
    settings.presets = [
      preset({
        id: 'local',
        targets: [`${acc.id}/qwen3:8b`, 'node:n1/qwen3:8b'],
        reasoningLevel: 'low',
      }),
    ];
    const t = await env.threads.create(ACCOUNT, { model: 'preset:local' });
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'hello' });
    await env.chat.idle();
    expect(flaky.calls).toHaveLength(1);
    expect(node.calls.length).toBeGreaterThanOrEqual(1);
    const turn = env.db.raw
      .prepare('SELECT execution_location, model_id, status FROM turn WHERE id = ?')
      .get(res.turnId);
    expect(turn).toEqual({
      execution_location: 'node:n1',
      model_id: 'preset:local',
      status: 'completed',
    });
    const reply = (await env.threads.detail(ACCOUNT, t.id)).messages.at(-1)!;
    expect(reply.parts).toContainEqual({ type: 'text', text: 'hi from node' });
    // The turn keeps the preset; the reply names the model that answered and the preset's
    // reasoning level is what the turn records (FR-023, FR-221).
    expect(reply.model).toBe('node:n1/qwen3:8b');
    expect(
      env.db.raw.prepare('SELECT reasoning_level FROM turn WHERE id = ?').get(res.turnId),
    ).toEqual({ reasoning_level: 'low' });
  });
});
