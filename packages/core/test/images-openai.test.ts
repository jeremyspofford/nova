// image.generate with a real adapter (FR-030): the OpenAI-compatible adapter now has the images
// call, so an account whose model list has an image model offers the tool, and a call saves the
// image the provider returned as an image artifact. The provider is a fake HTTP endpoint behind
// the adapter's `fetch`.
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, openAIModelCaps } from '@nova/providers';
import {
  canGenerateImages,
  imageToolSource,
  providerImageGenerator,
  type AccountModel,
  type ProviderAccountRow,
} from '../src/index.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv } from './helpers.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let env: ToolEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function openai(sent: { url: string; body: unknown }[]) {
  return new OpenAICompatibleProvider({
    id: 'acct-openai',
    kind: 'openai',
    apiKey: 'sk-test',
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : 'null';
      sent.push({ url, body: JSON.parse(body) as unknown });
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ b64_json: PNG, revised_prompt: 'a red dot' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
}

function model(id: string): AccountModel {
  return {
    view: {
      ref: `acct-openai/${id}`,
      kind: 'model',
      source: 'account',
      providerAccountId: 'acct-openai',
      provider: 'openai',
      modelId: id,
      label: id,
      reasoning: false,
    },
    info: { id, label: id, capabilities: openAIModelCaps(id) },
    account: { id: 'acct-openai' } as ProviderAccountRow,
    local: false,
    active: true,
  };
}

describe('image.generate through the OpenAI-compatible adapter (FR-030)', () => {
  it('is offered once an image model is configured and saves the generated image', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const provider = openai(sent);
    expect(canGenerateImages(provider)).toBe(true);
    let models = [model('gpt-4o')];
    const generator = providerImageGenerator({
      registry: { accountModels: () => Promise.resolve(models), provider: () => provider },
      allowCloud: () => Promise.resolve(true),
    });
    let source: ReturnType<typeof imageToolSource> | null = null;
    env = await makeToolEnv({
      sources: [
        {
          source: 'builtin',
          list: (accountId: string) => source?.list(accountId) ?? Promise.resolve([]),
        },
      ],
    });
    source = imageToolSource({ artifacts: env.artifacts, generator });
    // A chat model only: hidden.
    expect(await source.list(ACCOUNT)).toEqual([]);
    models = [model('gpt-4o'), model('gpt-image-1')];
    expect((await source.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual(['image.generate']);
    const thread = (await env.threads.create(ACCOUNT, {})).id;
    const { done } = await env.runtime.invoke({
      accountId: ACCOUNT,
      name: 'image.generate',
      args: { prompt: 'a red dot', size: '1024x1024' },
      threadId: thread,
      initiator: 'user',
    });
    const r = await done;
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/Generated a 1024x1024 image with acct-openai\/gpt-image-1/);
    expect(sent).toEqual([
      {
        url: 'https://api.openai.com/v1/images/generations',
        body: { model: 'gpt-image-1', prompt: 'a red dot', size: '1024x1024', n: 1 },
      },
    ]);
    const items = await env.artifacts.list(ACCOUNT, thread);
    expect(items).toEqual([expect.objectContaining({ kind: 'image', title: 'a red dot' })]);
  });
});
