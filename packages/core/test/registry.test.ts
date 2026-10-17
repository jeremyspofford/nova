import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type ProviderKind } from '@nova/shared';
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  collect,
  type ModelInfo,
  type Provider,
} from '@nova/providers';
import { MOCK_PROVIDER_LABEL, ProviderRegistry, isLocalProvider } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(() => env.close());

const KEY = 'sk-live-registry-0123456789abcdef';

function failingProvider(err: Error, calls: { n: number }): Provider {
  return {
    id: 'bad',
    capabilities: new OpenAICompatibleProvider({ id: 'x', kind: 'ollama' }).capabilities,
    listModels: () => {
      calls.n++;
      return Promise.reject(err);
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      await Promise.resolve();
      throw err;
    },
  };
}

describe('ProviderRegistry', () => {
  it('creates the offline mock account once, and never again after it is deleted', async () => {
    const list = await env.registry.list(ACCOUNT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      provider: 'mock',
      label: MOCK_PROVIDER_LABEL,
      authKind: 'none',
      hasSecret: false,
      status: 'active',
    });
    expect(await env.registry.ensureDefaultProvider(ACCOUNT)).toBeNull();
    await env.registry.remove(ACCOUNT, list[0]!.id);
    expect(await env.registry.ensureDefaultProvider(ACCOUNT)).toBeNull();
    expect(await env.registry.list(ACCOUNT)).toEqual([]);
  });

  it('stores the API key in the vault and only a secret:// reference in the database (FR-101)', async () => {
    const view = await env.registry.create(ACCOUNT, {
      provider: 'openai_compatible',
      label: '  Local server ',
      baseUrl: 'http://127.0.0.1:8080/v1/',
      apiKey: KEY,
    });
    expect(view).toMatchObject({
      label: 'Local server',
      authKind: 'api_key',
      hasSecret: true,
      baseUrl: 'http://127.0.0.1:8080/v1',
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
    const row = env.db.raw
      .prepare('SELECT * FROM provider_account WHERE id = ?')
      .get(view.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(row.secret_ref).toBe(`secret://provider/${view.id}/api_key`);
    expect(await env.secrets.get(row.secret_ref as string)).toBe(KEY);

    await env.registry.remove(ACCOUNT, view.id);
    expect(await env.secrets.has(`secret://provider/${view.id}/api_key`)).toBe(false);
    await expect(env.registry.account(ACCOUNT, view.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('validates provider requests', async () => {
    const create = (req: Parameters<ProviderRegistry['create']>[1]) =>
      env.registry.create(ACCOUNT, req);
    await expect(
      create({ provider: 'gemini' as ProviderKind, label: 'a', apiKey: 'k' }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'unsupported_provider' },
    });
    await expect(create({ provider: 'openai_compatible', label: 'a' })).rejects.toThrow(/base URL/);
    await expect(create({ provider: 'openai', label: 'a' })).rejects.toThrow(/API key/);
    await expect(
      create({ provider: 'openai_compatible', label: 'a', baseUrl: 'ftp://example.com/v1' }),
    ).rejects.toThrow(/http or https/);
    const ollama = await create({ provider: 'ollama', label: 'Ollama' });
    expect(ollama.baseUrl).toBe('http://127.0.0.1:11434/v1');
    const openai = await create({ provider: 'openai', label: 'OpenAI', apiKey: KEY });
    expect(openai.baseUrl).toBe('https://api.openai.com/v1');
    const row = await env.registry.account(ACCOUNT, openai.id);
    const p = env.registry.provider(row);
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect((p as OpenAICompatibleProvider).kind).toBe('openai');
    expect(env.registry.provider(row)).toBe(p);
  });

  it('tests a connection: ok with a model count, or ok:false with a redacted detail', async () => {
    const [mock] = await env.registry.list(ACCOUNT);
    expect(await env.registry.test(ACCOUNT, mock!.id)).toEqual({ ok: true, models: 2 });
    expect((await env.registry.list(ACCOUNT))[0]!.lastCheckAt).not.toBeNull();

    const calls = { n: 0 };
    const local = await makeEnv({
      factory: ({ row }) =>
        row.provider === 'openai'
          ? failingProvider(
              new NovaError('auth_expired', `the provider rejected the credential: ${KEY}`),
              calls,
            )
          : undefined,
    });
    try {
      const v = await local.registry.create(ACCOUNT, {
        provider: 'openai',
        label: 'o',
        apiKey: KEY,
      });
      const r = await local.registry.test(ACCOUNT, v.id);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('rejected');
      expect(r.detail).not.toContain(KEY);
      expect((await local.registry.list(ACCOUNT)).find((x) => x.id === v.id)?.status).toBe(
        'expired',
      );
    } finally {
      await local.close();
    }
  });

  it('marks a non-auth failure as error', async () => {
    const calls = { n: 0 };
    const local = await makeEnv({
      factory: ({ row }) =>
        row.provider === 'ollama'
          ? failingProvider(new Error('connect ECONNREFUSED'), calls)
          : undefined,
    });
    try {
      const v = await local.registry.create(ACCOUNT, { provider: 'ollama', label: 'o' });
      expect(await local.registry.test(ACCOUNT, v.id)).toEqual({
        ok: false,
        detail: 'connect ECONNREFUSED',
      });
      expect((await local.registry.account(ACCOUNT, v.id)).status).toBe('error');
    } finally {
      await local.close();
    }
  });

  it('lists models across accounts, caches them briefly and skips a failing provider', async () => {
    const calls = { n: 0 };
    let mockCalls = 0;
    const models: ModelInfo[] = [{ id: 'm1', label: 'M1', capabilities: { reasoning: 'levels' } }];
    const local = await makeEnv({
      factory: ({ row }) => {
        if (row.provider === 'ollama') return failingProvider(new Error('down'), calls);
        if (row.provider === 'openai_compatible') {
          return {
            ...failingProvider(new Error('unused'), calls),
            listModels: () => {
              mockCalls++;
              return Promise.resolve(models);
            },
          };
        }
        return undefined;
      },
    });
    try {
      await local.registry.create(ACCOUNT, { provider: 'ollama', label: 'down' });
      const ok = await local.registry.create(ACCOUNT, {
        provider: 'openai_compatible',
        label: 'up',
        baseUrl: 'http://127.0.0.1:1/v1',
      });
      const list = await local.registry.listModels(ACCOUNT);
      expect(list.map((m) => m.ref)).toEqual([
        `${local.mockAccountId}/mock-fast`,
        `${local.mockAccountId}/mock-smart`,
        `${ok.id}/m1`,
      ]);
      expect(list[2]).toMatchObject({
        provider: 'openai_compatible',
        reasoning: true,
        label: 'M1',
      });
      expect(list[0]!.reasoning).toBe(false);
      await local.registry.listModels(ACCOUNT);
      expect(mockCalls).toBe(1);
      expect(calls.n).toBe(1); // the failing provider is not asked again within the cache window
      expect(await local.registry.firstModel(ACCOUNT)).toBe(`${local.mockAccountId}/mock-fast`);
    } finally {
      await local.close();
    }
  });

  it('resolves model refs and refuses unknown ones', async () => {
    const r = await env.registry.resolve(ACCOUNT, `${env.mockAccountId}/mock-smart`);
    expect(r.modelId).toBe('mock-smart');
    expect(r.provider).toBe(env.mock);
    await expect(env.registry.resolve(ACCOUNT, 'nope')).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(env.registry.resolve(ACCOUNT, 'missing/model')).rejects.toMatchObject({
      details: { reason: 'unknown_model' },
    });
  });

  it('reads per-model prices from model_pref', async () => {
    expect(await env.registry.pricing(ACCOUNT, 'mock', 'mock-fast')).toBeNull();
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        `INSERT INTO model_pref (id, account_id, provider, model_id, cost_in, cost_out, created_at, updated_at)
         VALUES ('mp', ?, 'mock', 'mock-fast', 1.5, NULL, ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    expect(await env.registry.pricing(ACCOUNT, 'mock', 'mock-fast')).toEqual({
      costIn: 1.5,
      costOut: 0,
    });
  });

  it('builds the built-in mock when no factory overrides it', async () => {
    const plain = new ProviderRegistry({ db: env.db, secrets: env.secrets });
    const row = await plain.account(ACCOUNT, env.mockAccountId);
    expect((await plain.provider(row).listModels()).map((m) => m.id)).toEqual([
      'mock-fast',
      'mock-smart',
    ]);
    expect(() => plain.provider({ ...row, id: 'x', provider: 'gemini' })).toThrow(/no adapter/);
  });
});

describe('ProviderRegistry M2 kinds and routing helpers', () => {
  it('creates Anthropic, OpenRouter and llama.cpp accounts with their defaults (docs/07 §3)', async () => {
    const create = (req: Parameters<ProviderRegistry['create']>[1]) =>
      env.registry.create(ACCOUNT, req);
    await expect(create({ provider: 'anthropic', label: 'a' })).rejects.toThrow(
      /API key is required for Anthropic/,
    );
    await expect(create({ provider: 'openrouter', label: 'r' })).rejects.toThrow(/OpenRouter/);
    const anthropic = await create({ provider: 'anthropic', label: 'A', apiKey: KEY });
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com');
    const proxied = await create({
      provider: 'anthropic',
      label: 'A2',
      apiKey: KEY,
      baseUrl: 'http://127.0.0.1:9999',
    });
    const router = await create({ provider: 'openrouter', label: 'R', apiKey: KEY });
    expect(router.baseUrl).toBe('https://openrouter.ai/api/v1');
    const llama = await create({ provider: 'llamacpp', label: 'L' });
    expect(llama).toMatchObject({ baseUrl: 'http://127.0.0.1:8080/v1', hasSecret: false });

    const build = async (id: string) =>
      env.registry.provider(await env.registry.account(ACCOUNT, id));
    const a = await build(anthropic.id);
    expect(a).toBeInstanceOf(AnthropicProvider);
    expect((a as AnthropicProvider).baseUrl).toBe('https://api.anthropic.com/v1');
    // The account's own base URL is honoured (J2 points Anthropic at a local fake server).
    expect(((await build(proxied.id)) as AnthropicProvider).baseUrl).toBe(
      'http://127.0.0.1:9999/v1',
    );
    expect(((await build(router.id)) as OpenAICompatibleProvider).kind).toBe('openrouter');
    expect(((await build(llama.id)) as OpenAICompatibleProvider).kind).toBe('llamacpp');
  });

  it('builds adapters that leave retries to the router', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"busy"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const v = await env.registry.create(ACCOUNT, {
        provider: 'ollama',
        label: 'busy',
        baseUrl: `http://127.0.0.1:${port}`,
      });
      const p = env.registry.provider(await env.registry.account(ACCOUNT, v.id));
      const c = await collect(
        p.stream(
          { model: 'm', messages: [], signal: new AbortController().signal },
          { requestId: 'r' },
        ),
      );
      expect(c.error).toMatchObject({ code: 'provider_error', retryable: true });
      expect(hits).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('classifies local and cloud accounts, failing closed for public hosts', () => {
    expect(isLocalProvider('mock', null)).toBe(true);
    expect(isLocalProvider('anthropic', 'http://127.0.0.1:1')).toBe(false);
    expect(isLocalProvider('openai', null)).toBe(false);
    expect(isLocalProvider('ollama', null)).toBe(true);
    expect(isLocalProvider('ollama', 'https://ollama.example.com')).toBe(false);
    for (const host of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:8080/v1',
      'http://10.0.0.5/v1',
      'http://172.20.1.1/v1',
      'http://192.168.1.9:11434',
      'http://100.101.1.2/v1',
      'http://box.local/v1',
      'http://gpu.tail1234.ts.net/v1',
      'http://gpubox:8080/v1',
      'http://[::1]:8080/v1',
      'http://[fd12:3456::1]/v1',
    ])
      expect(isLocalProvider('openai_compatible', host)).toBe(true);
    expect(isLocalProvider('openai_compatible', 'https://api.example.com/v1')).toBe(false);
    expect(isLocalProvider('openai_compatible', 'http://172.32.0.1/v1')).toBe(false);
    expect(isLocalProvider('openai_compatible', 'not a url')).toBe(false);
  });

  it('exposes cached model lists, local servers serving a model, and resolved details', async () => {
    const info: ModelInfo[] = [
      { id: 'qwen3:8b', label: 'qwen3:8b', capabilities: { vision: true }, costIn: 1, costOut: 2 },
    ];
    const local = await makeEnv({
      factory: ({ row }) =>
        row.provider === 'ollama' || row.provider === 'llamacpp'
          ? {
              id: row.id,
              capabilities: new OpenAICompatibleProvider({ id: 'x', kind: 'ollama' }).capabilities,
              listModels: () => Promise.resolve(info),
              // eslint-disable-next-line require-yield
              stream: async function* () {
                await Promise.resolve();
              },
            }
          : undefined,
    });
    try {
      const a = await local.registry.create(ACCOUNT, { provider: 'ollama', label: 'o' });
      const b = await local.registry.create(ACCOUNT, { provider: 'llamacpp', label: 'l' });
      expect(local.registry.cachedModels(a.id)).toBeUndefined();
      expect(await local.registry.localServing(ACCOUNT, 'qwen3:8b', a.id)).toEqual([]);
      const models = await local.registry.accountModels(ACCOUNT);
      expect(models.filter((m) => m.local).map((m) => m.view.ref)).toEqual([
        `${local.mockAccountId}/mock-fast`,
        `${local.mockAccountId}/mock-smart`,
        `${a.id}/qwen3:8b`,
        `${b.id}/qwen3:8b`,
      ]);
      expect(local.registry.cachedModels(a.id)).toEqual(info);
      const serving = await local.registry.localServing(ACCOUNT, 'qwen3:8b', a.id);
      expect(serving.map((r) => r.ref)).toEqual([`${b.id}/qwen3:8b`]);
      expect(serving[0]).toMatchObject({
        vision: true,
        reasoning: false,
        local: true,
        costIn: 1,
        costOut: 2,
      });
      const smart = await local.registry.resolve(ACCOUNT, `${local.mockAccountId}/mock-smart`);
      expect(smart).toMatchObject({ reasoning: true, local: true });
      expect(
        (await local.registry.resolve(ACCOUNT, `${local.mockAccountId}/mock-fast`)).reasoning,
      ).toBe(false);
    } finally {
      await local.close();
    }
  });
});
