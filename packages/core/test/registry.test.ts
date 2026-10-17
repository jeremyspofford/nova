import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import { OpenAICompatibleProvider, type ModelInfo, type Provider } from '@nova/providers';
import { MOCK_PROVIDER_LABEL, ProviderRegistry } from '../src/index.ts';
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
    await expect(create({ provider: 'anthropic', label: 'a', apiKey: 'k' })).rejects.toMatchObject({
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
    expect(() => plain.provider({ ...row, id: 'x', provider: 'anthropic' })).toThrow(/no adapter/);
  });
});
