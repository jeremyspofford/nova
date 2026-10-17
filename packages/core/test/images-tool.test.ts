// image.generate (FR-030): offered only while a configured provider can make images, saved as an
// image artifact with its prompt, model and size, and served by the first image model a provider
// declares (local ones only when cloud routing is off). Providers are fakes: no adapter has an
// images call yet.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NovaError } from '@nova/shared';
import type { Provider, ProviderCapabilities } from '@nova/providers';
import {
  canGenerateImages,
  imageToolSource,
  providerImageGenerator,
  type ImageGenerator,
} from '../src/documents/index.ts';
import type { AccountModel, ProviderAccountRow } from '../src/index.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv } from './helpers.ts';

/** A 1x1 PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let env: ToolEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function fakeGenerator(over: Partial<ImageGenerator> = {}): ImageGenerator {
  return {
    model: () => Promise.resolve({ ref: 'pa9/painter', label: 'Painter' }),
    generate: () =>
      Promise.resolve({
        model: 'pa9/painter',
        image: { data: PNG, revisedPrompt: 'a red dot, flat' },
      }),
    ...over,
  };
}

async function setup(generator: ImageGenerator) {
  let source: ReturnType<typeof imageToolSource> | null = null;
  const e = await makeToolEnv({
    sources: [
      {
        source: 'builtin',
        list: (accountId: string) => source?.list(accountId) ?? Promise.resolve([]),
      },
    ],
  });
  source = imageToolSource({ artifacts: e.artifacts, generator });
  return { env: e, source };
}

async function call(e: ToolEnv, args: unknown, threadId: string) {
  const { done } = await e.runtime.invoke({
    accountId: ACCOUNT,
    name: 'image.generate',
    args,
    threadId,
    initiator: 'user',
  });
  return done;
}

describe('image.generate (FR-030)', () => {
  it('is listed only while a provider can generate images', async () => {
    const off = await setup(fakeGenerator({ model: () => Promise.resolve(null) }));
    env = off.env;
    expect(await off.source.list(ACCOUNT)).toEqual([]);
    const broken = imageToolSource({
      artifacts: off.env.artifacts,
      generator: fakeGenerator({ model: () => Promise.reject(new Error('down')) }),
    });
    expect(await broken.list(ACCOUNT)).toEqual([]);
    const on = imageToolSource({ artifacts: off.env.artifacts, generator: fakeGenerator() });
    const [tool] = await on.list(ACCOUNT);
    expect(tool!.descriptor).toMatchObject({
      name: 'image.generate',
      source: 'builtin',
      annotations: { action: 'write', costClass: 'metered' },
    });
  });

  it('saves the image as an artifact with its prompt, model and size', async () => {
    const base = fakeGenerator();
    const generate = vi.fn((accountId: string, req: Parameters<ImageGenerator['generate']>[1]) =>
      base.generate(accountId, req),
    );
    const s = await setup(fakeGenerator({ generate }));
    env = s.env;
    const save = vi.spyOn(env.artifacts, 'save');
    const t = await env.threads.create(ACCOUNT, {});
    const r = await call(env, { prompt: '  A red dot\non white ', size: '512x512' }, t.id);
    expect(r.ok).toBe(true);
    expect(generate).toHaveBeenCalledWith(
      ACCOUNT,
      expect.objectContaining({ prompt: 'A red dot\non white', size: '512x512' }),
    );
    const [art] = await env.artifacts.list(ACCOUNT, t.id);
    expect(art).toMatchObject({ kind: 'image', mime: 'image/png', title: 'A red dot on white' });
    expect(r.text).toBe(`Generated a 512x512 image with pa9/painter (artifact id ${art!.id}).`);
    expect(save.mock.calls[0]![0]).toMatchObject({
      meta: {
        prompt: 'A red dot\non white',
        model: 'pa9/painter',
        size: '512x512',
        revisedPrompt: 'a red dot, flat',
      },
    });
    // The default size, and the result fields the tool card keeps.
    await call(env, { prompt: 'square' }, t.id);
    expect(save.mock.calls[1]![0]).toMatchObject({
      meta: { size: '1024x1024', revisedPrompt: 'a red dot, flat' },
    });
  });

  it('reports provider failures and images the artifact store refuses', async () => {
    const s = await setup(
      fakeGenerator({
        generate: (_a, req) =>
          req.prompt === 'fail'
            ? Promise.reject(new NovaError('rate_limited', 'slow down'))
            : Promise.resolve({
                model: 'm',
                image: { data: Buffer.from('not an image').toString('base64') },
              }),
      }),
    );
    env = s.env;
    const t = await env.threads.create(ACCOUNT, {});
    expect(await call(env, { prompt: 'fail' }, t.id)).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', message: 'slow down' },
    });
    expect(await call(env, { prompt: 'bad bytes' }, t.id)).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    expect(await call(env, { prompt: '   ' }, t.id)).toMatchObject({
      ok: false,
      error: { code: 'validation', message: 'the prompt is empty' },
    });
  });
});

// ---- the provider-backed generator --------------------------------------------------------------

const CAPS: ProviderCapabilities = {
  streaming: true,
  tools: false,
  parallelToolCalls: false,
  vision: false,
  audioIn: false,
  audioOut: false,
  realtime: false,
  reasoning: false,
  promptCache: 'none',
  structuredOutput: false,
  imageGeneration: true,
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};

function provider(
  id: string,
  opts: { images?: boolean; method?: boolean; result?: unknown } = {},
): Provider {
  const p: Provider & { generateImage?: unknown } = {
    id,
    capabilities: { ...CAPS, imageGeneration: opts.images ?? true },
    listModels: () => Promise.resolve([]),
    stream: () => {
      throw new Error('not used');
    },
  };
  if (opts.method ?? true)
    p.generateImage = vi.fn(() =>
      Promise.resolve(opts.result ?? { model: 'x', images: [{ data: PNG }] }),
    );
  return p;
}

function model(account: string, id: string, images: boolean, local: boolean): AccountModel {
  return {
    view: {
      ref: `${account}/${id}`,
      kind: 'model',
      source: 'account',
      providerAccountId: account,
      provider: 'openai_compatible',
      modelId: id,
      label: id,
      reasoning: false,
    },
    info: { id, label: id, capabilities: images ? { imageGeneration: true } : {} },
    account: { id: account } as ProviderAccountRow,
    local,
    active: true,
  };
}

describe('providerImageGenerator (FR-030)', () => {
  it('uses the first image model whose provider has an images call', async () => {
    const providers: Record<string, Provider> = {
      chat: provider('chat'),
      flagless: provider('flagless', { images: false }),
      nomethod: provider('nomethod', { method: false }),
      cloud: provider('cloud'),
      local: provider('local'),
    };
    const models = [
      model('chat', 'talker', false, false),
      model('flagless', 'img-a', true, false),
      model('nomethod', 'img-b', true, false),
      model('cloud', 'img-c', true, false),
      model('local', 'img-d', true, true),
    ];
    let cloud = true;
    const gen = providerImageGenerator({
      registry: {
        accountModels: () => Promise.resolve(models),
        provider: (row) => providers[row.id]!,
      },
      allowCloud: () => Promise.resolve(cloud),
    });
    expect(canGenerateImages(providers.flagless!)).toBe(false);
    expect(canGenerateImages(providers.nomethod!)).toBe(false);
    expect(await gen.model(ACCOUNT)).toEqual({ ref: 'cloud/img-c', label: 'img-c' });
    const ctl = new AbortController();
    const out = await gen.generate(ACCOUNT, { prompt: 'p', size: '256x256', signal: ctl.signal });
    expect(out).toEqual({ model: 'cloud/img-c', image: { data: PNG } });
    expect(
      (providers.cloud as unknown as { generateImage: ReturnType<typeof vi.fn> }).generateImage,
    ).toHaveBeenCalledWith(
      { model: 'img-c', prompt: 'p', size: '256x256', signal: ctl.signal },
      expect.objectContaining({ requestId: expect.stringMatching(/^image:/) }),
    );
    // With cloud routing off, only local models serve images (privacy first).
    cloud = false;
    expect(await gen.model(ACCOUNT)).toEqual({ ref: 'local/img-d', label: 'img-d' });
  });

  it('reports no model, no image and a failing registry plainly', async () => {
    const none = providerImageGenerator({
      registry: { accountModels: () => Promise.resolve([]), provider: () => provider('x') },
    });
    expect(await none.model(ACCOUNT)).toBeNull();
    await expect(
      none.generate(ACCOUNT, {
        prompt: 'p',
        size: '256x256',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/no configured provider can generate images/);
    const empty = providerImageGenerator({
      registry: {
        accountModels: () => Promise.resolve([model('a', 'img', true, true)]),
        provider: () => provider('a', { result: { model: 'img', images: [] } }),
      },
    });
    await expect(
      empty.generate(ACCOUNT, {
        prompt: 'p',
        size: '256x256',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/returned no image/);
    const failing = providerImageGenerator({
      registry: {
        accountModels: () => Promise.reject(new Error('db gone')),
        provider: () => provider('x'),
      },
    });
    expect(await failing.model(ACCOUNT)).toBeNull();
  });
});
